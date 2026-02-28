#!/usr/bin/env node
/**
 * VAGUS Raw Sensor Daemon (Subscription-based)
 *
 * Uses only subscriptions (no reads) to avoid rate limiting.
 * All data streams—raw I/O sensors AND high-level inferences—flow
 * continuously through subscription updates.
 *
 * Aggregates and prints rolling summaries every 10 seconds.
 */

const { spawn } = require('child_process');
const BASE_DIR = '/usr/local/lib/node_modules/openclaw/skills/vagus/scripts';

// Reconnection settings
const RECONNECT_INITIAL_MS = 5000;
const RECONNECT_MAX_MS = 300000; // 5 minutes
const STALE_TIMEOUT_MS = 90000; // 90 seconds without data = consider dead

// Track all subscription objects for global stale watchdog
const subscriptions = [];

function startSubscription(uri, handler) {
  let retryCount = 0;
  let retryTimer = null;
  let proc = null;
  let lastDataTime = Date.now();

  function cleanup() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function spawnSubscription() {
    if (proc && !proc.killed) {
      try { proc.kill('SIGTERM'); } catch (e) {}
    }

    proc = spawn('node', [BASE_DIR + '/vagus-connect.js', 'subscribe', uri], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.on('error', (err) => {
      console.error(`[${uri}] Failed to start: ${err.message}`);
      scheduleReconnect();
    });

    proc.on('exit', (code, signal) => {
      console.log(`[${uri}] Subscription exited (code=${code}, signal=${signal})`);
      scheduleReconnect();
    });

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }

        if (msg.type === 'update' && msg.data) {
          lastDataTime = Date.now();
          retryCount = 0;
          cleanup();
          handler(msg.data);
        } else if (msg.type === 'subscribed') {
          console.log(`✅ Subscribed to ${uri}`);
        } else if (msg.type === 'error') {
          console.error(`[${uri}] Error: ${msg.message}`);
          // Consider treating certain errors as fatal to reconnect
        }
      }
    });

    proc.stderr.on('data', () => {});
  }

  function scheduleReconnect() {
    if (retryTimer) clearTimeout(retryTimer);
    const delay = Math.min(RECONNECT_INITIAL_MS * Math.pow(2, retryCount), RECONNECT_MAX_MS);
    retryCount++;
    console.log(`[RECONNECT] ${uri} in ${delay}ms (attempt ${retryCount})`);
    retryTimer = setTimeout(() => {
      spawnSubscription();
    }, delay);
  }

  // Global watchdog: if no data for STALE_TIMEOUT_MS, force reconnect
  const subObj = {
    uri,
    lastDataTime: () => lastDataTime,
    scheduleReconnect
  };
  subscriptions.push(subObj);

  spawnSubscription();
}

// Global stale check (runs every 30s)
setInterval(() => {
  const now = Date.now();
  for (const sub of subscriptions) {
    if (now - sub.lastDataTime() > STALE_TIMEOUT_MS) {
      console.log(`[STALE] ${sub.uri} no data for ${now - sub.lastDataTime()}ms → reconnecting`);
      sub.scheduleReconnect();
    }
  }
}, 30000);

// Graceful shutdown: kill all child processes
process.on('SIGINT', () => {
  console.log('Shutting down VAGUS daemon...');
  for (const sub of subscriptions) {
    try { sub.proc.kill('SIGTERM'); } catch (e) {}
  }
  process.exit(0);
});
process.on('SIGTERM', () => {
  for (const sub of subscriptions) {
    try { sub.proc.kill('SIGTERM'); } catch (e) {}
  }
  process.exit(0);
});

// Rolling buffers (last N samples)
const BUFFER_SIZE = 600;
const buffers = {
  magnet: [],
  light: [],
  orientation: [],
  color: [],
  proximity: []
};

// Inference state (latest values, not buffered)
const inference = {
  attention: null,
  screen: null,
  sleep: null
};

// Keep subscription processes
const subs = [];

function startSubscription(uri, handler) {
  const proc = spawn('node', [BASE_DIR + '/vagus-connect.js', 'subscribe', uri], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.on('error', (err) => {
    console.error(`Failed to start subscription to ${uri}: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    console.log(`Subscription to ${uri} exited with code ${code}`);
  });

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.type === 'update' && msg.data) {
        handler(msg.data);
      } else if (msg.type === 'subscribed') {
        console.log(`✅ Subscribed to ${uri}`);
      } else if (msg.type === 'error') {
        console.error(`[${uri}] Error: ${msg.message}`);
      }
    }
  });

  proc.stderr.on('data', () => {}); // ignore stderr
  subs.push(proc);
  return proc;
}

// Raw I/O sensors
startSubscription('vagus://io/type_2', (data) => {
  if (data.values && data.values.length >= 3) {
    buffers.magnet.push({ x: data.values[0], y: data.values[1], z: data.values[2], ts: data.ts });
    if (buffers.magnet.length > BUFFER_SIZE) buffers.magnet.shift();
  }
});

startSubscription('vagus://io/type_5', (data) => {
  if (data.values && data.values.length >= 3) {
    buffers.light.push({ ch0: data.values[0], ch1: data.values[1], ch2: data.values[2], ts: data.ts });
    if (buffers.light.length > BUFFER_SIZE) buffers.light.shift();
  }
});

startSubscription('vagus://io/type_3', (data) => {
  if (data.values && data.values.length >= 3) {
    buffers.orientation.push({ az: data.values[0], pitch: data.values[1], roll: data.values[2], ts: data.ts });
    if (buffers.orientation.length > BUFFER_SIZE) buffers.orientation.shift();
  }
});

startSubscription('vagus://io/type_65554', (data) => {
  if (data.values && data.values.length >= 4) {
    buffers.color.push({ channels: data.values.slice(0,4), ts: data.ts });
    if (buffers.color.length > BUFFER_SIZE) buffers.color.shift();
  }
});

startSubscription('vagus://io/type_8', (data) => {
  if (data.values && data.values.length >= 1) {
    buffers.proximity.push({ dist: data.values[0], raw: data.values[1] ?? null, ts: data.ts });
    if (buffers.proximity.length > BUFFER_SIZE) buffers.proximity.shift();
  }
});

// HALL sensor (magnetic cover/strap state) — may not exist on all devices
try {
  startSubscription('vagus://io/type_65555', (data) => {
    if (data.values && data.values.length >= 1) {
      if (!buffers.hall) buffers.hall = [];
      buffers.hall.push({ value: data.values[0], ts: data.ts });
      if (buffers.hall.length > BUFFER_SIZE) buffers.hall.shift();
    }
  });
} catch (e) {
  console.log('[CONFIG] HALL sensor not available on this device');
}

// CAP_PROX (capacitive proximity) — may not exist; attempting but will ignore errors
// Actually, we'll skip CAP_PROX for now; the earlier attempt failed. Uncomment if device supports type_1.
// startSubscription('vagus://io/type_1', (data) => { ... });

// Inferences (also available as subscription resources)
startSubscription('vagus://inference/attention', (data) => {
  inference.attention = data;
});

startSubscription('vagus://device/screen', (data) => {
  inference.screen = data;
});

startSubscription('vagus://inference/sleep_likelihood', (data) => {
  inference.sleep = data;
});

// Motion sensor (raw IMU: linear acceleration + angular velocity)
startSubscription('vagus://sensors/motion', (data) => {
  if (!buffers.motion) buffers.motion = [];
  buffers.motion.push({
    ax: data.ax, ay: data.ay, az: data.az,
    gx: data.gx, gy: data.gy, gz: data.gz,
    ts: data.ts
  });
  if (buffers.motion.length > BUFFER_SIZE) buffers.motion.shift();
});

// Activity classification (high-level: still, walking, running, in_vehicle, etc.)
try {
  startSubscription('vagus://sensors/activity', (data) => {
    inference.activity = data;
  });
} catch (e) {
  console.log('[CONFIG] vagus://sensors/activity not available on this device');
}

// Compute statistics from buffers
function computeStats() {
  const stats = {};

  if (buffers.magnet.length >= 10) {
    const recent = buffers.magnet.slice(-30);
    const mags = recent.map(s => Math.sqrt(s.x**2 + s.y**2));
    const mean = mags.reduce((a,b)=>a+b,0)/mags.length;
    const variance = mags.reduce((a,b)=>a+(b-mean)**2,0)/mags.length;
    stats.magnet = { mean, variance };
    const last = recent[recent.length-1];
    if (last) {
      const heading = Math.atan2(last.y, last.x) * (180/Math.PI);
      stats.magnet.heading_deg = heading;
    }
  }

  if (buffers.light.length >= 20) {
    const ch1 = buffers.light.map(s => s.ch1);
    const mean = ch1.reduce((a,b)=>a+b,0)/ch1.length;
    const flickerVar = ch1.reduce((a,b)=>a+(b-mean)**2,0)/ch1.length;
    stats.light = { ch0_mean: buffers.light.slice(-5).reduce((a,s)=>a+s.ch0,0)/5, flicker_variance: flickerVar };
  }

  if (buffers.orientation.length >= 10) {
    const recent = buffers.orientation.slice(-30);
    const pitches = recent.map(s => s.pitch);
    const rolls = recent.map(s => s.roll);
    const pitchMean = pitches.reduce((a,b)=>a+b,0)/pitches.length;
    const rollMean = rolls.reduce((a,b)=>a+b,0)/rolls.length;
    const pitchVar = pitches.reduce((a,b)=>a+(b - pitchMean)**2,0)/pitches.length;
    const rollVar = rolls.reduce((a,b)=>a+(b - rollMean)**2,0)/rolls.length;
    stats.orientation = { pitch_variance: pitchVar, roll_variance: rollVar };
    stats.orientation.last_azimuth = recent[recent.length-1]?.az;
  }

  if (buffers.color.length >= 5) {
    const last = buffers.color[buffers.color.length-1];
    if (last && last.channels.length >= 4) {
      stats.color = {
        r: last.channels[0],
        g: last.channels[1],
        b: last.channels[2],
        c: last.channels[3]
      };
      if (last.channels[2] > 0) {
        stats.color.rb_ratio = last.channels[0] / last.channels[2];
      }
    }
  }

  if (buffers.proximity.length >= 5) {
    const last = buffers.proximity[buffers.proximity.length-1];
    stats.proximity = { distance_cm: last.dist, raw: last.raw };
  }

  if (buffers.hall && buffers.hall.length >= 1) {
    const last = buffers.hall[buffers.hall.length-1];
    stats.hall = { value: last.value };
  }

  if (buffers.cap_prox && buffers.cap_prox.length >= 5) {
    const last = buffers.cap_prox[buffers.cap_prox.length-1];
    stats.cap_prox = { distance_cm: last.dist, raw: last.raw };
  }

  if (buffers.motion && buffers.motion.length >= 10) {
    const recent = buffers.motion.slice(-30);
    // Compute net acceleration magnitude (ignore gravity if needed, but here raw)
    const mags = recent.map(s => Math.sqrt(s.ax**2 + s.ay**2 + s.az**2));
    const mean = mags.reduce((a,b)=>a+b,0)/mags.length;
    const variance = mags.reduce((a,b)=>a+(b-mean)**2,0)/mags.length;
    stats.motion = { accel_mag_mean: mean, accel_mag_var: variance };
    // Also angular velocity stats
    const gMags = recent.map(s => Math.sqrt(s.gx**2 + s.gy**2 + s.gz**2));
    const gMean = gMags.reduce((a,b)=>a+b,0)/gMags.length;
    const gVar = gMags.reduce((a,b)=>a+(b-gMean)**2,0)/gMags.length;
    stats.motion.gyro_mag_mean = gMean;
    stats.motion.gyro_mag_var = gVar;
  }

  // Attach latest inference values
  stats.attention = inference.attention;
  stats.screen = inference.screen;
  stats.sleep = inference.sleep;

  return stats;
}

function formatStats(stats) {
  const parts = [];
  if (stats.magnet) {
    parts.push(`Magnet: heading=${stats.magnet.heading_deg?.toFixed(1) ?? 'n/a'}° var=${stats.magnet.variance?.toFixed(2)}`);
  }
  if (stats.light) {
    parts.push(`Light: ${stats.light.ch0_mean?.toFixed(1)}lx flick=${stats.light.flicker_variance?.toFixed(1)}`);
  }
  if (stats.orientation) {
    parts.push(`Orient: az=${stats.orientation.last_azimuth?.toFixed(1)}° pitchVar=${stats.orientation.pitch_variance?.toFixed(3)}`);
  }
  if (stats.color) {
    parts.push(`Color: R=${stats.color.r} G=${stats.color.g} B=${stats.color.b} C=${stats.color.c} RBratio=${stats.color.rb_ratio?.toFixed(2)}`);
  }
  if (stats.proximity) {
    parts.push(`Prox: ${stats.proximity.distance_cm}cm raw=${stats.proximity.raw}`);
  }
  if (stats.hall) {
    parts.push(`Hall: ${stats.hall.value}`);
  }
  if (stats.cap_prox) {
    parts.push(`CapProx: ${stats.cap_prox.distance_cm}cm raw=${stats.cap_prox.raw}`);
  }
  if (stats.motion) {
    parts.push(`Motion: accel=${stats.motion.accel_mag_mean?.toFixed(3)} var=${stats.motion.accel_mag_var?.toFixed(3)} | gyro=${stats.motion.gyro_mag_mean?.toFixed(4)} var=${stats.motion.gyro_mag_var?.toFixed(4)}`);
  }
  if (inference.activity && inference.activity.activity) {
    parts.push(`Activity: ${inference.activity.activity} (${inference.activity.confidence?.toFixed(2)})`);
  }
  if (stats.attention) {
    parts.push(`Attention: ${stats.attention.availability} (${stats.attention.confidence})`);
  }
  if (stats.screen) {
    parts.push(`Screen: ${stats.screen.screen_on ? 'on' : 'off'}${stats.screen.locked ? ' locked' : ''}`);
  }
  if (stats.sleep) {
    parts.push(`Sleep: ${(stats.sleep.sleep_probability*100).toFixed(0)}% (${stats.sleep.label})`);
  }
  return parts.join(' | ');
}

// Print summary every 10 seconds
setInterval(() => {
  const stats = computeStats();
  console.log(`[${new Date().toISOString()}] ${formatStats(stats)}`);
}, 10000);

// Global stale check
setInterval(() => {
  const now = Date.now();
  for (const sub of subscriptions) {
    if (now - sub.lastDataTime() > STALE_TIMEOUT_MS) {
      console.log(`[STALE] ${sub.uri} no data for ${now - sub.lastDataTime()}ms → reconnecting`);
      sub.scheduleReconnect();
    }
  }
}, 30000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down VAGUS daemon...');
  for (const sub of subscriptions) {
    try { sub.proc.kill('SIGTERM'); } catch (e) {}
  }
  process.exit(0);
});
process.on('SIGTERM', () => {
  for (const sub of subscriptions) {
    try { sub.proc.kill('SIGTERM'); } catch (e) {}
  }
  process.exit(0);
});

console.log('🚀 VAGUS Raw Sensor Daemon (sub-only) started');
console.log('All data via subscription (no reads → no rate limits)');

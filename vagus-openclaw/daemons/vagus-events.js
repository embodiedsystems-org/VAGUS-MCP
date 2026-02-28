#!/usr/bin/env node
/**
 * VAGUS Raw Sensor Daemon with Event Detection
 *
 * Subscriptions-only. Tracks state and logs significant transitions
 * that could indicate somatic patterns or attentional shifts.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BASE_DIR = '/usr/local/lib/node_modules/openclaw/skills/vagus/scripts';
const EVENT_CSV_PATH = '/data/.openclaw/workspace/vagus_events.csv';

// Reconnection settings
const RECONNECT_INITIAL_MS = 5000;
const RECONNECT_MAX_MS = 300000;
const STALE_TIMEOUT_MS = 90000;

const subscriptions = [];

// Initialize event CSV if not exists
if (!fs.existsSync(EVENT_CSV_PATH)) {
  const header = [
    'timestamp',
    'event_type',
    'old_value',
    'new_value',
    'source_uri',
    'confidence'
  ].join(',') + '\n';
  fs.writeFileSync(EVENT_CSV_PATH, header);
  console.log(`[INIT] Created event CSV at ${EVENT_CSV_PATH}`);
}

// Helper: log event to CSV immediately
function logEvent(type, oldVal, newVal, sourceUri, confidence = '') {
  const ts = Date.now();
  const row = [
    ts,
    type,
    JSON.stringify(oldVal),
    JSON.stringify(newVal),
    sourceUri,
    confidence
  ].join(',') + '\n';
  try {
    fs.appendFileSync(EVENT_CSV_PATH, row);
  } catch (e) {
    console.error(`[EVENT CSV ERROR] ${e.message}`);
  }
}

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

  const subObj = {
    uri,
    lastDataTime: () => lastDataTime,
    scheduleReconnect
  };
  subscriptions.push(subObj);

  spawnSubscription();
}

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
  console.log('Shutting down VAGUS events daemon...');
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

// Rolling buffers
const BUFFER_SIZE = 600;
const buffers = { magnet: [], light: [], orientation: [], color: [], proximity: [] };
const inference = { attention: null, screen: null, sleep: null };

// Remember previous state to detect transitions
let prev = {
  proximity: null,
  screen: null,
  attention: null,
  sleepLabel: null
};

const subs = [];

function startSubscription(uri, handler) {
  const proc = spawn('node', [BASE_DIR + '/vagus-connect.js', 'subscribe', uri], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.on('error', (err) => {
    console.error(`Failed to start subscription to ${uri}: ${err.message}`);
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
      }
    }
  });

  proc.stderr.on('data', () => {});
  subs.push(proc);
  return proc;
}

// Raw sensors
startSubscription('vagus://io/type_2', (d) => {
  if (d.values?.length >= 3) {
    buffers.magnet.push({ x: d.values[0], y: d.values[1], z: d.values[2], ts: d.ts });
    if (buffers.magnet.length > BUFFER_SIZE) buffers.magnet.shift();
  }
});

startSubscription('vagus://io/type_5', (d) => {
  if (d.values?.length >= 3) {
    buffers.light.push({ ch0: d.values[0], ch1: d.values[1], ch2: d.values[2], ts: d.ts });
    if (buffers.light.length > BUFFER_SIZE) buffers.light.shift();
  }
});

startSubscription('vagus://io/type_3', (d) => {
  if (d.values?.length >= 3) {
    buffers.orientation.push({ az: d.values[0], pitch: d.values[1], roll: d.values[2], ts: d.ts });
    if (buffers.orientation.length > BUFFER_SIZE) buffers.orientation.shift();
  }
});

startSubscription('vagus://io/type_65554', (d) => {
  if (d.values?.length >= 4) {
    buffers.color.push({ channels: d.values.slice(0,4), ts: d.ts });
    if (buffers.color.length > BUFFER_SIZE) buffers.color.shift();
  }
});

startSubscription('vagus://io/type_8', (d) => {
  if (d.values?.length >= 1) {
    buffers.proximity.push({ dist: d.values[0], raw: d.values[1] ?? null, ts: d.ts });
    if (buffers.proximity.length > BUFFER_SIZE) buffers.proximity.shift();
  }
});

// Inferences
startSubscription('vagus://inference/attention', (d) => {
  const old = inference.attention;
  inference.attention = d;
  if (old?.availability !== d.availability) {
    console.log(`[EVENT] Attention: ${old?.availability} → ${d.availability} (conf: ${d.confidence})`);
    logEvent('attention', { availability: old?.availability, confidence: old?.confidence },
             { availability: d.availability, confidence: d.confidence },
             'vagus://inference/attention', d.confidence);
  }
});

startSubscription('vagus://device/screen', (d) => {
  const old = inference.screen;
  inference.screen = d;
  if (old?.screen_on !== d.screen_on || old?.locked !== d.locked) {
    console.log(`[EVENT] Screen: ${old?.screen_on ? 'on' : 'off'}${old?.locked ? ' locked' : ''} → ${d.screen_on ? 'on' : 'off'}${d.locked ? ' locked' : ''}`);
    logEvent('screen', { screen_on: old?.screen_on, locked: old?.locked },
             { screen_on: d.screen_on, locked: d.locked },
             'vagus://device/screen');
  }
});

startSubscription('vagus://inference/sleep_likelihood', (d) => {
  const oldLabel = inference.sleep?.label;
  inference.sleep = d;
  if (d.label !== oldLabel) {
    console.log(`[EVENT] Sleep: ${oldLabel} → ${d.label} (prob: ${(d.sleep_probability*100).toFixed(0)}%)`);
    logEvent('sleep', { label: oldLabel, probability: inference.sleep?.sleep_probability },
             { label: d.label, probability: d.sleep_probability },
             'vagus://inference/sleep_likelihood');
  }
});

// Detect events on proximity (phone picked up / put down)
setInterval(() => {
  if (buffers.proximity.length >= 2) {
    const last = buffers.proximity[buffers.proximity.length-1];
    const prevVal = prev.proximity;
    if (prevVal !== null) {
      const delta = last.dist - prevVal;
      if (Math.abs(delta) > 20) {
        console.log(`[EVENT] Proximity jump: ${prevVal}cm → ${last.dist}cm (raw: ${last.raw})`);
        logEvent('proximity_jump', { dist: prevVal, raw: prev.proximity_raw },
                 { dist: last.dist, raw: last.raw },
                 'vagus://io/type_8');
      }
    }
    prev.proximity = last.dist;
    prev.proximity_raw = last.raw;
  }
}, 1000);

// Detect magnetometer heading shifts (rotation)
setInterval(() => {
  if (buffers.magnet.length >= 2) {
    const last = buffers.magnet[buffers.magnet.length-1];
    const prevVal = prev.magnet ? buffers.magnet[buffers.magnet.length-2] : null;
    if (prevVal) {
      const headingNow = Math.atan2(last.y, last.x) * (180/Math.PI);
      const headingPrev = Math.atan2(prevVal.y, prevVal.x) * (180/Math.PI);
      const delta = Math.abs(headingNow - headingPrev);
      if (delta > 45) {
        console.log(`[EVENT] Heading shift: ${headingPrev.toFixed(1)}° → ${headingNow.toFixed(1)}° (Δ${delta.toFixed(1)}°)`);
        logEvent('heading_shift', { heading: headingPrev }, { heading: headingNow }, 'vagus://io/type_2');
      }
    }
  }
  prev.magnet = buffers.magnet[buffers.magnet.length-2] || null;
}, 2000);

// Detect light level changes > 2 lx
setInterval(() => {
  if (buffers.light.length >= 2) {
    const lastCh0 = buffers.light[buffers.light.length-1].ch0;
    const prevCh0 = buffers.light[buffers.light.length-2].ch0;
    if (Math.abs(lastCh0 - prevCh0) > 2) {
      console.log(`[EVENT] Light change: ${prevCh0.toFixed(1)}lx → ${lastCh0.toFixed(1)}lx`);
      logEvent('light_change', { ch0: prevCh0 }, { ch0: lastCh0 }, 'vagus://io/type_5');
    }
  }
}, 2000);

// Periodic summary (every 30s now, includes sample counts)
setInterval(() => {
  const stats = {
    magnet_samples: buffers.magnet.length,
    light_samples: buffers.light.length,
    orient_samples: buffers.orientation.length,
    color_samples: buffers.color.length,
    prox_samples: buffers.proximity.length,
    bufFull: Object.values(buffers).some(b => b.length >= BUFFER_SIZE * 0.9)
  };
  console.log(`[SUMMARY] Buffers: ${JSON.stringify(stats)}`);
}, 30000);

console.log('🚀 VAGUS Event Detection Daemon started');
console.log('Listening for transitions...');

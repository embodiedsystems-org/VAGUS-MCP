#!/usr/bin/env node
/**
 * VAGUS CSV Logger
 *
 * Subscribes to all relevant streams and appends timestamped rows to a CSV file.
 * Designed for long-term data capture for somatic correlation analysis.
 */

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const BASE_DIR = path.join(os.homedir(), '.openclaw', 'skills', 'vagus', 'scripts');

// Reconnection settings
const RECONNECT_INITIAL_MS = 5000;
const RECONNECT_MAX_MS = 300000;
const STALE_TIMEOUT_MS = 90000; // Used by global stale check
const FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes: max age for data to be considered "fresh" for CSV writes

// Critical raw I/O URIs that must be fresh before emitting a row
const CRITICAL_URIS = [
  'vagus://io/type_2',   // magnetometer
  'vagus://io/type_5',   // light
  'vagus://io/type_3',   // orientation
  'vagus://io/type_65554', // color
  'vagus://io/type_8'    // proximity
];

const subscriptions = [];

const CSV_PATH = '/data/.openclaw/workspace/vagus_log.csv';
const HEADERS = [
  'timestamp',
  // Raw sensors
  'magnet_x', 'magnet_y', 'magnet_z',
  'light_ch0', 'light_ch1', 'light_ch2',
  'orient_az', 'orient_pitch', 'orient_roll',
  'color_r', 'color_g', 'color_b', 'color_c',
  'prox_dist', 'prox_raw',
  // Inferences
  'attention_availability', 'attention_confidence',
  'screen_on', 'screen_locked',
  'sleep_probability', 'sleep_label',
  // Motion raw (IMU)
  'motion_ax', 'motion_ay', 'motion_az',
  'motion_gx', 'motion_gy', 'motion_gz',
  // Activity classification (high-level)
  'activity_name', 'activity_confidence'
];

// Initialize CSV if not exists
if (!fs.existsSync(CSV_PATH)) {
  fs.writeFileSync(CSV_PATH, HEADERS.join(',') + '\n');
  console.log(`[INIT] Created CSV at ${CSV_PATH}`);
}

// Latest values (snapshot)
const latest = {};

// Buffers to keep most recent for fallback (in case some streams lag)
const buffs = {
  magnet: null,
  light: null,
  orient: null,
  color: null,
  prox: null
};

function startSubscription(uri, handler) {
  // State object that we'll expose for control
  const subObj = {
    uri,
    retryCount: 0,
    retryTimer: null,
    proc: null,
    lastDataTime: Date.now(),
    ignoreExit: false
  };

  function cleanup() {
    if (subObj.retryTimer) clearTimeout(subObj.retryTimer);
    subObj.retryTimer = null;
  }

  function spawnSubscription(resetBackoff = false) {
    if (resetBackoff) {
      subObj.retryCount = 0;
    }
    if (subObj.proc && !subObj.proc.killed) {
      try { subObj.proc.kill('SIGTERM'); } catch (e) {}
    }

    subObj.proc = spawn('node', [BASE_DIR + '/vagus-connect.js', 'subscribe', uri], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    subObj.proc.on('error', (err) => {
      console.error(`[${uri}] Failed to start: ${err.message}`);
      scheduleReconnect();
    });

    subObj.proc.on('exit', (code, signal) => {
      if (subObj.ignoreExit) {
        subObj.ignoreExit = false;
        return;
      }
      console.log(`[${uri}] Subscription exited (code=${code}, signal=${signal})`);
      scheduleReconnect();
    });

    subObj.proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }

        if (msg.type === 'update' && msg.data) {
          subObj.lastDataTime = Date.now();
          subObj.retryCount = 0;
          cleanup();
          handler(msg.data);
        }
      }
    });

    subObj.proc.stderr.on('data', () => {});
  }

  function scheduleReconnect() {
    cleanup();
    const delay = Math.min(RECONNECT_INITIAL_MS * Math.pow(2, subObj.retryCount), RECONNECT_MAX_MS);
    subObj.retryCount++;
    console.log(`[RECONNECT] ${uri} in ${delay}ms (attempt ${subObj.retryCount})`);
    subObj.retryTimer = setTimeout(() => {
      spawnSubscription(false);
    }, delay);
  }

  subObj.forceReconnect = function() {
    // Immediate restart, resetting backoff and suppressing exit handler rescheduling
    cleanup();
    subObj.ignoreExit = true;
    if (subObj.proc && !subObj.proc.killed) {
      try { subObj.proc.kill('SIGTERM'); } catch (e) {}
    }
    subObj.retryCount = 0;
    spawnSubscription(false); // false: don't reset backoff again (already set)
  };

  subscriptions.push(subObj);

  spawnSubscription(false);
}

// Raw sensors
startSubscription('vagus://io/type_2', (d) => {
  if (d.values?.length >= 3) {
    buffs.magnet = { x: d.values[0], y: d.values[1], z: d.values[2] };
  }
});

startSubscription('vagus://io/type_5', (d) => {
  if (d.values?.length >= 3) {
    buffs.light = { ch0: d.values[0], ch1: d.values[1], ch2: d.values[2] };
  }
});

startSubscription('vagus://io/type_3', (d) => {
  if (d.values?.length >= 3) {
    buffs.orient = { az: d.values[0], pitch: d.values[1], roll: d.values[2] };
  }
});

startSubscription('vagus://io/type_65554', (d) => {
  if (d.values?.length >= 4) {
    buffs.color = { r: d.values[0], g: d.values[1], b: d.values[2], c: d.values[3] };
  }
});

startSubscription('vagus://io/type_8', (d) => {
  if (d.values?.length >= 1) {
    buffs.prox = { dist: d.values[0], raw: d.values[1] ?? null };
  }
});

// Inferences
startSubscription('vagus://inference/attention', (d) => {
  latest.attention_availability = d.availability;
  latest.attention_confidence = d.confidence;
});

startSubscription('vagus://device/screen', (d) => {
  latest.screen_on = d.screen_on ? 1 : 0;
  latest.screen_locked = d.locked ? 1 : 0;
});

startSubscription('vagus://inference/sleep_likelihood', (d) => {
  latest.sleep_probability = d.sleep_probability;
  latest.sleep_label = d.label;
});

// Motion sensor (raw IMU)
startSubscription('vagus://sensors/motion', (d) => {
  latest.motion_ax = d.ax;
  latest.motion_ay = d.ay;
  latest.motion_az = d.az;
  latest.motion_gx = d.gx;
  latest.motion_gy = d.gy;
  latest.motion_gz = d.gz;
});

// Activity classification (high-level)
startSubscription('vagus://sensors/activity', (d) => {
  latest.activity_name = d.activity;
  latest.activity_confidence = d.confidence;
});

// CSV flush every 10 seconds (batch writes to reduce I/O)
setInterval(() => {
  const now = Date.now();

  // Check freshness of critical raw I/O subscriptions
  const staleCriticalURIs = subscriptions.filter(sub => {
    if (!CRITICAL_URIS.includes(sub.uri)) return false;
    return now - sub.lastDataTime > FRESHNESS_THRESHOLD_MS;
  }).map(sub => sub.uri);

  // Also check if any critical buffer is still null (no data ever received)
  const missingBuffers = [];
  if (!buffs.magnet) missingBuffers.push('magnet');
  if (!buffs.light) missingBuffers.push('light');
  if (!buffs.orient) missingBuffers.push('orient');
  if (!buffs.color) missingBuffers.push('color');
  if (!buffs.prox) missingBuffers.push('prox');

  if (staleCriticalURIs.length > 0 || missingBuffers.length > 0) {
    const reasons = [];
    if (staleCriticalURIs.length) reasons.push(`stale (${staleCriticalURIs.join(', ')})`);
    if (missingBuffers.length) reasons.push(`missing buffers (${missingBuffers.join(', ')})`);
    console.warn(`[FLUSH SKIP] Incomplete data: ${reasons.join('; ')}`);
    return;
  }

  // Use latest buffered raw values (may be up to a few seconds old, but we verified freshness above)
  const row = [
    now,
    // magnet
    buffs.magnet?.x ?? '', buffs.magnet?.y ?? '', buffs.magnet?.z ?? '',
    // light
    buffs.light?.ch0 ?? '', buffs.light?.ch1 ?? '', buffs.light?.ch2 ?? '',
    // orient
    buffs.orient?.az ?? '', buffs.orient?.pitch ?? '', buffs.orient?.roll ?? '',
    // color
    buffs.color?.r ?? '', buffs.color?.g ?? '', buffs.color?.b ?? '', buffs.color?.c ?? '',
    // prox
    buffs.prox?.dist ?? '', buffs.prox?.raw ?? '',
    // inferences
    latest.attention_availability ?? '',
    latest.attention_confidence ?? '',
    latest.screen_on ?? '',
    latest.screen_locked ?? '',
    latest.sleep_probability ?? '',
    latest.sleep_label ?? '',
    latest.motion_ax ?? '',
    latest.motion_ay ?? '',
    latest.motion_az ?? '',
    latest.motion_gx ?? '',
    latest.motion_gy ?? '',
    latest.motion_gz ?? '',
    // legacy motion fields (kept for backward compatibility, may be empty)
    latest.motion_activity ?? '',
    latest.motion_confidence ?? '',
    // activity classification
    latest.activity_name ?? '',
    latest.activity_confidence ?? ''
  ];
  const line = row.map(v => v === '' ? '' : v).join(',') + '\n';
  try {
    fs.appendFileSync(CSV_PATH, line);
  } catch (e) {
    console.error(`[CSV ERROR] ${e.message}`);
  }
}, 10000);

// Global stale check: force immediate reconnect for any subscription that hasn't sent data recently
setInterval(() => {
  const now = Date.now();
  for (const sub of subscriptions) {
    const stalledMs = now - sub.lastDataTime;
    if (stalledMs > STALE_TIMEOUT_MS) {
      console.log(`[STALE] ${sub.uri} no data for ${stalledMs}ms → forcing immediate reconnect`);
      sub.forceReconnect();
    }
  }
}, 30000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down VAGUS logger...');
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

console.log(`📊 VAGUS CSV Logger started`);
console.log(`Logging to: ${CSV_PATH}`);
console.log('Subscribing to raw I/O + inference streams');

#!/usr/bin/env node
/**
 * VAGUS CSV Logger
 *
 * Subscribes to all relevant streams and appends timestamped rows to a CSV file.
 * Designed for long-term data capture for somatic correlation analysis.
 */

const { spawn } = require('child_process');
const BASE_DIR = '/usr/local/lib/node_modules/openclaw/skills/vagus/scripts';
const fs = require('fs');
const path = require('path');

// Reconnection settings
const RECONNECT_INITIAL_MS = 5000;
const RECONNECT_MAX_MS = 300000;
const STALE_TIMEOUT_MS = 90000;

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
  const ts = Date.now();
  // Use latest buffered raw values (may be up to a few seconds old)
  const row = [
    ts,
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

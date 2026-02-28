#!/usr/bin/env node
/**
 * VAGUS Baseline Context Daemon
 *
 * Subscribes to high-level inference streams to maintain ongoing context
 * about user state, activity, environment, and location. Acts as the
 * "autonomic" layer that monitors for notable transitions.
 *
 * When something interesting is detected, it can spawn the focused
 * sensing daemon to capture raw sensor data for deeper analysis.
 */

const { spawn } = require('child_process');
const BASE_DIR = '/usr/local/lib/node_modules/openclaw/skills/vagus/scripts';
const FOCUSED_DAEMON_PATH = '/data/.openclaw/workspace/vagus-focused.js';

const RECONNECT_INITIAL_MS = 5000;
const RECONNECT_MAX_MS = 300000;
const STALE_TIMEOUT_MS = 90000;

const subscriptions = [];
let focusedProc = null;

function startSubscription(uri, handler, opts = {}) {
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
          handler(msg.data, uri);
        } else if (msg.type === 'subscribed') {
          console.log(`✅ Subscribed to ${uri}`);
        } else if (msg.type === 'error') {
          console.error(`[${uri}] Error: ${msg.message}`);
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
  return proc;
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
  console.log('Shutting down baseline daemon...');
  subscriptions.forEach(sub => {
    try { sub.proc.kill('SIGTERM'); } catch (e) {}
  });
  if (focusedProc) {
    try { focusedProc.kill('SIGTERM'); } catch (e) {}
  }
  process.exit(0);
});
process.on('SIGTERM', () => {
  subscriptions.forEach(sub => {
    try { sub.proc.kill('SIGTERM'); } catch (e) {}
  });
  if (focusedProc) {
    try { focusedProc.kill('SIGTERM'); } catch (e) {}
  }
  process.exit(0);
});

// State tracking
let lastState = {
  attention: null,
  activity: null,
  environment: null,
  location: null,
  motion: null,
  battery: null,
  connectivity: null
};

// Event detection thresholds
const ATTENTION_DROP_CONFIDENCE = 0.6; // lower to catch more
const ACTIVITY_CHANGE = true;
const ENVIRONMENT_CHANGE = true;
const BATTERY_CHANGE_PCT = 10; // trigger if battery changes by >10%
const CONNECTIVITY_CHANGE = true;

// Recent history for anomaly detection
const HISTORY_WINDOW = 30; // samples
const buffers = {
  motionAccelVar: [],
  magnetHeadingVar: []
};

function avg(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }
function variance(arr) {
  const m = avg(arr);
  return arr.reduce((a,b)=>a+(b-m)**2,0)/arr.length;
}

// Anomaly detection: if motion variance suddenly spikes or magnet variance jumps
function checkAnomalies() {
  if (buffers.motionAccelVar.length < HISTORY_WINDOW) return false;
  const recent = buffers.motionAccelVar.slice(-HISTORY_WINDOW);
  const base = avg(recent);
  const std = Math.sqrt(variance(recent));
  // If latest variance is >3 std above mean, consider it anomalous
  const latest = recent[recent.length-1];
  if (latest > base + 3*std) {
    console.log(`[ANOMALY] Motion accel variance spike: ${latest.toFixed(4)} (base ${base.toFixed(4)}+${(3*std).toFixed(4)})`);
    return true;
  }
  return false;
}

function shouldTriggerFocusedSensing(type, data, prev) {
  switch (type) {
    case 'attention':
      return data.availability === 'unavailable' && data.confidence >= ATTENTION_DROP_CONFIDENCE;
    case 'activity':
      return ACTIVITY_CHANGE && prev && prev.activity !== data.activity;
    case 'environment':
      return ENVIRONMENT_CHANGE && prev && prev.context !== data.context;
    case 'battery':
      if (!prev) return false;
      const delta = Math.abs(data.level - prev.level);
      return delta >= BATTERY_CHANGE_PCT;
    case 'connectivity':
      return CONNECTIVITY_CHANGE && prev && JSON.stringify(prev) !== JSON.stringify(data);
    case 'motion':
      // track accel variance from aggregator summary? We'll capture from motion stream itself if needed
      return false;
    default:
      return false;
  }
}

function startFocusedSensing(durationMs = 60000) {
  if (focusedProc && !focusedProc.killed) {
    console.log('[FOCUS] Already running, extending...');
    try { focusedProc.kill('SIGTERM'); } catch (e) {}
  }
  console.log(`[FOCUS] Starting raw sensor capture for ${durationMs/1000}s`);
  focusedProc = spawn('node', [FOCUSED_DAEMON_PATH, '--duration', durationMs.toString()], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  focusedProc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`[FOCUS] ${line}`);
    }
  });

  focusedProc.stderr.on('data', (data) => {
    console.error(`[FOCUS-ERR] ${data.toString().trim()}`);
  });

  focusedProc.on('exit', (code, signal) => {
    console.log(`[FOCUS] Raw sensor capture exited (code=${code}, signal=${signal})`);
    focusedProc = null;
  });
}

// Subscription handlers
startSubscription('vagus://inference/attention', (data, uri) => {
  const old = lastState.attention;
  lastState.attention = data;
  if (old?.availability !== data.availability) {
    console.log(`[EVENT] Attention: ${old?.availability} → ${data.availability} (conf: ${data.confidence})`);
    if (shouldTriggerFocusedSensing('attention', data, old)) {
      console.log('[TRIGGER] Attention drop detected → starting focused sensing');
      startFocusedSensing(60000); // capture 60s of raw data
    }
  }
});

startSubscription('vagus://sensors/activity', (data, uri) => {
  const old = lastState.activity;
  lastState.activity = data;
  if (old?.activity !== data.activity) {
    console.log(`[EVENT] Activity: ${old?.activity} → ${data.activity} (conf: ${data.confidence})`);
    if (shouldTriggerFocusedSensing('activity', data, old)) {
      console.log('[TRIGGER] Activity change → starting focused sensing');
      startFocusedSensing(60000);
    }
  }
});

startSubscription('vagus://sensors/environment', (data, uri) => {
  const old = lastState.environment;
  lastState.environment = data;
  if (old?.context !== data.context) {
    console.log(`[EVENT] Environment: ${old?.context} → ${data.context} (conf: ${data.confidence})`);
    if (shouldTriggerFocusedSensing('environment', data, old)) {
      console.log('[TRIGGER] Environment change → starting focused sensing');
      startFocusedSensing(60000);
    }
  }
});

startSubscription('vagus://sensors/location', (data, uri) => {
  const old = lastState.location;
  lastState.location = data;
  // Could trigger on significant location change (e.g., >100m)
});

startSubscription('vagus://sensors/motion', (data, uri) => {
  const old = lastState.motion;
  lastState.motion = data;
  // Track accel variance for anomaly detection
  if (data.accel_mag_var !== undefined) {
    buffers.motionAccelVar.push(data.accel_mag_var);
    if (buffers.motionAccelVar.length > 300) buffers.motionAccelVar.shift();
  }
});

startSubscription('vagus://device/battery', (data, uri) => {
  const old = lastState.battery;
  lastState.battery = data;
  if (old && Math.abs(data.level - old.level) >= BATTERY_CHANGE_PCT) {
    console.log(`[EVENT] Battery: ${old.level}% → ${data.level}% (charging: ${data.charging})`);
    if (shouldTriggerFocusedSensing('battery', data, old)) {
      console.log('[TRIGGER] Battery change → starting focused sensing');
      startFocusedSensing(60000);
    }
  }
});

startSubscription('vagus://device/connectivity', (data, uri) => {
  const old = lastState.connectivity;
  lastState.connectivity = data;
  if (old && (old.connected !== data.connected || old.type !== data.type)) {
    console.log(`[EVENT] Connectivity: ${old.type} (${old.connected}) → ${data.type} (${data.connected})`);
    if (shouldTriggerFocusedSensing('connectivity', data, old)) {
      console.log('[TRIGGER] Connectivity change → starting focused sensing');
      startFocusedSensing(60000);
    }
  }
});

// Periodic anomaly check + summary
setInterval(() => {
  // Check for motion variance anomaly
  if (buffers.motionAccelVar.length >= HISTORY_WINDOW && focusedProc === null) {
    if (checkAnomalies()) {
      console.log('[ANOMALY] Triggering focused sensing due to motion variance spike');
      startFocusedSensing(60000);
    }
  }

  // Periodic status summary
  const now = new Date().toISOString();
  const summary = {
    ts: now,
    attention: lastState.attention?.availability,
    activity: lastState.activity?.activity,
    environment: lastState.environment?.context,
    location: lastState.location ? 'present' : null,
    battery: lastState.battery ? `${lastState.battery.level}%` : null,
    connectivity: lastState.connectivity ? `${lastState.connectivity.type}/${lastState.battery.connected}` : null,
    focused: focusedProc ? 'active' : 'idle'
  };
  console.log(`[SUMMARY] ${JSON.stringify(summary)}`);
}, 30000);

console.log('🧠 VAGUS Baseline Context Daemon started');
console.log('Monitoring: attention, activity, environment, location, motion, battery, connectivity');
console.log('Focused sensing will spawn on notable transitions.');

#!/usr/bin/env node
/**
 * VAGUS Focused Sensing Daemon
 *
 * Captures raw I/O sensor streams for a limited window when the
 * baseline daemon detects something noteworthy. This provides
 * high-resolution data for deeper analysis.
 *
 * Invocation: node vagus-focused.js --duration <ms> (optional, default 60000)
 */

const { spawn } = require('child_process');
const BASE_DIR = '/usr/local/lib/node_modules/openclaw/skills/vagus/scripts';
const fs = require('fs');
const path = require('path');

// Parse args
const durationMs = parseInt(process.argv.find((_,i) => process.argv[i]==='--duration' && process.argv[i+1]) || '60000', 10) || 60000;

const RECONNECT_INITIAL_MS = 5000;
const RECONNECT_MAX_MS = 300000;
const STALE_TIMEOUT_MS = 90000;

const subscriptions = [];
const rawDataBuffer = [];
const BUFFER_MAX = 10000; // keep up to 10k samples in memory

function startSubscription(uri) {
  let retryCount = 0;
  let retryTimer = null;
  let proc = null;
  let lastDataTime = Date.now();

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
          handleUpdate(uri, msg.data);
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

// Collect raw updates into buffer
function handleUpdate(uri, data) {
  const entry = {
    ts: data.ts || Date.now(),
    uri,
    data
  };
  rawDataBuffer.push(entry);
  if (rawDataBuffer.length > BUFFER_MAX) {
    rawDataBuffer.shift();
  }
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

// Graceful shutdown: flush buffer to JSONL file
function shutdown() {
  console.log('[FOCUS] Shutting down, flushing buffer...');
  const outPath = `/data/.openclaw/workspace/focused_${Date.now()}.jsonl`;
  const lines = rawDataBuffer.map(entry => JSON.stringify(entry));
  try {
    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    console.log(`[FOCUS] Wrote ${rawDataBuffer.length} samples to ${outPath}`);
  } catch (e) {
    console.error(`[FOCUS] Failed to write buffer: ${e.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Time limit: exit after durationMs
setTimeout(() => {
  console.log(`[FOCUS] Duration (${durationMs}ms) elapsed, exiting.`);
  shutdown();
}, durationMs);

// Start all raw I/O subscriptions
startSubscription('vagus://io/type_2');
startSubscription('vagus://io/type_5');
startSubscription('vagus://io/type_3');
startSubscription('vagus://io/type_65554');
startSubscription('vagus://io/type_8');

console.log(`📡 VAGUS Focused Sensing Daemon started`);
console.log(`Capturing raw I/O for ${durationMs/1000} seconds`);
console.log(`Buffer limit: ${BUFFER_MAX} samples`);

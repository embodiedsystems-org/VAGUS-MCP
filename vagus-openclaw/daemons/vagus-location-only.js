#!/usr/bin/env node
/**
 * VAGUS Location-Only Daemon
 *
 * Subscribes to vagus://sensors/location for a limited window.
 * Prints raw updates to stdout (JSONL).
 * Must be run after a successful pairing (session file exists).
 *
 * Note: The VAGUS app must grant Location permission.
 * Either ACCESS_FINE_LOCATION or ACCESS_COARSE_LOCATION is sufficient.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DURATION_MS = 30000; // 30 seconds
const BASE_DIR = path.join(os.homedir(), '.openclaw', 'skills', 'vagus', 'scripts');

// Check for session file
const SESSION_PATH = path.join(os.homedir(), '.openclaw', 'vagus-session.json');
if (!fs.existsSync(SESSION_PATH)) {
  console.error('[ERROR] No VAGUS session found. Please run pairing first.');
  process.exit(1);
}

let proc = null;
let startTime = Date.now();

function spawnSubscription() {
  proc = spawn('node', [BASE_DIR + '/vagus-connect.js', 'subscribe', 'vagus://sensors/location'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.on('error', (err) => {
    console.error(`[ERROR] Failed to start subscription: ${err.message}`);
    setTimeout(shutdown, 1000);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[INFO] Subscription exited (code=${code}, signal=${signal})`);
    // If not time's up, try to reconnect once
    if (Date.now() - startTime < DURATION_MS - 5000) {
      console.log('[INFO] Reconnecting...');
      setTimeout(spawnSubscription, 2000);
    } else {
      shutdown();
    }
  });

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'error' && msg.message && msg.message.includes('ACCESS_FINE_LOCATION')) {
          console.error('[HINT] Enable Location permission in VAGUS app (Access coarse location is sufficient).');
        }
      } catch (e) {}
      process.stdout.write(line + '\n');
    }
  });

  proc.stderr.on('data', (data) => {
    // Suppress stderr noise; uncomment for debugging
    // console.error(`[STDERR] ${data.toString().trim()}`);
  });
}

function shutdown() {
  if (proc && !proc.killed) {
    try { proc.kill('SIGTERM'); } catch (e) {}
  }
  console.log(`[INFO] Location daemon finished after ${((Date.now() - startTime)/1000).toFixed(1)}s`);
  process.exit(0);
}

// Duration timeout
setTimeout(shutdown, DURATION_MS);

// Handle signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start
spawnSubscription();

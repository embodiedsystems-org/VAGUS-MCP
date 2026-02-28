#!/usr/bin/env node
/**
 * VAGUS Notifications Logger
 *
 * Subscribes to vagus://device/notifications and logs each incoming
 * notification to a separate file with timestamp and sensor context.
 */

const { spawn } = require('child_process');
const BASE_DIR = '/usr/local/lib/node_modules/openclaw/skills/vagus/scripts';
const fs = require('fs');
const path = require('path');

const LOG_PATH = '/data/.openclaw/workspace/notifications.log';

function startSubscription(uri) {
  const proc = spawn('node', [BASE_DIR + '/vagus-connect.js', 'subscribe', uri], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.on('error', (err) => {
    console.error(`❌ Failed to subscribe to ${uri}: ${err.message}`);
  });

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.type === 'update' && msg.data) {
        const notif = msg.data;
        const entry = {
          ts: Date.now(),
          title: notif.title || '',
          text: notif.text || '',
          package: notif.package || '',
          id: notif.id || ''
        };
        fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
        console.log(`📱 Notification: ${entry.title} — ${entry.text.substring(0, 80)}`);
      } else if (msg.type === 'subscribed') {
        console.log(`✅ Subscribed to ${uri}`);
      } else if (msg.type === 'error') {
        console.error(`[${uri}] ${msg.message}`);
      }
    }
  });

  proc.stderr.on('data', () => {});
  return proc;
}

// Initialize log
if (!fs.existsSync(LOG_PATH)) {
  fs.writeFileSync(LOG_PATH, '');
  console.log(`[INIT] Created notifications log at ${LOG_PATH}`);
}

startSubscription('vagus://device/notifications');
console.log('📊 VAGUS Notifications Logger started');

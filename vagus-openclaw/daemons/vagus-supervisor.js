#!/usr/bin/env node
/**
 * VAGUS Daemon Supervisor
 *
 * Spawns and monitors the three main VAGUS daemons.
 * Auto-restarts any that exit unexpectedly.
 */

const { spawn } = require('child_process');
const workspace = '/data/.openclaw/workspace';

const daemons = [
  { name: 'aggregator', script: 'vagus-daemon.js' },
  { name: 'events', script: 'vagus-events.js' },
  { name: 'logger', script: 'vagus-logger.js' }
];

const processes = new Map();

function start(daemon) {
  const proc = spawn('node', [workspace + '/' + daemon.script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  proc.on('error', (err) => {
    console.error(`[${daemon.name}] spawn error: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[${daemon.name}] exited with code ${code} signal ${signal}`);
    // Auto-restart after short delay
    setTimeout(() => {
      console.log(`[${daemon.name}] restarting...`);
      start(daemon);
    }, 3000);
  });

  proc.stdout.on('data', (data) => {
    // Prefix output with daemon name for clarity
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) console.log(`[${daemon.name}] ${line}`);
    });
  });

  proc.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) console.error(`[${daemon.name}] ${line}`);
    });
  });

  processes.set(daemon.name, proc);
  console.log(`[${daemon.name}] started (pid ${proc.pid})`);
}

// Start all daemons
daemons.forEach(d => start(d));

console.log('✅ VAGUS Daemon Supervisor started');
console.log('Press Ctrl+C to stop all');

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[supervisor] Shutting down all daemons...');
  processes.forEach((proc, name) => {
    console.log(`[${name}] killing...`);
    proc.kill('SIGTERM');
  });
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n[supervisor] Received SIGTERM, exiting...');
  process.exit(0);
});

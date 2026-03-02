#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { SessionStore } = require('./lib/session-store');
const { ManagedSubscriptionSession } = require('./lib/managed-subscription-session');
const { AdaptiveFreshness } = require('./lib/adaptive-freshness');

const DEFAULT_RESOURCES = [
  'vagus://sensors/motion',
  'vagus://sensors/environment',
  'vagus://inference/attention',
  'vagus://inference/notification_timing',
];

const BASE_DIR = __dirname;
const LOG_DIR = path.join(BASE_DIR, 'logs');
const PID_DIR = path.join(BASE_DIR, 'pid');
const LOCK_PATH = path.join(PID_DIR, 'vagus-manager.lock.json');
const STATE_PATH = path.join(PID_DIR, 'vagus-manager.state.json');
const CONTROL_HOST = '127.0.0.1';
const CONTROL_PORT = 31877;
const LEGACY_PID_GLOB = /^vagus___.*\.pid$/;

async function main() {
  ensureDir(LOG_DIR);
  ensureDir(PID_DIR);

  const [command, ...args] = process.argv.slice(2);
  if (isControlCommand(command)) {
    await runControlCommand(command, args);
    return;
  }

  await runManager(command ? [command, ...args] : []);
}

function isControlCommand(command) {
  return ['add', 'remove', 'list', 'status'].includes(command);
}

async function runControlCommand(command, args) {
  let body = {};
  if (command === 'add' || command === 'remove') {
    const uri = args[0];
    if (!uri) {
      console.error(`Usage: node vagus-manager.js ${command} <uri>`);
      process.exit(1);
    }
    body = { uri };
  }

  const pathName = command === 'list' ? '/subscriptions' : command === 'status' ? '/status' : `/subscriptions/${command}`;
  const method = command === 'list' || command === 'status' ? 'GET' : 'POST';
  const response = await requestControl(pathName, method, body);
  process.stdout.write(JSON.stringify(response) + '\n');
}

async function runManager(startupUris) {
  enforceSingleton();
  cleanupLegacyProcesses();

  const store = new SessionStore();
  const saved = store.load();
  if (!saved?.session_token) {
    logManager({ type: 'fatal', message: 'No saved session. Run pair first.' });
    process.exit(1);
  }

  const persisted = loadPersistedUris();
  const initialUris = startupUris.length > 0 ? startupUris : persisted.length > 0 ? persisted : DEFAULT_RESOURCES;
  persistUris(initialUris);

  const managed = new ManagedSubscriptionSession({
    sessionToken: saved.session_token,
    relayUrl: saved.relay_url || 'wss://relay.withvagus.com',
  });

  const streams = new Map();
  for (const uri of initialUris) {
    streams.set(uri, createStreamState());
    await managed.subscribe(uri);
  }

  let shutdownStarted = false;

  managed.onLifecycle((event) => {
    if (event.type === 'transport_closed') {
      for (const stream of streams.values()) {
        stream.freshness.startGrace();
      }
    }

    logManager({ type: 'lifecycle', event });
    writeStateSnapshot(streams);
    if (event.type === 'connected') {
      for (const [uri, stream] of streams) {
        emitStreamState(uri, stream, true);
      }
    }
  });

  managed.onSessionReconnect((payload) => {
    for (const stream of streams.values()) {
      stream.freshness.startGrace();
    }
    logManager({ type: 'session_reconnect', ...payload });
    writeStateSnapshot(streams);
    for (const [uri, stream] of streams) {
      emitStreamState(uri, stream, true);
    }
  });

  managed.onUpdate((uri, data, mcpMeta) => {
    const stream = streams.get(uri);
    if (!stream) {
      return;
    }

    const receivedAt = Date.now();
    const sourceTs = typeof data?.ts === 'number' ? data.ts : null;
    stream.freshness.observe(sourceTs, receivedAt);
    stream.lastData = data;
    stream.lastMcp = mcpMeta || null;

    writeResourceLog(uri, {
      type: 'update',
      uri,
      data,
      freshness: stream.freshness.getStatus(receivedAt),
      mcp: mcpMeta || null,
    });

    emitStreamState(uri, stream, true);
    writeStateSnapshot(streams);
  });

  const interval = setInterval(() => {
    for (const [uri, stream] of streams) {
      emitStreamState(uri, stream, false);
    }
    writeStateSnapshot(streams);
  }, 1000);

  const controlServer = createControlServer({
    streams,
    addUri: async (uri) => {
      if (streams.has(uri)) {
        return { ok: true, changed: false, uri };
      }
      streams.set(uri, createStreamState());
      await managed.subscribe(uri);
      persistUris([...streams.keys()]);
      emitStreamState(uri, streams.get(uri), true);
      writeStateSnapshot(streams);
      logManager({ type: 'subscription_added', uri });
      return { ok: true, changed: true, uri };
    },
    removeUri: async (uri) => {
      if (!streams.has(uri)) {
        return { ok: true, changed: false, uri };
      }
      await managed.unsubscribe(uri);
      streams.delete(uri);
      persistUris([...streams.keys()]);
      writeStateSnapshot(streams);
      logManager({ type: 'subscription_removed', uri });
      return { ok: true, changed: true, uri };
    },
    listUris: () => [...streams.keys()],
    getStatus: () => buildStateSnapshot(streams),
  });

  controlServer.listen(CONTROL_PORT, CONTROL_HOST, () => {
    logManager({
      type: 'control_server_started',
      host: CONTROL_HOST,
      port: CONTROL_PORT,
    });
  });

  await managed.start();

  const shutdown = async () => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    clearInterval(interval);
    controlServer.close();
    await managed.close();
    releaseSingleton();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', releaseSingleton);
}

function createControlServer(handlers) {
  return http.createServer(async (req, res) => {
    try {
      if (req.socket.remoteAddress !== CONTROL_HOST && req.socket.remoteAddress !== '::ffff:127.0.0.1') {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      if (req.method === 'GET' && req.url === '/subscriptions') {
        json(res, 200, { ok: true, subscriptions: handlers.listUris() });
        return;
      }

      if (req.method === 'GET' && req.url === '/status') {
        json(res, 200, { ok: true, status: handlers.getStatus() });
        return;
      }

      if (req.method === 'POST' && req.url === '/subscriptions/add') {
        const body = await readJson(req);
        json(res, 200, await handlers.addUri(body.uri));
        return;
      }

      if (req.method === 'POST' && req.url === '/subscriptions/remove') {
        const body = await readJson(req);
        json(res, 200, await handlers.removeUri(body.uri));
        return;
      }

      json(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message });
    }
  });
}

function emitStreamState(uri, stream, force) {
  const snapshot = stream.freshness.getStatus();
  if (!force && snapshot.status === stream.lastStatus) {
    return;
  }
  stream.lastStatus = snapshot.status;
  writeResourceLog(uri, {
    type: 'stream_state',
    uri,
    status: snapshot.status,
    freshness_ms: snapshot.freshness_ms,
    last_received_at: snapshot.last_received_at,
    last_source_ts: snapshot.last_source_ts,
    thresholds: snapshot.thresholds,
  });
}

function createStreamState() {
  return {
    freshness: new AdaptiveFreshness(),
    lastStatus: null,
    lastData: null,
    lastMcp: null,
  };
}

function buildStateSnapshot(streams) {
  const byUri = {};
  for (const [uri, stream] of streams) {
    byUri[uri] = {
      uri,
      state: stream.freshness.getStatus(),
      last_status: stream.lastStatus,
      last_source_ts: stream.lastData?.ts ?? null,
      last_mcp: stream.lastMcp,
    };
  }
  return {
    updated_at: Date.now(),
    subscriptions: [...streams.keys()],
    streams: byUri,
  };
}

function writeStateSnapshot(streams) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(buildStateSnapshot(streams), null, 2));
}

function loadPersistedUris() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    return Array.isArray(state?.subscriptions) ? state.subscriptions : [];
  } catch (_) {
    return [];
  }
}

function persistUris(uris) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    current = {};
  }
  current.subscriptions = [...new Set(uris)];
  current.updated_at = Date.now();
  fs.writeFileSync(STATE_PATH, JSON.stringify(current, null, 2));
}

async function requestControl(pathName, method, body) {
  const payload = method === 'GET' ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: CONTROL_HOST,
        port: CONTROL_PORT,
        path: pathName,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function enforceSingleton() {
  if (fs.existsSync(LOCK_PATH)) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (lock?.pid && isProcessAlive(lock.pid)) {
        console.error(`VAGUS manager already running with PID ${lock.pid}`);
        process.exit(1);
      }
    } catch (_) {
      // ignore malformed lock and replace it
    }
  }

  fs.writeFileSync(
    LOCK_PATH,
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), started_at: new Date().toISOString() }, null, 2)
  );
}

function releaseSingleton() {
  try {
    if (!fs.existsSync(LOCK_PATH)) {
      return;
    }
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (lock?.pid === process.pid) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch (_) {
    // ignore cleanup failures
  }
}

function cleanupLegacyProcesses() {
  const files = fs.readdirSync(PID_DIR).filter((name) => LEGACY_PID_GLOB.test(name));
  for (const file of files) {
    const fullPath = path.join(PID_DIR, file);
    try {
      const pid = Number(fs.readFileSync(fullPath, 'utf8').trim());
      if (Number.isFinite(pid) && isProcessAlive(pid)) {
        process.kill(pid, 'SIGTERM');
        logManager({ type: 'duplicate_process_detected', pid, file });
      }
    } catch (_) {
      // ignore stale pid content
    }

    try {
      fs.unlinkSync(fullPath);
    } catch (_) {
      // ignore stale pid cleanup failures
    }
  }
}

function writeResourceLog(uri, payload) {
  const name = sanitizeUri(uri);
  fs.appendFileSync(path.join(LOG_DIR, `${name}.log`), JSON.stringify(payload) + '\n');
}

function logManager(payload) {
  fs.appendFileSync(path.join(LOG_DIR, 'manager.out'), JSON.stringify(payload) + '\n');
}

function sanitizeUri(uri) {
  return uri.replace(/[/:]/g, '_');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * VAGUS MCP Client - CLI for OpenClaw agent
 *
 * Usage:
 *   vagus-connect.js pair <code>          Pair with phone via relay
 *   vagus-connect.js connect              Connect using saved session
 *   vagus-connect.js status               Report connection state
 *   vagus-connect.js read <uri>           Read resource, print JSON
 *   vagus-connect.js subscribe <uri>      Stream resource updates (JSONL)
 *   vagus-connect.js unsubscribe <uri>    Stop subscription
 *   vagus-connect.js call <tool> '<json>' Call tool, print result
 *   vagus-connect.js list-resources       List available resources
 *   vagus-connect.js list-tools           List available tools
 *   vagus-connect.js disconnect           Graceful close
 *
 * All output is JSONL (one JSON object per line).
 * Errors: {"type":"error","code":"...","message":"..."}
 */

const { WsTransport } = require('./lib/ws-transport');
const { McpSession } = require('./lib/mcp-session');
const { SessionStore } = require('./lib/session-store');
const { SubscriptionManager } = require('./lib/subscription-manager');
const { ManagedSubscriptionSession } = require('./lib/managed-subscription-session');
const { AdaptiveFreshness } = require('./lib/adaptive-freshness');

const DEFAULT_RELAY = process.env.VAGUS_RELAY_URL || 'wss://relay.withvagus.com';
const DEFAULT_PAIR_ENDPOINT = process.env.VAGUS_PAIR_ENDPOINT || 'https://relay.withvagus.com/pair';

// --- Output helpers ---

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitError(code, message) {
  emit({ type: 'error', code, message });
  process.exit(1);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    emitError('NO_COMMAND', 'Usage: vagus-connect.js <command> [args]');
  }

  const store = new SessionStore();

  switch (command) {
    case 'pair':
      await cmdPair(args[1], store);
      break;
    case 'connect':
      await cmdConnect(store);
      break;
    case 'status':
      await cmdStatus(store);
      break;
    case 'read':
      await cmdRead(args[1], store);
      break;
    case 'subscribe':
      await cmdSubscribe(args[1], store);
      break;
    case 'unsubscribe':
      await cmdUnsubscribe(args[1], store);
      break;
    case 'call':
      await cmdCall(args[1], args[2], store);
      break;
    case 'list-resources':
      await cmdListResources(store);
      break;
    case 'list-tools':
      await cmdListTools(store);
      break;
    case 'disconnect':
      await cmdDisconnect(store);
      break;
    default:
      emitError('UNKNOWN_COMMAND', `Unknown command: ${command}`);
  }
}

// --- pair ---

async function cmdPair(code, store) {
  if (!code) emitError('NO_CODE', 'Usage: vagus-connect.js pair <code>');

  // Step 1: POST code to relay pair endpoint
  let sessionToken;
  try {
    const res = await fetch(DEFAULT_PAIR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.toUpperCase().trim() }),
    });
    if (!res.ok) {
      const body = await res.text();
      emitError('PAIR_FAILED', `Relay returned ${res.status}: ${body}`);
    }
    const data = await res.json();
    sessionToken = data.session_token;
  } catch (err) {
    emitError('PAIR_FAILED', `Cannot reach relay: ${err.message}`);
  }

  // Step 2: Connect WSS and run MCP handshake
  const { session, transport } = await connectAndInitialize(sessionToken);

  // Step 3: Save session
  store.save({
    session_token: sessionToken,
    relay_url: DEFAULT_RELAY,
    paired_at: new Date().toISOString(),
    device_model: session.serverInfo?.device_model || 'unknown',
    vagus_version: session.serverInfo?.vagus_version || 'unknown',
  });

  // Step 4: Emit results
  emit({
    type: 'paired',
    session_token: sessionToken,
    device_model: session.serverInfo?.device_model,
    vagus_version: session.serverInfo?.vagus_version,
  });
  emitCapabilities(session);

  transport.close();
  process.exit(0);
}

// --- connect ---

async function cmdConnect(store) {
  const saved = store.load();
  if (!saved) emitError('NO_SESSION', 'No saved session. Run pair first.');

  const { session, transport } = await connectAndInitialize(saved.session_token);

  emit({
    type: 'connected',
    device_model: session.serverInfo?.device_model,
    vagus_version: session.serverInfo?.vagus_version,
  });
  emitCapabilities(session);

  transport.close();
  process.exit(0);
}

// --- status ---

async function cmdStatus(store) {
  const saved = store.load();
  if (!saved) {
    emit({ type: 'status', connected: false, reason: 'no_session' });
    process.exit(0);
  }

  try {
    const { session, transport } = await connectAndInitialize(saved.session_token);
    const info = await session.readResource('vagus://session/info');
    emit({
      type: 'status',
      connected: true,
      device_model: info?.device_model || session.serverInfo?.device_model,
      active_modules: Array.isArray(info?.active_modules) ? info.active_modules : [],
      vagus_version: info?.vagus_version || session.serverInfo?.vagus_version,
      paired_at: saved.paired_at,
    });
    transport.close();
  } catch (err) {
    emit({
      type: 'status',
      connected: false,
      last_error: err.message,
    });
  }
  process.exit(0);
}

// --- read ---

async function cmdRead(uri, store) {
  if (!uri) emitError('NO_URI', 'Usage: vagus-connect.js read <uri>');

  const saved = store.load();
  if (!saved) emitError('NO_SESSION', 'No saved session. Run pair first.');

  const { session, transport } = await connectAndInitialize(saved.session_token);
  try {
    const result = await session.readResource(uri);
    emit({ type: 'resource', uri, data: result, mcp: session.getLastResponseMeta() });
  } catch (err) {
    emit({ type: 'error', code: 'READ_FAILED', message: err.message, mcp: err.mcp || session.getLastResponseMeta() });
  }
  transport.close();
  process.exit(0);
}

// --- subscribe ---

async function cmdSubscribe(uri, store) {
  if (!uri) emitError('NO_URI', 'Usage: vagus-connect.js subscribe <uri>');

  const saved = store.load();
  if (!saved) emitError('NO_SESSION', 'No saved session. Run pair first.');

  const managed = new ManagedSubscriptionSession({
    sessionToken: saved.session_token,
    relayUrl: saved.relay_url || DEFAULT_RELAY,
  });
  const freshness = new AdaptiveFreshness();
  let lastStatus = null;
  let freshnessTimer = null;

  const emitFreshness = (force = false) => {
    const snapshot = freshness.getStatus();
    if (!force && snapshot.status === lastStatus) {
      return;
    }
    lastStatus = snapshot.status;
    emit({
      type: 'stream_state',
      uri,
      status: snapshot.status,
      freshness_ms: snapshot.freshness_ms,
      last_received_at: snapshot.last_received_at,
      last_source_ts: snapshot.last_source_ts,
      thresholds: snapshot.thresholds,
    });
  };

  managed.onSessionReconnect((payload) => {
    freshness.startGrace();
    emit({
      type: 'session_reconnect',
      sessionId: payload?.sessionId,
      reconnect_seq: payload?.reconnect_seq,
      gap_ms: payload?.gap_ms,
      source: payload?.source,
      ts: payload?.ts,
      trace_id: payload?.trace_id || null,
    });
    emitFreshness(true);
  });

  managed.onLifecycle((event) => {
    if (event.type === 'transport_closed') {
      freshness.startGrace();
      emitFreshness(true);
    }
    emit({ type: 'lifecycle', uri, event });
  });

  managed.onUpdate((updateUri, data, mcpMeta) => {
    if (updateUri !== uri) {
      return;
    }
    const receivedAt = Date.now();
    const sourceTs = typeof data?.ts === 'number' ? data.ts : null;
    freshness.observe(sourceTs, receivedAt);
    emit({
      type: 'update',
      uri: updateUri,
      data,
      freshness: freshness.getStatus(receivedAt),
      mcp: mcpMeta,
    });
    emitFreshness(true);
  });

  await managed.subscribe(uri);
  await managed.start();
  emitFreshness(true);

  freshnessTimer = setInterval(() => {
    emitFreshness(false);
  }, 1000);

  const cleanup = async () => {
    if (freshnessTimer) {
      clearInterval(freshnessTimer);
      freshnessTimer = null;
    }
    await managed.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// --- unsubscribe ---

async function cmdUnsubscribe(uri, store) {
  if (!uri) emitError('NO_URI', 'Usage: vagus-connect.js unsubscribe <uri>');
  // Note: this is a convenience command. In practice, the agent kills
  // the subscribe process (SIGTERM). This command connects fresh and unsubscribes.
  const saved = store.load();
  if (!saved) emitError('NO_SESSION', 'No saved session.');
  const { session, transport } = await connectAndInitialize(saved.session_token);
  await session.unsubscribe(uri);
  emit({ type: 'unsubscribed', uri, mcp: session.getLastResponseMeta() });
  transport.close();
  process.exit(0);
}

// --- call ---

async function cmdCall(toolName, paramsJson, store) {
  if (!toolName) emitError('NO_TOOL', "Usage: vagus-connect.js call <tool> '<json>'");

  const saved = store.load();
  if (!saved) emitError('NO_SESSION', 'No saved session. Run pair first.');

  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch (err) { emitError('BAD_JSON', `Invalid JSON params: ${err.message}`); }
  }

  const { session, transport } = await connectAndInitialize(saved.session_token);
  try {
    const result = await session.callTool(toolName, params);
    emit({ type: 'result', tool: toolName, success: !result.isError, data: result, mcp: session.getLastResponseMeta() });
  } catch (err) {
    emit({ type: 'result', tool: toolName, success: false, error: err.code || 'CALL_FAILED', message: err.message, mcp: err.mcp || session.getLastResponseMeta() });
  }
  transport.close();
  process.exit(0);
}

// --- list-resources ---

async function cmdListResources(store) {
  const saved = store.load();
  if (!saved) emitError('NO_SESSION', 'No saved session.');
  const { session, transport } = await connectAndInitialize(saved.session_token);
  const resources = await session.listResources();
  emit({ type: 'resources', data: resources, mcp: session.getLastResponseMeta() });
  transport.close();
  process.exit(0);
}

// --- list-tools ---

async function cmdListTools(store) {
  const saved = store.load();
  if (!saved) emitError('NO_SESSION', 'No saved session.');
  const { session, transport } = await connectAndInitialize(saved.session_token);
  const tools = await session.listTools();
  emit({ type: 'tools', data: tools, mcp: session.getLastResponseMeta() });
  transport.close();
  process.exit(0);
}

// --- disconnect ---

async function cmdDisconnect(store) {
  store.delete();
  emit({ type: 'disconnected' });
  process.exit(0);
}

// --- Helpers ---

function emitCapabilities(session) {
  emit({
    type: 'capabilities',
    resources: session.resources.map((r) => r.uri),
    tools: session.tools.map((t) => t.name),
  });
}

async function connectAndInitialize(sessionToken) {
  const transport = new WsTransport(`${DEFAULT_RELAY}/connect/${sessionToken}`);
  const session = new McpSession(transport);

  try {
    await transport.connect();
    await session.initialize();
  } catch (err) {
    if (err.code === 'AUTH_FAILED' || err.statusCode === 401 || err.statusCode === 403) {
      emitError('SESSION_EXPIRED', 'Session token rejected. Delete vagus-session.json and re-pair.');
    }
    emitError('CONNECT_FAILED', `Connection failed: ${err.message}`);
  }

  return { session, transport };
}

main().catch((err) => emitError('FATAL', err.message));

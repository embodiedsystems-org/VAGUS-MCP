"use strict";

const crypto = require("crypto");
const http = require("http");
const { URL } = require("url");
const { createClient } = require("redis");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const PAIR_TTL_MS = Number(process.env.PAIR_TTL_MS || 15 * 60 * 1000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 0);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 16 * 1024);
const MAX_MESSAGE_BYTES = Number(process.env.MAX_MESSAGE_BYTES || 1024 * 1024);
const MAX_PAIR_REQUESTS_PER_WINDOW = Number(process.env.MAX_PAIR_REQUESTS_PER_WINDOW || 30);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15_000);
const MAX_PENDING_FOR_APP_BYTES = Number(process.env.MAX_PENDING_FOR_APP_BYTES || MAX_MESSAGE_BYTES);
const RELAY_BUILD = String(process.env.RELAY_BUILD || "dev");
const TRUST_PROXY = String(process.env.TRUST_PROXY || "false").toLowerCase() === "true";
const REQUIRE_ORIGIN = String(process.env.REQUIRE_ORIGIN || "false").toLowerCase() === "true";
const ORIGIN_ALLOWLIST = new Set(
  String(process.env.ORIGIN_ALLOWLIST || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);
const CORS_ALLOW_ORIGIN = String(process.env.CORS_ALLOW_ORIGIN || "");
const REDIS_URL = String(process.env.REDIS_URL || "").trim();
const REDIS_PREFIX = String(process.env.REDIS_PREFIX || "vagus:relay:");
const REQUIRE_REDIS = String(process.env.REQUIRE_REDIS || "false").toLowerCase() === "true";

/** @type {Map<string, RelaySession>} */
const sessionsByToken = new Map();
/** @type {Map<string, RelaySession>} */
const sessionsByCode = new Map();
/** @type {Map<string, { count: number, resetAtMs: number }>} */
const pairRateByIp = new Map();
let redis = null;

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_BYTES
});

/**
 * @typedef {Object} InflightRequest
 * @property {string} clientId
 * @property {string|number|null} originalId
 */

/**
 * @typedef {Object} RelaySession
 * @property {string} code
 * @property {string} token
 * @property {number} createdAtMs
 * @property {number} expiresAtMs
 * @property {import("ws").WebSocket | null} app
 * @property {Map<string, import("ws").WebSocket>} clients
 * @property {WeakMap<import("ws").WebSocket, string>} clientIdsByWs
 * @property {Map<string, InflightRequest>} inflight
 * @property {Array<{ data: Buffer | string, isBinary: boolean, size: number }>} pendingForApp
 * @property {number} pendingForAppBytes
 * @property {boolean} hasAppConnectedEver
 * @property {boolean} hasClientConnectedEver
 * @property {boolean} pinnedAfterPair
 * @property {number | null} appDisconnectedAtMs
 * @property {number | null} lastAppReconnectGapMs
 * @property {number} appReconnectSeq
 */

function now() {
  return Date.now();
}

function persistenceEnabled() {
  return !!redis;
}

function sessionKey(token) {
  return `${REDIS_PREFIX}session:${token}`;
}

function codeKey(code) {
  return `${REDIS_PREFIX}code:${code}`;
}

function ttlSecondsFromMs(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

function persistentSessionTtlMs(session) {
  const remaining = session.expiresAtMs - now();
  return remaining > 0 ? remaining : 1;
}

function persistentModeLabel() {
  return persistenceEnabled() ? "redis" : "memory";
}

function log(level, message, meta) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta || {})
  };
  console.log(JSON.stringify(payload));
}

function toPersistedSession(session) {
  return {
    code: session.code,
    token: session.token,
    createdAtMs: session.createdAtMs,
    expiresAtMs: session.expiresAtMs,
    hasAppConnectedEver: session.hasAppConnectedEver,
    hasClientConnectedEver: session.hasClientConnectedEver,
    pinnedAfterPair: session.pinnedAfterPair,
    appDisconnectedAtMs: session.appDisconnectedAtMs,
    lastAppReconnectGapMs: session.lastAppReconnectGapMs,
    appReconnectSeq: session.appReconnectSeq || 0
  };
}

function toLiveSession(persisted) {
  return {
    code: persisted.code,
    token: persisted.token,
    createdAtMs: persisted.createdAtMs,
    expiresAtMs: persisted.expiresAtMs,
    app: null,
    clients: new Map(),
    clientIdsByWs: new WeakMap(),
    inflight: new Map(),
    pendingForApp: [],
    pendingForAppBytes: 0,
    hasAppConnectedEver: !!persisted.hasAppConnectedEver,
    hasClientConnectedEver: !!persisted.hasClientConnectedEver,
    pinnedAfterPair: !!persisted.pinnedAfterPair,
    appDisconnectedAtMs: typeof persisted.appDisconnectedAtMs === "number" ? persisted.appDisconnectedAtMs : null,
    lastAppReconnectGapMs: typeof persisted.lastAppReconnectGapMs === "number" ? persisted.lastAppReconnectGapMs : null,
    appReconnectSeq: typeof persisted.appReconnectSeq === "number" ? persisted.appReconnectSeq : 0
  };
}

async function saveSessionPersistent(session) {
  if (!persistenceEnabled()) {
    return;
  }
  const payload = JSON.stringify(toPersistedSession(session));
  const ttlMs = persistentSessionTtlMs(session);
  const multi = redis.multi();
  if (session.pinnedAfterPair && SESSION_TTL_MS <= 0) {
    multi.set(sessionKey(session.token), payload);
    multi.del(codeKey(session.code));
  } else {
    const ttlSec = ttlSecondsFromMs(ttlMs);
    multi.set(sessionKey(session.token), payload, { EX: ttlSec });
    multi.set(codeKey(session.code), session.token, { EX: ttlSec });
  }
  await multi.exec();
}

async function deleteSessionPersistent(session) {
  if (!persistenceEnabled()) {
    return;
  }
  await redis.del(sessionKey(session.token), codeKey(session.code));
}

async function deleteSessionPersistentByToken(token) {
  if (!persistenceEnabled()) {
    return null;
  }
  const sessionText = await redis.get(sessionKey(token));
  if (!sessionText) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(sessionText);
  } catch (_) {
    await redis.del(sessionKey(token));
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.code || !parsed.token) {
    await redis.del(sessionKey(token));
    return null;
  }
  await redis.del(sessionKey(token), codeKey(parsed.code));
  return parsed;
}

async function loadSessionByTokenPersistent(token) {
  if (!persistenceEnabled()) {
    return null;
  }
  const text = await redis.get(sessionKey(token));
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.token !== "string" || typeof parsed.code !== "string") {
      return null;
    }
    if (typeof parsed.expiresAtMs !== "number") {
      return null;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

async function loadSessionByCodePersistent(code) {
  if (!persistenceEnabled()) {
    return null;
  }
  const token = await redis.get(codeKey(code));
  if (!token) {
    return null;
  }
  return loadSessionByTokenPersistent(token);
}

function json(res, statusCode, body) {
  const text = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
  if (CORS_ALLOW_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = CORS_ALLOW_ORIGIN;
    headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  res.writeHead(statusCode, headers);
  res.end(text);
}

function closeIfOpen(ws, code, reason) {
  if (!ws) {
    return;
  }
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
    ws.close(code, reason);
  }
}

function isSocketOpen(ws) {
  return !!ws && ws.readyState === ws.OPEN;
}

function deleteSession(session) {
  sessionsByToken.delete(session.token);
  const byCode = sessionsByCode.get(session.code);
  if (byCode && byCode.token === session.token) {
    sessionsByCode.delete(session.code);
  }
}

function indexSession(session) {
  sessionsByToken.set(session.token, session);
  if (!session.pinnedAfterPair) {
    sessionsByCode.set(session.code, session);
  }
}

async function getSessionByToken(token) {
  const inMemory = sessionsByToken.get(token);
  if (inMemory) {
    return inMemory;
  }
  const persisted = await loadSessionByTokenPersistent(token);
  if (!persisted) {
    return null;
  }
  const hydrated = toLiveSession(persisted);
  indexSession(hydrated);
  return hydrated;
}

function closeAllClients(session, code, reason) {
  for (const ws of session.clients.values()) {
    closeIfOpen(ws, code, reason);
  }
  session.clients.clear();
}

function sendJsonToClient(ws, payload) {
  if (!isSocketOpen(ws)) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function notifyAllClients(session, method, params) {
  const payload = {
    jsonrpc: "2.0",
    method,
    params: {
      ...(params || {}),
      ts: now()
    }
  };
  for (const ws of session.clients.values()) {
    sendJsonToClient(ws, payload);
  }
}

function cleanupSession(session, closeSockets, options) {
  const persist = options?.persist !== false;
  if (closeSockets) {
    closeIfOpen(session.app, 1012, "session closed");
    closeAllClients(session, 1012, "session closed");
  }
  session.inflight.clear();
  session.pendingForApp.length = 0;
  session.pendingForAppBytes = 0;
  deleteSession(session);
  if (persist) {
    void deleteSessionPersistent(session).catch((err) => {
      log("warn", "relay_session_persist_delete_failed", {
        token: session.token,
        error: err?.message || "unknown"
      });
    });
  }
}

function activePairCount() {
  let count = 0;
  for (const session of sessionsByToken.values()) {
    if (isSocketOpen(session.app) && session.clients.size > 0) {
      count += 1;
    }
  }
  return count;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      reject(new Error("Request timeout"));
      req.destroy();
    });

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

async function initPersistence() {
  if (!REDIS_URL) {
    if (REQUIRE_REDIS) {
      throw new Error("REQUIRE_REDIS=true but REDIS_URL is not set");
    }
    log("warn", "relay_persistence_memory_mode", { reason: "REDIS_URL not configured" });
    return;
  }
  const client = createClient({ url: REDIS_URL });
  client.on("error", (err) => {
    log("error", "relay_redis_error", { error: err?.message || "unknown" });
  });
  await client.connect();
  redis = client;
  log("info", "relay_persistence_redis_connected", { prefix: REDIS_PREFIX });
}

function normalizeCode(input) {
  if (typeof input !== "string") {
    return null;
  }
  const code = input.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function newClientId() {
  return crypto.randomBytes(8).toString("hex");
}

function newRelayMessageId(clientId) {
  return `${clientId}:${crypto.randomBytes(8).toString("hex")}`;
}

function getClientIp(req) {
  if (TRUST_PROXY) {
    const forwardedFor = req.headers["x-forwarded-for"];
    if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
      return forwardedFor.split(",")[0].trim();
    }
  }
  return req.socket?.remoteAddress || "unknown";
}

function isOriginAllowed(originValue) {
  if (ORIGIN_ALLOWLIST.size === 0) {
    return true;
  }
  if (!originValue || typeof originValue !== "string") {
    return !REQUIRE_ORIGIN;
  }
  return ORIGIN_ALLOWLIST.has(originValue);
}

function isRateLimited(ip) {
  const currentMs = now();
  const bucket = pairRateByIp.get(ip);
  if (!bucket || bucket.resetAtMs <= currentMs) {
    pairRateByIp.set(ip, { count: 1, resetAtMs: currentMs + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  if (bucket.count >= MAX_PAIR_REQUESTS_PER_WINDOW) {
    return true;
  }
  bucket.count += 1;
  return false;
}

function isSessionExpired(session) {
  return session.expiresAtMs <= now();
}

function persistentExpiresAtMs() {
  if (SESSION_TTL_MS > 0) {
    return now() + SESSION_TTL_MS;
  }
  return Number.MAX_SAFE_INTEGER;
}

function maybePinSessionAfterPair(session) {
  if (session.pinnedAfterPair) {
    return;
  }
  if (!session.hasAppConnectedEver || !session.hasClientConnectedEver) {
    return;
  }
  session.pinnedAfterPair = true;
  session.expiresAtMs = persistentExpiresAtMs();
  sessionsByCode.delete(session.code);
  void saveSessionPersistent(session).catch((err) => {
    log("warn", "relay_session_persist_pin_failed", {
      token: session.token,
      error: err?.message || "unknown"
    });
  });
  log("info", "relay_session_pinned", {
    token: session.token,
    code: session.code,
    sessionTtlMs: SESSION_TTL_MS
  });
}

async function reserveSessionForCode(code) {
  const existing = sessionsByCode.get(code);
  if (existing && !isSessionExpired(existing)) {
    return existing;
  }
  if (existing) {
    cleanupSession(existing, true);
  }
  const persisted = await loadSessionByCodePersistent(code);
  if (persisted) {
    const hydrated = toLiveSession(persisted);
    if (!isSessionExpired(hydrated)) {
      indexSession(hydrated);
      return hydrated;
    }
    cleanupSession(hydrated, false);
  }

  const session = {
    code,
    token: newToken(),
    createdAtMs: now(),
    expiresAtMs: now() + PAIR_TTL_MS,
    app: null,
    clients: new Map(),
    clientIdsByWs: new WeakMap(),
    inflight: new Map(),
    pendingForApp: [],
    pendingForAppBytes: 0,
    hasAppConnectedEver: false,
    hasClientConnectedEver: false,
    pinnedAfterPair: false,
    appDisconnectedAtMs: null,
    lastAppReconnectGapMs: null,
    appReconnectSeq: 0
  };

  indexSession(session);
  await saveSessionPersistent(session);
  return session;
}

function messageSizeBytes(data, isBinary) {
  if (isBinary) {
    return data.length;
  }
  if (typeof data === "string") {
    return Buffer.byteLength(data);
  }
  return data.length;
}

function sendToAppOrQueue(session, data, isBinary) {
  const size = messageSizeBytes(data, isBinary);
  if (size > MAX_MESSAGE_BYTES) {
    return;
  }
  if (isSocketOpen(session.app)) {
    session.app.send(data, { binary: isBinary });
    return;
  }
  session.pendingForApp.push({ data, isBinary, size });
  session.pendingForAppBytes += size;
  while (session.pendingForAppBytes > MAX_PENDING_FOR_APP_BYTES && session.pendingForApp.length > 0) {
    const dropped = session.pendingForApp.shift();
    session.pendingForAppBytes -= dropped.size;
  }
}

function notifyAppClientDisconnected(session, clientId, reason) {
  const msg = {
    jsonrpc: "2.0",
    method: "relay/client_disconnected",
    params: {
      sessionId: clientId,
      reason: reason || "client_disconnected",
      ts: now()
    }
  };
  sendToAppOrQueue(session, JSON.stringify(msg), false);
}

function notifyAppClientConnected(session, clientId) {
  const msg = {
    jsonrpc: "2.0",
    method: "relay/client_connected",
    params: {
      sessionId: clientId,
      ts: now()
    }
  };
  sendToAppOrQueue(session, JSON.stringify(msg), false);
}

function notifyClientRelayReconnected(session, ws) {
  if (!isSocketOpen(ws)) {
    return;
  }
  if (!session.lastAppReconnectGapMs || session.appReconnectSeq <= 0) {
    return;
  }
  const msg = {
    jsonrpc: "2.0",
    method: "session/reconnect",
    params: {
      reconnect_seq: session.appReconnectSeq,
      gap_ms: session.lastAppReconnectGapMs,
      source: "relay",
      ts: now()
    }
  };
  sendJsonToClient(ws, msg);
}

function notifyAllClientsRelayReconnected(session) {
  if (!session.lastAppReconnectGapMs || session.appReconnectSeq <= 0) {
    return;
  }
  notifyAllClients(session, "session/reconnect", {
    reconnect_seq: session.appReconnectSeq,
    gap_ms: session.lastAppReconnectGapMs,
    source: "relay"
  });
}

function flushPendingForApp(session) {
  if (!isSocketOpen(session.app)) {
    return;
  }
  while (session.pendingForApp.length > 0 && isSocketOpen(session.app)) {
    const msg = session.pendingForApp.shift();
    session.pendingForAppBytes -= msg.size;
    session.app.send(msg.data, { binary: msg.isBinary });
  }
}

function removeInflightForClient(session, clientId) {
  for (const [relayId, meta] of session.inflight.entries()) {
    if (meta.clientId === clientId) {
      session.inflight.delete(relayId);
    }
  }
}

function forwardClientMessage(session, clientId, data, isBinary) {
  if (isBinary) {
    sendToAppOrQueue(session, data, true);
    return;
  }

  const text = typeof data === "string" ? data : data.toString("utf8");
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_) {
    sendToAppOrQueue(session, text, false);
    return;
  }

  if (!obj || typeof obj !== "object" || !Object.prototype.hasOwnProperty.call(obj, "id")) {
    sendToAppOrQueue(session, JSON.stringify(obj), false);
    return;
  }

  // Attach trusted per-client session id so app can route subscriptions/notifications.
  if (!obj.params || typeof obj.params !== "object" || Array.isArray(obj.params)) {
    obj.params = {};
  }
  obj.params.sessionId = clientId;

  const relayId = newRelayMessageId(clientId);
  session.inflight.set(relayId, {
    clientId,
    originalId: obj.id
  });
  obj.id = relayId;
  sendToAppOrQueue(session, JSON.stringify(obj), false);
}

function forwardAppMessage(session, data, isBinary) {
  if (isBinary) {
    for (const ws of session.clients.values()) {
      if (isSocketOpen(ws)) {
        ws.send(data, { binary: true });
      }
    }
    return;
  }

  const text = typeof data === "string" ? data : data.toString("utf8");
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_) {
    for (const ws of session.clients.values()) {
      if (isSocketOpen(ws)) {
        ws.send(text);
      }
    }
    return;
  }

  if (
    obj &&
    typeof obj === "object" &&
    typeof obj.id === "string" &&
    session.inflight.has(obj.id)
  ) {
    const meta = session.inflight.get(obj.id);
    session.inflight.delete(obj.id);
    const target = session.clients.get(meta.clientId);
    if (isSocketOpen(target)) {
      obj.id = meta.originalId;
      target.send(JSON.stringify(obj));
    }
    return;
  }

  if (
    obj &&
    typeof obj === "object" &&
    !Object.prototype.hasOwnProperty.call(obj, "id") &&
    obj.params &&
    typeof obj.params === "object" &&
    typeof obj.params.sessionId === "string"
  ) {
    const target = session.clients.get(obj.params.sessionId);
    if (isSocketOpen(target)) {
      target.send(JSON.stringify(obj));
    }
    return;
  }

  const payload = JSON.stringify(obj);
  for (const ws of session.clients.values()) {
    if (isSocketOpen(ws)) {
      ws.send(payload);
    }
  }
}

function wireAppSocket(session, ws) {
  ws.on("message", (data, isBinary) => {
    const size = messageSizeBytes(data, isBinary);
    if (size > MAX_MESSAGE_BYTES) {
      ws.close(1009, "message too large");
      return;
    }
    forwardAppMessage(session, data, isBinary);
  });

  ws.on("close", () => {
    if (session.app === ws) {
      session.app = null;
    }
    session.appDisconnectedAtMs = now();
    session.inflight.clear();
    notifyAllClients(session, "relay/disconnected", { reason: "app_disconnected" });
    void saveSessionPersistent(session).catch((err) => {
      log("warn", "relay_session_persist_save_failed", {
        token: session.token,
        error: err?.message || "unknown"
      });
    });
  });

  ws.on("error", (err) => {
    log("warn", "websocket_app_error", { error: err?.message || "unknown" });
    closeIfOpen(ws, 1011, "socket error");
  });
}

function wireClientSocket(session, ws, clientId) {
  ws.on("message", (data, isBinary) => {
    const size = messageSizeBytes(data, isBinary);
    if (size > MAX_MESSAGE_BYTES) {
      ws.close(1009, "message too large");
      return;
    }
    forwardClientMessage(session, clientId, data, isBinary);
  });

  ws.on("close", () => {
    const current = session.clients.get(clientId);
    if (current === ws) {
      session.clients.delete(clientId);
    }
    removeInflightForClient(session, clientId);
    notifyAppClientDisconnected(session, clientId, "client_socket_closed");
  });

  ws.on("error", (err) => {
    log("warn", "websocket_client_error", { error: err?.message || "unknown" });
    closeIfOpen(ws, 1011, "socket error");
  });
}

function parseConnectPath(urlPathname) {
  const match = /^\/connect\/([A-Za-z0-9_-]+)$/.exec(urlPathname);
  return match ? match[1] : null;
}

function parseRole(raw) {
  return raw === "app" ? "app" : "client";
}

function purgeExpiredSessions() {
  for (const session of sessionsByToken.values()) {
    if (!isSessionExpired(session)) {
      continue;
    }
    cleanupSession(session, true);
  }

  const currentMs = now();
  for (const [ip, bucket] of pairRateByIp.entries()) {
    if (bucket.resetAtMs <= currentMs) {
      pairRateByIp.delete(ip);
    }
  }
}

setInterval(purgeExpiredSessions, 10_000).unref();

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    json(res, 400, { error: "Bad request" });
    return;
  }

  const reqUrl = new URL(req.url, "http://127.0.0.1");

  if (req.method === "OPTIONS") {
    if (!CORS_ALLOW_ORIGIN) {
      json(res, 404, { error: "Not found" });
      return;
    }
    json(res, 204, {});
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/health") {
    json(res, 200, {
      status: "ok",
      active_pairs: activePairCount(),
      mode: "multi-client",
      relay_build: RELAY_BUILD,
      persistence: persistentModeLabel()
    });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/pair") {
    try {
      const ip = getClientIp(req);
      if (isRateLimited(ip)) {
        json(res, 429, { error: "Too many pairing requests. Try again soon." });
        return;
      }
      const body = await parseJsonBody(req);
      const code = normalizeCode(body.code);
      if (!code) {
        json(res, 400, { error: "code must be 6 uppercase alphanumeric characters" });
        return;
      }
      const session = await reserveSessionForCode(code);
      json(res, 200, {
        session_token: session.token,
        expires_at_ms: session.expiresAtMs
      });
    } catch (err) {
      json(res, 400, { error: err.message || "Invalid request" });
    }
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/revoke") {
    try {
      const body = await parseJsonBody(req);
      const token = typeof body.session_token === "string" ? body.session_token.trim() : "";
      if (!token) {
        json(res, 400, { error: "session_token is required" });
        return;
      }
      const session = await getSessionByToken(token);
      if (session) {
        cleanupSession(session, true);
      } else {
        await deleteSessionPersistentByToken(token);
      }
      // idempotent success even if token not found
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message || "Invalid request" });
    }
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.on("upgrade", (req, socket, head) => {
  void (async () => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const reqUrl = new URL(req.url, "http://127.0.0.1");
    const token = parseConnectPath(reqUrl.pathname);
    const role = parseRole(reqUrl.searchParams.get("role"));
    if (!token) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const session = await getSessionByToken(token);
    if (!session) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (isSessionExpired(session)) {
      cleanupSession(session, true);
      socket.write("HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (role === "app") {
        if (isSocketOpen(session.app)) {
          closeIfOpen(session.app, 1012, "app reconnected");
        }
        if (typeof session.appDisconnectedAtMs === "number") {
          const gap = now() - session.appDisconnectedAtMs;
          if (gap > 0) {
            session.lastAppReconnectGapMs = gap;
            session.appReconnectSeq = (session.appReconnectSeq || 0) + 1;
            log("info", "relay_app_reconnected", {
              token: session.token,
              reconnectSeq: session.appReconnectSeq,
              gapMs: gap
            });
          }
          session.appDisconnectedAtMs = null;
        }
        session.app = ws;
        session.hasAppConnectedEver = true;
        void saveSessionPersistent(session).catch((err) => {
          log("warn", "relay_session_persist_save_failed", {
            token: session.token,
            error: err?.message || "unknown"
          });
        });
        maybePinSessionAfterPair(session);
        flushPendingForApp(session);
        notifyAllClientsRelayReconnected(session);
        wireAppSocket(session, ws);
        return;
      }

      const clientId = newClientId();
      session.clients.set(clientId, ws);
      session.clientIdsByWs.set(ws, clientId);
      session.hasClientConnectedEver = true;
      void saveSessionPersistent(session).catch((err) => {
        log("warn", "relay_session_persist_save_failed", {
          token: session.token,
          error: err?.message || "unknown"
        });
      });
      maybePinSessionAfterPair(session);
      notifyAppClientConnected(session, clientId);
      notifyClientRelayReconnected(session, ws);
      wireClientSocket(session, ws, clientId);
    });
  })().catch((err) => {
    log("error", "relay_upgrade_error", { error: err?.message || "unknown" });
    try {
      socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
    } catch (_) {
      // ignore
    }
    socket.destroy();
  });
});

server.headersTimeout = 20_000;
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = 5_000;

async function startServer() {
  await initPersistence();
  server.listen(PORT, () => {
    log("info", "relay_listening", {
      port: PORT,
      pairTtlMs: PAIR_TTL_MS,
      sessionTtlMs: SESSION_TTL_MS,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      maxPairRequestsPerWindow: MAX_PAIR_REQUESTS_PER_WINDOW,
      rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
      trustProxy: TRUST_PROXY,
      requireOrigin: REQUIRE_ORIGIN,
      originAllowlistSize: ORIGIN_ALLOWLIST.size,
      persistence: persistentModeLabel()
    });
  });
}

function shutdown(signal) {
  log("info", "relay_shutdown_start", { signal });
  for (const session of sessionsByToken.values()) {
    cleanupSession(session, true, { persist: false });
  }
  for (const client of wss.clients) {
    try {
      client.terminate();
    } catch (_) {
      // best effort
    }
  }
  wss.close();
  server.close(() => {
    const finish = async () => {
      if (redis) {
        try {
          await redis.quit();
        } catch (_) {
          // best effort
        }
      }
      log("info", "relay_shutdown_done");
      process.exit(0);
    };
    void finish();
  });
  setTimeout(() => {
    log("warn", "relay_shutdown_forced_exit");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startServer().catch((err) => {
  log("error", "relay_start_failed", { error: err?.message || "unknown" });
  process.exit(1);
});

/**
 * MCP JSON-RPC 2.0 codec
 *
 * Encodes outgoing requests/notifications and decodes incoming
 * responses/notifications from raw WebSocket text frames.
 */

let _nextId = 1;

function nextId() {
  return _nextId++;
}

// --- Encode ---

function encodeRequest(method, params) {
  const id = nextId();
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined && params !== null) msg.params = params;
  return { id, raw: JSON.stringify(msg) };
}

function encodeNotification(method, params) {
  const msg = { jsonrpc: '2.0', method };
  if (params !== undefined && params !== null) msg.params = params;
  return JSON.stringify(msg);
}

function encodeResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function encodeErrorResponse(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// --- Decode ---

function decode(raw) {
  const msg = JSON.parse(raw);

  if (msg.jsonrpc !== '2.0') throw new Error('Not JSON-RPC 2.0');

  // Response (has id + result or error)
  if ('id' in msg && ('result' in msg || 'error' in msg)) {
    return {
      type: 'response',
      id: msg.id,
      jsonrpc: msg.jsonrpc,
      trace_id: msg.trace_id || null,
      result: msg.result || null,
      error: msg.error || null,
    };
  }

  // Request (has id + method)
  if ('id' in msg && 'method' in msg) {
    return {
      type: 'request',
      id: msg.id,
      method: msg.method,
      params: msg.params || {},
    };
  }

  // Notification (has method, no id)
  if ('method' in msg && !('id' in msg)) {
    return {
      type: 'notification',
      jsonrpc: msg.jsonrpc,
      trace_id: msg.trace_id || null,
      method: msg.method,
      params: msg.params || {},
    };
  }

  throw new Error('Unrecognized JSON-RPC message');
}

module.exports = {
  encodeRequest,
  encodeNotification,
  encodeResponse,
  encodeErrorResponse,
  decode,
  nextId,
};

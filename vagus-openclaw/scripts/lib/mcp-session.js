/**
 * MCP session - protocol state machine
 *
 * Lifecycle:
 *   1. new McpSession(transport)
 *   2. await session.initialize()
 *      -> sends "initialize" request
 *      -> receives server capabilities
 *      -> sends "initialized" notification
 *      -> fetches resources/list and tools/list
 *   3. session.readResource(uri) / session.callTool(name, params)
 *   4. session.subscribe(uri) / session.unsubscribe(uri)
 */

const codec = require('./mcp-codec');

const REQUEST_TIMEOUT_MS = 22000;
const INITIALIZE_TIMEOUT_MS = 20000;
const INIT_SETTLE_MS = 50;

class McpSession {
  constructor(transport) {
    this.transport = transport;
    this.serverInfo = null;
    this.serverCapabilities = null;
    this.resources = [];
    this.tools = [];
    this._pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this._resourceUpdateHandlers = [];
    this._sessionReconnectHandlers = [];
    this._lastResponseMeta = null;
    this._lastNotificationMeta = null;

    // Wire up incoming messages
    this.transport.onMessage((raw) => this._handleMessage(raw));
  }

  // --- Initialize ---

  async initialize() {
    let result;
    try {
      result = await this._request(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'vagus-openclaw', version: '1.0.0' },
        },
        INITIALIZE_TIMEOUT_MS
      );
    } catch (err) {
      // Retry initialize once if the first attempt timed out.
      if (String(err?.message || '').includes('timed out')) {
        result = await this._request(
          'initialize',
          {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'vagus-openclaw', version: '1.0.0' },
          },
          INITIALIZE_TIMEOUT_MS
        );
      } else {
        throw err;
      }
    }

    this.serverInfo = result.serverInfo || {};
    this.serverCapabilities = result.capabilities || {};

    // Send initialized signal (support variants seen in server builds)
    this.transport.send(codec.encodeNotification('initialized'));
    this.transport.send(codec.encodeNotification('notifications/initialized'));
    this.transport.send(codec.encodeRequest('initialized').raw);

    // Fetch available resources and tools
    try {
      const [resList, toolsList] = await Promise.all([
        this._request('resources/list'),
        this._request('tools/list'),
      ]);
      this.resources = resList.resources || [];
      this.tools = toolsList.tools || [];
    } catch (err) {
      // Some server builds apply initialized state asynchronously.
      const msg = String(err?.message || '');
      if (msg.includes('Server not initialized')) {
        await new Promise((resolve) => setTimeout(resolve, INIT_SETTLE_MS));
        const [resList, toolsList] = await Promise.all([
          this._request('resources/list'),
          this._request('tools/list'),
        ]);
        this.resources = resList.resources || [];
        this.tools = toolsList.tools || [];
      } else {
        throw err;
      }
    }
  }

  // --- Resource operations ---

  async readResource(uri) {
    const result = await this._request('resources/read', { uri });
    // Parse the text content as JSON
    const contents = result.contents || [];
    if (contents.length > 0 && contents[0].text) {
      try { return JSON.parse(contents[0].text); } catch (_) { return contents[0].text; }
    }
    return null;
  }

  async listResources() {
    const result = await this._request('resources/list');
    this.resources = result.resources || [];
    return this.resources;
  }

  async subscribe(uri) {
    await this._request('resources/subscribe', { uri });
  }

  async unsubscribe(uri) {
    await this._request('resources/unsubscribe', { uri });
  }

  onResourceUpdate(handler) {
    this._resourceUpdateHandlers.push(handler);
  }

  onSessionReconnect(handler) {
    this._sessionReconnectHandlers.push(handler);
  }

  getLastResponseMeta() {
    return this._lastResponseMeta;
  }

  getLastNotificationMeta() {
    return this._lastNotificationMeta;
  }

  // --- Tool operations ---

  async callTool(name, args) {
    const result = await this._request('tools/call', { name, arguments: args });
    return result;
  }

  async listTools() {
    const result = await this._request('tools/list');
    this.tools = result.tools || [];
    return this.tools;
  }

  // --- Internal ---

  async _request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const { id, raw } = codec.encodeRequest(method, params);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pendingRequests.set(id, { resolve, reject, timer, method });
      this.transport.send(raw);
    });
  }

  _handleMessage(raw) {
    let msg;
    try { msg = codec.decode(raw); } catch (_) { return; } // Ignore unparseable messages

    if (msg.type === 'response') {
      const pending = this._pendingRequests.get(msg.id);
      if (pending) {
        this._pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);
        this._lastResponseMeta = {
          id: msg.id,
          method: pending.method,
          trace_id: msg.trace_id || null,
          jsonrpc: msg.jsonrpc || '2.0',
        };
        if (msg.error) {
          const err = new Error(msg.error.message || 'MCP error');
          err.code = msg.error.code;
          err.mcp = this._lastResponseMeta;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
    }

    if (msg.type === 'notification') {
      if (msg.method === 'session/reconnect') {
        const payload = {
          sessionId: msg.params?.sessionId,
          reconnect_seq: msg.params?.reconnect_seq,
          gap_ms: msg.params?.gap_ms,
          source: msg.params?.source,
          ts: msg.params?.ts,
          trace_id: msg.trace_id || null,
        };
        this._lastNotificationMeta = {
          method: msg.method,
          trace_id: msg.trace_id || null,
          ts: msg.params?.ts,
          sessionId: msg.params?.sessionId,
        };
        for (const handler of this._sessionReconnectHandlers) {
          handler(payload);
        }
      }

      if (msg.method === 'notifications/resources/updated') {
        // Resource update from subscription
        const uri = msg.params?.uri;
        const contents = msg.params?.contents || [];
        // Current app behavior may send structured payload in params.data / params.value.
        let data = msg.params?.data ?? msg.params?.value ?? null;
        if (data === null && contents.length > 0 && contents[0].text) {
          try { data = JSON.parse(contents[0].text); } catch (_) { data = contents[0].text; }
        }
        const meta = {
          method: msg.method,
          trace_id: msg.trace_id || null,
          ts: msg.params?.ts,
          sessionId: msg.params?.sessionId,
        };
        this._lastNotificationMeta = meta;
        for (const handler of this._resourceUpdateHandlers) {
          handler(uri, data, meta);
        }
      }

      if (
        msg.method === 'notifications/resources/list_changed' ||
        msg.method === 'notifications/tools/list_changed'
      ) {
        // Capabilities changed - re-fetch (fire-and-forget)
        this.listResources().catch(() => {});
        this.listTools().catch(() => {});
      }
    }
  }
}

module.exports = { McpSession };

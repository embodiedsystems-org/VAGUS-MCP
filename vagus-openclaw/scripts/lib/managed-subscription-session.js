const { WsTransport } = require('./ws-transport');
const { McpSession } = require('./mcp-session');

const DEFAULT_RECONNECT_DELAYS = [250, 500, 1000, 2000, 5000, 10000, 30000];

class ManagedSubscriptionSession {
  constructor(options) {
    this.sessionToken = options.sessionToken;
    this.relayUrl = options.relayUrl;
    this.reconnectDelays = options.reconnectDelays || DEFAULT_RECONNECT_DELAYS;

    this._closed = false;
    this._connecting = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._transport = null;
    this._session = null;
    this._activeUris = new Set();
    this._listeners = {
      update: [],
      sessionReconnect: [],
      lifecycle: [],
    };
  }

  async start() {
    this._scheduleReconnect(0, 'start');
    return this.waitUntilConnected();
  }

  async waitUntilConnected() {
    while (!this._closed) {
      if (this._session && this._transport) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async subscribe(uri) {
    this._activeUris.add(uri);
    if (this._session) {
      await this._session.subscribe(uri);
      this._emitLifecycle({ type: 'subscribed', uri });
    }
  }

  async unsubscribe(uri) {
    this._activeUris.delete(uri);
    if (this._session) {
      try {
        await this._session.unsubscribe(uri);
      } catch (_) {
        // best effort during shutdown/reconnect
      }
      this._emitLifecycle({ type: 'unsubscribed', uri });
    }
  }

  onUpdate(handler) {
    this._listeners.update.push(handler);
  }

  onSessionReconnect(handler) {
    this._listeners.sessionReconnect.push(handler);
  }

  onLifecycle(handler) {
    this._listeners.lifecycle.push(handler);
  }

  async close() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    const session = this._session;
    const transport = this._transport;
    const uris = [...this._activeUris];
    this._session = null;
    this._transport = null;
    if (session) {
      for (const uri of uris) {
        try {
          await session.unsubscribe(uri);
        } catch (_) {
          // ignore shutdown errors
        }
      }
    }
    if (transport) {
      transport.close();
    }
  }

  _scheduleReconnect(delayMs, reason) {
    if (this._closed || this._reconnectTimer || this._connecting) {
      return;
    }

    this._emitLifecycle({
      type: delayMs === 0 ? 'reconnect_now' : 'reconnect_scheduled',
      attempt: this._reconnectAttempt,
      delay_ms: delayMs,
      reason,
    });

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      await this._connect();
    }, delayMs);
  }

  async _connect() {
    if (this._closed || this._connecting) {
      return;
    }

    this._connecting = (async () => {
      const url = `${this.relayUrl}/connect/${this.sessionToken}`;
      const transport = new WsTransport(url);
      const session = new McpSession(transport);
      let closedHandled = false;

      session.onResourceUpdate((uri, data, meta) => {
        for (const handler of this._listeners.update) {
          handler(uri, data, meta);
        }
      });

      session.onSessionReconnect((payload) => {
        for (const handler of this._listeners.sessionReconnect) {
          handler(payload);
        }
      });

      transport.onClose((code, reason) => {
        if (closedHandled || this._closed || transport !== this._transport) {
          return;
        }
        closedHandled = true;
        this._session = null;
        this._transport = null;
        this._emitLifecycle({
          type: 'transport_closed',
          code,
          reason,
        });
        this._scheduleReconnect(this._nextDelay(), reason || 'transport_closed');
      });

      try {
        this._emitLifecycle({
          type: 'reconnect_attempt',
          attempt: this._reconnectAttempt,
        });
        await transport.connect();
        await session.initialize();
        this._transport = transport;
        this._session = session;

        for (const uri of this._activeUris) {
          await session.subscribe(uri);
          this._emitLifecycle({ type: 'subscribed', uri });
        }

        this._reconnectAttempt = 0;
        this._emitLifecycle({
          type: 'connected',
          subscriptions: [...this._activeUris],
        });
      } catch (err) {
        try {
          transport.close();
        } catch (_) {
          // ignore close failures
        }
        this._emitLifecycle({
          type: 'reconnect_failed',
          attempt: this._reconnectAttempt,
          message: err.message,
        });
        this._scheduleReconnect(this._nextDelay(), err.message);
      } finally {
        this._connecting = null;
      }
    })();

    return this._connecting;
  }

  _nextDelay() {
    const index = Math.min(this._reconnectAttempt, this.reconnectDelays.length - 1);
    const delay = this.reconnectDelays[index];
    this._reconnectAttempt += 1;
    return delay;
  }

  _emitLifecycle(event) {
    for (const handler of this._listeners.lifecycle) {
      handler(event);
    }
  }
}

module.exports = { ManagedSubscriptionSession };

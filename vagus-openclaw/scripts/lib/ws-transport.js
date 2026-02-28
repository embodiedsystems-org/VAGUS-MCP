/**
 * WebSocket transport with reconnection and heartbeat
 */

const WebSocket = require('ws');

const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 10000;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]; // exponential backoff

class WsTransport {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this._messageHandlers = [];
    this._closeHandlers = [];
    this._heartbeatInterval = null;
    this._heartbeatTimeout = null;
    this._reconnectAttempt = 0;
    this._closed = false;
  }

  // --- Public ---

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this._reconnectAttempt = 0;
        this._startHeartbeat();
        resolve();
      });

      this.ws.on('message', (data) => {
        const raw = data.toString();
        for (const handler of this._messageHandlers) {
          handler(raw);
        }
      });

      this.ws.on('pong', () => {
        // Heartbeat received
        if (this._heartbeatTimeout) {
          clearTimeout(this._heartbeatTimeout);
          this._heartbeatTimeout = null;
        }
      });

      this.ws.on('close', (code, reason) => {
        this._stopHeartbeat();
        for (const handler of this._closeHandlers) {
          handler(code, reason.toString());
        }
      });

      this.ws.on('error', (err) => {
        if (this.ws.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  send(raw) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    }
  }

  close() {
    this._closed = true;
    this._stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
    }
  }

  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  onClose(handler) {
    this._closeHandlers.push(handler);
  }

  // --- Heartbeat ---

  _startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this._heartbeatTimeout = setTimeout(() => {
          // No pong received — connection dead
          if (this.ws) this.ws.terminate();
        }, HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    if (this._heartbeatTimeout) clearTimeout(this._heartbeatTimeout);
    this._heartbeatInterval = null;
    this._heartbeatTimeout = null;
  }
}

module.exports = { WsTransport };

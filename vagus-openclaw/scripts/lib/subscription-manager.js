/**
 * Tracks active subscriptions for re-subscription after reconnect
 */

class SubscriptionManager {
  constructor(session) {
    this.session = session;
    this._active = new Set();
  }

  async subscribe(uri) {
    await this.session.subscribe(uri);
    this._active.add(uri);
  }

  async unsubscribe(uri) {
    await this.session.unsubscribe(uri);
    this._active.delete(uri);
  }

  async resubscribeAll() {
    for (const uri of this._active) {
      try { await this.session.subscribe(uri); } catch (_) {} // Best effort
    }
  }

  getActive() {
    return [...this._active];
  }
}

module.exports = { SubscriptionManager };

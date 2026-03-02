class AdaptiveFreshness {
  constructor(options = {}) {
    this._intervals = [];
    this._maxIntervals = options.maxIntervals || 32;
    this._minSamples = options.minSamples || 3;
    this._delayedMultiplier = options.delayedMultiplier || 2.5;
    this._staleMultiplier = options.staleMultiplier || 6;
    this._unavailableMultiplier = options.unavailableMultiplier || 20;
    this._lastReceivedAt = null;
    this._lastSourceTs = null;
    this._graceUntil = 0;
  }

  observe(sourceTs, receivedAt = Date.now()) {
    if (this._lastReceivedAt !== null) {
      const interval = receivedAt - this._lastReceivedAt;
      if (interval > 0) {
        this._intervals.push(interval);
        if (this._intervals.length > this._maxIntervals) {
          this._intervals.shift();
        }
      }
    }

    this._lastReceivedAt = receivedAt;
    this._lastSourceTs = typeof sourceTs === 'number' ? sourceTs : null;
    this._graceUntil = 0;
  }

  startGrace(now = Date.now()) {
    const thresholds = this.getThresholds();
    if (!thresholds) {
      this._graceUntil = Infinity;
      return;
    }
    this._graceUntil = now + thresholds.stale_after_ms;
  }

  clearGrace() {
    this._graceUntil = 0;
  }

  getThresholds() {
    if (this._intervals.length < this._minSamples) {
      return null;
    }

    const expected = percentile(this._intervals, 0.95);
    return {
      observed_p95_interval_ms: expected,
      delayed_after_ms: Math.ceil(expected * this._delayedMultiplier),
      stale_after_ms: Math.ceil(expected * this._staleMultiplier),
      unavailable_after_ms: Math.ceil(expected * this._unavailableMultiplier),
    };
  }

  getStatus(now = Date.now()) {
    if (this._lastReceivedAt === null) {
      return {
        status: 'warming',
        last_received_at: null,
        last_source_ts: this._lastSourceTs,
        freshness_ms: null,
        thresholds: null,
      };
    }

    const thresholds = this.getThresholds();
    const freshnessMs = now - this._lastReceivedAt;
    if (!thresholds) {
      return {
        status: 'warming',
        last_received_at: this._lastReceivedAt,
        last_source_ts: this._lastSourceTs,
        freshness_ms: freshnessMs,
        thresholds: null,
      };
    }

    if (this._graceUntil && now < this._graceUntil) {
      return {
        status: 'grace',
        last_received_at: this._lastReceivedAt,
        last_source_ts: this._lastSourceTs,
        freshness_ms: freshnessMs,
        thresholds,
      };
    }

    let status = 'fresh';
    if (freshnessMs >= thresholds.unavailable_after_ms) {
      status = 'unavailable';
    } else if (freshnessMs >= thresholds.stale_after_ms) {
      status = 'stale';
    } else if (freshnessMs >= thresholds.delayed_after_ms) {
      status = 'delayed';
    }

    return {
      status,
      last_received_at: this._lastReceivedAt,
      last_source_ts: this._lastSourceTs,
      freshness_ms: freshnessMs,
      thresholds,
    };
  }
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  );
  return sorted[index];
}

module.exports = { AdaptiveFreshness };

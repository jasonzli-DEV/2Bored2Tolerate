// src/eta-learner.js - Adaptive ETA learning system
// Learns from historical queue sessions to improve future ETA estimates.
// Accounts for day-of-week and time-of-day patterns in 2b2t queue speed.
// Data is stored locally in data/eta-learn.json only.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_PATH = path.join(__dirname, '..', 'data', 'eta-learn.json');
const MAX_SESSIONS = 200; // Keep last 200 completed sessions

/**
 * ETALearner - blends three sources to estimate remaining queue time:
 *   1. Base model (exponential decay, from queue.json factors)
 *   2. Historical session data for similar time-of-day / day-of-week
 *   3. Observed rate from the *current* active session (once we have enough points)
 */
class ETALearner {
  /**
   * @param {string} [dataPath] - Override the default data file path (useful for tests)
   */
  constructor(dataPath) {
    this.dataPath = dataPath || DATA_PATH;
    /**
     * Stored sessions: array of { startPos, startTimeMs, endTimeMs,
     *   dayOfWeek, startHour, positionsPerHour }
     */
    this.sessions = [];
    this._load();

    // Track active session position samples for live rate calculation
    // Each entry: { time: Date.now(), pos: number }
    this.activeSamples = [];
    this.sessionStartPos = null;
    this.sessionStartTime = null;
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
      this.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    } catch {
      this.sessions = [];
    }
  }

  _save() {
    try {
      const dataDir = path.dirname(this.dataPath);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify({ sessions: this.sessions }, null, 2), 'utf-8');
    } catch (e) {
      logger.warn(`ETA learner: failed to save data – ${e.message}`);
    }
  }

  // ─── Active session tracking ───────────────────────────────────────────────

  /** Call once when queue starts */
  beginSession(startPos) {
    this.sessionStartPos = startPos;
    this.sessionStartTime = Date.now();
    this.activeSamples = [{ time: Date.now(), pos: startPos }];
  }

  /** Call on every position update during the active session */
  recordSample(pos) {
    this.activeSamples.push({ time: Date.now(), pos });
    // Keep last 30 samples for rate calculation
    if (this.activeSamples.length > 30) this.activeSamples.shift();
  }

  /**
   * Call when the queue finishes (position reached 0).
   * Stores the completed session for future estimates.
   */
  recordCompletedSession() {
    if (!this.sessionStartPos || !this.sessionStartTime) return;

    const endTime = Date.now();
    const durationMs = endTime - this.sessionStartTime;
    if (durationMs < 2 * 60 * 1000) return; // ignore very short sessions (< 2 min)

    const durationHours = durationMs / 3_600_000;
    const positionsPerHour = Math.round(this.sessionStartPos / durationHours);
    if (positionsPerHour <= 0 || positionsPerHour > 10000) return; // sanity check

    const date = new Date(this.sessionStartTime);
    const session = {
      startPos: this.sessionStartPos,
      startTimeMs: this.sessionStartTime,
      endTimeMs: endTime,
      durationMs,
      dayOfWeek: date.getDay(),   // 0 = Sunday … 6 = Saturday
      startHour: date.getHours(), // 0–23
      positionsPerHour,
    };

    this.sessions.push(session);
    if (this.sessions.length > MAX_SESSIONS) this.sessions.shift();
    this._save();

    logger.info(
      `ETA learner: saved session – ${this.sessionStartPos} positions in ` +
      `${Math.round(durationMs / 60000)}m ≈ ${positionsPerHour}/hr`
    );

    this.sessionStartPos = null;
    this.sessionStartTime = null;
    this.activeSamples = [];
  }

  // ─── Rate helpers ──────────────────────────────────────────────────────────

  /**
   * Compute positions-per-hour from the currently active session samples.
   * Returns null if not enough data.
   */
  _getLiveRate() {
    if (this.activeSamples.length < 5) return null;

    // Use oldest and newest sample for a stable rate
    const oldest = this.activeSamples[0];
    const newest = this.activeSamples[this.activeSamples.length - 1];
    const elapsedHours = (newest.time - oldest.time) / 3_600_000;
    if (elapsedHours < 1 / 60) return null; // less than 1 minute elapsed

    const posDropped = oldest.pos - newest.pos;
    if (posDropped <= 0) return null;

    return posDropped / elapsedHours; // positions per hour
  }

  /**
   * Compute weighted-average positions-per-hour from historical sessions
   * that match the current time context (day type + hour window).
   * Returns null if there aren't enough matches.
   */
  _getHistoricalRate(now = new Date()) {
    if (this.sessions.length < 3) return null;

    const hour = now.getHours();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;

    // Look for sessions within ±3 hours on the same day type
    const similar = this.sessions.filter((s) => {
      const sWeekend = s.dayOfWeek === 0 || s.dayOfWeek === 6;
      const hourDiff = Math.min(
        Math.abs(s.startHour - hour),
        24 - Math.abs(s.startHour - hour)
      );
      return sWeekend === isWeekend && hourDiff <= 3;
    });

    // Fall back to all sessions if we have fewer than 3 matches
    const pool = similar.length >= 3 ? similar : (this.sessions.length >= 5 ? this.sessions : null);
    if (!pool) return null;

    // Linear-decay weighting: more recent sessions contribute more
    const sorted = [...pool].sort((a, b) => b.startTimeMs - a.startTimeMs);
    let weightedSum = 0;
    let totalWeight = 0;
    sorted.forEach((s, i) => {
      const weight = sorted.length - i; // n, n-1, n-2 …
      weightedSum += s.positionsPerHour * weight;
      totalWeight += weight;
    });

    return totalWeight > 0 ? weightedSum / totalWeight : null;
  }

  // ─── ETA estimation ────────────────────────────────────────────────────────

  /**
   * Estimate remaining minutes using a blend of the base model,
   * historical learned data, and the current session's observed rate.
   *
   * @param {number} currentPos  - Current queue position
   * @param {number} baseMinutes - Estimate from the exponential decay model (proxy.js _getWaitTime)
   * @param {Date}   now         - Current time (defaults to now)
   * @returns {number}           - Blended ETA in minutes
   */
  estimateMinutes(currentPos, baseMinutes, now = new Date()) {
    const historicalRate = this._getHistoricalRate(now); // pos/hr
    const liveRate = this._getLiveRate();                 // pos/hr (null if < 5 samples)

    // Count similar historical sessions for confidence weighting
    const hour = now.getHours();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const similarCount = this.sessions.filter((s) => {
      const sWeekend = s.dayOfWeek === 0 || s.dayOfWeek === 6;
      const hourDiff = Math.min(Math.abs(s.startHour - hour), 24 - Math.abs(s.startHour - hour));
      return sWeekend === isWeekend && hourDiff <= 3;
    }).length;

    // --- Build array of (minutes, weight) ---
    const candidates = [];

    // 1. Base model always contributes (30–50%)
    candidates.push({ minutes: baseMinutes, weight: 0.5 });

    // 2. Historical rate (increases from 0.25 to 0.5 as we get more data)
    if (historicalRate && historicalRate > 0) {
      const histMinutes = (currentPos / historicalRate) * 60;
      const histWeight = Math.min(0.5, 0.1 + similarCount * 0.04);
      candidates.push({ minutes: histMinutes, weight: histWeight });
    }

    // 3. Live session rate (up to 0.4 weight once established)
    if (liveRate && liveRate > 0) {
      const liveMinutes = (currentPos / liveRate) * 60;
      // Grow weight: 0 → 0.4 over first 20 samples
      const liveWeight = Math.min(0.4, this.activeSamples.length * 0.02);
      candidates.push({ minutes: liveMinutes, weight: liveWeight });
    }

    // Normalize weights so they sum to 1
    const totalWeight = candidates.reduce((s, c) => s + c.weight, 0);
    const blended = candidates.reduce((s, c) => s + c.minutes * (c.weight / totalWeight), 0);

    return Math.max(1, Math.round(blended));
  }

  // ─── Stats (for logging/debugging) ────────────────────────────────────────

  /** Return a brief summary string for logging */
  summary(now = new Date()) {
    const similar = this.sessions.filter((s) => {
      const isWeekend = now.getDay() === 0 || now.getDay() === 6;
      const sWeekend = s.dayOfWeek === 0 || s.dayOfWeek === 6;
      const hourDiff = Math.min(Math.abs(s.startHour - now.getHours()), 24 - Math.abs(s.startHour - now.getHours()));
      return sWeekend === isWeekend && hourDiff <= 3;
    });
    const rate = this._getHistoricalRate(now);
    return `${this.sessions.length} sessions total, ` +
           `${similar.length} matching time context` +
           (rate ? `, ~${Math.round(rate)} pos/hr historical` : '');
  }
}

module.exports = ETALearner;

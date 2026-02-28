// src/eta-learner.js - Adaptive ETA learning system
// Learns from historical queue sessions to improve future ETA estimates.
// Accounts for day-of-week and time-of-day patterns in 2b2t queue speed.
// Data is stored locally in data/eta-learn.json only.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_PATH = path.join(__dirname, '..', 'data', 'eta-learn.json');
const MAX_SESSIONS = 500; // Keep last 500 completed sessions

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
   * Compute a weighted positions-per-hour from all historical sessions,
   * using a Gaussian decay over hour-of-day distance, a day-type bonus
   * (weekend vs weekday), and linear recency weighting.
   *
   * Unlike a hard ±N hour bracket, every session always contributes — sessions
   * far from the current hour simply carry very low weight, so the estimate
   * gracefully degrades when matching data is sparse rather than falling off a
   * cliff to an "all sessions" average.
   *
   * @param {Date} now
   * @returns {{ rate: number, effectiveSessions: number } | null}
   */
  _getHistoricalRate(now = new Date()) {
    if (this.sessions.length === 0) return null;

    const hour = now.getHours();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;

    // Sort by recency so we can assign a recency rank
    const sorted = [...this.sessions].sort((a, b) => b.startTimeMs - a.startTimeMs);
    const n = sorted.length;

    let weightedSum = 0;
    let totalWeight = 0;
    let effectiveCount = 0; // Kish effective sample size numerator
    let effectiveCountDenom = 0;

    sorted.forEach((s, i) => {
      // ── Hour similarity: Gaussian, σ = 4 hours (wraps around midnight) ──
      const rawDiff = Math.abs(s.startHour - hour);
      const hourDiff = Math.min(rawDiff, 24 - rawDiff);
      const timeWeight = Math.exp(-0.5 * Math.pow(hourDiff / 4, 2)); // σ=4h

      // ── Day-type bonus: same weekend/weekday type = 1.0, different = 0.35 ──
      const sWeekend = s.dayOfWeek === 0 || s.dayOfWeek === 6;
      const dayWeight = sWeekend === isWeekend ? 1.0 : 0.35;

      // ── Recency: linear decay, newest = n, oldest = 1 ──
      const recencyWeight = (n - i) / n;

      const w = timeWeight * dayWeight * recencyWeight;
      weightedSum += s.positionsPerHour * w;
      totalWeight += w;

      // Kish effective sample size — measures how many "full-weight" sessions
      // this pool is equivalent to
      effectiveCount += w;
      effectiveCountDenom += w * w;
    });

    if (totalWeight === 0) return null;

    const rate = weightedSum / totalWeight;
    // Kish ESS: (Σw)² / Σw²
    const effectiveSessions = effectiveCountDenom > 0
      ? Math.round((effectiveCount * effectiveCount) / effectiveCountDenom)
      : 0;

    return { rate, effectiveSessions };
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
    const historical = this._getHistoricalRate(now); // { rate, effectiveSessions } | null
    const liveRate = this._getLiveRate();             // pos/hr (null if < 5 samples)

    // --- Build array of (minutes, weight) ---
    const candidates = [];

    // 1. Base model always contributes
    candidates.push({ minutes: baseMinutes, weight: 0.5 });

    // 2. Historical rate — confidence grows with effective session count
    //    0 effective → weight 0; 10+ effective → up to 0.5
    if (historical && historical.rate > 0) {
      const histMinutes = (currentPos / historical.rate) * 60;
      const histWeight = Math.min(0.5, historical.effectiveSessions * 0.04);
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
    const historical = this._getHistoricalRate(now);
    const ess = historical?.effectiveSessions ?? 0;
    const rate = historical?.rate ?? null;
    return `${this.sessions.length} sessions stored, ` +
           `~${ess} effective for current time` +
           (rate ? `, ~${Math.round(rate)} pos/hr historical` : ', no historical rate yet');
  }
}

module.exports = ETALearner;

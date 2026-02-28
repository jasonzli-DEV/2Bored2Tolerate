// src/antiafk.js - Anti-AFK system to prevent server kicks
// Keeps the bot alive without moving more than 2 blocks from the origin position.
const logger = require('./logger');

const MAX_DRIFT = 2; // Maximum blocks from origin before returning

class AntiAFK {
  /**
   * @param {import('mineflayer').Bot} bot - The mineflayer bot instance
   * @param {object} options - Anti-AFK configuration
   */
  constructor(bot, options = {}) {
    this.bot = bot;
    this.options = {
      enabled: true,
      walk: true,
      look: true,
      jump: true,
      swing: true,
      sneak: true,
      interval: 15000,
      ...options,
    };
    this.running = false;
    this.timers = new Map(); // actionName -> active timer ID
    this.origin = null; // Set when start() is called
  }

  /** Start all anti-AFK behaviors */
  start() {
    if (this.running || !this.options.enabled) return;
    this.running = true;

    // Record origin position
    if (this.bot?.entity?.position) {
      this.origin = {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      };
    }

    logger.info('Anti-AFK started');

    const base = this.options.interval;

    // Use setTimeout with re-randomized delays to avoid periodic patterns
    const scheduleAction = (name, fn, baseDelay, jitterMs) => {
      const tick = () => {
        if (!this.running) return;
        fn();
        const timer = setTimeout(tick, baseDelay + this._jitter(jitterMs));
        this.timers.set(name, timer);
      };
      const timer = setTimeout(tick, baseDelay + this._jitter(jitterMs));
      this.timers.set(name, timer);
    };

    if (this.options.walk) {
      scheduleAction('walk', () => this._boundedWalk(), base, 3000);
    }

    if (this.options.look) {
      scheduleAction('look', () => this._randomLook(), base * 0.7, 2000);
    }

    if (this.options.jump) {
      scheduleAction('jump', () => this._randomJump(), base * 1.5, 5000);
    }

    if (this.options.swing) {
      scheduleAction('swing', () => this._swingArm(), base * 2, 4000);
    }

    if (this.options.sneak) {
      scheduleAction('sneak', () => this._toggleSneak(), base * 3, 5000);
    }
  }

  /** Stop all anti-AFK behaviors */
  stop() {
    if (!this.running) return;
    this.running = false;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();

    try {
      this.bot?.setControlState('forward', false);
      this.bot?.setControlState('back', false);
      this.bot?.setControlState('left', false);
      this.bot?.setControlState('right', false);
      this.bot?.setControlState('jump', false);
      this.bot?.setControlState('sneak', false);
    } catch (e) {
      // Bot may already be disconnected
    }

    logger.info('Anti-AFK stopped');
  }

  /** Get horizontal distance from origin */
  _distanceFromOrigin() {
    if (!this.origin || !this.bot?.entity?.position) return 0;
    const pos = this.bot.entity.position;
    const dx = pos.x - this.origin.x;
    const dz = pos.z - this.origin.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** Check if bot is too far from origin */
  _isTooFar() {
    return this._distanceFromOrigin() >= MAX_DRIFT;
  }

  /**
   * Walk in a bounded way. If too far from origin, walk back toward it.
   * Otherwise, do a short random walk and immediately stop.
   */
  _boundedWalk() {
    if (!this.running || !this.bot) return;
    try {
      const dist = this._distanceFromOrigin();

      if (dist >= MAX_DRIFT && this.origin) {
        // Walk back toward origin
        const pos = this.bot.entity.position;
        const dx = this.origin.x - pos.x;
        const dz = this.origin.z - pos.z;
        const yaw = Math.atan2(-dx, dz); // mineflayer yaw convention

        this.bot.look(yaw, 0, true);
        this.bot.setControlState('forward', true);

        // Walk for a very short time to return
        const walkTime = Math.min(600, dist * 200);
        setTimeout(() => {
          try {
            this.bot?.setControlState('forward', false);
          } catch (e) { /* ignore */ }
        }, walkTime);
      } else {
        // Random short walk (very short to stay within bounds)
        const yaw = Math.random() * Math.PI * 2;
        this.bot.look(yaw, 0, true);

        const directions = ['forward', 'back', 'left', 'right'];
        const dir = directions[Math.floor(Math.random() * directions.length)];

        this.bot.setControlState(dir, true);

        // Very short walk time (200-500ms) to prevent drifting beyond 2 blocks
        const walkTime = 200 + Math.random() * 300;

        setTimeout(() => {
          try {
            this.bot?.setControlState(dir, false);
            // Check if we drifted too far and correct
            if (this._isTooFar()) {
              this._returnToOrigin();
            }
          } catch (e) { /* ignore */ }
        }, walkTime);
      }
    } catch (e) {
      logger.warn(`Anti-AFK walk error: ${e.message}`);
    }
  }

  /** Return to origin position */
  _returnToOrigin() {
    if (!this.origin || !this.bot?.entity?.position) return;
    try {
      const pos = this.bot.entity.position;
      const dx = this.origin.x - pos.x;
      const dz = this.origin.z - pos.z;
      const yaw = Math.atan2(-dx, dz);
      const dist = Math.sqrt(dx * dx + dz * dz);

      this.bot.look(yaw, 0, true);
      this.bot.setControlState('forward', true);

      setTimeout(() => {
        try {
          this.bot?.setControlState('forward', false);
        } catch (e) { /* ignore */ }
      }, Math.min(800, dist * 200));
    } catch (e) {
      logger.warn(`Anti-AFK return error: ${e.message}`);
    }
  }

  /** Look in a random direction */
  _randomLook() {
    if (!this.running || !this.bot) return;
    try {
      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * Math.PI * 0.8;
      this.bot.look(yaw, pitch, true);
    } catch (e) {
      logger.warn(`Anti-AFK look error: ${e.message}`);
    }
  }

  /** Jump randomly */
  _randomJump() {
    if (!this.running || !this.bot) return;
    try {
      if (Math.random() > 0.4) {
        this.bot.setControlState('jump', true);
        setTimeout(() => {
          try {
            this.bot?.setControlState('jump', false);
          } catch (e) { /* ignore */ }
        }, 300 + Math.random() * 300);
      }
    } catch (e) {
      logger.warn(`Anti-AFK jump error: ${e.message}`);
    }
  }

  /** Swing arm */
  _swingArm() {
    if (!this.running || !this.bot) return;
    try {
      this.bot.swingArm();
    } catch (e) {
      logger.warn(`Anti-AFK swing error: ${e.message}`);
    }
  }

  /** Toggle sneak for a random duration */
  _toggleSneak() {
    if (!this.running || !this.bot) return;
    try {
      this.bot.setControlState('sneak', true);
      const sneakTime = 1000 + Math.random() * 3000;
      setTimeout(() => {
        try {
          this.bot?.setControlState('sneak', false);
        } catch (e) { /* ignore */ }
      }, sneakTime);
    } catch (e) {
      logger.warn(`Anti-AFK sneak error: ${e.message}`);
    }
  }

  /** Get a random jitter to make timing less predictable */
  _jitter(maxMs) {
    return Math.floor(Math.random() * maxMs);
  }

  /** Check if anti-AFK is currently active */
  isActive() {
    return this.running;
  }
}

module.exports = AntiAFK;

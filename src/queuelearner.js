#!/usr/bin/env node
// src/queuelearner.js - Standalone queue data collector
//
// Sits in the 2b2t queue for up to a week, recording how fast the queue moves
// into the same data/eta-learn.json file that ETALearner uses. When the queue
// position drops to RELOG_THRESHOLD it disconnects and re-queues so it never
// actually joins the server and wastes the queue slot.
//
// Usage:
//   node src/queuelearner.js              # uses .env for MC credentials
//   node src/queuelearner.js --days 3     # run for 3 days instead of 7
//
// Requires: MC_EMAIL (and auth tokens in data/auth/) set in .env

const mc = require('minecraft-protocol');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const ETALearner = require('./eta-learner');

// ─── Configuration ───────────────────────────────────────────────────────────

/** Position threshold: disconnect and re-queue when position drops to this */
const RELOG_THRESHOLD = 30;

/** Delay (ms) before re-queuing after a disconnect */
const RECONNECT_DELAY = 60_000; // 1 minute

/** How long to run (ms). Default 7 days, overridden with --days N */
const runDays = (() => {
  const idx = process.argv.indexOf('--days');
  return idx !== -1 && process.argv[idx + 1] ? Number(process.argv[idx + 1]) : 7;
})();
const RUN_DURATION = runDays * 24 * 3600 * 1000;

// ─── State ───────────────────────────────────────────────────────────────────

const learner = new ETALearner();
const startedAt = Date.now();
let client = null;
let lastPosition = null;
let sessionActive = false;
let stopping = false;
let reconnectTimer = null;
let sessionCount = 0;

// ─── Chat text extraction (mirrors ProxyManager._extractChatText) ────────────

function extractChatText(component) {
  if (component == null) return '';
  if (typeof component === 'string') {
    try { return extractChatText(JSON.parse(component)); }
    catch { return component; }
  }
  if (typeof component !== 'object') return String(component);

  if (component.type === 'compound' && component.value)
    return extractChatText(component.value);
  if (component.type === 'string' && typeof component.value === 'string')
    return component.value;
  if (component.type === 'list' && component.value) {
    const inner = component.value;
    if (Array.isArray(inner)) return inner.map(extractChatText).join('');
    if (inner.value && Array.isArray(inner.value))
      return inner.value.map(extractChatText).join('');
    return extractChatText(inner);
  }

  let result = '';
  if ('text' in component) result += extractChatText(component.text);
  if (component.translate && !('text' in component))
    result += extractChatText(component.translate);
  if (component.extra) {
    if (Array.isArray(component.extra))
      for (const c of component.extra) result += extractChatText(c);
    else result += extractChatText(component.extra);
  }
  if (component.with) {
    if (Array.isArray(component.with))
      for (const c of component.with) result += extractChatText(c);
    else result += extractChatText(component.with);
  }
  return result;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function timeLeft() {
  const remaining = RUN_DURATION - (Date.now() - startedAt);
  const h = Math.floor(remaining / 3_600_000);
  const m = Math.floor((remaining % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function savePartialSession() {
  // Record whatever we have even if the queue didn't finish
  // (the learner's recordCompletedSession has safeguards for short sessions)
  if (sessionActive) {
    learner.recordCompletedSession();
    sessionActive = false;
  }
}

function disconnect(reason) {
  if (client) {
    try { client.end(reason); } catch { /* ignore */ }
    client = null;
  }
}

function scheduleReconnect() {
  if (stopping) return;
  if (Date.now() - startedAt >= RUN_DURATION) {
    logger.info('Run duration reached. Shutting down.');
    shutdown();
    return;
  }
  logger.info(`Reconnecting in ${RECONNECT_DELAY / 1000}s ... (${timeLeft()} remaining)`);
  reconnectTimer = setTimeout(connectToQueue, RECONNECT_DELAY);
}

function connectToQueue() {
  if (stopping) return;
  if (Date.now() - startedAt >= RUN_DURATION) {
    logger.info('Run duration reached. Shutting down.');
    shutdown();
    return;
  }

  lastPosition = null;
  sessionActive = false;
  let positionError = false;
  let finishedQueue = false;

  sessionCount++;
  logger.info(`─── Session #${sessionCount} starting (${timeLeft()} remaining) ───`);

  const options = {
    host: config.server.host,
    port: config.server.port,
    version: config.mc.version,
    profilesFolder: config.mc.profilesFolder,
  };

  if (config.mc.email) {
    options.username = config.mc.email;
    options.auth = config.mc.authType;
    options.onMsaCode = (data) => {
      logger.info(`Microsoft Auth: Go to ${data.verification_uri} — code: ${data.user_code}`);
      try { require('open')(data.verification_uri).catch(() => {}); } catch { /* ignore */ }
    };
  } else {
    logger.error('MC_EMAIL is required. Set it in .env');
    process.exit(1);
  }

  try {
    client = mc.createClient(options);
  } catch (err) {
    logger.error(`Failed to create client: ${err.message}`);
    scheduleReconnect();
    return;
  }

  client.on('session', (session) => {
    const name = session?.selectedProfile?.name || config.mc.email;
    logger.info(`Authenticated as ${name}`);
  });

  client.on('packet', (data, meta) => {
    if (meta.name === 'playerlist_header') {
      if (finishedQueue) return;

      let pos = null;
      try {
        const text = extractChatText(data.header);
        const match = text.match(/position in queue:\s*(\d+)/i);
        if (match) pos = parseInt(match[1], 10);
      } catch (e) {
        if (!positionError) {
          logger.warn('Could not parse queue position from tab header.');
          positionError = true;
        }
      }

      if (pos == null) return;

      // First position of this session → start tracking
      if (!sessionActive) {
        learner.beginSession(pos);
        sessionActive = true;
        logger.info(`Queue entered at position #${pos}`);
      }

      // Record every position update
      if (pos !== lastPosition) {
        learner.recordSample(pos);
        logger.info(`Position: #${pos}`);
        lastPosition = pos;
      }

      // Close to the front → save data and re-queue
      if (pos <= RELOG_THRESHOLD) {
        logger.info(`Position #${pos} ≤ ${RELOG_THRESHOLD} — saving session and re-queueing`);
        savePartialSession();
        disconnect('Re-queueing for data collection');
        // Don't wait for 'end' event here; scheduleReconnect is idempotent
        scheduleReconnect();
      }
    }

    if (meta.name === 'chat' || meta.name === 'system_chat' || meta.name === 'profileless_chat') {
      if (finishedQueue) return;
      let msg = '';
      try {
        const raw = data.content || data.formattedMessage || data.message || '';
        msg = extractChatText(raw);
      } catch { msg = ''; }

      if (msg.includes('Connected to the server')) {
        // Somehow made it through — save and disconnect immediately
        finishedQueue = true;
        logger.info('Queue finished (connected to server). Saving session and disconnecting.');
        learner.recordCompletedSession();
        sessionActive = false;
        disconnect('Data collection only — not playing');
        scheduleReconnect();
      }
    }
  });

  const onDisconnect = (reason) => {
    // Guard against double-fire
    if (!client) return;
    client = null;
    const msg = reason?.message || reason || 'Unknown';
    logger.warn(`Disconnected: ${msg}`);
    savePartialSession();
    scheduleReconnect();
  };

  client.on('end', onDisconnect);
  client.on('error', onDisconnect);
}

function shutdown() {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  savePartialSession();
  disconnect('Shutting down');
  const elapsed = Math.round((Date.now() - startedAt) / 3_600_000 * 10) / 10;
  logger.info(`Queue learner finished after ${elapsed}h — ${learner.sessions.length} total sessions stored`);
  process.exit(0);
}

// ─── Main ────────────────────────────────────────────────────────────────────

logger.info('╔══════════════════════════════════════════════╗');
logger.info('║         2Bored2Tolerate Queue Learner        ║');
logger.info('╠══════════════════════════════════════════════╣');
logger.info(`║  Duration:  ${String(runDays).padEnd(4)} days                        ║`);
logger.info(`║  Relog at:  position ≤ ${String(RELOG_THRESHOLD).padEnd(4)}                  ║`);
logger.info(`║  Server:    ${String(config.server.host).padEnd(30).slice(0, 30)}    ║`);
logger.info(`║  Account:   ${String(config.mc.email || '(none)').padEnd(30).slice(0, 30)}    ║`);
logger.info(`║  Sessions:  ${String(learner.sessions.length).padEnd(4)} already stored             ║`);
logger.info('╚══════════════════════════════════════════════╝');

// Graceful shutdown
process.on('SIGINT', () => { logger.info('SIGINT received'); shutdown(); });
process.on('SIGTERM', () => { logger.info('SIGTERM received'); shutdown(); });

connectToQueue();

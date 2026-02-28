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
//   node src/queuelearner.js --relog 50   # relog when position <= 50
//
// Requires: MC_EMAIL (and auth tokens in data/auth/) set in .env

const mc         = require('minecraft-protocol');
const config     = require('./config');
const logger     = require('./logger');
const ETALearner = require('./eta-learner');

// ── CLI flags ────────────────────────────────────────────────────────────────
function getFlag(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const val = Number(process.argv[idx + 1]);
  return isNaN(val) ? fallback : val;
}

const MAX_DAYS        = getFlag('--days',  7);
const RELOG_THRESHOLD = getFlag('--relog', 30);
const STATUS_INTERVAL = 30_000;   // ms between [STATUS] lines
const RUN_DURATION_MS = MAX_DAYS * 24 * 60 * 60 * 1000;

const learner = new ETALearner();
learner.load();

// ── Session state ─────────────────────────────────────────────────────────────
let client          = null;
let statusTimer     = null;
let sessionEntryPos = null;
let sessionEntryMs  = null;
let posAtLastStatus = null;
let currentPos      = null;
let reconnectTimer  = null;
const startMs       = Date.now();

// ── Helpers ───────────────────────────────────────────────────────────────────
function hm(ms) {
  if (ms < 0) ms = 0;
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return m + 'm';
  return h + 'h ' + m + 'm';
}

function sessionRate() {
  if (sessionEntryMs === null || sessionEntryPos === null || currentPos === null) return null;
  const elapsedHr = (Date.now() - sessionEntryMs) / 3_600_000;
  if (elapsedHr < 0.005) return null;          // too soon (<18 s)
  const moved = sessionEntryPos - currentPos;
  if (moved <= 0) return null;
  return moved / elapsedHr;                    // pos/hr
}

function rateStr(rate, pos) {
  if (rate == null || rate <= 0) return null;
  const msLeft = (pos / rate) * 3_600_000;
  return Math.round(rate) + ' pos/hr  (~' + hm(msLeft) + ' to pos 0)';
}

function printStatus() {
  if (currentPos === null) return;
  const rate     = sessionRate();
  const hist     = learner._getHistoricalRate(new Date());
  const histRate = hist ? hist.rate              : null;
  const histEss  = hist ? hist.effectiveSessions : 0;
  const moved    = (posAtLastStatus !== null && currentPos !== null)
    ? (posAtLastStatus - currentPos) : '?';
  const sessions = learner.sessions.length;
  const running  = hm(Date.now() - startMs);
  const eta      = (rate && rate > 0) ? hm((currentPos / rate) * 3_600_000) : '?';

  const obsStr  = rate     ? Math.round(rate)     + ' pos/hr' : 'n/a';
  const histStr = histRate
    ? Math.round(histRate) + ' pos/hr (' + Math.round(histEss) + ' eff.)'
    : 'n/a';

  logger.info('[STATUS] #' + currentPos +
    '  |  observed: '   + obsStr +
    '  |  historical: '  + histStr +
    '  |  moved '       + moved + ' in last 30s' +
    '  |  stored: '     + sessions + ' sessions' +
    '  |  '             + running + ' running' +
    '  |  ~'            + eta + ' left');

  posAtLastStatus = currentPos;
}

function startStatusTicker() {
  if (statusTimer) clearInterval(statusTimer);
  posAtLastStatus = currentPos;
  statusTimer = setInterval(printStatus, STATUS_INTERVAL);
}

function stopStatusTicker() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

// ── Connect ───────────────────────────────────────────────────────────────────
function connectToQueue() {
  logger.info('Connecting to ' + config.server.host + ':' + config.server.port + ' ...');

  const options = {
    host:     config.server.host,
    port:     config.server.port,
    username: config.mc.email,
    version:  config.mc.version,
    auth:     config.mc.authType,
  };
  if (config.mc.profilesFolder) options.profilesFolder = config.mc.profilesFolder;

  client = mc.createClient(options);

  client.on('login', () => {
    logger.info('Logged in — waiting for queue position ...');
  });

  client.on('chat', (packet) => {
    // 2b2t sends queue position in chat as JSON text; parse it roughly
    let raw = '';
    try { raw = JSON.parse(packet.message).text || ''; } catch (_) { raw = packet.message || ''; }

    const posMatch = raw.match(/Position in queue: (\d+)/i) ||
                     raw.match(/queue position[:\s]+(\d+)/i);
    if (!posMatch) return;

    const pos = parseInt(posMatch[1], 10);
    currentPos = pos;

    if (sessionEntryPos === null) {
      // First position reading this session — record queue entry
      sessionEntryPos = pos;
      sessionEntryMs  = Date.now();
      startStatusTicker();

      const hist    = learner._getHistoricalRate(new Date());
      const histStr = hist
        ? '  |  historical ~' + Math.round(hist.rate) + ' pos/hr (' +
          Math.round(hist.effectiveSessions) + ' eff. sessions)'
        : '';
      logger.info('Queue entered at #' + pos + histStr);
      return;
    }

    const rate = sessionRate();
    const rs   = rateStr(rate, pos);
    logger.info('Position: #' + pos + (rs ? '  |  ' + rs : ''));

    if (pos <= RELOG_THRESHOLD) {
      const durationMs = Date.now() - sessionEntryMs;
      const r          = sessionRate();
      const summary    = r
        ? '~' + hm(durationMs) + ' session, ~' + Math.round(r) + ' pos/hr'
        : '~' + hm(durationMs) + ' session';
      logger.info('Position #' + pos + ' <= ' + RELOG_THRESHOLD +
        ' — saving session and re-queueing  (' + summary + ')');
      learner.recordSession(sessionEntryMs, sessionEntryPos, pos);
      learner.save();
      stopStatusTicker();
      sessionEntryPos = null;
      sessionEntryMs  = null;
      client.end();
    }
  });

  client.on('error', (err) => {
    logger.error('Client error: ' + err.message);
    onDisconnect(err);
  });

  client.on('end', (reason) => {
    onDisconnect({ message: reason || 'end' });
  });

  client.on('kick_disconnect', (packet) => {
    let reason = packet.reason;
    try { reason = JSON.parse(reason).text || reason; } catch (_) {}
    logger.warn('Kicked: ' + reason);
    onDisconnect({ message: 'kicked: ' + reason });
  });
}

function onDisconnect(reason) {
  if (!client) return;  // guard double-fire
  client = null;
  stopStatusTicker();
  const msg = (reason && reason.message) || String(reason) || 'Unknown reason';
  logger.warn('Disconnected: ' + msg);

  // Save partial session data if meaningful progress was made
  if (sessionEntryPos !== null && currentPos !== null && currentPos < sessionEntryPos) {
    learner.recordSession(sessionEntryMs, sessionEntryPos, currentPos);
    learner.save();
    logger.info('Partial session saved (#' + sessionEntryPos + ' -> #' + currentPos + ')');
  }
  sessionEntryPos = null;
  sessionEntryMs  = null;
  currentPos      = null;

  const elapsed = Date.now() - startMs;
  if (elapsed >= RUN_DURATION_MS) {
    logger.info('Run duration of ' + MAX_DAYS + 'd reached — exiting.');
    shutdown();
    return;
  }

  const delay = 30_000;
  logger.info('Re-connecting in 30s ...');
  reconnectTimer = setTimeout(connectToQueue, delay);
}

// ── Shutdown ──────────────────────────────────────────────────────────────────
function shutdown() {
  stopStatusTicker();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (client)         { client.end(); client = null; }
  learner.save();
  logger.info('queuelearner shut down.');
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────
logger.info('=== queuelearner starting ===');
logger.info('Account : ' + config.mc.email);
logger.info('Server  : ' + config.server.host + ':' + config.server.port);
logger.info('Run for : ' + MAX_DAYS + 'd max, relog at <= #' + RELOG_THRESHOLD);
logger.info('Sessions: ' + learner.sessions.length + ' loaded');

connectToQueue();

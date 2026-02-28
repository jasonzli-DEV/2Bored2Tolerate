// src/proxy.js - Core Minecraft proxy and queue management
const EventEmitter = require('events');
const mc = require('minecraft-protocol');
const mcproxy = require('@rob9315/mcproxy');
const { DateTime } = require('luxon');
const { version: APP_VERSION } = require('../package.json');
const everpolate = require('everpolate');
const notifier = require('node-notifier');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const AntiAFK = require('./antiafk');
const ETALearner = require('./eta-learner');

const QUEUE_DATA_PATH = path.join(__dirname, '..', 'data', 'queue.json');
const C = 150; // Constant for queue time estimation

class ProxyManager extends EventEmitter {
  constructor() {
    super();

    // Connections
    this.conn = null;
    this.client = null;
    this.server = null;
    this.proxyClient = null;
    this.antiAfk = null;

    // Queue tracking
    this.finishedQueue = false;
    this.stoppedByPlayer = false;
    this.queueStartPlace = null;
    this.queueStartTime = null;
    this.notificationSent = false;
    this.reconnectTimer = null;
    this.queueHistory = [];
    this.antiAfkPending = false; // User wants anti-AFK but not on server yet

    // Ensure data directories exist
    this._ensureDataDirs();

    // Smart ETA learner (loads historical data on construction)
    this.etaLearner = new ETALearner();

    // Load queue data for ETA estimation
    try {
      this.queueData = JSON.parse(fs.readFileSync(QUEUE_DATA_PATH, 'utf-8'));
    } catch {
      this.queueData = {
        place: [257, 789, 93, 418, 666, 826, 231, 506, 550, 207, 586, 486, 412, 758],
        factor: [
          0.9999291667668093, 0.9999337457796981, 0.9998618838664679,
          0.9999168965649361, 0.9999219189483673, 0.9999279556964097,
          0.9999234240704379, 0.9999262577896301, 0.9999462301738332,
          0.9999220416881794, 0.999938895110192, 0.9999440195022513,
          0.9999410569845172, 0.9999473463335498,
        ],
      };
    }

    // Proxy state
    this.state = {
      isInQueue: false,
      queuePlace: 'None',
      eta: 'None',
      finTime: 'Never',
      restartQueue: config.restartQueue,
      doing: 'idle',
      connected: false,
      username: null,
      antiAfkActive: false,
      health: null,
      food: null,
      uptime: null,
      startTime: null,
    };

    this._logs = [];
  }

  /** Ensure data directories exist */
  _ensureDataDirs() {
    const dataDir = path.join(__dirname, '..', 'data');
    const authDir = config.mc.profilesFolder;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.mkdirSync(authDir, { recursive: true });
    } catch (e) {
      // ignore if already exists
    }
  }

  /** Update state and emit change event */
  _updateState(changes) {
    Object.assign(this.state, changes);
    this.emit('stateChange', { ...this.state });
  }

  /** Add a log entry and emit */
  _log(message, level = 'info') {
    const entry = {
      time: new Date().toISOString(),
      message,
      level,
    };
    this._logs.push(entry);
    if (this._logs.length > 200) this._logs.shift();
    this.emit('log', entry);
    logger[level](message);
  }

  /** Get current state snapshot */
  getState() {
    return {
      ...this.state,
      logs: this._logs.slice(-50),
      queueHistory: this.queueHistory.slice(), // full history for client-side timeframe filtering
      proxyAddress: `localhost:${config.proxy.port}`,
      version: APP_VERSION,
      etaLearnedSessions: this.etaLearner.sessions.length,
    };
  }

  /** Start the queueing process */
  start() {
    if (this.state.isInQueue) {
      this._log('Already in queue', 'warn');
      return;
    }

    this.stoppedByPlayer = false;
    this._log('Starting queue...');
    this.queueHistory = []; // Reset chart history for each fresh queue session
    this._cleanup();

    // Check for cached auth tokens
    this._checkCachedAuth();

    this._updateState({
      doing: 'auth',
      isInQueue: true,
      startTime: Date.now(),
    });

    const options = {
      host: config.server.host,
      port: config.server.port,
      version: config.mc.version,
      profilesFolder: config.mc.profilesFolder,
    };

    // Set auth options
    if (config.mc.email) {
      options.username = config.mc.email;
      options.auth = config.mc.authType;

      // Microsoft auth device code flow: user needs to visit a URL to sign in
      options.onMsaCode = (data) => {
        const msg = `Sign in at ${data.verification_uri} with code: ${data.user_code}`;
        this._log(msg);
        logger.info('──────────────────────────────────────────');
        logger.info(`Microsoft Auth: Go to ${data.verification_uri}`);
        logger.info(`Enter code: ${data.user_code}`);
        logger.info('──────────────────────────────────────────');

        // Try to open the URL in the default browser
        try {
          const open = require('open');
          open(data.verification_uri).catch(() => {});
        } catch { /* ignore if open not available */ }
      };
    } else {
      options.username = config.proxy.offlineUsername;
    }

    try {
      this.conn = new mcproxy.Conn(options);
      this.client = this.conn.client || this.conn.bot._client;
    } catch (err) {
      this._log(`Failed to create proxy connection: ${err.message}`, 'error');
      this._updateState({ doing: 'idle', isInQueue: false });
      return;
    }

    // Attach error listener immediately to catch async auth/connection errors
    this.client.on('error', (err) => {
      // Will be handled by _setupQueueHandling's onDisconnect once attached
      if (!this._queueHandlingSetup) {
        this._log(`Connection error: ${err.message}`, 'error');
        this._cleanup();
        this._updateState({ doing: 'idle', isInQueue: false });
      }
    });

    this._queueHandlingSetup = false;
    this._setupQueueHandling();
    this._queueHandlingSetup = true;
    this._setupLocalServer();
  }

  /** Stop the queue and disconnect everything */
  stop() {
    this.stoppedByPlayer = true;
    this.antiAfkPending = false;
    this._cleanup();
    this._updateState({
      isInQueue: false,
      queuePlace: 'None',
      eta: 'None',
      finTime: 'Never',
      doing: 'idle',
      connected: false,
      health: null,
      food: null,
    });
    this._log('Queue stopped');
    this.emit('stopped');
  }

  /** Toggle restart-on-disconnect behavior */
  toggleRestart() {
    this.state.restartQueue = !this.state.restartQueue;
    this._updateState({ restartQueue: this.state.restartQueue });
    this._log(`Auto-restart ${this.state.restartQueue ? 'enabled' : 'disabled'}`);
  }

  /** Toggle anti-AFK */
  toggleAntiAfk() {
    if (this.antiAfk?.isActive()) {
      // Currently running - stop it
      this.antiAfk.stop();
      this.antiAfkPending = false;
      this._updateState({ antiAfkActive: false });
    } else if (this.antiAfk) {
      // Bot is on server but anti-AFK isn't running - start it
      this.antiAfk.start();
      this.antiAfkPending = true;
      this._updateState({ antiAfkActive: true });
    } else {
      // Not on server yet (still in queue) - toggle the pending flag
      this.antiAfkPending = !this.antiAfkPending;
      this._updateState({ antiAfkActive: this.antiAfkPending });
      if (this.antiAfkPending) {
        this._log('Anti-AFK enabled (will activate after queue)');
      } else {
        this._log('Anti-AFK disabled');
      }
    }
  }

  /** Internal: clean up all connections and timers */
  _cleanup() {
    this.finishedQueue = false;
    this.notificationSent = false;

    if (this.antiAfk) {
      this.antiAfk.stop();
      this.antiAfk = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      try { this.client.end(); } catch (e) { /* ignore */ }
      this.client = null;
    }

    if (this.proxyClient) {
      try { this.proxyClient.end('Proxy stopped.'); } catch (e) { /* ignore */ }
      this.proxyClient = null;
    }

    if (this.server) {
      try { this.server.close(); } catch (e) { /* ignore */ }
      this.server = null;
    }

    this.conn = null;
  }

  /** Internal: set up queue packet handling */
  _setupQueueHandling() {
    let lastQueuePlace = 'None';
    let positionError = false;

    this._updateState({ doing: 'queue' });
    this._log('Waiting in queue...');

    // Listen for successful login (auth complete)
    this.client.on('session', (session) => {
      const username = session?.selectedProfile?.name || config.mc.email;
      this._log(`Authenticated as ${username}`);
      this._updateState({ username });
    });

    this.client.on('packet', (data, meta) => {
      switch (meta.name) {
        case 'playerlist_header': {
          if (this.finishedQueue) break;

          let positionInQueue = 'None';
          try {
            // In MC 1.21.4, header is an NBT compound (structured chat component),
            // not a plain string. We must recursively extract all text values.
            const headerText = this._extractChatText(data.header);

            // Extract position from "Position in queue: XXX"
            const match = headerText.match(/position in queue:\s*(\d+)/i);
            if (match) {
              positionInQueue = parseInt(match[1], 10);
            }
          } catch (e) {
            if (!positionError) {
              this._log('Could not read queue position from tab header.', 'warn');
              positionError = true;
            }
          }

          if (positionInQueue !== 'None') {
            // Track queue start
            if (lastQueuePlace === 'None') {
              this.queueStartPlace = positionInQueue;
              this.queueStartTime = DateTime.local();
              this.etaLearner.beginSession(positionInQueue);
              this._log(`ETA learner: ${this.etaLearner.summary()}`);
            }

            // Feed sample to live rate tracker
            this.etaLearner.recordSample(positionInQueue);

            if (lastQueuePlace !== positionInQueue) {
              // Calculate base ETA from exponential decay model
              const totalWait = this._getWaitTime(this.queueStartPlace, 0);
              const elapsed = this._getWaitTime(this.queueStartPlace, positionInQueue);
              const baseMinutes = (totalWait - elapsed) / 60;

              // Blend with learned data
              const etaMinutes = this.etaLearner.estimateMinutes(positionInQueue, baseMinutes);

              const eta = `${Math.floor(etaMinutes / 60)}h ${Math.floor(etaMinutes % 60)}m`;
              const finTime = new Date(Date.now() + etaMinutes * 60000).toISOString();

              // Update MC server MOTD
              if (this.server) {
                try {
                  this.server.motd = `Position: ${positionInQueue} | ETA: ${eta}`;
                } catch (e) { /* ignore */ }
              }

              // Track history for chart (keep up to 720 data points ≈ 12h at 1/min)
              this.queueHistory.push({
                time: Date.now(),
                position: positionInQueue,
              });
              if (this.queueHistory.length > 720) this.queueHistory.shift();

              this._updateState({
                queuePlace: positionInQueue,
                eta,
                finTime,
              });

              this._log(`Queue position: ${positionInQueue} | ETA: ${eta}`);
              this.emit('queueUpdate', { position: positionInQueue, eta, finTime });

              // Desktop notification
              if (
                config.notifications.enabled &&
                positionInQueue <= config.notifications.threshold &&
                !this.notificationSent
              ) {
                notifier.notify({
                  title: '2Bored2Tolerate',
                  message: `Queue position: ${positionInQueue}! Almost there!`,
                  sound: true,
                  wait: true,
                });
                this.notificationSent = true;
              }
            }

            lastQueuePlace = positionInQueue;
          }

          break;
        }

        case 'chat':
        case 'system_chat':
        case 'profileless_chat': {
          if (this.finishedQueue) break;

          let chatMessage = '';
          try {
            // In MC 1.21.4, content is an NBT compound, not a JSON string.
            const raw = data.content || data.formattedMessage || data.message || '';
            chatMessage = this._extractChatText(raw);
          } catch {
            chatMessage = '';
          }

          if (chatMessage.includes('Queued for server') || chatMessage.includes('already queued')) {
            this._log(`Server: ${chatMessage}`);
          }

          if (chatMessage.includes('Connected to the server')) {
            this._handleQueueFinished();
          }
          break;
        }
      }
    });

    // Handle disconnection
    const onDisconnect = (reason) => {
      // Guard against double-fire (error then end) and intentional cleanup
      if (!this.conn) return;
      if (this.reconnectTimer) return;

      const msg = reason?.message || reason || 'Unknown reason';
      this._log(`Disconnected: ${msg}`, 'warn');

      if (this.proxyClient) {
        try {
          this.proxyClient.end('Connection reset by server. Reconnecting...');
        } catch (e) { /* ignore */ }
        this.proxyClient = null;
      }

      if (this.antiAfk) {
        this.antiAfk.stop();
        this.antiAfk = null;
      }

      this._updateState({
        isInQueue: false,
        connected: false,
        antiAfkActive: false,
      });

      if (!this.stoppedByPlayer && config.reconnectOnError) {
        this._log('Reconnecting in 30 seconds...');
        this._updateState({ doing: 'reconnecting' });
        this.reconnectTimer = setTimeout(() => this._reconnect(), 30000);
      }
    };

    this.client.on('end', onDisconnect);
    this.client.on('error', onDisconnect);
  }

  /** Internal: handle queue completion */
  _handleQueueFinished() {
    this._log('Queue finished! Connected to server.');

    // Record this session so ETA estimates improve over time
    this.etaLearner.recordCompletedSession();

    // Save queue data for ETA improvement
    if (config.expandQueueData && this.queueStartPlace && this.queueStartTime) {
      this.queueData.place.push(this.queueStartPlace);
      const elapsed = DateTime.local().toSeconds() - this.queueStartTime.toSeconds();
      const b = Math.pow(C / (this.queueStartPlace + C), 1 / elapsed);
      this.queueData.factor.push(b);
      fs.writeFile(QUEUE_DATA_PATH, JSON.stringify(this.queueData), 'utf-8', (err) => {
        if (err) logger.error(`Failed to save queue data: ${err.message}`);
      });
    }

    if (this.state.restartQueue && !this.proxyClient) {
      this._log('No client connected and restart enabled. Restarting queue...');
      this._cleanup();
      this._reconnect();
      return;
    }

    this.finishedQueue = true;
    this._updateState({
      queuePlace: 'DONE',
      eta: 'NOW',
      doing: 'connected',
      connected: true,
    });

    // Track player health/food updates
    if (this.conn?.bot) {
      this.conn.bot.on('health', () => {
        this._updateState({
          health: this.conn?.bot?.health ?? null,
          food: this.conn?.bot?.food ?? null,
        });
      });
    }

    // Start anti-AFK if no player is connected
    this._tryStartAntiAfk();

    this.emit('queueFinished');
  }

  /** Internal: set up the local MC server */
  _setupLocalServer() {
    let faviconBase64 = config.favicon;
    if (!faviconBase64) {
      try {
        const faviconPath = path.join(__dirname, '..', 'favicon.png');
        faviconBase64 = fs.readFileSync(faviconPath).toString('base64');
      } catch {
        // No favicon available
      }
    }

    this.server = mc.createServer({
      'online-mode': config.proxy.onlineMode,
      encryption: true,
      host: config.proxy.bind,
      port: config.proxy.port,
      version: config.mc.version,
      'max-players': 1,
      motd: 'Waiting in queue...',
      favicon: faviconBase64 ? `data:image/png;base64,${faviconBase64}` : undefined,
    });

    this.server.on('login', (newProxyClient) => {
      this._log(`Player connected: ${newProxyClient.username}`);

      // Whitelist check
      if (config.proxy.whitelist && this.client && this.client.uuid !== newProxyClient.uuid) {
        newProxyClient.end('Not whitelisted! Use the same account as the proxy.');
        this._log(`Rejected ${newProxyClient.username}: not whitelisted`, 'warn');
        return;
      }

      // Forward player packets to server
      newProxyClient.on('packet', (_, meta, rawData) => {
        this._filterAndSend(rawData, meta, this.client);
      });

      newProxyClient.on('end', () => {
        this._log('Player disconnected');
        this.proxyClient = null;
        this._updateState({ connected: false });
        this._tryStartAntiAfk();
      });

      // Stop anti-AFK when player connects
      if (this.antiAfk) {
        this.antiAfk.stop();
        this._updateState({ antiAfkActive: false });
      }

      // Send cached packets and link
      try {
        this.conn.sendPackets(newProxyClient);
        this.conn.link(newProxyClient);
        this.proxyClient = newProxyClient;

        this._updateState({
          connected: true,
          username: newProxyClient.username,
        });
      } catch (err) {
        this._log(`Failed to link player: ${err.message}`, 'error');
        newProxyClient.end('Failed to link connection.');
      }
    });

    this.server.on('error', (err) => {
      this._log(`Local server error: ${err.message}`, 'error');
    });
  }

  /** Internal: attempt to start anti-AFK (only when bot is on server and no player is connected) */
  _tryStartAntiAfk() {
    // Only start if enabled in config OR user toggled it on (pending)
    if (!config.antiAfk.enabled && !this.antiAfkPending) return;
    // NEVER start anti-AFK when a real player is connected and playing
    if (this.proxyClient) return;
    // Only start after queue is finished (bot is on the actual server)
    if (!this.finishedQueue) return;

    if (this.conn?.bot) {
      this.antiAfk = new AntiAFK(this.conn.bot, config.antiAfk);
      this.antiAfk.start();
      this.antiAfkPending = true;
      this._updateState({ antiAfkActive: true });
    }
  }

  /** Internal: reconnect to the server */
  _reconnect() {
    if (this.stoppedByPlayer) {
      this.stoppedByPlayer = false;
      return;
    }

    this._log('Attempting reconnect...');
    this._updateState({ doing: 'reconnecting' });

    mc.ping(
      {
        host: config.server.host,
        port: config.server.port,
      },
      (err) => {
        // User may have called stop() while the ping was in flight – respect that
        if (this.stoppedByPlayer) return;
        if (err) {
          this._log('Server not responding, retrying in 3s...', 'warn');
          this.reconnectTimer = setTimeout(() => this._reconnect(), 3000);
        } else {
          this._log('Server is up, starting queue...');
          this.start();
        }
      }
    );
  }

  /** Internal: filter and send packets (skip keep_alive/update_time to avoid double-response) */
  _filterAndSend(data, meta, dest) {
    if (!dest) return;
    if (meta.name !== 'keep_alive' && meta.name !== 'update_time') {
      try {
        dest.writeRaw(data);
      } catch (e) {
        // Connection may have closed
      }
    }
  }

  /** Check for cached Microsoft auth tokens and log status */
  _checkCachedAuth() {
    if (!config.mc.email || config.mc.authType !== 'microsoft') return;
    try {
      const files = fs.readdirSync(config.mc.profilesFolder).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        this._log(`Found cached auth in ${config.mc.profilesFolder} – attempting token reuse (no sign-in needed unless expired)`);
      } else {
        this._log('No cached auth tokens found – Microsoft device-code sign-in will be required');
      }
    } catch {
      // Folder doesn't exist yet; auth will create it
      this._log('No cached auth tokens found – Microsoft device-code sign-in will be required');
    }
  }

  /** Internal: calculate wait time using exponential decay model */
  _getWaitTime(queueLength, queuePos) {
    const b = everpolate.linear(queueLength, this.queueData.place, this.queueData.factor)[0];
    return Math.log((queuePos + C) / (queueLength + C)) / Math.log(b);
  }

  /** Get player health/food if connected */
  getPlayerStats() {
    if (!this.conn?.bot) return null;
    return {
      health: this.conn.bot.health ?? null,
      food: this.conn.bot.food ?? null,
    };
  }

  /**
   * Extract plain text from a Minecraft chat component.
   * In MC 1.21.4+, chat components are NBT compounds like:
   *   { type: "compound", value: { text: { type: "string", value: "..." }, extra: { type: "list", value: { type: "compound", value: [...] } } } }
   * In older versions, they may be JSON strings or simple { text: "..." } objects.
   * This method handles all formats recursively.
   */
  _extractChatText(component) {
    if (component == null) return '';
    if (typeof component === 'string') {
      // Could be a plain string or a JSON-encoded chat component
      try {
        const parsed = JSON.parse(component);
        return this._extractChatText(parsed);
      } catch {
        return component;
      }
    }
    if (typeof component !== 'object') return String(component);

    let result = '';

    // NBT compound: { type: "compound", value: { text: {...}, extra: {...} } }
    if (component.type === 'compound' && component.value) {
      return this._extractChatText(component.value);
    }

    // NBT string: { type: "string", value: "hello" }
    if (component.type === 'string' && typeof component.value === 'string') {
      return component.value;
    }

    // NBT list: { type: "list", value: { type: "compound", value: [...] } }
    if (component.type === 'list' && component.value) {
      const inner = component.value;
      if (Array.isArray(inner)) {
        return inner.map(item => this._extractChatText(item)).join('');
      }
      // Nested: { type: "compound", value: [...array of items...] }
      if (inner.value && Array.isArray(inner.value)) {
        return inner.value.map(item => this._extractChatText(item)).join('');
      }
      return this._extractChatText(inner);
    }

    // Standard chat component: { text: "...", extra: [...] }
    // Also handles NBT unwrapped objects like { text: { type: "string", value: "..." }, extra: { type: "list", ... } }
    if ('text' in component) {
      result += this._extractChatText(component.text);
    }

    // Handle translate key (translation components may contain the string directly)
    if (component.translate && !('text' in component)) {
      result += this._extractChatText(component.translate);
    }

    // Process 'extra' array (child components)
    if (component.extra) {
      if (Array.isArray(component.extra)) {
        for (const child of component.extra) {
          result += this._extractChatText(child);
        }
      } else {
        // NBT list wrapper
        result += this._extractChatText(component.extra);
      }
    }

    // Process 'with' array (translation arguments, used in some chat packets)
    if (component.with) {
      if (Array.isArray(component.with)) {
        for (const child of component.with) {
          result += this._extractChatText(child);
        }
      } else {
        result += this._extractChatText(component.with);
      }
    }

    return result;
  }
}

module.exports = ProxyManager;

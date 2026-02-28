// src/web/server.js - Express + Socket.IO web server
const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const { version: APP_VERSION } = require('../../package.json');

class WebServer {
  /**
   * @param {import('../proxy')} proxy - The proxy manager instance
   */
  constructor(proxy) {
    this.proxy = proxy;
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.io = new SocketIOServer(this.httpServer);

    this._setupRoutes();
    this._setupSocket();
  }

  /** Start the web server */
  start() {
    return new Promise((resolve, reject) => {
      this.httpServer.on('error', reject);
      this.httpServer.listen(config.web.port, config.web.bind, () => {
        logger.info(`Web dashboard: http://${config.web.bind === '0.0.0.0' ? 'localhost' : config.web.bind}:${config.web.port}`);
        resolve();
      });
    });
  }

  /** Set up Express routes */
  _setupRoutes() {
    // Serve static files
    this.app.use(express.static(path.join(__dirname, 'public')));

    // API: Check password middleware for protected routes
    const authMiddleware = (req, res, next) => {
      if (config.web.password) {
        // Express lowercases all header names
        const pw = req.headers['x-password'] || req.headers.xpassword || '';
        if (pw !== config.web.password) {
          return res.status(403).json({ error: 'Invalid password' });
        }
      }
      next();
    };

    // API: Get current state
    this.app.get('/api/state', authMiddleware, (req, res) => {
      res.json(this.proxy.getState());
    });

    // API: Start queue
    this.app.post('/api/start', authMiddleware, (req, res) => {
      this.proxy.start();
      res.json({ success: true });
    });

    // API: Stop queue
    this.app.post('/api/stop', authMiddleware, (req, res) => {
      this.proxy.stop();
      res.json({ success: true });
    });

    // API: Toggle restart
    this.app.post('/api/toggle-restart', authMiddleware, (req, res) => {
      this.proxy.toggleRestart();
      res.json({ restartQueue: this.proxy.state.restartQueue });
    });

    // API: Toggle anti-AFK
    this.app.post('/api/toggle-antiafk', authMiddleware, (req, res) => {
      this.proxy.toggleAntiAfk();
      res.json({ antiAfkActive: this.proxy.state.antiAfkActive });
    });

    // API: Get player stats
    this.app.get('/api/stats', authMiddleware, (req, res) => {
      const stats = this.proxy.getPlayerStats();
      res.json(stats || { health: null, food: null });
    });

    // Legacy endpoints (backward compatible with original 2bored2wait API)
    this.app.get('/update', authMiddleware, (req, res) => {
      const state = this.proxy.getState();
      res.json({
        username: state.username || 'undefined',
        place: state.queuePlace,
        ETA: state.eta,
        inQueue: state.isInQueue,
        restartQueue: state.restartQueue,
        isInQueue: state.isInQueue,
        finTime: state.finTime,
        queuePlace: state.queuePlace,
      });
    });

    this.app.post('/start', authMiddleware, (req, res) => {
      this.proxy.start();
      res.sendStatus(200);
    });

    this.app.post('/stop', authMiddleware, (req, res) => {
      this.proxy.stop();
      res.sendStatus(200);
    });

    this.app.post('/togglerestart', authMiddleware, (req, res) => {
      this.proxy.toggleRestart();
      res.sendStatus(200);
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', version: APP_VERSION });
    });
  }

  /** Set up Socket.IO for real-time updates */
  _setupSocket() {
    // Authentication middleware for Socket.IO
    this.io.use((socket, next) => {
      if (config.web.password) {
        const password = socket.handshake.auth.password;
        if (password !== config.web.password) {
          return next(new Error('Authentication failed'));
        }
      }
      next();
    });

    this.io.on('connection', (socket) => {
      logger.info(`Dashboard client connected (${socket.id})`);

      // Send current state on connect
      socket.emit('state', this.proxy.getState());

      // Handle commands from the dashboard
      socket.on('start', () => this.proxy.start());
      socket.on('stop', () => this.proxy.stop());
      socket.on('toggleRestart', () => this.proxy.toggleRestart());
      socket.on('toggleAntiAfk', () => this.proxy.toggleAntiAfk());

      socket.on('disconnect', () => {
        logger.info(`Dashboard client disconnected (${socket.id})`);
      });
    });

    // Forward proxy events to all connected sockets
    this.proxy.on('stateChange', (state) => {
      this.io.emit('state', {
        ...state,
        queueHistory: this.proxy.queueHistory.slice(), // full history for client-side timeframe filtering
      });
    });

    this.proxy.on('log', (entry) => {
      this.io.emit('log', entry);
    });

    this.proxy.on('queueUpdate', (data) => {
      this.io.emit('queueUpdate', data);
    });

    this.proxy.on('queueFinished', () => {
      this.io.emit('queueFinished');
    });

    this.proxy.on('stopped', () => {
      this.io.emit('stopped');
    });
  }

  /** Shutdown the web server */
  async shutdown() {
    return new Promise((resolve) => {
      this.io.close();
      this.httpServer.close(resolve);
    });
  }
}

module.exports = WebServer;

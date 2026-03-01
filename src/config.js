// src/config.js - Configuration loaded from .env
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

/** Parse an integer from a string, returning the fallback if NaN */
const intOr = (str, fallback) => { const n = parseInt(str, 10); return Number.isNaN(n) ? fallback : n; };

const config = {
  // Minecraft Account
  mc: {
    email: process.env.MC_EMAIL || '',
    authType: process.env.MC_AUTH_TYPE || 'microsoft',
    version: process.env.MC_VERSION || '1.21.4',
    profilesFolder: process.env.AUTH_PROFILES_FOLDER
      ? path.resolve(process.env.AUTH_PROFILES_FOLDER)
      : path.join(__dirname, '..', 'data', 'auth'),
  },

  // Target Server
  server: {
    host: process.env.SERVER_HOST || '2b2t.org',
    port: intOr(process.env.SERVER_PORT, 25565),
  },

  // Local Proxy Server
  proxy: {
    port: intOr(process.env.PROXY_PORT, 25565),
    bind: process.env.PROXY_BIND || '0.0.0.0',
    onlineMode: process.env.PROXY_ONLINE_MODE === 'true',
    whitelist: process.env.PROXY_WHITELIST === 'true',
    offlineUsername: process.env.PROXY_OFFLINE_USERNAME || 'Player',
  },

  // Web Dashboard
  web: {
    port: intOr(process.env.WEB_PORT, 8080),
    bind: process.env.WEB_BIND || '0.0.0.0',
    password: process.env.WEB_PASSWORD || '',
    openBrowser: process.env.OPEN_BROWSER === 'true',
  },

  // Discord Bot
  discord: {
    enabled: process.env.DISCORD_ENABLED === 'true',
    token: process.env.DISCORD_TOKEN || '',
    chat: process.env.DISCORD_CHAT !== 'false',
    notify: process.env.DISCORD_NOTIFY === 'true',
    notifyPosition: intOr(process.env.DISCORD_NOTIFY_POSITION, 20),
  },

  // Anti-AFK
  antiAfk: {
    enabled: process.env.ANTIAFK_ENABLED !== 'false',
    walk: process.env.ANTIAFK_WALK !== 'false',
    look: process.env.ANTIAFK_LOOK !== 'false',
    jump: process.env.ANTIAFK_JUMP !== 'false',
    swing: process.env.ANTIAFK_SWING !== 'false',
    sneak: process.env.ANTIAFK_SNEAK !== 'false',
    interval: intOr(process.env.ANTIAFK_INTERVAL, 15000),
  },

  // Desktop Notifications
  notifications: {
    enabled: process.env.DESKTOP_NOTIFY !== 'false',
    threshold: intOr(process.env.DESKTOP_NOTIFY_POSITION, 20),
  },

  // Behavior
  joinOnStart: process.env.JOIN_ON_START === 'true',
  reconnectOnError: process.env.RECONNECT_ON_ERROR !== 'false',
  restartQueue: process.env.RESTART_QUEUE === 'true',
  logging: process.env.LOG_ENABLED !== 'false',
  expandQueueData: process.env.EXPAND_QUEUE_DATA === 'true',
  showUsernameStatus: process.env.SHOW_USERNAME_STATUS !== 'false',
  favicon: process.env.FAVICON || '',
};

module.exports = config;

// src/discord.js - Discord bot integration
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const config = require('./config');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');
const { version: APP_VERSION } = require('../package.json');

const SAVE_PATH = path.join(__dirname, '..', 'data', 'saveid');

class DiscordBot {
  /**
   * @param {import('./proxy')} proxy - The proxy manager instance
   */
  constructor(proxy) {
    this.proxy = proxy;
    this.client = null;
    this.dcUser = null;
    this.ready = false;
    this.discordNotificationSent = false;
  }

  /** Initialize and connect the Discord bot */
  async init() {
    if (!config.discord.enabled || !config.discord.token) {
      logger.info('Discord bot disabled or no token provided');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on('ready', () => {
      logger.info(`Discord bot logged in as ${this.client.user.tag}`);
      this.ready = true;
      this._setActivity('Idle - Ready to queue');

      // Load saved user
      try {
        const savedId = fs.readFileSync(SAVE_PATH, 'utf8').trim();
        if (savedId) {
          this.client.users.fetch(savedId).then((user) => {
            this.dcUser = user;
          }).catch(() => {});
        }
      } catch {
        // No saved user
      }
    });

    this.client.on('messageCreate', (message) => {
      if (message.author.bot) return;
      if (message.author.username === this.client.user.username) return;

      this._handleCommand(message);

      // Save user for notifications
      if (!this.dcUser || message.author.id !== this.dcUser.id) {
        fs.writeFile(SAVE_PATH, message.author.id, (err) => {
          if (err) logger.error(`Failed to save Discord user: ${err.message}`);
        });
      }
      this.dcUser = message.author;
    });

    // Listen to proxy events
    this.proxy.on('stateChange', (state) => {
      if (state.doing === 'auth') {
        this.discordNotificationSent = false;
      }
      if (state.doing === 'queue' && state.queuePlace !== 'None') {
        const name = config.showUsernameStatus ? ` - ${state.username || 'Unknown'}` : '';
        this._setActivity(`P: ${state.queuePlace} | E: ${state.eta}${name}`);
      }
    });

    this.proxy.on('queueFinished', () => {
      this._setActivity('Queue finished!');
      if (config.discord.notify && this.dcUser) {
        this._sendEmbed(this.dcUser, 'Queue Complete', 'The queue is finished! Connect now!');
      }
    });

    this.proxy.on('queueUpdate', ({ position }) => {
      if (
        config.discord.notify &&
        position <= config.discord.notifyPosition &&
        this.dcUser &&
        !this.discordNotificationSent
      ) {
        this.discordNotificationSent = true;
        this._sendEmbed(
          this.dcUser,
          'Queue Alert',
          `Position: ${position}. Almost through the queue!`
        );
      }
    });

    this.proxy.on('stopped', () => {
      this._setActivity('Queue stopped');
    });

    try {
      await this.client.login(config.discord.token);
    } catch (err) {
      logger.warn(`Discord login failed: ${err.message}`);
    }
  }

  /** Handle incoming Discord commands */
  _handleCommand(message) {
    const cmd = message.content.toLowerCase().trim();

    switch (cmd) {
      case 'help':
      case 'commands':
        this._sendEmbed(message.channel, 'Commands', [
          '**start** - Start queueing',
          '**stop** - Stop queueing',
          '**update** - Get current queue status',
          '**stats** - Show health and hunger',
          '**antiafk** - Toggle anti-AFK',
          '**restart** - Toggle auto-restart on disconnect',
          '**help** - Show this message',
        ].join('\n'));
        break;

      case 'start':
        this.proxy.start();
        this._sendEmbed(message.channel, 'Queue', 'Starting queue...');
        break;

      case 'stop':
        this.proxy.stop();
        this._sendEmbed(message.channel, 'Queue', 'Queue **stopped**');
        break;

      case 'update': {
        const state = this.proxy.getState();
        this._sendEmbed(
          message.channel,
          'Status',
          `Position: ${state.queuePlace}\nETA: ${state.eta}\nStatus: ${state.doing}`
        );
        break;
      }

      case 'stats': {
        const stats = this.proxy.getPlayerStats();
        if (stats && stats.health != null) {
          this._sendEmbed(
            message.channel,
            'Player Stats',
            `Health: ${Math.ceil(stats.health / 2)}/10\nHunger: ${Math.floor(stats.food / 2)}/10`
          );
        } else {
          this._sendEmbed(message.channel, 'Player Stats', 'Not connected to server');
        }
        break;
      }

      case 'antiafk':
        this.proxy.toggleAntiAfk();
        this._sendEmbed(
          message.channel,
          'Anti-AFK',
          `Anti-AFK ${this.proxy.state.antiAfkActive ? 'enabled' : 'disabled'}`
        );
        break;

      case 'restart':
        this.proxy.toggleRestart();
        this._sendEmbed(
          message.channel,
          'Auto-Restart',
          `Auto-restart ${this.proxy.state.restartQueue ? 'enabled' : 'disabled'}`
        );
        break;

      default:
        if (cmd.length > 0 && cmd.length < 30) {
          this._sendEmbed(message.channel, 'Error', `Unknown command: "${cmd}". Type **help** for commands.`);
        }
    }
  }

  /** Set Discord bot activity */
  _setActivity(text) {
    if (!this.ready || !this.client?.user) return;
    try {
      this.client.user.setActivity(text);
    } catch (e) {
      // ignore
    }
  }

  /** Send an embed message */
  _sendEmbed(channel, title, content) {
    if (!config.discord.chat) return;

    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle(title)
      .setDescription(content)
      .setTimestamp()
      .setFooter({ text: `2Bored2Tolerate v${APP_VERSION}` });

    const target = (channel && typeof channel.send === 'function') ? channel : this.dcUser;
    if (!target) return;
    target.send({ embeds: [embed] }).catch((err) => {
      logger.warn(`Discord send error: ${err.message}`);
    });
  }

  /** Shutdown the bot */
  async shutdown() {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }
}

module.exports = DiscordBot;

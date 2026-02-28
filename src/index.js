#!/usr/bin/env node
// src/index.js - 2Bored2Tolerate Entry Point

const config = require('./config');
const logger = require('./logger');
const ProxyManager = require('./proxy');
const WebServer = require('./web/server');
const DiscordBot = require('./discord');
const CommandHandler = require('./commands');

// ASCII banner
const chalk = require('chalk');
const boxen = require('boxen');
const { version: APP_VERSION } = require('../package.json');

console.log(
  boxen(
    chalk.green.bold('2Bored2Tolerate') +
      chalk.gray(` v${APP_VERSION}`) +
      '\n\n' +
      chalk.white('Queue Proxy for 2b2t.org') +
      '\n' +
      chalk.gray('github.com/jasonzli-DEV/2Bored2Tolerate'),
    {
      padding: 1,
      margin: { top: 1, bottom: 1, left: 2, right: 2 },
      borderStyle: 'round',
      borderColor: 'green',
      textAlignment: 'center',
    }
  )
);

async function main() {
  // Validate config
  if (!config.mc.email && config.proxy.onlineMode) {
    logger.error('MC_EMAIL is required when PROXY_ONLINE_MODE is true');
    logger.info('Set MC_EMAIL in your .env file or set PROXY_ONLINE_MODE=false');
    process.exit(1);
  }

  // Ensure auth directory exists
  const fs = require('fs');
  try { fs.mkdirSync(config.mc.profilesFolder, { recursive: true }); } catch { /* ignore */ }

  // Initialize proxy manager
  const proxy = new ProxyManager();
  logger.info('Proxy manager initialized');

  // Initialize web server
  const webServer = new WebServer(proxy);
  await webServer.start();

  // Open browser if configured
  if (config.web.openBrowser) {
    const open = require('open');
    open(`http://localhost:${config.web.port}`).catch(() => {});
  }

  // Initialize Discord bot
  const discord = new DiscordBot(proxy);
  await discord.init();

  // Start CLI command handler
  const commands = new CommandHandler(proxy);
  commands.start();

  logger.info(`Server: ${config.server.host}:${config.server.port}`);
  logger.info(`MC Version: ${config.mc.version}`);
  logger.info(`Proxy: ${config.proxy.bind}:${config.proxy.port}`);
  logger.info(`Auth tokens: ${config.mc.profilesFolder}`);
  logger.info(`Anti-AFK: ${config.antiAfk.enabled ? 'Enabled' : 'Disabled'}`);
  logger.info('Type "help" for available commands');

  // Auto-join if configured
  if (config.joinOnStart) {
    logger.info('Auto-joining queue (JOIN_ON_START=true)...');
    setTimeout(() => proxy.start(), 1500);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    proxy.stop();
    commands.shutdown();
    await discord.shutdown();
    await webServer.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Global error handling
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    logger.error(err.stack);
    console.error(
      boxen(
        chalk.red('Something went wrong!') +
          '\n\n' +
          chalk.white(err.message) +
          '\n\n' +
          chalk.gray('GitHub: github.com/jasonzli-DEV/2Bored2Tolerate'),
        {
          padding: 1,
          margin: 1,
          borderStyle: 'bold',
          borderColor: 'red',
          textAlignment: 'center',
        }
      )
    );
  });

  process.on('unhandledRejection', (err) => {
    logger.error(`Unhandled rejection: ${err?.message || err}`);
  });
}

main().catch((err) => {
  logger.error(`Startup failed: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});

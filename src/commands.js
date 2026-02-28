// src/commands.js - CLI command handler
const readline = require('readline');
const logger = require('./logger');

class CommandHandler {
  /**
   * @param {import('./proxy')} proxy - The proxy manager instance
   */
  constructor(proxy) {
    this.proxy = proxy;
    this.rl = null;
  }

  /** Start listening for CLI input */
  start() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this._prompt();
  }

  /** Internal: show prompt and read input */
  _prompt() {
    this.rl.question('> ', (cmd) => {
      this._handleCommand(cmd.trim().toLowerCase());
      this._prompt();
    });
  }

  /** Handle a command string */
  _handleCommand(cmd) {
    switch (cmd) {
      case 'help':
      case 'commands':
        console.log(`
  Available Commands:
  ─────────────────────────────────────
  start       Start queueing
  stop        Stop queueing
  update      Show current queue status
  stats       Show health and hunger
  antiafk     Toggle anti-AFK
  restart     Toggle auto-restart
  help        Show this help message
  exit/quit   Exit the application
  ─────────────────────────────────────
`);
        break;

      case 'start':
        this.proxy.start();
        break;

      case 'stop':
        this.proxy.stop();
        break;

      case 'update': {
        const state = this.proxy.getState();
        console.log(`  Status: ${state.doing}`);
        console.log(`  Position: ${state.queuePlace}`);
        console.log(`  ETA: ${state.eta}`);
        console.log(`  Anti-AFK: ${state.antiAfkActive ? 'Active' : 'Inactive'}`);
        console.log(`  Auto-Restart: ${state.restartQueue ? 'On' : 'Off'}`);
        break;
      }

      case 'stats': {
        const stats = this.proxy.getPlayerStats();
        if (stats && stats.health != null) {
          const hp = Math.ceil(stats.health / 2);
          const food = Math.floor(stats.food / 2);
          console.log(`  Health: ${hp === 0 ? 'DEAD' : `${hp}/10`}`);
          console.log(`  Hunger: ${food === 0 ? 'STARVING' : `${food}/10`}`);
        } else {
          console.log('  Not connected to server');
        }
        break;
      }

      case 'antiafk':
        this.proxy.toggleAntiAfk();
        break;

      case 'restart':
        this.proxy.toggleRestart();
        break;

      case 'exit':
      case 'quit':
        logger.info('Shutting down...');
        // Trigger graceful shutdown via SIGINT handler in index.js
        process.kill(process.pid, 'SIGINT');
        break;

      default:
        if (cmd) {
          console.log(`  Unknown command: "${cmd}". Type "help" for available commands.`);
        }
    }
  }

  /** Clean up readline */
  shutdown() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

module.exports = CommandHandler;

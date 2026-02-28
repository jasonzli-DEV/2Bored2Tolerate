<div align="center">

# 2Bored2Tolerate

### A modern proxy to wait out 2b2t.org's queue

*Fork of the archived [2bored2wait](https://github.com/themoonisacheese/2bored2wait) project, fully modernized.*

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org)

</div>

---

## What is this?

2Bored2Tolerate is a queue proxy for 2b2t.org. It connects to the server, waits through the queue for you, and lets you join through a local Minecraft server when your position is near the front. Features include:

- **Real-time web dashboard** with queue position, ETA, and live chart
- **Anti-AFK system** — automatically prevents kicks after queue finishes so you don't have to time your login
- **Discord bot** integration for remote monitoring
- **Desktop notifications** when queue is almost done
- **REST API** for external control
- **Docker support** with simple `.env` configuration
- **Auto-reconnect** on disconnection
- **Queue ETA estimation** using exponential decay modeling

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 22 or higher
- A Minecraft account (Microsoft auth)

### Installation

```sh
git clone https://github.com/jasonzli-DEV/2Bored2Tolerate.git
cd 2Bored2Tolerate
cp .env.example .env
# Edit .env with your settings
npm install
npm start
```

### Docker

```sh
cp .env.example .env
# Edit .env with your settings
docker compose up -d
```

Or with environment variables directly:

```sh
docker run -d \
  -p 8080:8080 -p 25565:25565 \
  -e MC_EMAIL=your@email.com \
  -e MC_AUTH_TYPE=microsoft \
  ghcr.io/jasonzli-dev/2bored2tolerate:latest
```

## Configuration

All configuration is done through environment variables or a `.env` file. Copy `.env.example` to `.env` and edit:

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_EMAIL` | | Your Minecraft account email |
| `MC_AUTH_TYPE` | `microsoft` | Auth type: `microsoft` |
| `MC_VERSION` | `1.21.4` | Minecraft protocol version (2b2t uses 1.21.4) |
| `AUTH_PROFILES_FOLDER` | `./data/auth` | Where to store auth tokens |
| `SERVER_HOST` | `2b2t.org` | Target server hostname |
| `SERVER_PORT` | `25565` | Target server port |
| `PROXY_PORT` | `25565` | Local proxy server port |
| `PROXY_ONLINE_MODE` | `true` | Require authenticated Minecraft client |
| `WEB_PORT` | `8080` | Web dashboard port |
| `WEB_PASSWORD` | | Dashboard password (optional) |
| `DISCORD_ENABLED` | `false` | Enable Discord bot |
| `DISCORD_TOKEN` | | Discord bot token |
| `ANTIAFK_ENABLED` | `true` | Enable anti-AFK after queue |
| `JOIN_ON_START` | `false` | Auto-join queue on startup |
| `RECONNECT_ON_ERROR` | `true` | Auto-reconnect on disconnect |
| `RESTART_QUEUE` | `false` | Auto-restart queue if no player |

See `.env.example` for all options.

## How to Use

1. **Start the proxy**: `npm start`
2. **Authenticate**: On first run, you'll be prompted with a Microsoft device code — visit the URL shown and enter the code to sign in. Auth tokens are cached in `data/auth/` for future runs.
3. **Open the dashboard**: Navigate to `http://localhost:8080` (if `WEB_PASSWORD` is set, you'll see a login screen)
4. **Click "Start Queue"** to begin queueing
5. **Wait** — the dashboard shows real-time position and ETA
6. **Connect in Minecraft** to `localhost:25565` when the queue is near the front
7. **Anti-AFK**: If enabled, the bot will automatically prevent kicks until you connect (stays within 2 blocks of its position)
8. **Click "Stop Queue"** after you're done playing

## Anti-AFK

The anti-AFK system activates automatically when:
- The queue finishes and you haven't connected yet
- You disconnect from the local server while the bot is still on the server

It performs randomized actions (walking, looking, jumping, etc.) to prevent the server from kicking you for being idle. The bot **never moves more than 2 blocks** from its original position and will walk back if it drifts too far.

**Anti-AFK does NOT activate** when a real player is connected and playing. It only runs when the bot is unattended.

Configure via `.env`:
```
ANTIAFK_ENABLED=true
ANTIAFK_WALK=true
ANTIAFK_LOOK=true
ANTIAFK_JUMP=true
ANTIAFK_SWING=true
ANTIAFK_SNEAK=true
ANTIAFK_INTERVAL=15000
```

## CLI Commands

Type these in the terminal while running:

| Command | Description |
|---------|-------------|
| `start` | Start queueing |
| `stop` | Stop queueing |
| `update` | Show current status |
| `stats` | Show health/hunger |
| `antiafk` | Toggle anti-AFK |
| `restart` | Toggle auto-restart |
| `help` | Show commands |
| `exit` | Exit application |

## API

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/state` | Full proxy state |
| POST | `/api/start` | Start queue |
| POST | `/api/stop` | Stop queue |
| POST | `/api/toggle-restart` | Toggle auto-restart |
| POST | `/api/toggle-antiafk` | Toggle anti-AFK |
| GET | `/api/stats` | Player health/hunger |

All protected endpoints require `X-Password` header if `WEB_PASSWORD` is set.

### WebSocket (Socket.IO)

Connect to the same port. Events:
- `state` — full state updates
- `log` — activity log entries
- `queueUpdate` — position changes
- `queueFinished` — queue complete
- `stopped` — queue stopped

## Testing

```sh
npm test
```

## Project Structure

```
src/
  index.js        Entry point
  config.js       Environment configuration
  logger.js       Winston logging
  proxy.js        MC proxy & queue management  
  antiafk.js      Anti-AFK behaviors
  discord.js      Discord bot
  commands.js     CLI commands
  web/
    server.js     Express + Socket.IO
    public/       Dashboard assets
data/
  queue.json      ETA estimation data
test/
  test.js         Test suite
```

## License

GPL-3.0 — see [LICENSE](LICENSE)

## Credits

Originally created by [themoonisacheese](https://github.com/themoonisacheese/2bored2wait) and contributors.
Modernized fork by [jasonzli-DEV](https://github.com/jasonzli-DEV).

# Tradebot

A Discord bot for logging and verifying player trades, with Minecraft integration via [ForestBot-RS](https://github.com/BaconCat1/ForestBot-RS).

## Features

- `/trade @user <description>` — propose a trade; recipient gets a Discord embed with Confirm/Reject/Report buttons
- `/trades [@user | mc_user:<name>]` — view trade history for a Discord or Minecraft user
- `/tradestats [@user | mc_user:<name>]` — trade statistics and top partners
- `/report` — file a report against a user or a specific trade
- Moderator commands: warn, mark scammer, unmark scammer, CSV export
- **Minecraft integration**: trades proposed and confirmed in-game via `!trade` subcommands are logged to the `verified-trades` Discord channel with NameMC profile links

## Prerequisites

### Hub

Tradebot has no database of its own. All reads and writes go through **[Hub](https://github.com/jollycurv-e/Hub)**, a Fastify REST/WebSocket API that sits in front of a shared MariaDB `forestbot_hub` database. Hub must be running before tradebot starts.

## Setup

1. Stand up Hub and confirm it is reachable at `http://localhost:8001`.
2. Copy `.env.example` to `.env` and fill in values.
3. Start the bot:

```bash
node bot.js          # production
node bot.js --debug  # verbose logging
npm run dev          # nodemon auto-restart
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Bot token |
| `HUB_API_KEY` | Yes | Authenticates Hub REST + WebSocket calls |
| `GUILD_ID` | No | Register slash commands to one guild (instant); omit for global (up to 1h) |

## Architecture

All data lives in Hub's MariaDB database. Tradebot never reads/writes the DB directly, everything goes through the Hub REST API (`http://localhost:8001`) using the key from `HUB_API_KEY`.

```
Discord ──► bot.js ──► hub.js (HTTP + WS) ──► Hub API ──► MariaDB
                                │
                   hub.onMessage (WebSocket)
                                │
                   trades.listenForMcConfirms()
                                │
                  posts to #verified-trades
```

**Handler modules** (`handlers/`):
- `trades.js` — trade lifecycle, button interactions, history/stats, MC confirm listener
- `reports.js` — report flow, mod-channel notifications
- `mod.js` — moderator slash commands, CSV exports

## Database tables

| Table | Purpose |
|---|---|
| `trades` | All trade records (Discord and Minecraft) |
| `trade_reports` | User/trade reports |
| `mod_actions` | Scammer flags and warnings (`type` = `scammer` \| `warn`) |
| `tradebot_config` | Key-value config store |
| `user_links` | Discord snowflake ↔ Minecraft UUID mapping |

MC-originated trades: `channel_id = 'minecraft'`, `guild_id = NULL`. Discord-originated trades: both set to real IDs. The `formatUserId()` helper in `trades.js` detects numeric (Discord) vs UUID-format IDs and formats accordingly.

# Tradebot — Installation

## Prerequisites

- Node.js 18+
- Hub running at `http://localhost:8001`
- A Discord bot application ([discord.com/developers](https://discord.com/developers))

## Setup

```
npm install
```

Create `.env` in the project root:

```env
DISCORD_TOKEN=your_discord_bot_token
HUB_API_KEY=your_hub_api_key
GUILD_ID=your_guild_id
```

- `HUB_API_KEY` must match `APIKEY` in Hub's `.env`
- `GUILD_ID` is optional but recommended during development — registers slash commands instantly to one guild instead of globally (global propagation takes up to 1 hour)

## Discord Bot Permissions

The bot requires the following in the Discord developer portal:

- Scopes: `bot`, `applications.commands`
- Permissions: `Send Messages`, `Read Message History`, `Attach Files`
- Privileged intents: none required

## Run

```
node bot.js          # normal
node bot.js --debug  # verbose logging + enables /testall command
npm run dev          # auto-restart on file save (nodemon)
```

Slash commands register automatically on startup.

# Telegram Music Bot

Production-ready Telegram group music bot scaffold built with Node.js 22, TypeScript, grammY, MongoDB, FFmpeg, yt-dlp, Docker, Winston, ESLint, and Prettier.

This project is being generated module by module. Current status:

- Module 1: project foundation, configuration, logger, bootstrap, Docker support.
- Module 2: MongoDB connection lifecycle and Mongoose models.
- Next module: grammY bot bootstrap, middleware, and basic commands.

## Requirements

- Node.js 22+
- MongoDB 7+
- FFmpeg
- yt-dlp
- Telegram bot token from BotFather
- Telegram `API_ID`, `API_HASH`, and user session string for the voice assistant integration

## Installation

```bash
npm install
cp .env.example .env
npm run dev
```

For Docker:

```bash
docker compose up --build
```

## Scripts

- `npm run dev` starts the TypeScript development server.
- `npm run build` compiles TypeScript into `dist/`.
- `npm start` runs the compiled bot.
- `npm run lint` runs ESLint.
- `npm run format` formats files with Prettier.
- `npm run typecheck` runs TypeScript without emitting files.

## Environment

See `.env.example` for all required variables.

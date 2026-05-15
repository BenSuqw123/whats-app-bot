# WhatsApp Group Bot

A production-ready WhatsApp bot built with Node.js and `whatsapp-web.js` that monitors specified groups, captures all messages and media in real-time, and persists everything locally to your filesystem.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 18+ |
| npm | 8+ |
| Google Chrome or Chromium | Latest stable |
| Operating System | Linux, macOS, or Windows (WSL recommended on Windows) |

> **Note for Linux servers:** You may need to install Chromium system dependencies. Run:
> ```bash
> sudo apt-get install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
>   libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
>   libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
>   libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
>   libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release \
>   wget xdg-utils
> ```

---

## Installation

```bash
# 1. Clone or download the project
git clone <your-repo-url>
cd whatsapp-group-bot

# 2. Install dependencies
npm install

# 3. Set up your environment file
cp .env.example .env
```

---

## Environment Configuration

Open `.env` and configure the following variables:

```env
# Comma-separated keywords to match group names (case-insensitive substring match)
GROUP_KEYWORDS=sales,marketing,support

# Logging level: error | warn | info | debug
LOG_LEVEL=info

# Reconnect settings
RECONNECT_MAX_RETRIES=5
RECONNECT_DELAY_MS=5000
```

### Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `GROUP_KEYWORDS` | Yes | `sales,marketing,support` | Comma-separated list of keywords used to decide which groups to monitor |
| `LOG_LEVEL` | No | `info` | Winston log level (`error`, `warn`, `info`, `debug`) |
| `RECONNECT_MAX_RETRIES` | No | `5` | How many times the bot will attempt to reconnect before exiting |
| `RECONNECT_DELAY_MS` | No | `5000` | Milliseconds to wait between reconnect attempts |

---

## Running the Bot

```bash
# Production mode
npm start

# Development mode (auto-restarts on file changes, requires Node 18+)
npm run dev
```

### First-time startup flow

1. The bot prints a QR code in your terminal.
2. Open **WhatsApp** on your phone.
3. Navigate to **Settings → Linked Devices → Link a Device**.
4. Scan the QR code displayed in the terminal.
5. The bot logs `✅ Bot is ready! Listening for messages...` once connected.
6. Your session is saved to `.wwebjs_auth/` — subsequent startups will not require re-scanning.

---

## How Group Keyword Filtering Works

The bot only monitors groups whose **display names contain** at least one of your configured keywords (case-insensitive substring match).

**Example:**

```env
GROUP_KEYWORDS=sales,vip,support
```

| Group Name | Monitored? | Reason |
|---|---|---|
| `🔥 Sales Team Q2` | ✅ Yes | contains "sales" |
| `VIP Clients 2024` | ✅ Yes | contains "vip" |
| `Customer Support` | ✅ Yes | contains "support" |
| `Birthday Party 🎉` | ❌ No | no keyword match |
| `Family Chat` | ❌ No | no keyword match |

Set `LOG_LEVEL=debug` in your `.env` to see a log line for every group check.

---

## Where Files Are Saved

### Media Downloads

All media files are saved under `./downloads/`, organized by type:

```
downloads/
├── images/    ← image/jpeg, image/png, image/gif, image/webp
├── videos/    ← video/mp4, video/3gpp
├── audio/     ← audio/ogg (voice notes), audio/mpeg, audio/mp4
├── pdfs/      ← application/pdf
└── files/     ← everything else (zip, docx, xlsx, etc.)
```

**Filename format:**
```
YYYY-MM-DD_HH-mm-ss_{SenderName}_{uuid}.{ext}
```

Example: `2024-01-15_14-30-05_John_Smith_f47ac10b-58cc-4372-a567-0e02b2c3d479.jpg`

### JSON Database

Message metadata is stored in `./database/` as daily JSON files:

```
database/
├── messages-2024-01-15.json
├── messages-2024-01-16.json
└── ...
```

---

## JSON Database Structure

Each daily file is a JSON array of message records:

```json
[
  {
    "id": "3EB0123456789ABCDEF",
    "uniqueId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "timestamp": "2024-01-15T07:30:05.000Z",
    "groupId": "1234567890-1234567890@g.us",
    "groupName": "Sales Team Q2",
    "senderId": "60123456789@c.us",
    "senderName": "John Smith",
    "messageType": "image",
    "body": "Check out this product shot!",
    "hasMedia": true,
    "media": {
      "filename": "2024-01-15_14-30-05_John_Smith_f47ac10b.jpg",
      "filePath": "./downloads/images/2024-01-15_14-30-05_John_Smith_f47ac10b.jpg",
      "mimetype": "image/jpeg",
      "subDir": "images",
      "fileSize": 245760
    },
    "raw": {
      "chatId": "1234567890-1234567890@g.us",
      "fromMe": false
    }
  }
]
```

### `messageType` Values

| Value | Trigger |
|---|---|
| `text` | Plain text message |
| `image` | Any image (JPEG, PNG, GIF, WebP) |
| `video` | Video file |
| `audio` | Audio file or voice note (push-to-talk) |
| `pdf` | PDF document |
| `document` | Any other file attachment |
| `sticker` | WhatsApp sticker |
| `location` | Shared location |
| `other` | Polls, contacts, and any unrecognized types |

---

## Logs

Logs are written to both the terminal (colorized) and to `./logs/bot-YYYY-MM-DD.log`.

```
[2024-01-15 14:30:05] [INFO] [bot] ✅ Bot is ready! Listening for messages...
[2024-01-15 14:30:10] [INFO] [messageHandler] [MSG] Sales Team Q2 | John Smith | image | "Check out this product shot!"
[2024-01-15 14:30:10] [INFO] [mediaHandler] [MEDIA] Downloaded image/jpeg (245760 bytes) → ./downloads/images/2024-01-15_14-30-05_John_Smith_f47ac10b.jpg
```

Set `LOG_LEVEL=debug` to see group filtering decisions and database operations.

---

## Project Structure

```
whatsapp-group-bot/
├── index.js                          ← Entry point, global error handlers
├── src/
│   ├── bot.js                        ← Client init, auth, reconnect logic
│   ├── config.js                     ← Env var loading & validation
│   ├── handlers/
│   │   ├── messageHandler.js         ← Routes messages, builds DB records
│   │   └── mediaHandler.js           ← Downloads & saves media files
│   ├── services/
│   │   ├── storageService.js         ← Writes media buffers to disk
│   │   └── jsonDatabaseService.js    ← Reads/writes daily JSON files
│   └── utils/
│       ├── logger.js                 ← Winston logger factory
│       ├── groupFilter.js            ← Keyword-based group whitelist
│       └── helpers.js                ← Shared utility functions
├── downloads/                        ← Media files (created at runtime)
├── database/                         ← JSON message logs (created at runtime)
└── logs/                             ← Winston log files (created at runtime)
```

---

## How to Extend

### Add a REST API

Install Express and expose `/api/messages?date=YYYY-MM-DD` and `/api/messages?group=GroupName` using the already-exported `getMessagesByDate` and `getMessagesByGroup` functions from `jsonDatabaseService.js`.

### Migrate to PostgreSQL

Replace `jsonDatabaseService.js` with a PostgreSQL adapter (e.g., `pg` or `prisma`). The `saveMessage(record)` interface stays the same — no other files need to change.

### Add AI Summarization

After `saveMessage(record)` in `messageHandler.js`, push text messages to a queue and call an LLM API (OpenAI, Anthropic, Gemini) to generate a daily digest. The `getMessagesByDate` function already provides all the data you need.

### Forward to Webhook / Slack / Telegram

In `messageHandler.js`, after saving the record, POST the payload to any webhook URL configured in `.env`.

---

## Security Notes

- **Never commit `.env`** — it is already in `.gitignore`.
- **Never commit `.wwebjs_auth/`** — this contains your WhatsApp session credentials.
- Run the bot on a dedicated machine or VM, not on your personal development machine.
- The bot only reads messages from groups; it never sends messages unless you add that logic explicitly.

---

## License

MIT

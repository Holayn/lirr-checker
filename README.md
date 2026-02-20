# lirr-checker

Monitors LIRR train departures and alerts you when a train is approaching its scheduled departure time. Checks real-time status, announces results via text-to-speech, and optionally sends push notifications.

## How it works

- Reads a list of trips to watch from `config.json`
- Polls every 60 seconds; once a departure is within 30 minutes, fetches live data
- Compares the scheduled trip (from the static GTFS feed) against the real-time GTFS feed
- Logs status to the console, plays a ding + TTS announcement, and POSTs to a notify endpoint

Static GTFS data is cached locally for 24 hours. The real-time feed is fetched fresh on each check.

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure environment

```sh
cp .env.example .env
```

Edit `.env`:

| Variable        | Description                                                          |
| --------------- | -------------------------------------------------------------------- |
| `NOTIFY_URL`    | URL to POST notifications to (optional)                              |
| `SPEAK_COMMAND` | Command to use for text-to-speech (optional, defaults to system TTS) |
| `HTTP_PORT`     | Port for the HTTP control server (optional, defaults to `3000`)      |

### 3. Add a ding sound

Place a `ding.wav` in the project root. If the file is missing, the ding is skipped and only TTS plays.

### 4. Configure your trips

Edit `config.json`. It is an array of trip objects:

```json
[
  {
    "source": "Penn Station",
    "destination": "Mineola",
    "departureTime": "08:15",
    "days": ["mon", "tue", "wed", "thu", "fri"],
    "users": ["alice"],
    "audio": true
  }
]
```

| Field           | Type     | Description                                                                     |
| --------------- | -------- | ------------------------------------------------------------------------------- |
| `source`        | string   | Origin stop name (partial match supported)                                      |
| `destination`   | string   | Destination stop name (partial match supported)                                 |
| `departureTime` | string   | Scheduled departure in `HH:MM` or `HH:MM:SS` (24-hour)                          |
| `users`         | string[] | _(optional)_ Array of user identifiers sent with push notification              |
| `audio`         | boolean  | Whether to play ding + TTS for this trip                                        |
| `days`          | string[] | _(optional)_ Array of days to check (e.g., ["mon", "tue", "wed", "thu", "fri"]) |

If `users` is omitted, the notify endpoint is not called for that entry.

### 5. Run

```sh
npm start
```

## Notification endpoint

When `users` is set and `NOTIFY_URL` is configured, the checker POSTs:

```json
{
  "message": "Train from Penn Station to Mineola, departing 08:15:00, is on time.",
  "users": ["alice"]
}
```

## Control endpoints

When running, the app exposes a small HTTP server (default port `3000`) for on-demand control.

### `POST /snooze`

Suppresses all checks for 24 hours.

```sh
curl -X POST http://localhost:3000/snooze
```

```json
{ "ok": true, "message": "Checks snoozed for 24 hours.", "snoozeUntil": "2026-02-20T23:59:59.999Z" }
```

### `POST /skip-next-day`

Skips all checks for the next calendar day.

```sh
curl -X POST http://localhost:3000/skip-next-day
```

```json
{ "ok": true, "message": "Checks will be skipped on 20260221.", "skippedDate": "20260221" }
```

Past skip dates are pruned automatically on each poll cycle.

## Scripts

| Command                | Description                      |
| ---------------------- | -------------------------------- |
| `npm start`            | Run the checker                  |
| `npm run lint`         | Check for lint errors            |
| `npm run lint:fix`     | Auto-fix lint errors             |
| `npm run format`       | Format all files with Prettier   |
| `npm run format:check` | Check formatting without writing |

## Project structure

```
lirr-checker/
├── index.js              # Main loop and orchestration
├── lib/
│   ├── audio.js          # ding.wav playback and TTS
│   ├── notify.js         # HTTP push notification
│   ├── gtfs-static.js    # Static GTFS download, caching, and trip search
│   └── gtfs-realtime.js  # Real-time GTFS feed and delay parsing
├── config.json           # Your trip configuration
├── ding.wav              # (you provide this)
└── .env                  # Environment variables (not committed)
```

## Data sources

| Feed              | URL                                                                       |
| ----------------- | ------------------------------------------------------------------------- |
| Real-time GTFS-RT | `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr` |
| Static GTFS       | `https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip`                       |

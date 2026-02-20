'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');

const dayjs = require('dayjs');
const duration = require('dayjs/plugin/duration');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(duration);
dayjs.extend(customParseFormat);

const logger = require('./lib/logger');
const { announce } = require('./lib/audio');
const { postNotification } = require('./lib/notify');
const { ensureStaticGtfs, loadStaticGtfs, findMatchingTrips } = require('./lib/gtfs-static');
const { fetchRealtimeFeed, getTripDelay, formatDelay } = require('./lib/gtfs-realtime');

// ─── Config ───────────────────────────────────────────────────────────────────

const NOTIFY_WINDOW = 30 * 60; // seconds before departure to start checking
const CHECK_THROTTLE = 5 * 60 * 1000; // ms between checks for the same departure
const POLL_INTERVAL = 60 * 1000; // main loop cadence
const HTTP_PORT = process.env.HTTP_PORT || 3000;

// ─── Snooze / skip state ──────────────────────────────────────────────────────
// snoozeUntil: Date — suppress all checks until this timestamp
// skipDates: Set<string> — date strings (YYYYMMDD) for which checks are skipped
let snoozeUntil = null;
const skipDates = new Set();

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
}

function timeSecs(str) {
  const [h, m, s] = str.split(':').map(Number);
  return dayjs.duration({ hours: h, minutes: m, seconds: s || 0 }).asSeconds();
}

function nowSecs() {
  const now = dayjs();
  return now.diff(now.startOf('day'), 'second');
}

function todayDateStr() {
  return dayjs().format('YYYYMMDD');
}

function departureKey(entry) {
  return `${entry.source}|${entry.destination}|${entry.departureTime}|${todayDateStr()}`;
}

// ─── Per-departure check ──────────────────────────────────────────────────────

async function checkDeparture(entry, gtfsData) {
  const { source, destination, departureTime } = entry;
  logger.info(`[CHECK] ${source} → ${destination} at ${departureTime}`);

  let trips;
  try {
    trips = findMatchingTrips(source, destination, timeSecs(departureTime), gtfsData);
  } catch (err) {
    const msg = `Error finding trips: ${err.message}`;
    logger.error(msg);
    return {
      success: false,
      message: msg,
    };
  }

  if (trips.length === 0) {
    const msg = `No scheduled train found from ${source} to ${destination} at ${departureTime} today.`;
    return {
      success: true,
      message: msg,
    };
  }

  let feed;
  try {
    feed = await fetchRealtimeFeed();
  } catch (err) {
    const msg = `Could not fetch real-time data: ${err.message}`;
    logger.error(msg);
    return {
      success: false,
      message: msg,
    };
  }

  const results = [];

  for (const trip of trips) {
    const delayInfo = getTripDelay(feed, trip.tripId, trip.srcStopId);
    const status = formatDelay(delayInfo.delay);
    const msg =
      `${dayjs(trip.scheduledDep, 'HH:mm:ss').format('h:mm A')} train, from ${trip.srcStopName} to ${trip.dstStopName}, ` +
      `is ${status}.`;

    results.push(msg);
  }

  return {
    success: true,
    message: results.join('\n'),
  };
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  logger.info('=== LIRR Train Status Checker ===');

  let gtfsData;

  logger.info(
    `Running. Checking departures within ${NOTIFY_WINDOW / 60} minutes of scheduled time.`
  );

  const lastChecked = {};
  const checkResults = {};

  async function runChecks() {
    if (snoozeUntil && dayjs().isBefore(snoozeUntil)) {
      logger.info(`[SNOOZE] Checks snoozed until ${snoozeUntil.format('h:mm A')}. Skipping.`);
      return;
    }

    if (skipDates.has(todayDateStr())) {
      logger.info(`[SKIP] Checks skipped for ${todayDateStr()}.`);
      return;
    }

    try {
      await ensureStaticGtfs();
      gtfsData = loadStaticGtfs();
    } catch (err) {
      logger.error(`Failed to load static GTFS: ${err.message}`);
      process.exit(1);
    }

    let config;
    try {
      config = loadConfig();
    } catch (err) {
      logger.error(`Failed to load config.json: ${err.message}`);
      return;
    }

    const now = nowSecs();
    const announcements = [];

    for (const entry of config) {
      const { days, users, audio, departureTime } = entry;
      const today = dayjs().format('ddd').toLowerCase();
      if (days && !days.includes(today)) continue;

      const secsUntil = timeSecs(departureTime) - now;
      if (secsUntil < 0 || secsUntil > NOTIFY_WINDOW) continue;

      const key = departureKey(entry);
      if (Date.now() - (lastChecked[key] || 0) < CHECK_THROTTLE) continue;

      lastChecked[key] = Date.now();

      const { success, message } = await checkDeparture(entry, gtfsData);

      if (!success) {
        postNotification(message, users);
      } else {
        // Only notify if the message changes, which is what we really care about.
        const existing = checkResults[key];
        if (existing && existing === message) {
          continue;
        }

        checkResults[key] = message;
        postNotification(message, users);
        if (audio) {
          announcements.push({ msg: message, audio: true });
        }
      }
    }

    for (const { msg, audio } of announcements) {
      await announce(msg, audio);
    }

    // Prune keys from previous days
    const today = todayDateStr();
    for (const k of Object.keys(lastChecked)) {
      if (!k.endsWith(`|${today}`)) delete lastChecked[k];
    }
    for (const d of skipDates) {
      if (d < today) skipDates.delete(d);
    }

    gtfsData = null;
  }

  await runChecks();
  setInterval(runChecks, POLL_INTERVAL);
}

function startServer() {
  // ─── HTTP control server ──────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  // Snooze: suppress checks for 24 hours.
  app.post('/snooze', (req, res) => {
    snoozeUntil = dayjs().add('1', 'day');
    const msg = `Checks snoozed for 24 hours.`;
    logger.info(`[HTTP] /snooze — ${msg}`);
    res.json({ ok: true, message: msg, snoozeUntil: snoozeUntil.toISOString() });
  });

  // Skip next day: skip all checks on the next calendar day.
  app.post('/skip-next-day', (req, res) => {
    const nextDay = dayjs().add(1, 'day').format('YYYYMMDD');
    skipDates.add(nextDay);
    const msg = `Checks will be skipped on ${nextDay}.`;
    logger.info(`[HTTP] /skip-next-day — ${msg}`);
    res.json({ ok: true, message: msg, skippedDate: nextDay });
  });

  app.listen(HTTP_PORT, () => {
    logger.info(`[HTTP] Control server listening on port ${HTTP_PORT}`);
  });
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});

startServer();

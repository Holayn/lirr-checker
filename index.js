'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const dayjs = require('dayjs');
const duration = require('dayjs/plugin/duration');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(duration);
dayjs.extend(customParseFormat);

const logger = require('./lib/logger');
const { announce } = require('./lib/audio');
const { postNotification } = require('./lib/notify');
const {
  ensureStaticGtfs,
  loadStaticGtfs,
  findMatchingTrips,
  todayDateStr,
} = require('./lib/gtfs-static');
const { fetchRealtimeFeed, getTripDelay, formatDelay } = require('./lib/gtfs-realtime');

// ─── Config ───────────────────────────────────────────────────────────────────

const NOTIFY_WINDOW = 30 * 60; // seconds before departure to start checking
const CHECK_THROTTLE = 5 * 60 * 1000; // ms between checks for the same departure
const POLL_INTERVAL = 60 * 1000; // main loop cadence

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

function departureKey(entry) {
  return `${entry.source}|${entry.destination}|${entry.departureTime}|${todayDateStr()}`;
}

// ─── Per-departure check ──────────────────────────────────────────────────────

async function checkDeparture(entry, gtfsData) {
  const { source, destination, departureTime, users, audio } = entry;
  logger.info(`[CHECK] ${source} → ${destination} at ${departureTime}`);

  let trips;
  try {
    trips = findMatchingTrips(source, destination, timeSecs(departureTime), gtfsData);
  } catch (err) {
    const msg = `Error finding trips: ${err.message}`;
    logger.error(msg);
    await Promise.all([
      announce(msg, audio),
      postNotification(msg, users)
    ]);
    return;
  }

  if (trips.length === 0) {
    const msg = `No scheduled train found from ${source} to ${destination} at ${departureTime} today.`;
    await Promise.all([
      announce(msg, audio),
      postNotification(msg, users)
    ]);
    return;
  }

  let feed;
  try {
    feed = await fetchRealtimeFeed();
  } catch (err) {
    const msg = `Could not fetch real-time data: ${err.message}`;
    logger.error(msg);
    await Promise.all([
      announce(msg, audio),
      postNotification(msg, users)
    ]);
    return;
  }

  const announcements = [];

  for (const trip of trips) {
    const delayInfo = getTripDelay(feed, trip.tripId, trip.srcStopId);
    const status = formatDelay(delayInfo.delay);
    const msg =
      `${dayjs(trip.scheduledDep, 'HH:mm:ss').format('h:mm A')} train, from ${trip.srcStopName} to ${trip.dstStopName}, ` +
      `is ${status}.`;

    announcements.push({ msg, audio });
    postNotification(msg, users)
  }

  for (const { msg, audio } of announcements) {
    await announce(msg, audio);
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  logger.info('=== LIRR Train Status Checker ===');

  let gtfsData;
  try {
    await ensureStaticGtfs();
    gtfsData = loadStaticGtfs();
  } catch (err) {
    logger.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }

  logger.info(
    `Running. Checking departures within ${NOTIFY_WINDOW / 60} minutes of scheduled time.`
  );

  const lastChecked = {};

  async function runChecks() {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      logger.error(`Failed to load config.json: ${err.message}`);
      return;
    }

    const now = nowSecs();

    for (const entry of config) {
      const today = dayjs().format('ddd').toLowerCase();
      if (entry.days && !entry.days.includes(today)) continue;

      const secsUntil = timeSecs(entry.departureTime) - now;
      if (secsUntil < 0 || secsUntil > NOTIFY_WINDOW) continue;

      const key = departureKey(entry);
      if (Date.now() - (lastChecked[key] || 0) < CHECK_THROTTLE) continue;

      lastChecked[key] = Date.now();
      await checkDeparture(entry, gtfsData);
    }

    // Prune keys from previous days
    const today = todayDateStr();
    for (const k of Object.keys(lastChecked)) {
      if (!k.endsWith(`|${today}`)) delete lastChecked[k];
    }
  }

  await runChecks();
  setInterval(runChecks, POLL_INTERVAL);
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});

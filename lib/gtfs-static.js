'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { parse: parseCsv } = require('csv-parse/sync');
const dayjs = require('dayjs');
const duration = require('dayjs/plugin/duration');
const logger = require('./logger');

dayjs.extend(duration);

const STATIC_GTFS_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip';
const CACHE_DIR = path.join(__dirname, '..', '.cache');
const ZIP_CACHE_PATH = path.join(CACHE_DIR, 'gtfslirr.zip');
const GTFS_DIR = path.join(CACHE_DIR, 'gtfslirr');
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const DEPARTURE_TOLERANCE = 5 * 60; // ±5 minutes in seconds

// ─── Download / extraction ────────────────────────────────────────────────────

async function ensureStaticGtfs() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  let needsDownload = true;
  if (fs.existsSync(ZIP_CACHE_PATH)) {
    const age = Date.now() - fs.statSync(ZIP_CACHE_PATH).mtimeMs;
    if (age < CACHE_MAX_AGE) needsDownload = false;
  }

  if (needsDownload) {
    logger.info('Downloading static GTFS...');
    const res = await axios.get(STATIC_GTFS_URL, { responseType: 'arraybuffer' });
    fs.writeFileSync(ZIP_CACHE_PATH, res.data);
    logger.info('Static GTFS downloaded.');
    if (fs.existsSync(GTFS_DIR)) fs.rmSync(GTFS_DIR, { recursive: true });
  }

  if (!fs.existsSync(GTFS_DIR)) {
    logger.info('Extracting static GTFS...');
    new AdmZip(ZIP_CACHE_PATH).extractAllTo(GTFS_DIR, true);
    logger.info('Static GTFS extracted.');
  }
}

// ─── Loading ──────────────────────────────────────────────────────────────────

function readCsv(filename) {
  return parseCsv(fs.readFileSync(path.join(GTFS_DIR, filename), 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function loadStaticGtfs() {
  logger.info('Loading static GTFS into memory...');

  const stops = readCsv('stops.txt');
  const stopTimes = readCsv('stop_times.txt');
  const trips = readCsv('trips.txt');
  const calendar = fs.existsSync(path.join(GTFS_DIR, 'calendar.txt'))
    ? readCsv('calendar.txt')
    : [];
  const calendarDates = fs.existsSync(path.join(GTFS_DIR, 'calendar_dates.txt'))
    ? readCsv('calendar_dates.txt')
    : [];

  const stopsByName = {};
  const stopsById = {};
  for (const s of stops) {
    stopsById[s.stop_id] = s;
    const key = s.stop_name.toLowerCase();
    (stopsByName[key] = stopsByName[key] || []).push(s);
  }

  const stopTimesByTrip = {};
  for (const st of stopTimes) {
    (stopTimesByTrip[st.trip_id] = stopTimesByTrip[st.trip_id] || []).push(st);
  }

  const tripsById = {};
  for (const t of trips) tripsById[t.trip_id] = t;

  const calByService = {};
  for (const c of calendar) calByService[c.service_id] = c;

  const calDatesByService = {};
  for (const cd of calendarDates) {
    (calDatesByService[cd.service_id] = calDatesByService[cd.service_id] || []).push(cd);
  }

  logger.info(`  ${stops.length} stops | ${stopTimes.length} stop_times | ${trips.length} trips`);
  return { stopsByName, stopsById, stopTimesByTrip, tripsById, calByService, calDatesByService };
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

function isServiceActive(serviceId, gtfsData) {
  const today = dayjs();
  const dateStr = today.format('YYYYMMDD');
  const dayName = today.format('dddd').toLowerCase(); // e.g. 'monday'

  for (const ex of gtfsData.calDatesByService[serviceId] || []) {
    if (ex.date === dateStr) return ex.exception_type === '1';
  }

  const cal = gtfsData.calByService[serviceId];
  if (!cal) return false;
  if (dateStr < cal.start_date || dateStr > cal.end_date) return false;
  return cal[dayName] === '1';
}

// ─── Trip search ──────────────────────────────────────────────────────────────

// GTFS times can exceed 24:00:00 (post-midnight runs), so treat them as durations.
function gtfsTimeSecs(str) {
  const [h, m, s] = str.split(':').map(Number);
  return dayjs.duration({ hours: h, minutes: m, seconds: s || 0 }).asSeconds();
}

function findStops(query, gtfsData) {
  const lq = query.toLowerCase();
  if (gtfsData.stopsByName[lq]) return gtfsData.stopsByName[lq];
  return Object.entries(gtfsData.stopsByName)
    .filter(([name]) => name.includes(lq))
    .flatMap(([, arr]) => arr);
}

function findMatchingTrips(source, destination, deptSecs, gtfsData) {
  const srcStops = findStops(source, gtfsData);
  const dstStops = findStops(destination, gtfsData);

  if (srcStops.length === 0) throw new Error(`No stops found for "${source}"`);
  if (dstStops.length === 0) throw new Error(`No stops found for "${destination}"`);

  const srcIds = new Set(srcStops.map((s) => s.stop_id));
  const dstIds = new Set(dstStops.map((s) => s.stop_id));
  const results = [];

  for (const [tripId, sts] of Object.entries(gtfsData.stopTimesByTrip)) {
    const sorted = sts.slice().sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));

    const srcSt = sorted.find((st) => srcIds.has(st.stop_id));
    if (!srcSt) continue;
    if (Math.abs(gtfsTimeSecs(srcSt.departure_time) - deptSecs) > DEPARTURE_TOLERANCE) continue;

    const srcIdx = sorted.indexOf(srcSt);
    const dstSt = sorted.slice(srcIdx + 1).find((st) => dstIds.has(st.stop_id));
    if (!dstSt) continue;

    const trip = gtfsData.tripsById[tripId];
    if (!trip || !isServiceActive(trip.service_id, gtfsData)) continue;

    results.push({
      tripId,
      srcStopId: srcSt.stop_id,
      srcStopName: gtfsData.stopsById[srcSt.stop_id]?.stop_name || source,
      dstStopId: dstSt.stop_id,
      dstStopName: gtfsData.stopsById[dstSt.stop_id]?.stop_name || destination,
      scheduledDep: srcSt.departure_time,
      scheduledArr: dstSt.arrival_time,
    });
  }

  return results;
}

module.exports = { ensureStaticGtfs, loadStaticGtfs, findMatchingTrips };

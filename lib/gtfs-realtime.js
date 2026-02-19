'use strict';

const axios = require('axios');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const logger = require('./logger');

const REALTIME_FEED_URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr';

async function fetchRealtimeFeed() {
  logger.info('Fetching real-time feed...');

  const headers = {};

  const res = await axios.get(REALTIME_FEED_URL, {
    responseType: 'arraybuffer',
    headers,
  });

  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(res.data));
}

function getTripDelay(feed, tripId, stopId) {
  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    if (entity.tripUpdate.trip.tripId !== tripId) continue;

    for (const stu of entity.tripUpdate.stopTimeUpdate || []) {
      if (stu.stopId === stopId) {
        const delay =
          stu.departure?.delay != null ? stu.departure.delay : (stu.arrival?.delay ?? 0);
        return { found: true, delay };
      }
    }
    // Trip found but no stop-specific update → on time
    return { found: true, delay: 0 };
  }
  return { found: false, delay: 0 };
}

function formatDelay(delaySecs) {
  if (Math.abs(delaySecs) < 60) return 'on time';
  const mins = Math.round(Math.abs(delaySecs) / 60);
  const label = `${mins} minute${mins !== 1 ? 's' : ''}`;
  return delaySecs > 0 ? `${label} late` : `${label} early`;
}

module.exports = { fetchRealtimeFeed, getTripDelay, formatDelay };

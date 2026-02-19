'use strict';

const axios = require('axios');
const logger = require('./logger');

async function postNotification(message, users) {
  const url = process.env.NOTIFY_URL;
  if (!url || !users || users.length === 0) return;
  try {
    for (const user of users) {
      await axios.post(url, { message, user });
      logger.info(`Notification sent → user="${user}"`);
    }
  } catch (err) {
    logger.error(`Notification failed: ${err.message}`);
  }
}

module.exports = { postNotification };

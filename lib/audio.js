'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const logger = require('./logger');

const DING_WAV = path.join(__dirname, '..', 'ding.wav');

function playDing() {
  return new Promise((resolve) => {
    if (!fs.existsSync(DING_WAV)) {
      logger.warn(`ding.wav not found at ${DING_WAV}, skipping ding`);
      return resolve();
    }
    let cmd;
    if (process.platform === 'win32') {
      cmd = `powershell -NoProfile -Command "(New-Object Media.SoundPlayer '${DING_WAV}').PlaySync()"`;
    } else if (process.platform === 'darwin') {
      cmd = `afplay "${DING_WAV}"`;
    } else {
      cmd = `aplay "${DING_WAV}" 2>/dev/null || paplay "${DING_WAV}" 2>/dev/null || true`;
    }
    exec(cmd, () => resolve());
  });
}

function speakText(text) {
  return new Promise((resolve) => {
    let cmd;
    if (process.platform === 'win32') {
      const escaped = text.replace(/'/g, "''");
      cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${escaped}')"`;
    } else if (process.platform === 'darwin') {
      cmd = `say "${text.replace(/"/g, '\\"')}"`;
    } else {
      cmd = `espeak-ng "${text.replace(/"/g, '\\"')}" 2>/dev/null || true`;
    }
    exec(cmd, () => resolve());
  });
}

async function announce(text, playAudio) {
  logger.info(`[ANNOUNCE] ${text}`);
  if (!playAudio) return;
  await playDing();
  await speakText(text);
}

module.exports = { announce };

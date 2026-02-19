'use strict';

const { createLogger, format } = require('winston');
const Transport = require('winston-transport');

// Winston's built-in Console transport writes via process.stdout.write, which
// VS Code's Debug Console does not intercept. This transport routes through
// console.* instead so output appears everywhere console.log would.
class ConsoleTransport extends Transport {
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));

    // After the format chain runs, the final rendered string lives here.
    const line = info[Symbol.for('message')] ?? info.message;

    if (info[Symbol.for('level')] === 'error') console.error(line);
    else if (info[Symbol.for('level')] === 'warn') console.warn(line);
    else console.log(line);

    if (callback) callback();
  }
}

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.colorize(),
    format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level}: ${message}`)
  ),
  transports: [new ConsoleTransport()],
});

module.exports = logger;

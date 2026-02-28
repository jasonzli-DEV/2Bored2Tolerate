// src/logger.js - Winston-based logging
const winston = require('winston');
const path = require('path');
const config = require('./config');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] ${level}: ${message}`;
        })
      ),
    }),
  ],
});

if (config.logging) {
  logger.add(
    new winston.transports.File({
      filename: path.join(__dirname, '..', '2bored2tolerate.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 3,
    })
  );
}

module.exports = logger;

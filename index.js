'use strict';
require('./src/config'); // dotenv before logger snapshots environment
const logger = require('./src/utils/logger');
const shutdown = require('./src/utils/shutdownManager');
shutdown.register();
const bot = require('./src/bot');
logger.info('[startup] Starting WhatsApp collector pid=' + process.pid);
bot.start().catch(error => {
  logger.error('[startup] ' + error.message, { stack: error.stack });
  shutdown.shutdown('startup-fatal', error.code === 'SESSION_LOCKED' ? 78 : 1);
});

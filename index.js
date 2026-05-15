'use strict';

const logger   = require('./src/utils/logger');
const shutdown = require('./src/utils/shutdownManager');
const bot      = require('./src/bot');

shutdown.register();

logger.info('🚀 Starting WhatsApp Bot...');
bot.start();

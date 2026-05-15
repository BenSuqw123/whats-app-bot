// index.js
'use strict';

const logger   = require('./src/utils/logger');
const shutdown = require('./src/utils/shutdownManager');
const bot      = require('./src/bot');

// Register all OS signal handlers and the global error safety nets.
// This must be called BEFORE bot.start() so that any startup error is caught.
shutdown.register();

logger.info('🚀 Starting WhatsApp Bot...');
bot.start();

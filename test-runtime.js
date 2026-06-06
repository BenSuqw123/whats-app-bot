// test-runtime.js
'use strict';

const logger = require('./src/utils/logger');
const { BaileysMessageWrapper } = require('./src/utils/baileysWrapper');

logger.info('[test-runtime] Loader validation starting...');
try {
  // Simple check to ensure classes can be resolved and loaded without syntax errors
  if (typeof BaileysMessageWrapper === 'function') {
    logger.info('[test-runtime] ✅ BaileysMessageWrapper loaded successfully.');
  } else {
    throw new Error('BaileysMessageWrapper is not a function');
  }
} catch (err) {
  logger.error(`[test-runtime] ❌ Loader validation failed: ${err.message}`);
  process.exit(1);
}
logger.info('[test-runtime] Loader validation completed successfully.');

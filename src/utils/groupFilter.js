'use strict';

const config = require('../config');
const logger = require('./logger');

function isAllowed(groupName) {
  if (!config.groupKeywords || config.groupKeywords.length === 0) {
    return true;
  }

  const lowerName = (groupName || '').toLowerCase();

  for (const keyword of config.groupKeywords) {
    if (lowerName.includes(keyword)) {
      return true;
    }
  }

  logger.debug(
    `[groupFilter] BLOCKED: "${groupName}" — no match in [${config.groupKeywords.join(', ')}]`
  );
  return false;
}

module.exports = { isAllowed };

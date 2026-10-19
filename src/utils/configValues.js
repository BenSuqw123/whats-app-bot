'use strict';
function integer(env, name, fallback, min = 1, max = 2_147_483_647) {
  const raw = env[name] === undefined ? String(fallback) : env[name];
  if (!/^\d+$/.test(raw)) throw new Error(`[config] ${name} must be an integer (${min}..${max}).`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`[config] ${name} must be an integer (${min}..${max}).`);
  return value;
}
module.exports = { integer };

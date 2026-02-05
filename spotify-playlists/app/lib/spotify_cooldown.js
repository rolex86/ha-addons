let _cooldownUntil = 0;

function nowMs() {
  return Date.now();
}

function getCooldownRemainingMs() {
  const rem = _cooldownUntil - nowMs();
  return rem > 0 ? rem : 0;
}

function setCooldownMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return _cooldownUntil;
  const until = nowMs() + n;
  if (until > _cooldownUntil) _cooldownUntil = until;
  return _cooldownUntil;
}

function clearCooldown() {
  _cooldownUntil = 0;
}

module.exports = {
  getCooldownRemainingMs,
  setCooldownMs,
  clearCooldown,
};

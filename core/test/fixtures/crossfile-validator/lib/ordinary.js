function isOrdinary(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized) return false;
  return /^[A-Za-z0-9._-]+$/.test(normalized);
}

module.exports = { isOrdinary };

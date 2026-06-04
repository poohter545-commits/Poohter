const clampInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const getPagination = (query = {}, { defaultLimit = 50, maxLimit = 100 } = {}) => {
  const limit = clampInteger(query.limit, defaultLimit, 1, maxLimit);
  const offset = clampInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return {
    limit,
    offset,
    nextOffset: offset + limit,
  };
};

module.exports = {
  getPagination,
};

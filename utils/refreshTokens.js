const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { JWT_SECRET } = require('../config/auth');

// Sellers stay signed in via a long-lived refresh token even though the
// access token itself is short-lived. Each refresh rotates the stored jti
// so a stolen refresh token can't be replayed after the legitimate client
// has refreshed at least once.
const ACCESS_TOKEN_TTL = '2h';
const REFRESH_TOKEN_TTL = '30d';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ensureRefreshTokenColumns = async (clientOrPool, tableName) => {
  if (!['sellers', 'wholesalers'].includes(tableName)) {
    throw new Error('Unsupported refresh token table');
  }
  await clientOrPool.query(`
    ALTER TABLE ${tableName}
      ADD COLUMN IF NOT EXISTS refresh_token_jti TEXT,
      ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMP
  `);
};

const issueTokenPair = ({ id, email, role }) => {
  const accessToken = jwt.sign({ id, email, role }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
  const jti = crypto.randomUUID();
  const refreshToken = jwt.sign({ id, role, jti, type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
  return { accessToken, refreshToken, jti };
};

const storeRefreshToken = async (clientOrPool, tableName, id, jti) => {
  await clientOrPool.query(
    `UPDATE ${tableName}
     SET refresh_token_jti = $1,
         refresh_token_expires_at = NOW() + INTERVAL '30 days'
     WHERE id = $2`,
    [jti, id]
  );
};

// Verifies the refresh token's signature/expiry, then confirms it matches
// the jti currently on file (guards against reuse of a rotated-out token).
const verifyRefreshToken = async (clientOrPool, tableName, role, refreshToken) => {
  let payload;
  try {
    payload = jwt.verify(refreshToken, JWT_SECRET);
  } catch {
    return null;
  }
  if (payload.type !== 'refresh' || payload.role !== role || !payload.id || !payload.jti) return null;

  const result = await clientOrPool.query(
    `SELECT id, email, status, refresh_token_jti, refresh_token_expires_at
     FROM ${tableName}
     WHERE id = $1`,
    [payload.id]
  );
  const account = result.rows[0];
  if (!account) return null;
  if (!account.refresh_token_jti || account.refresh_token_jti !== payload.jti) return null;
  if (account.refresh_token_expires_at && new Date(account.refresh_token_expires_at).getTime() < Date.now()) return null;

  return account;
};

module.exports = {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  REFRESH_TOKEN_TTL_MS,
  ensureRefreshTokenColumns,
  issueTokenPair,
  storeRefreshToken,
  verifyRefreshToken,
};

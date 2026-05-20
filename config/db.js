const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const shouldUseSsl = (connectionString) => (
  process.env.NODE_ENV === 'production'
  || /supabase\.com/i.test(connectionString || '')
);

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const timeoutConfig = {
  connectionTimeoutMillis: positiveNumber(process.env.DB_CONNECTION_TIMEOUT_MS, 10000),
  idleTimeoutMillis: positiveNumber(process.env.DB_IDLE_TIMEOUT_MS, 30000),
  query_timeout: positiveNumber(process.env.DB_QUERY_TIMEOUT_MS, 15000),
  statement_timeout: positiveNumber(process.env.DB_STATEMENT_TIMEOUT_MS, 15000),
  idle_in_transaction_session_timeout: positiveNumber(process.env.DB_IDLE_TRANSACTION_TIMEOUT_MS, 15000),
  keepAlive: true,
  max: positiveNumber(process.env.DB_POOL_MAX, 10),
};

const poolConfig = process.env.DATABASE_URL
  ? {
      ...timeoutConfig,
      connectionString: process.env.DATABASE_URL,
      ssl: shouldUseSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
    }
  : {
      ...timeoutConfig,
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'postgres',
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    };

const pool = new Pool(poolConfig);

module.exports = pool;

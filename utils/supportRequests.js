const pool = require('../config/db');

const SUPPORT_STATUSES = ['pending', 'contacted', 'resolved'];

const ensureSupportRequestsTable = async (clientOrPool = pool) => {
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS support_requests (
      id SERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT NOT NULL,
      message TEXT,
      account_type TEXT NOT NULL DEFAULT 'buyer',
      source TEXT NOT NULL DEFAULT 'website',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await clientOrPool.query(`
    CREATE INDEX IF NOT EXISTS idx_support_requests_status_created
    ON support_requests(status, created_at DESC)
  `);
};

const normalizeSupportStatus = (status) => String(status || '').trim().toLowerCase();
const isSupportStatus = (status) => SUPPORT_STATUSES.includes(normalizeSupportStatus(status));

module.exports = {
  SUPPORT_STATUSES,
  ensureSupportRequestsTable,
  isSupportStatus,
  normalizeSupportStatus,
};

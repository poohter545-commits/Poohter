const pool = require('../config/db');

const RECEIVING_STATUSES = [
  'scanned',
  'pending_review',
  'added_to_inventory',
  'approved',
  'rejected',
  'needs_correction',
];

const ensureWarehouseReceivingTable = async (clientOrPool = pool) => {
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS warehouse_receiving_scans (
      id SERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      wholesale_order_id INTEGER,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      tracking_id TEXT,
      product_uid TEXT,
      receipt_code TEXT,
      source_account_type TEXT,
      source_name TEXT,
      quantity INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scanned',
      notes TEXT,
      scanned_by TEXT,
      scanned_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await clientOrPool.query(`
    CREATE INDEX IF NOT EXISTS idx_warehouse_receiving_scans_status_scanned
    ON warehouse_receiving_scans(status, scanned_at DESC)
  `);
  await clientOrPool.query(`
    CREATE INDEX IF NOT EXISTS idx_warehouse_receiving_scans_lookup
    ON warehouse_receiving_scans(product_uid, receipt_code, tracking_id)
  `);
};

const normalizeReceivingStatus = (status) => String(status || '').trim().toLowerCase().replace(/\s+/g, '_');
const isReceivingStatus = (status) => RECEIVING_STATUSES.includes(normalizeReceivingStatus(status));

module.exports = {
  RECEIVING_STATUSES,
  ensureWarehouseReceivingTable,
  isReceivingStatus,
  normalizeReceivingStatus,
};

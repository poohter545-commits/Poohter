const RETURN_STATUSES = ['pending', 'approved', 'rejected', 'completed'];
const RETURN_REFUND_STATUSES = ['approved', 'completed'];

const ensureReturnsTable = async (clientOrPool) => {
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS return_requests (
      id SERIAL PRIMARY KEY,
      return_code TEXT UNIQUE,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      refund_amount NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      processed_at TIMESTAMP,
      inventory_reversed_at TIMESTAMP
    )
  `);
  await clientOrPool.query(`
    ALTER TABLE return_requests
      ADD COLUMN IF NOT EXISTS platform TEXT,
      ADD COLUMN IF NOT EXISTS processed_by TEXT,
      ADD COLUMN IF NOT EXISTS admin_note TEXT,
      ALTER COLUMN status SET DEFAULT 'pending'
  `);
  await clientOrPool.query(`
    UPDATE return_requests
    SET status = CASE
      WHEN status = 'requested' THEN 'pending'
      WHEN status IN ('received', 'refunded') THEN 'completed'
      ELSE status
    END
    WHERE status IN ('requested', 'received', 'refunded')
  `);
};

const createReturnCode = () => `RET-${Date.now().toString().slice(-8)}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

const normalizeReturnStatus = (status) => String(status || '').trim().toLowerCase();

const isReturnStatus = (status) => RETURN_STATUSES.includes(normalizeReturnStatus(status));

const getReturnWindow = (deliveredAt) => {
  const deliveredTime = deliveredAt ? new Date(deliveredAt).getTime() : NaN;
  if (!Number.isFinite(deliveredTime)) {
    return {
      eligible: false,
      expiresAt: null,
      reason: 'Order delivery time is not available.',
    };
  }

  const expiresAt = new Date(deliveredTime + 7 * 24 * 60 * 60 * 1000);
  const eligible = Date.now() <= expiresAt.getTime();
  return {
    eligible,
    expiresAt,
    reason: eligible ? '' : 'Return period expired',
  };
};

module.exports = {
  RETURN_REFUND_STATUSES,
  RETURN_STATUSES,
  createReturnCode,
  ensureReturnsTable,
  getReturnWindow,
  isReturnStatus,
  normalizeReturnStatus,
};

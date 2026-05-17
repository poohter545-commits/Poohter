const DEFAULT_COMMISSION_RATE = 0;

const numberValue = (value) => Number(value || 0);
const payoutCode = () => `PAY-${Date.now().toString().slice(-8)}`;

const ensureSellerPayoutTables = async (clientOrPool) => {
  await clientOrPool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS admin_price NUMERIC(12,2)
  `);
  await clientOrPool.query(`
    UPDATE products
    SET admin_price = price
    WHERE admin_price IS NULL
  `);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS return_requests (
      id SERIAL PRIMARY KEY,
      return_code TEXT UNIQUE,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'requested',
      refund_amount NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      processed_at TIMESTAMP,
      inventory_reversed_at TIMESTAMP
    )
  `);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS seller_payouts (
      id SERIAL PRIMARY KEY,
      payout_code TEXT UNIQUE,
      seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'paid',
      method TEXT,
      reference TEXT,
      note TEXT,
      period_start DATE,
      period_end DATE,
      gross_sales NUMERIC(12,2) DEFAULT 0,
      refund_amount NUMERIC(12,2) DEFAULT 0,
      commission_amount NUMERIC(12,2) DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      paid_at TIMESTAMP DEFAULT NOW()
    )
  `);
};

const sellerPayoutQuery = `
  WITH seller_sales AS (
    SELECT
      s.id AS seller_id,
      COALESCE(SUM(
        CASE
          WHEN o.status IN ('delivered', 'successful')
          THEN oi.quantity * COALESCE(p.admin_price, p.price, oi.price, 0)
          ELSE 0
        END
      ), 0) AS gross_sales,
      COALESCE(SUM(CASE WHEN o.status IN ('delivered', 'successful') THEN oi.quantity ELSE 0 END), 0) AS units_sold,
      COUNT(DISTINCT CASE WHEN o.status IN ('delivered', 'successful') THEN o.id END) AS delivered_orders,
      MIN(CASE WHEN o.status IN ('delivered', 'successful') THEN o.created_at::date END) AS first_sale_at,
      MAX(CASE WHEN o.status IN ('delivered', 'successful') THEN o.created_at::date END) AS last_sale_at
    FROM sellers s
    LEFT JOIN products p ON p.seller_id = s.id
    LEFT JOIN order_items oi ON oi.product_id = p.id
    LEFT JOIN orders o ON o.id = oi.order_id
    WHERE ($1::integer IS NULL OR s.id = $1::integer)
    GROUP BY s.id
  ),
  seller_refunds AS (
    SELECT
      p.seller_id,
      COALESCE(SUM(rr.quantity * COALESCE(p.admin_price, p.price, 0)), 0) AS refund_amount
    FROM return_requests rr
    JOIN products p ON rr.product_id = p.id
    WHERE rr.status IN ('approved', 'received', 'refunded')
      AND ($1::integer IS NULL OR p.seller_id = $1::integer)
    GROUP BY p.seller_id
  ),
  paid AS (
    SELECT
      seller_id,
      COALESCE(SUM(amount), 0) AS paid_amount,
      MAX(paid_at) AS last_paid_at
    FROM seller_payouts
    WHERE status = 'paid'
      AND ($1::integer IS NULL OR seller_id = $1::integer)
    GROUP BY seller_id
  ),
  seller_orders AS (
    SELECT
      p.seller_id,
      json_agg(
        json_build_object(
          'order_id', o.id,
          'order_code', o.order_code,
          'status', o.status,
          'platform', CASE WHEN o.source = 'manual' THEN COALESCE(NULLIF(o.platform, ''), 'Manual') ELSE 'Poohter app' END,
          'customer_name', COALESCE(o.customer_name, u.name),
          'created_at', o.created_at,
          'product_uid', p.product_uid,
          'product_name', p.name,
          'quantity', oi.quantity,
          'admin_price', COALESCE(p.admin_price, p.price, oi.price, 0),
          'seller_amount', oi.quantity * COALESCE(p.admin_price, p.price, oi.price, 0)
        )
        ORDER BY o.created_at DESC, o.id DESC
      ) AS payout_orders
    FROM products p
    JOIN order_items oi ON oi.product_id = p.id
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN users u ON o.user_id = u.id
    WHERE o.status IN ('delivered', 'successful')
      AND ($1::integer IS NULL OR p.seller_id = $1::integer)
    GROUP BY p.seller_id
  )
  SELECT
    s.id,
    COALESCE(s.shop_name, s.name) AS seller_name,
    s.name AS owner_name,
    s.email,
    s.phone,
    s.bank_name,
    s.account_title,
    s.account_number,
    s.mobile_wallet,
    s.status,
    COALESCE(ss.gross_sales, 0) AS gross_sales,
    COALESCE(sr.refund_amount, 0) AS refund_amount,
    GREATEST(COALESCE(ss.gross_sales, 0) - COALESCE(sr.refund_amount, 0), 0) AS net_sales,
    GREATEST(COALESCE(ss.gross_sales, 0) - COALESCE(sr.refund_amount, 0), 0) * $2::numeric AS commission_amount,
    GREATEST(COALESCE(ss.gross_sales, 0) - COALESCE(sr.refund_amount, 0), 0) * (1 - $2::numeric) AS seller_earning,
    COALESCE(paid.paid_amount, 0) AS paid_amount,
    GREATEST((GREATEST(COALESCE(ss.gross_sales, 0) - COALESCE(sr.refund_amount, 0), 0) * (1 - $2::numeric)) - COALESCE(paid.paid_amount, 0), 0) AS pending_payout,
    COALESCE(ss.units_sold, 0) AS units_sold,
    COALESCE(ss.delivered_orders, 0) AS delivered_orders,
    ss.first_sale_at,
    ss.last_sale_at,
    paid.last_paid_at,
    COALESCE(so.payout_orders, '[]'::json) AS payout_orders
  FROM sellers s
  LEFT JOIN seller_sales ss ON ss.seller_id = s.id
  LEFT JOIN seller_refunds sr ON sr.seller_id = s.id
  LEFT JOIN paid ON paid.seller_id = s.id
  LEFT JOIN seller_orders so ON so.seller_id = s.id
  WHERE s.status = 'approved'
    AND ($1::integer IS NULL OR s.id = $1::integer)
  ORDER BY pending_payout DESC, seller_earning DESC
`;

const normalizePayoutRow = (row) => ({
  ...row,
  gross_sales: numberValue(row.gross_sales),
  refund_amount: numberValue(row.refund_amount),
  net_sales: numberValue(row.net_sales),
  commission_amount: numberValue(row.commission_amount),
  seller_earning: numberValue(row.seller_earning),
  paid_amount: numberValue(row.paid_amount),
  pending_payout: numberValue(row.pending_payout),
  units_sold: numberValue(row.units_sold),
  delivered_orders: numberValue(row.delivered_orders),
  payout_orders: Array.isArray(row.payout_orders)
    ? row.payout_orders.map((order) => ({
      ...order,
      quantity: numberValue(order.quantity),
      admin_price: numberValue(order.admin_price),
      seller_amount: numberValue(order.seller_amount),
    }))
    : [],
});

const getSellerPayoutRows = async (clientOrPool, sellerId = null, commissionRate = DEFAULT_COMMISSION_RATE) => {
  await ensureSellerPayoutTables(clientOrPool);
  const result = await clientOrPool.query(sellerPayoutQuery, [sellerId, commissionRate]);
  return result.rows.map(normalizePayoutRow);
};

const getRecentPayouts = async (clientOrPool, sellerId = null, limit = 12) => {
  await ensureSellerPayoutTables(clientOrPool);
  const result = await clientOrPool.query(
    `SELECT
      sp.id, sp.payout_code, sp.seller_id, COALESCE(s.shop_name, s.name) AS seller_name,
      sp.amount, sp.status, sp.method, sp.reference, sp.note, sp.period_start, sp.period_end,
      sp.gross_sales, sp.refund_amount, sp.commission_amount, sp.created_at, sp.paid_at
     FROM seller_payouts sp
     JOIN sellers s ON sp.seller_id = s.id
     WHERE ($1::integer IS NULL OR sp.seller_id = $1::integer)
     ORDER BY sp.paid_at DESC, sp.created_at DESC
     LIMIT $2`,
    [sellerId, limit]
  );

  return result.rows.map(row => ({
    ...row,
    amount: numberValue(row.amount),
    gross_sales: numberValue(row.gross_sales),
    refund_amount: numberValue(row.refund_amount),
    commission_amount: numberValue(row.commission_amount),
  }));
};

const getPayoutSummary = async (clientOrPool, sellerId = null, commissionRate = DEFAULT_COMMISSION_RATE) => {
  const rows = await getSellerPayoutRows(clientOrPool, sellerId, commissionRate);
  const recent = await getRecentPayouts(clientOrPool, sellerId);
  return {
    commission_rate: commissionRate,
    seller_payout_rate: 1 - commissionRate,
    total_pending: rows.reduce((sum, row) => sum + row.pending_payout, 0),
    total_paid: rows.reduce((sum, row) => sum + row.paid_amount, 0),
    total_seller_earning: rows.reduce((sum, row) => sum + row.seller_earning, 0),
    rows,
    recent,
  };
};

const createSellerPayout = async (client, sellerId, options = {}) => {
  await ensureSellerPayoutTables(client);
  const commissionRate = options.commissionRate ?? DEFAULT_COMMISSION_RATE;
  const rows = await getSellerPayoutRows(client, sellerId, commissionRate);
  const seller = rows[0];

  if (!seller) {
    throw Object.assign(new Error('Seller payout account not found'), { status: 404 });
  }

  const amount = options.amount == null ? seller.pending_payout : Number(options.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Payout amount must be greater than zero'), { status: 400 });
  }
  if (amount > seller.pending_payout + 0.01) {
    throw Object.assign(new Error('Payout amount cannot exceed pending payout'), { status: 400 });
  }

  const result = await client.query(
    `INSERT INTO seller_payouts (
      payout_code, seller_id, amount, status, method, reference, note,
      period_start, period_end, gross_sales, refund_amount, commission_amount,
      created_by, paid_at
     ) VALUES ($1, $2, $3, 'paid', $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     RETURNING *`,
    [
      payoutCode(),
      sellerId,
      amount,
      options.method || 'Bank transfer',
      options.reference || null,
      options.note || null,
      seller.first_sale_at || null,
      seller.last_sale_at || null,
      seller.gross_sales,
      seller.refund_amount,
      seller.commission_amount,
      options.createdBy || 'topteam',
    ]
  );

  return {
    ...result.rows[0],
    amount: numberValue(result.rows[0].amount),
    gross_sales: numberValue(result.rows[0].gross_sales),
    refund_amount: numberValue(result.rows[0].refund_amount),
    commission_amount: numberValue(result.rows[0].commission_amount),
  };
};

module.exports = {
  DEFAULT_COMMISSION_RATE,
  ensureSellerPayoutTables,
  getPayoutSummary,
  getSellerPayoutRows,
  getRecentPayouts,
  createSellerPayout,
};

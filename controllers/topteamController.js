const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const {
  DEFAULT_COMMISSION_RATE,
  getPayoutSummary,
  createSellerPayout,
} = require('../utils/sellerPayouts');
const {
  slugify,
  ensureSalesPlatformsTable,
  getSalesPlatforms,
} = require('../utils/salesPlatforms');

const PROFIT_RATE = DEFAULT_COMMISSION_RATE;

const generateTopTeamToken = () => jwt.sign(
  { id: 'topteam', email: 'topteam@poohter.local', role: 'topteam' },
  process.env.JWT_SECRET || 'your_jwt_secret_here',
  { expiresIn: '12h' }
);

const numberValue = (value) => Number(value || 0);
const textValue = (value) => String(value || '').trim();

const amountValue = (value, fallback = 0) => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const pctChange = (current, previous) => {
  const currentValue = numberValue(current);
  const previousValue = numberValue(previous);
  if (!previousValue && currentValue) return 100;
  if (!previousValue) return 0;
  return ((currentValue - previousValue) / previousValue) * 100;
};

const ensureReturnTable = async () => {
  await pool.query(`
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
};

const ensureExecutiveTables = async () => {
  await ensureReturnTable();
  await ensureSalesPlatformsTable(pool);
  await pool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS admin_price NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS topteam_priced_at TIMESTAMP
  `);
  await pool.query(`
    UPDATE products
    SET admin_price = price
    WHERE admin_price IS NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS delivery_updates (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE delivery_updates
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_finance (
      product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
      supplier_name TEXT,
      note TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_platform_pricing (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      platform_id INTEGER NOT NULL REFERENCES sales_platforms(id) ON DELETE CASCADE,
      platform_selling_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      expected_receivable NUMERIC(12,2) NOT NULL DEFAULT 0,
      note TEXT,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(product_id, platform_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_finance (
      order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      delivery_cost NUMERIC(12,2) DEFAULT 0,
      return_shipping_cost NUMERIC(12,2) DEFAULT 0,
      packaging_cost NUMERIC(12,2) DEFAULT 0,
      payment_fee NUMERIC(12,2) DEFAULT 0,
      platform_fee NUMERIC(12,2) DEFAULT 0,
      damage_adjustment NUMERIC(12,2) DEFAULT 0,
      note TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_spend (
      id SERIAL PRIMARY KEY,
      channel TEXT NOT NULL,
      campaign TEXT,
      amount NUMERIC(12,2) NOT NULL,
      spend_date DATE DEFAULT CURRENT_DATE,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_targets (
      id SERIAL PRIMARY KEY,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      target_sales NUMERIC(12,2) DEFAULT 0,
      target_orders INTEGER DEFAULT 0,
      target_profit NUMERIC(12,2) DEFAULT 0,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
};

const login = async (req, res) => {
  const { password } = req.body;
  const expectedPassword = process.env.TOPTEAM_PASSWORD || 'topteam123';

  if (password !== expectedPassword) {
    return res.status(401).json({ error: 'Invalid top team password' });
  }

  res.json({
    token: generateTopTeamToken(),
    user: { name: 'Poohter Top Team', role: 'topteam' }
  });
};

const getOverview = async (req, res, next) => {
  try {
    await ensureExecutiveTables();

    const [
      core,
      today,
      month,
      previousMonth,
      salesSeries,
      statusBreakdown,
      sourceBreakdown,
      topProducts,
      sellerPerformance,
      stockRisk,
      returnsByStatus,
      attention,
      payouts,
      financeSummary,
      productCosts,
      orderCosts,
      marketingChannels,
      marketingRecent,
      inventoryAging,
      customerHealth,
      topCustomers,
      targets,
      platforms,
      productPlatformPricing,
      pendingPriceProducts
    ] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM orders WHERE status != 'cancelled') AS orders,
          (SELECT COALESCE(SUM(total_price), 0) FROM orders WHERE status != 'cancelled') AS gross_sales,
          (SELECT COALESCE(SUM(refund_amount), 0) FROM return_requests WHERE status IN ('approved', 'received', 'refunded')) AS refunds,
          (SELECT COALESCE(AVG(total_price), 0) FROM orders WHERE status != 'cancelled') AS average_order_value,
          (
            SELECT COALESCE(SUM(oi.quantity), 0)
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE o.status != 'cancelled'
          ) AS units_sold
      `),
      pool.query(`
        SELECT
          COUNT(*) AS orders,
          COALESCE(SUM(total_price), 0) AS sales
        FROM orders
        WHERE status != 'cancelled'
          AND created_at::date = CURRENT_DATE
      `),
      pool.query(`
        SELECT
          COUNT(*) AS orders,
          COALESCE(SUM(total_price), 0) AS sales
        FROM orders
        WHERE status != 'cancelled'
          AND created_at >= date_trunc('month', CURRENT_DATE)
      `),
      pool.query(`
        SELECT
          COUNT(*) AS orders,
          COALESCE(SUM(total_price), 0) AS sales
        FROM orders
        WHERE status != 'cancelled'
          AND created_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
          AND created_at < date_trunc('month', CURRENT_DATE)
      `),
      pool.query(`
        SELECT
          to_char(days.day, 'Mon DD') AS label,
          days.day::date AS date,
          COALESCE(COUNT(o.id), 0) AS orders,
          COALESCE(SUM(o.total_price), 0) AS sales
        FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') AS days(day)
        LEFT JOIN orders o
          ON o.created_at::date = days.day::date
         AND o.status != 'cancelled'
        GROUP BY days.day
        ORDER BY days.day
      `),
      pool.query(`
        SELECT status, COUNT(*) AS orders, COALESCE(SUM(total_price), 0) AS sales
        FROM orders
        GROUP BY status
        ORDER BY orders DESC
      `),
      pool.query(`
        SELECT
          CASE
            WHEN source = 'manual' THEN COALESCE(NULLIF(platform, ''), 'Manual')
            ELSE 'Poohter app'
          END AS label,
          COUNT(*) AS orders,
          COALESCE(SUM(total_price), 0) AS sales
        FROM orders
        WHERE status != 'cancelled'
        GROUP BY label
        ORDER BY sales DESC
      `),
      pool.query(`
        SELECT
          p.id, p.product_uid, p.name,
          COALESCE(s.shop_name, s.name, 'Poohter') AS seller_name,
          COALESCE(SUM(oi.quantity), 0) AS units,
          COALESCE(SUM(oi.quantity * oi.price), 0) AS sales
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        JOIN products p ON oi.product_id = p.id
        LEFT JOIN sellers s ON p.seller_id = s.id
        WHERE o.status != 'cancelled'
        GROUP BY p.id, s.id
        ORDER BY sales DESC
        LIMIT 8
      `),
      pool.query(`
        SELECT
          s.id,
          COALESCE(s.shop_name, s.name) AS seller_name,
          s.city,
          COUNT(DISTINCT p.id) AS products,
          COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.quantity ELSE 0 END), 0) AS units,
          COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.quantity * oi.price ELSE 0 END), 0) AS sales
        FROM sellers s
        LEFT JOIN products p ON p.seller_id = s.id
        LEFT JOIN order_items oi ON oi.product_id = p.id
        LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'cancelled'
        WHERE s.status = 'approved'
        GROUP BY s.id
        ORDER BY sales DESC
        LIMIT 8
      `),
      pool.query(`
        SELECT
          p.id, p.product_uid, p.name,
          COALESCE(s.shop_name, s.name, 'Poohter') AS seller_name,
          COALESCE(i.stock_quantity, 0) AS stock_quantity
        FROM products p
        LEFT JOIN sellers s ON p.seller_id = s.id
        LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
        WHERE COALESCE(i.stock_quantity, 0) <= 5
          AND COALESCE(p.status, 'pending') IN ('live', 'active', 'warehouse_received')
        ORDER BY COALESCE(i.stock_quantity, 0), p.name
        LIMIT 10
      `),
      pool.query(`
        SELECT status, COUNT(*) AS returns, COALESCE(SUM(quantity), 0) AS units, COALESCE(SUM(refund_amount), 0) AS refunds
        FROM return_requests
        GROUP BY status
        ORDER BY returns DESC
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM sellers WHERE status = 'pending') AS pending_sellers,
          (SELECT COUNT(*) FROM products WHERE COALESCE(status, 'pending') = 'pending') AS pending_products,
          (SELECT COUNT(*) FROM return_requests WHERE status = 'requested') AS open_returns,
          (SELECT COUNT(*) FROM inventory WHERE stock_quantity <= 5) AS low_stock_items,
          (SELECT COUNT(*) FROM orders WHERE status IN ('pending', 'accepted', 'packed')) AS orders_in_process
      `)
      ,
      getPayoutSummary(pool, null, PROFIT_RATE),
      pool.query(`
        WITH product_costs AS (
          SELECT COALESCE(SUM(oi.quantity * pf.unit_cost), 0) AS product_cost
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.id
          JOIN product_finance pf ON pf.product_id = oi.product_id
          WHERE o.status != 'cancelled'
        ),
        order_costs AS (
          SELECT COALESCE(SUM(
            delivery_cost + return_shipping_cost + packaging_cost + payment_fee + platform_fee + damage_adjustment
          ), 0) AS operational_cost
          FROM order_finance
        ),
        marketing AS (
          SELECT
            COALESCE(SUM(amount), 0) AS marketing_spend,
            COALESCE(SUM(amount) FILTER (WHERE spend_date >= date_trunc('month', CURRENT_DATE)), 0) AS marketing_this_month
          FROM marketing_spend
        ),
        coverage AS (
          SELECT
            (SELECT COUNT(*) FROM products WHERE COALESCE(status, 'pending') IN ('live', 'active', 'warehouse_received', 'topteam_pending')) AS active_products,
            (SELECT COUNT(*) FROM product_finance) AS costed_products,
            (SELECT COUNT(*) FROM orders WHERE status != 'cancelled') AS active_orders,
            (SELECT COUNT(*) FROM order_finance) AS costed_orders
        )
        SELECT *
        FROM product_costs, order_costs, marketing, coverage
      `),
      pool.query(`
        SELECT
          p.id, p.product_uid, p.name,
          COALESCE(s.shop_name, s.name, 'Poohter') AS seller_name,
          p.price AS admin_price,
          pf.unit_cost, pf.supplier_name, pf.note, pf.updated_at,
          COALESCE(i.stock_quantity, 0) AS stock_quantity,
          COALESCE(i.stock_quantity, 0) * pf.unit_cost AS stock_value,
          COALESCE(sold.units, 0) AS units_sold,
          COALESCE(sold.sales, 0) AS sales
        FROM product_finance pf
        JOIN products p ON pf.product_id = p.id
        LEFT JOIN sellers s ON p.seller_id = s.id
        LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
        LEFT JOIN (
          SELECT oi.product_id, SUM(oi.quantity) AS units, SUM(oi.quantity * oi.price) AS sales
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE o.status != 'cancelled'
          GROUP BY oi.product_id
        ) sold ON sold.product_id = p.id
        ORDER BY stock_value DESC, p.name
        LIMIT 12
      `),
      pool.query(`
        SELECT
          ofi.order_id, o.order_code, o.platform, o.source, o.total_price,
          ofi.delivery_cost, ofi.return_shipping_cost, ofi.packaging_cost,
          ofi.payment_fee, ofi.platform_fee, ofi.damage_adjustment, ofi.note, ofi.updated_at,
          (ofi.delivery_cost + ofi.return_shipping_cost + ofi.packaging_cost + ofi.payment_fee + ofi.platform_fee + ofi.damage_adjustment) AS total_cost
        FROM order_finance ofi
        JOIN orders o ON ofi.order_id = o.id
        ORDER BY ofi.updated_at DESC
        LIMIT 12
      `),
      pool.query(`
        SELECT channel AS label, COALESCE(SUM(amount), 0) AS spend, COUNT(*) AS entries
        FROM marketing_spend
        GROUP BY channel
        ORDER BY spend DESC
      `),
      pool.query(`
        SELECT id, channel, campaign, amount, spend_date, note, created_at
        FROM marketing_spend
        ORDER BY spend_date DESC, id DESC
        LIMIT 12
      `),
      pool.query(`
        SELECT
          p.id, p.product_uid, p.name,
          COALESCE(s.shop_name, s.name, 'Poohter') AS seller_name,
          COALESCE(i.stock_quantity, 0) AS stock_quantity,
          COALESCE(p.live_at, p.warehouse_received_at, p.created_at) AS stock_since,
          GREATEST(CURRENT_DATE - COALESCE(p.live_at, p.warehouse_received_at, p.created_at)::date, 0) AS age_days,
          COALESCE(sold30.units, 0) AS units_sold_30d,
          COALESCE(i.stock_quantity, 0) * COALESCE(pf.unit_cost, 0) AS stock_value
        FROM products p
        LEFT JOIN sellers s ON p.seller_id = s.id
        LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
        LEFT JOIN product_finance pf ON pf.product_id = p.id
        LEFT JOIN (
          SELECT oi.product_id, SUM(oi.quantity) AS units
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE o.status != 'cancelled'
            AND o.created_at >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY oi.product_id
        ) sold30 ON sold30.product_id = p.id
        WHERE COALESCE(i.stock_quantity, 0) > 0
        ORDER BY age_days DESC, stock_quantity DESC
        LIMIT 12
      `),
      pool.query(`
        WITH customer_counts AS (
          SELECT
            COALESCE(o.user_id::text, NULLIF(o.customer_phone, ''), NULLIF(o.customer_email, ''), 'guest-' || o.id::text) AS customer_key,
            COUNT(*) AS orders,
            COALESCE(SUM(o.total_price) FILTER (WHERE o.status != 'cancelled'), 0) AS spend
          FROM orders o
          GROUP BY customer_key
        )
        SELECT
          (SELECT COUNT(*) FROM customer_counts) AS total_customers,
          (SELECT COUNT(*) FROM customer_counts WHERE orders > 1) AS repeat_customers,
          (SELECT COUNT(*) FROM orders WHERE status = 'cancelled') AS cancelled_orders,
          (SELECT COUNT(*) FROM orders) AS all_orders,
          (
            SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (du.created_at - o.created_at)) / 86400), 0)
            FROM orders o
            JOIN delivery_updates du ON du.order_id = o.id AND du.status = 'delivered'
            WHERE du.created_at >= o.created_at
          ) AS avg_delivery_days
      `),
      pool.query(`
        SELECT
          COALESCE(o.user_id::text, NULLIF(o.customer_phone, ''), NULLIF(o.customer_email, ''), 'guest-' || o.id::text) AS customer_key,
          COALESCE(MAX(o.customer_name), 'Customer') AS customer_name,
          COALESCE(MAX(o.customer_phone), MAX(o.customer_email), 'No contact') AS contact,
          COUNT(*) AS orders,
          COALESCE(SUM(o.total_price) FILTER (WHERE o.status != 'cancelled'), 0) AS spend,
          MAX(o.created_at) AS last_order_at
        FROM orders o
        GROUP BY customer_key
        ORDER BY spend DESC, orders DESC
        LIMIT 8
      `),
      pool.query(`
        SELECT id, period_start, period_end, target_sales, target_orders, target_profit, note, created_at
        FROM business_targets
        ORDER BY period_start DESC, id DESC
        LIMIT 8
      `),
      getSalesPlatforms(pool, true),
      pool.query(`
        SELECT
          ppp.id, ppp.product_id, p.product_uid, p.name,
          COALESCE(s.shop_name, s.name, 'Poohter') AS seller_name,
          sp.id AS platform_id, sp.name AS platform_name,
          p.price AS admin_price,
          COALESCE(pf.unit_cost, 0) AS unit_cost,
          ppp.platform_selling_price,
          ppp.expected_receivable,
          ppp.expected_receivable - COALESCE(pf.unit_cost, 0) AS expected_gross_profit,
          ppp.expected_receivable - p.price AS receivable_vs_admin_price,
          ppp.note,
          ppp.updated_at
        FROM product_platform_pricing ppp
        JOIN products p ON ppp.product_id = p.id
        JOIN sales_platforms sp ON ppp.platform_id = sp.id
        LEFT JOIN sellers s ON p.seller_id = s.id
        LEFT JOIN product_finance pf ON pf.product_id = p.id
        ORDER BY ppp.updated_at DESC, p.name
        LIMIT 20
      `),
      pool.query(`
        SELECT
          p.id, p.product_uid, p.name, p.name_urdu,
          COALESCE(p.admin_price, p.price, 0) AS admin_price,
          p.status, p.warehouse_received_at,
          COALESCE(s.shop_name, s.name, 'Poohter') AS seller_name,
          COALESCE(i.stock_quantity, 0) AS stock_quantity
        FROM products p
        LEFT JOIN sellers s ON p.seller_id = s.id
        LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
        WHERE COALESCE(p.status, 'pending') = 'topteam_pending'
        ORDER BY p.warehouse_received_at DESC NULLS LAST, p.created_at DESC
        LIMIT 30
      `)
    ]);

    const grossSales = numberValue(core.rows[0].gross_sales);
    const refunds = numberValue(core.rows[0].refunds);
    const netSales = Math.max(grossSales - refunds, 0);
    const estimatedProfit = netSales * PROFIT_RATE;
    const totalOrders = numberValue(core.rows[0].orders);
    const unitsSold = numberValue(core.rows[0].units_sold);
    const returnedUnits = returnsByStatus.rows.reduce((sum, row) => sum + numberValue(row.units), 0);
    const finance = financeSummary.rows[0];
    const productCostTotal = numberValue(finance.product_cost);
    const operationalCostTotal = numberValue(finance.operational_cost);
    const marketingSpend = numberValue(finance.marketing_spend);
    const marketingThisMonth = numberValue(finance.marketing_this_month);
    const trackedProfit = netSales - payouts.total_seller_earning - productCostTotal - operationalCostTotal - marketingSpend;
    const activeProducts = numberValue(finance.active_products);
    const activeOrders = numberValue(finance.active_orders);
    const currentTarget = targets.rows.find((target) => {
      const now = new Date();
      return new Date(target.period_start) <= now && new Date(target.period_end) >= now;
    }) || targets.rows[0] || null;

    res.json({
      generated_at: new Date().toISOString(),
      assumptions: {
        profit_rate: PROFIT_RATE,
        profit_label: 'Tracked Poohter profit',
        note: 'Profit becomes more accurate as product costs, order costs, and marketing spend are entered.'
      },
      summary: {
        gross_sales: grossSales,
        refunds,
        net_sales: netSales,
        estimated_profit: estimatedProfit,
        total_orders: totalOrders,
        units_sold: unitsSold,
        average_order_value: numberValue(core.rows[0].average_order_value),
        sales_today: numberValue(today.rows[0].sales),
        orders_today: numberValue(today.rows[0].orders),
        sales_this_month: numberValue(month.rows[0].sales),
        month_growth_percent: pctChange(month.rows[0].sales, previousMonth.rows[0].sales),
        return_rate_percent: unitsSold ? (returnedUnits / unitsSold) * 100 : 0,
        pending_seller_payouts: payouts.total_pending,
        seller_payouts_sent: payouts.total_paid,
        product_costs: productCostTotal,
        operational_costs: operationalCostTotal,
        marketing_spend: marketingSpend,
        marketing_this_month: marketingThisMonth,
        tracked_profit: trackedProfit,
        costed_product_percent: activeProducts ? (numberValue(finance.costed_products) / activeProducts) * 100 : 0,
        costed_order_percent: activeOrders ? (numberValue(finance.costed_orders) / activeOrders) * 100 : 0
      },
      charts: {
        sales_series: salesSeries.rows.map(row => ({
          ...row,
          orders: numberValue(row.orders),
          sales: numberValue(row.sales)
        })),
        status_breakdown: statusBreakdown.rows.map(row => ({
          ...row,
          orders: numberValue(row.orders),
          sales: numberValue(row.sales)
        })),
        source_breakdown: sourceBreakdown.rows.map(row => ({
          ...row,
          orders: numberValue(row.orders),
          sales: numberValue(row.sales)
        }))
      },
      tables: {
        top_products: topProducts.rows.map(row => ({
          ...row,
          units: numberValue(row.units),
          sales: numberValue(row.sales)
        })),
        seller_performance: sellerPerformance.rows.map(row => ({
          ...row,
          products: numberValue(row.products),
          units: numberValue(row.units),
          sales: numberValue(row.sales)
        })),
        stock_risk: stockRisk.rows.map(row => ({
          ...row,
          stock_quantity: numberValue(row.stock_quantity)
        })),
        product_costs: productCosts.rows.map(row => ({
          ...row,
          admin_price: numberValue(row.admin_price),
          unit_cost: numberValue(row.unit_cost),
          stock_quantity: numberValue(row.stock_quantity),
          stock_value: numberValue(row.stock_value),
          units_sold: numberValue(row.units_sold),
          sales: numberValue(row.sales)
        })),
        platforms: platforms.map(row => ({
          ...row,
          default_commission_rate: numberValue(row.default_commission_rate),
          default_payment_fee_rate: numberValue(row.default_payment_fee_rate)
        })),
        product_platform_prices: productPlatformPricing.rows.map(row => ({
          ...row,
          admin_price: numberValue(row.admin_price),
          unit_cost: numberValue(row.unit_cost),
          platform_selling_price: numberValue(row.platform_selling_price),
          expected_receivable: numberValue(row.expected_receivable),
          expected_gross_profit: numberValue(row.expected_gross_profit),
          receivable_vs_admin_price: numberValue(row.receivable_vs_admin_price)
        })),
        pending_price_products: pendingPriceProducts.rows.map(row => ({
          ...row,
          admin_price: numberValue(row.admin_price),
          stock_quantity: numberValue(row.stock_quantity)
        })),
        order_costs: orderCosts.rows.map(row => ({
          ...row,
          total_price: numberValue(row.total_price),
          delivery_cost: numberValue(row.delivery_cost),
          return_shipping_cost: numberValue(row.return_shipping_cost),
          packaging_cost: numberValue(row.packaging_cost),
          payment_fee: numberValue(row.payment_fee),
          platform_fee: numberValue(row.platform_fee),
          damage_adjustment: numberValue(row.damage_adjustment),
          total_cost: numberValue(row.total_cost)
        })),
        marketing_channels: marketingChannels.rows.map(row => ({
          ...row,
          spend: numberValue(row.spend),
          entries: numberValue(row.entries)
        })),
        marketing_recent: marketingRecent.rows.map(row => ({
          ...row,
          amount: numberValue(row.amount)
        })),
        inventory_aging: inventoryAging.rows.map(row => ({
          ...row,
          stock_quantity: numberValue(row.stock_quantity),
          age_days: numberValue(row.age_days),
          units_sold_30d: numberValue(row.units_sold_30d),
          stock_value: numberValue(row.stock_value)
        })),
        top_customers: topCustomers.rows.map(row => ({
          ...row,
          orders: numberValue(row.orders),
          spend: numberValue(row.spend)
        })),
        targets: targets.rows.map(row => ({
          ...row,
          target_sales: numberValue(row.target_sales),
          target_orders: numberValue(row.target_orders),
          target_profit: numberValue(row.target_profit)
        })),
        returns_by_status: returnsByStatus.rows.map(row => ({
          ...row,
          returns: numberValue(row.returns),
          units: numberValue(row.units),
          refunds: numberValue(row.refunds)
        }))
      },
      customer_health: {
        total_customers: numberValue(customerHealth.rows[0].total_customers),
        repeat_customers: numberValue(customerHealth.rows[0].repeat_customers),
        repeat_rate_percent: numberValue(customerHealth.rows[0].total_customers)
          ? (numberValue(customerHealth.rows[0].repeat_customers) / numberValue(customerHealth.rows[0].total_customers)) * 100
          : 0,
        cancelled_orders: numberValue(customerHealth.rows[0].cancelled_orders),
        cancellation_rate_percent: numberValue(customerHealth.rows[0].all_orders)
          ? (numberValue(customerHealth.rows[0].cancelled_orders) / numberValue(customerHealth.rows[0].all_orders)) * 100
          : 0,
        avg_delivery_days: numberValue(customerHealth.rows[0].avg_delivery_days)
      },
      forecast: currentTarget ? {
        current_target: {
          ...currentTarget,
          target_sales: numberValue(currentTarget.target_sales),
          target_orders: numberValue(currentTarget.target_orders),
          target_profit: numberValue(currentTarget.target_profit),
          sales_gap: numberValue(currentTarget.target_sales) - numberValue(month.rows[0].sales),
          order_gap: numberValue(currentTarget.target_orders) - numberValue(month.rows[0].orders),
          profit_gap: numberValue(currentTarget.target_profit) - trackedProfit
        }
      } : { current_target: null },
      attention: {
        pending_sellers: numberValue(attention.rows[0].pending_sellers),
        pending_products: numberValue(attention.rows[0].pending_products),
        open_returns: numberValue(attention.rows[0].open_returns),
        low_stock_items: numberValue(attention.rows[0].low_stock_items),
        orders_in_process: numberValue(attention.rows[0].orders_in_process)
      },
      payouts,
      required_for_true_profit: [
        'Keep product unit cost updated for every Poohter-owned SKU',
        'Record delivery, return shipping, packaging, payment, and platform costs',
        'Enter marketing spend by channel and campaign',
        'Set weekly or monthly sales, order, and profit targets',
        'Review inventory age and stock value every week',
        'Track repeat buyers, cancellations, and delivery speed'
      ]
    });
  } catch (error) {
    next(error);
  }
};

const markSellerPayoutPaid = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const sellerId = Number(req.params.sellerId);
    const { amount, method, reference, note } = req.body || {};

    if (!Number.isInteger(sellerId) || sellerId <= 0) {
      return res.status(400).json({ error: 'Valid seller ID is required' });
    }

    await client.query('BEGIN');
    const payout = await createSellerPayout(client, sellerId, {
      amount,
      method,
      reference,
      note,
      commissionRate: PROFIT_RATE,
      createdBy: req.user?.email || req.user?.role || 'topteam',
    });
    await client.query('COMMIT');

    res.status(201).json({ payout });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const saveSalesPlatform = async (req, res, next) => {
  try {
    await ensureExecutiveTables();
    const name = textValue(req.body.name);

    if (!name) {
      return res.status(400).json({ error: 'Platform name is required' });
    }

    const result = await pool.query(
      `INSERT INTO sales_platforms (
        name, code, active, default_commission_rate, default_payment_fee_rate, note, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (name)
       DO UPDATE SET
         active = TRUE,
         updated_at = NOW()
       RETURNING *`,
      [
        name,
        slugify(req.body.code || name),
        true,
        0,
        0,
        null,
      ]
    );

    res.status(201).json({ platform: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const saveProductCost = async (req, res, next) => {
  try {
    await ensureExecutiveTables();
    const productLookup = textValue(req.body.product_lookup || req.body.product_id || req.body.product_uid);
    const hasUnitCost = req.body.unit_cost !== undefined && textValue(req.body.unit_cost) !== '';
    const unitCost = hasUnitCost ? amountValue(req.body.unit_cost, NaN) : null;
    const platformId = Number(req.body.platform_id || 0);
    const hasPlatformPricing =
      platformId > 0 &&
      textValue(req.body.platform_selling_price) !== '' &&
      textValue(req.body.expected_receivable) !== '';

    if (platformId > 0 && !hasPlatformPricing) {
      return res.status(400).json({ error: 'Platform selling price and expected receivable are required for platform pricing' });
    }

    if (!productLookup || (!hasUnitCost && !hasPlatformPricing)) {
      return res.status(400).json({ error: 'Product ID/UID and at least one cost or platform price field are required' });
    }

    if (hasUnitCost && (!Number.isFinite(unitCost) || unitCost < 0)) {
      return res.status(400).json({ error: 'Unit cost must be a non-negative number' });
    }

    const productResult = await pool.query(
      `SELECT id, name, product_uid, price, admin_price, status
       FROM products
       WHERE product_uid = $1 OR id::text = $1
       LIMIT 1`,
      [productLookup]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productResult.rows[0];
    let finance = null;
    let platformPricing = null;

    if (hasUnitCost) {
      const result = await pool.query(
        `INSERT INTO product_finance (product_id, unit_cost, supplier_name, note, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (product_id)
         DO UPDATE SET
           unit_cost = EXCLUDED.unit_cost,
           supplier_name = EXCLUDED.supplier_name,
           note = EXCLUDED.note,
           updated_at = NOW()
         RETURNING *`,
        [product.id, unitCost, textValue(req.body.supplier_name) || null, textValue(req.body.note) || null]
      );
      finance = result.rows[0];
    }

    if (hasPlatformPricing) {
      const platformResult = await pool.query('SELECT id, name, code FROM sales_platforms WHERE id = $1 LIMIT 1', [platformId]);
      if (platformResult.rows.length === 0) {
        return res.status(404).json({ error: 'Sales platform not found' });
      }

      const platformSellingPrice = amountValue(req.body.platform_selling_price, NaN);
      const expectedReceivable = amountValue(req.body.expected_receivable, NaN);

      if (!Number.isFinite(platformSellingPrice) || platformSellingPrice < 0 || !Number.isFinite(expectedReceivable) || expectedReceivable < 0) {
        return res.status(400).json({ error: 'Platform selling price and expected receivable must be non-negative numbers' });
      }

      const pricingResult = await pool.query(
        `INSERT INTO product_platform_pricing (
          product_id, platform_id, platform_selling_price, expected_receivable, note, updated_at
         ) VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (product_id, platform_id)
         DO UPDATE SET
           platform_selling_price = EXCLUDED.platform_selling_price,
           expected_receivable = EXCLUDED.expected_receivable,
           note = EXCLUDED.note,
           updated_at = NOW()
         RETURNING *`,
        [
          product.id,
          platformId,
          platformSellingPrice,
          expectedReceivable,
          textValue(req.body.platform_note || req.body.note) || null,
        ]
      );
      platformPricing = pricingResult.rows[0];

      const platform = platformResult.rows[0];
      const isPoohterBuyerPlatform = platform.code === 'poohter-app' || platform.name.toLowerCase() === 'poohter app';
      if (isPoohterBuyerPlatform) {
        await pool.query(
          `UPDATE products
           SET price = $1,
               admin_price = COALESCE(admin_price, $2),
               status = 'live',
               live_at = COALESCE(live_at, NOW()),
               topteam_priced_at = NOW()
           WHERE id = $3`,
          [platformSellingPrice, product.admin_price || product.price || 0, product.id]
        );
      }
    }

    res.json({ product, finance, platform_pricing: platformPricing });
  } catch (error) {
    next(error);
  }
};

const saveOrderCost = async (req, res, next) => {
  try {
    await ensureExecutiveTables();
    const orderLookup = textValue(req.body.order_lookup || req.body.order_id || req.body.order_code);

    if (!orderLookup) {
      return res.status(400).json({ error: 'Order code or ID is required' });
    }

    const orderResult = await pool.query(
      `SELECT id, order_code
       FROM orders
       WHERE order_code = $1 OR id::text = $1
       LIMIT 1`,
      [orderLookup]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    const result = await pool.query(
      `INSERT INTO order_finance (
        order_id, delivery_cost, return_shipping_cost, packaging_cost,
        payment_fee, platform_fee, damage_adjustment, note, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (order_id)
       DO UPDATE SET
         delivery_cost = EXCLUDED.delivery_cost,
         return_shipping_cost = EXCLUDED.return_shipping_cost,
         packaging_cost = EXCLUDED.packaging_cost,
         payment_fee = EXCLUDED.payment_fee,
         platform_fee = EXCLUDED.platform_fee,
         damage_adjustment = EXCLUDED.damage_adjustment,
         note = EXCLUDED.note,
         updated_at = NOW()
       RETURNING *`,
      [
        order.id,
        amountValue(req.body.delivery_cost),
        amountValue(req.body.return_shipping_cost),
        amountValue(req.body.packaging_cost),
        amountValue(req.body.payment_fee),
        amountValue(req.body.platform_fee),
        amountValue(req.body.damage_adjustment),
        textValue(req.body.note) || null
      ]
    );

    res.json({ order, finance: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const addMarketingSpend = async (req, res, next) => {
  try {
    await ensureExecutiveTables();
    const channel = textValue(req.body.channel);
    const amount = amountValue(req.body.amount, NaN);

    if (!channel || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Channel and a positive spend amount are required' });
    }

    const result = await pool.query(
      `INSERT INTO marketing_spend (channel, campaign, amount, spend_date, note)
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5)
       RETURNING *`,
      [
        channel,
        textValue(req.body.campaign) || null,
        amount,
        textValue(req.body.spend_date) || null,
        textValue(req.body.note) || null
      ]
    );

    res.status(201).json({ spend: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const addBusinessTarget = async (req, res, next) => {
  try {
    await ensureExecutiveTables();
    const periodStart = textValue(req.body.period_start);
    const periodEnd = textValue(req.body.period_end);

    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: 'Target start and end dates are required' });
    }

    const result = await pool.query(
      `INSERT INTO business_targets (period_start, period_end, target_sales, target_orders, target_profit, note)
       VALUES ($1::date, $2::date, $3, $4, $5, $6)
       RETURNING *`,
      [
        periodStart,
        periodEnd,
        amountValue(req.body.target_sales),
        Math.max(0, Math.round(amountValue(req.body.target_orders))),
        amountValue(req.body.target_profit),
        textValue(req.body.note) || null
      ]
    );

    res.status(201).json({ target: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  login,
  getOverview,
  markSellerPayoutPaid,
  saveSalesPlatform,
  saveProductCost,
  saveOrderCost,
  addMarketingSpend,
  addBusinessTarget
};

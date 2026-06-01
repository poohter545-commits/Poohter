const numberValue = (value) => Number(value || 0);
const textValue = (value) => String(value || '').trim();

const createCode = (prefix) => `${prefix}-${Date.now().toString().slice(-8)}-${Math.floor(Math.random() * 900 + 100)}`;

let wholesaleSchemaReady = false;
let wholesaleSchemaPromise = null;

const ensureProductWorkflowColumns = async (clientOrPool) => {
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS sellers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT UNIQUE NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      phone TEXT,
      shop_name TEXT,
      business_type TEXT,
      warehouse_address TEXT,
      city TEXT,
      cnic_number TEXT UNIQUE,
      cnic_front TEXT,
      cnic_back TEXT,
      bank_name TEXT,
      account_title TEXT,
      account_number TEXT,
      mobile_wallet TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_at TIMESTAMP,
      rejected_reason TEXT,
      password_changed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      description TEXT,
      image_url TEXT,
      seller_id INTEGER REFERENCES sellers(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'pending',
      stock INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT,
      phone TEXT,
      address TEXT,
      role TEXT DEFAULT 'buyer',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      total_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      order_code TEXT UNIQUE,
      source TEXT DEFAULT 'app',
      platform TEXT,
      external_order_ref TEXT,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      customer_address TEXT,
      out_for_delivery_at TIMESTAMP,
      payment_status TEXT DEFAULT 'pending',
      payment_received_amount NUMERIC(12,2) DEFAULT 0,
      payment_received_at TIMESTAMP,
      payment_reference TEXT,
      payment_note TEXT,
      closed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      price NUMERIC(12,2) NOT NULL DEFAULT 0
    )
  `);
  await clientOrPool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS name_urdu TEXT,
      ADD COLUMN IF NOT EXISTS expected_stock INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS admin_media_required BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS product_uid TEXT,
      ADD COLUMN IF NOT EXISTS receipt_code TEXT,
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS warehouse_received_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS live_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS admin_price NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS topteam_priced_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS source_wholesale_order_id INTEGER,
      ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0
  `);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS product_media (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      warehouse_id INTEGER NOT NULL DEFAULT 1,
      stock_quantity INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(product_id, warehouse_id)
    )
  `);
};

const runWholesaleTableEnsure = async (clientOrPool) => {
  await ensureProductWorkflowColumns(clientOrPool);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS wholesalers (
      id SERIAL PRIMARY KEY,
      cnic_number TEXT UNIQUE,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      phone TEXT,
      shop_name TEXT,
      business_type TEXT,
      warehouse_address TEXT,
      city TEXT,
      cnic_front TEXT,
      cnic_back TEXT,
      bank_name TEXT,
      account_title TEXT,
      account_number TEXT,
      mobile_wallet TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_at TIMESTAMP,
      rejected_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      password_changed_at TIMESTAMP
    )
  `);
  await clientOrPool.query(`
    ALTER TABLE wholesalers
      ADD COLUMN IF NOT EXISTS topteam_report_status TEXT DEFAULT 'clear',
      ADD COLUMN IF NOT EXISTS topteam_report_reason TEXT,
      ADD COLUMN IF NOT EXISTS topteam_reported_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS topteam_reported_by TEXT,
      ADD COLUMN IF NOT EXISTS topteam_reviewed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS ban_reason TEXT,
      ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS cnic_update_status TEXT DEFAULT 'clear',
      ADD COLUMN IF NOT EXISTS cnic_update_requested_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS cnic_update_requested_by TEXT,
      ADD COLUMN IF NOT EXISTS cnic_update_note TEXT,
      ADD COLUMN IF NOT EXISTS pending_cnic_front TEXT,
      ADD COLUMN IF NOT EXISTS pending_cnic_back TEXT,
      ADD COLUMN IF NOT EXISTS pending_cnic_uploaded_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS cnic_update_reviewed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS cnic_update_rejection_reason TEXT
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS wholesale_products (
      id SERIAL PRIMARY KEY,
      product_uid TEXT UNIQUE,
      wholesaler_id INTEGER NOT NULL REFERENCES wholesalers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_urdu TEXT,
      description TEXT,
      wholesale_price NUMERIC(12,2) NOT NULL,
      base_price NUMERIC(12,2),
      top_team_extra_cost NUMERIC(12,2) DEFAULT 0,
      final_price NUMERIC(12,2),
      pricing_status TEXT NOT NULL DEFAULT 'pending_top_team',
      priced_by_top_team_id TEXT,
      priced_at TIMESTAMP,
      min_order_quantity INTEGER NOT NULL DEFAULT 1,
      available_stock INTEGER NOT NULL DEFAULT 0,
      image_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await clientOrPool.query(`
    ALTER TABLE wholesale_products
      ALTER COLUMN status SET DEFAULT 'pending',
      ALTER COLUMN min_order_quantity SET DEFAULT 1
  `);
  await clientOrPool.query(`
    ALTER TABLE wholesale_products
      ADD COLUMN IF NOT EXISTS admin_description_note TEXT,
      ADD COLUMN IF NOT EXISTS admin_price_note TEXT,
      ADD COLUMN IF NOT EXISTS admin_reviewed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS admin_reviewed_by TEXT,
      ADD COLUMN IF NOT EXISTS base_price NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS top_team_extra_cost NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS final_price NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS pricing_status TEXT DEFAULT 'pending_top_team',
      ADD COLUMN IF NOT EXISTS priced_by_top_team_id TEXT,
      ADD COLUMN IF NOT EXISTS priced_at TIMESTAMP
  `);
  await clientOrPool.query(`
    UPDATE wholesale_products
    SET base_price = COALESCE(base_price, wholesale_price),
        top_team_extra_cost = COALESCE(top_team_extra_cost, 0),
        pricing_status = COALESCE(pricing_status, 'pending_top_team'),
        final_price = CASE
          WHEN COALESCE(pricing_status, 'pending_top_team') = 'approved'
          THEN COALESCE(final_price, wholesale_price, base_price)
          ELSE final_price
        END,
        updated_at = NOW()
    WHERE base_price IS NULL
       OR top_team_extra_cost IS NULL
       OR pricing_status IS NULL
       OR (status = 'active' AND pricing_status = 'approved' AND final_price IS NULL)
  `);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS wholesale_schema_migrations (
      key TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await clientOrPool.query(`
    WITH migration AS (
      INSERT INTO wholesale_schema_migrations (key)
      VALUES ('top_team_pricing_backfill')
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    )
    UPDATE wholesale_products
    SET base_price = COALESCE(base_price, wholesale_price),
        top_team_extra_cost = COALESCE(top_team_extra_cost, 0),
        final_price = COALESCE(final_price, wholesale_price, base_price),
        pricing_status = 'approved',
        priced_by_top_team_id = COALESCE(priced_by_top_team_id, 'legacy-backfill'),
        priced_at = COALESCE(priced_at, admin_reviewed_at, updated_at, created_at, NOW()),
        updated_at = NOW()
    WHERE EXISTS (SELECT 1 FROM migration)
      AND status = 'active'
      AND COALESCE(pricing_status, 'pending_top_team') = 'pending_top_team'
  `);
  await clientOrPool.query(`
    UPDATE wholesale_products
    SET admin_reviewed_at = COALESCE(admin_reviewed_at, updated_at, created_at, NOW()),
        admin_reviewed_by = COALESCE(admin_reviewed_by, 'admin'),
        updated_at = NOW()
    WHERE status = 'active'
      AND admin_reviewed_at IS NULL
  `);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS wholesale_product_media (
      id SERIAL PRIMARY KEY,
      wholesale_product_id INTEGER NOT NULL REFERENCES wholesale_products(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS wholesale_orders (
      id SERIAL PRIMARY KEY,
      order_code TEXT UNIQUE NOT NULL,
      seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
      wholesaler_id INTEGER NOT NULL REFERENCES wholesalers(id) ON DELETE CASCADE,
      wholesale_product_id INTEGER NOT NULL REFERENCES wholesale_products(id),
      linked_product_id INTEGER REFERENCES products(id),
      quantity INTEGER NOT NULL,
      wholesale_unit_price NUMERIC(12,2) NOT NULL,
      total_price NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'admin_review',
      seller_note TEXT,
      admin_note TEXT,
      wholesaler_note TEXT,
      requested_at TIMESTAMP DEFAULT NOW(),
      admin_reviewed_at TIMESTAMP,
      accepted_at TIMESTAMP,
      rejected_at TIMESTAMP
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS wholesale_payouts (
      id SERIAL PRIMARY KEY,
      payout_code TEXT UNIQUE,
      wholesaler_id INTEGER NOT NULL REFERENCES wholesalers(id) ON DELETE CASCADE,
      wholesale_order_id INTEGER UNIQUE NOT NULL REFERENCES wholesale_orders(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'paid',
      method TEXT DEFAULT 'Instant wholesale payment',
      reference TEXT,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      paid_at TIMESTAMP DEFAULT NOW()
    )
  `);

};

const ensureWholesaleTables = async (clientOrPool) => {
  if (process.env.NODE_ENV !== 'test' && wholesaleSchemaReady) return;
  if (process.env.NODE_ENV !== 'test' && wholesaleSchemaPromise) return wholesaleSchemaPromise;

  const run = runWholesaleTableEnsure(clientOrPool).then(() => {
    wholesaleSchemaReady = true;
  });

  if (process.env.NODE_ENV === 'test') return run;

  wholesaleSchemaPromise = run
    .catch((error) => {
      wholesaleSchemaReady = false;
      throw error;
    })
    .finally(() => {
      if (!wholesaleSchemaReady) wholesaleSchemaPromise = null;
    });

  return wholesaleSchemaPromise;
};

const normalizeWholesaler = (row) => ({
  ...row,
  id: numberValue(row.id),
});

const normalizeMediaFiles = (mediaFiles) => {
  let parsed = mediaFiles;
  if (typeof mediaFiles === 'string') {
    try {
      parsed = JSON.parse(mediaFiles);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((file) => {
      if (!file) return null;
      if (typeof file === 'string') {
        return { type: 'image', file_path: textValue(file) };
      }
      const filePath = textValue(file.file_path || file.path || file.url);
      if (!filePath) return null;
      return {
        ...file,
        id: file.id == null ? file.id : numberValue(file.id),
        type: file.type || 'image',
        file_path: filePath,
      };
    })
    .filter(Boolean);
};

const productImagePaths = (row, mediaFiles) => {
  const seen = new Set();
  return [row.image_url, ...mediaFiles.map((file) => file.file_path)]
    .map(textValue)
    .filter((path) => {
      if (!path || seen.has(path)) return false;
      seen.add(path);
      return true;
    });
};

const normalizeWholesaleProduct = (row) => {
  const mediaFiles = normalizeMediaFiles(row.media_files);
  return {
    ...row,
    id: numberValue(row.id),
    wholesaler_id: numberValue(row.wholesaler_id),
    wholesale_price: numberValue(row.wholesale_price),
    base_price: numberValue(row.base_price ?? row.wholesale_price),
    top_team_extra_cost: numberValue(row.top_team_extra_cost),
    final_price: row.final_price == null ? null : numberValue(row.final_price),
    min_order_quantity: numberValue(row.min_order_quantity),
    available_stock: numberValue(row.available_stock),
    media_files: mediaFiles,
    product_images: productImagePaths(row, mediaFiles),
  };
};

const normalizeWholesaleOrder = (row) => ({
  ...row,
  id: numberValue(row.id),
  seller_id: numberValue(row.seller_id),
  wholesaler_id: numberValue(row.wholesaler_id),
  wholesale_product_id: numberValue(row.wholesale_product_id),
  linked_product_id: row.linked_product_id ? numberValue(row.linked_product_id) : null,
  quantity: numberValue(row.quantity),
  wholesale_unit_price: numberValue(row.wholesale_unit_price),
  total_price: numberValue(row.total_price),
  wholesale_price: numberValue(row.wholesale_price),
  min_order_quantity: numberValue(row.min_order_quantity),
  available_stock: numberValue(row.available_stock),
});

const wholesaleOrderSelect = `
  SELECT
    wo.*,
    wp.product_uid AS wholesale_product_uid,
    wp.name AS product_name,
    wp.name_urdu AS product_name_urdu,
    wp.description AS product_description,
    wp.wholesale_price,
    wp.min_order_quantity,
    wp.available_stock,
    wp.image_url,
    COALESCE(s.shop_name, s.name) AS seller_shop,
    s.name AS seller_name,
    s.email AS seller_email,
    s.phone AS seller_phone,
    s.city AS seller_city,
    s.cnic_number AS seller_public_id,
    COALESCE(w.shop_name, w.name) AS wholesaler_shop,
    w.name AS wholesaler_name,
    w.email AS wholesaler_email,
    w.phone AS wholesaler_phone,
    w.city AS wholesaler_city,
    w.bank_name AS wholesaler_bank_name,
    w.account_title AS wholesaler_account_title,
    w.account_number AS wholesaler_account_number,
    w.mobile_wallet AS wholesaler_mobile_wallet,
    p.product_uid AS linked_product_uid,
    p.receipt_code AS linked_receipt_code,
    p.status AS linked_product_status
  FROM wholesale_orders wo
  JOIN wholesale_products wp ON wo.wholesale_product_id = wp.id
  JOIN sellers s ON wo.seller_id = s.id
  JOIN wholesalers w ON wo.wholesaler_id = w.id
  LEFT JOIN products p ON wo.linked_product_id = p.id
`;

const createSellerProductFromWholesaleOrder = async (client, order) => {
  if (order.linked_product_id) {
    const linkedProductId = numberValue(order.linked_product_id);
    await client.query(
      `UPDATE products
       SET product_uid = COALESCE(NULLIF(product_uid, ''), $2),
           receipt_code = COALESCE(NULLIF(receipt_code, ''), $3)
       WHERE id = $1`,
      [
        linkedProductId,
        `PHT-${String(linkedProductId).padStart(6, '0')}`,
        `RCT-${String(linkedProductId).padStart(6, '0')}`,
      ]
    );
    return linkedProductId;
  }

  const insert = await client.query(
    `INSERT INTO products (
      name, name_urdu, price, admin_price, description, seller_id, status,
      expected_stock, admin_media_required, stock, source_wholesale_order_id
     ) VALUES ($1, $2, $3, $3, $4, $5, 'pending_sending', $6, TRUE, $6, $7)
     RETURNING id`,
    [
      order.product_name,
      order.product_name_urdu || null,
      order.wholesale_unit_price,
      `${order.product_description || ''}\n\nWholesale order ${order.order_code}. Seller invested ${order.quantity} units from ${order.wholesaler_shop}.`.trim(),
      order.seller_id,
      order.quantity,
      order.id,
    ]
  );
  const productId = insert.rows[0].id;
  const productUid = `PHT-${String(productId).padStart(6, '0')}`;
  const receiptCode = `RCT-${String(productId).padStart(6, '0')}`;

  await client.query(
    `UPDATE products
     SET product_uid = $1,
         receipt_code = $2
     WHERE id = $3`,
    [productUid, receiptCode, productId]
  );

  await client.query(
    `INSERT INTO inventory (product_id, warehouse_id, stock_quantity)
     VALUES ($1, 1, $2)
     ON CONFLICT (product_id, warehouse_id)
     DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity, updated_at = NOW()`,
    [productId, order.quantity]
  );

  if (order.image_url) {
    await client.query(
      'INSERT INTO product_media (product_id, type, file_path) VALUES ($1, $2, $3)',
      [productId, 'image', order.image_url]
    ).catch(() => null);
  }

  return productId;
};

const receiptLinesForWholesaleOrder = (order) => [
  `Wholesale Order: ${order.order_code}`,
  `Generated Product ID: ${order.linked_product_uid || 'Generated after acceptance'}`,
  `Receipt Code: ${order.linked_receipt_code || 'Generated after acceptance'}`,
  `Product: ${order.product_name}`,
  `Quantity: ${order.quantity}`,
  `Wholesale Unit Price: Rs ${Math.round(numberValue(order.wholesale_unit_price)).toLocaleString()}`,
  `Total Wholesale Payment: Rs ${Math.round(numberValue(order.total_price)).toLocaleString()}`,
  `Seller: ${order.seller_shop || order.seller_name}`,
  `Seller ID: ${order.seller_public_id || order.seller_id}`,
  `Wholesaler: ${order.wholesaler_shop || order.wholesaler_name}`,
  `Wholesaler Phone: ${order.wholesaler_phone || ''}`,
  'Send this physical stock to the Poohter warehouse with this receipt.',
];

module.exports = {
  createCode,
  ensureWholesaleTables,
  normalizeWholesaler,
  normalizeWholesaleProduct,
  normalizeWholesaleOrder,
  textValue,
  numberValue,
  wholesaleOrderSelect,
  createSellerProductFromWholesaleOrder,
  receiptLinesForWholesaleOrder,
};

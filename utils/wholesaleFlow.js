const bcrypt = require('bcrypt');

const numberValue = (value) => Number(value || 0);
const textValue = (value) => String(value || '').trim();

const createCode = (prefix) => `${prefix}-${Date.now().toString().slice(-8)}-${Math.floor(Math.random() * 900 + 100)}`;

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

const ensureWholesaleTables = async (clientOrPool) => {
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
    CREATE TABLE IF NOT EXISTS wholesale_products (
      id SERIAL PRIMARY KEY,
      product_uid TEXT UNIQUE,
      wholesaler_id INTEGER NOT NULL REFERENCES wholesalers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_urdu TEXT,
      description TEXT,
      wholesale_price NUMERIC(12,2) NOT NULL,
      min_order_quantity INTEGER NOT NULL DEFAULT 25,
      available_stock INTEGER NOT NULL DEFAULT 0,
      image_url TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
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

  await seedDummyWholesaler(clientOrPool);
};

const seedDummyWholesaler = async (clientOrPool) => {
  const existing = await clientOrPool.query('SELECT id FROM wholesalers WHERE email = $1 LIMIT 1', ['wholesale@poohter.local']);
  let wholesalerId = existing.rows[0]?.id;

  if (!wholesalerId) {
    const password = await bcrypt.hash('Whole@123', 10);
    const result = await clientOrPool.query(
      `INSERT INTO wholesalers (
        cnic_number, name, email, password, phone, shop_name, business_type,
        warehouse_address, city, bank_name, account_title, account_number,
        mobile_wallet, status, approved_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'approved', NOW())
       RETURNING id`,
      [
        '35202-0000000-1',
        'Demo Wholesale Owner',
        'wholesale@poohter.local',
        password,
        '0300-0000001',
        'Poohter Demo Wholesale',
        'General supplies',
        'Demo wholesale warehouse, Lahore',
        'Lahore',
        'Demo Bank',
        'Demo Wholesale Owner',
        'PK00POOHTERWHOLESALE',
        '0300-0000001',
      ]
    );
    wholesalerId = result.rows[0].id;
  }

  if (wholesalerId) {
    await clientOrPool.query(
      `INSERT INTO wholesale_products (
        product_uid, wholesaler_id, name, name_urdu, description,
        wholesale_price, min_order_quantity, available_stock, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
       ON CONFLICT (product_uid) DO NOTHING`,
      [
        'WHP-DEMO-001',
        wholesalerId,
        'Cotton T-Shirts Wholesale Pack',
        '',
        'Demo wholesale item for sellers. Minimum purchase is 25 units.',
        850,
        25,
        250,
      ]
    );
  }
};

const normalizeWholesaler = (row) => ({
  ...row,
  id: numberValue(row.id),
});

const normalizeWholesaleProduct = (row) => ({
  ...row,
  id: numberValue(row.id),
  wholesaler_id: numberValue(row.wholesaler_id),
  wholesale_price: numberValue(row.wholesale_price),
  min_order_quantity: numberValue(row.min_order_quantity),
  available_stock: numberValue(row.available_stock),
});

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
  if (order.linked_product_id) return order.linked_product_id;

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

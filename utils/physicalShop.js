const ensurePhysicalShopTables = async (clientOrPool) => {
  await clientOrPool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS product_uid TEXT,
      ADD COLUMN IF NOT EXISTS admin_price NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS image_url TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS physical_shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT,
      address TEXT,
      phone TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS shop_staff (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES physical_shops(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier',
      pin_code TEXT,
      password_hash TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT shop_staff_role_check CHECK (role IN ('cashier', 'manager', 'admin'))
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS shop_inventory (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES physical_shops(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity_available INTEGER NOT NULL DEFAULT 0,
      reorder_level INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(shop_id, product_id)
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS shop_sales (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES physical_shops(id),
      cashier_id INTEGER REFERENCES shop_staff(id),
      receipt_code TEXT NOT NULL UNIQUE,
      subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
      discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      payment_status TEXT NOT NULL DEFAULT 'paid',
      source TEXT NOT NULL DEFAULT 'physical_shop',
      platform TEXT NOT NULL DEFAULT 'poohter-shop',
      external_order_ref TEXT,
      return_status TEXT NOT NULL DEFAULT 'none',
      refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT shop_sales_payment_method_check CHECK (payment_method IN ('cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer')),
      CONSTRAINT shop_sales_payment_status_check CHECK (payment_status IN ('paid', 'partial_refund', 'refunded', 'void')),
      CONSTRAINT shop_sales_return_status_check CHECK (return_status IN ('none', 'partial_return', 'returned', 'exchanged'))
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS shop_sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES shop_sales(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL,
      discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_price NUMERIC(12,2) NOT NULL,
      returned_quantity INTEGER NOT NULL DEFAULT 0
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS shop_stock_movements (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES physical_shops(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      movement_type TEXT NOT NULL,
      quantity_change INTEGER NOT NULL,
      reference_type TEXT,
      reference_id INTEGER,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT shop_stock_movement_type_check CHECK (movement_type IN ('transfer_in', 'transfer_out', 'sale', 'return', 'adjustment', 'damage'))
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS shop_shifts (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES physical_shops(id),
      cashier_id INTEGER NOT NULL REFERENCES shop_staff(id),
      opened_at TIMESTAMP DEFAULT NOW(),
      closed_at TIMESTAMP,
      opening_cash NUMERIC(12,2) NOT NULL DEFAULT 0,
      closing_cash NUMERIC(12,2),
      expected_cash NUMERIC(12,2),
      difference NUMERIC(12,2),
      status TEXT NOT NULL DEFAULT 'open',
      CONSTRAINT shop_shifts_status_check CHECK (status IN ('open', 'closed'))
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS shop_transfer_batches (
      id SERIAL PRIMARY KEY,
      batch_code TEXT NOT NULL UNIQUE,
      shop_id INTEGER NOT NULL REFERENCES physical_shops(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'out_from_warehouse',
      created_by TEXT,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT shop_transfer_batch_status_check CHECK (status IN ('out_from_warehouse', 'received', 'cancelled'))
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS shop_physical_units (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES shop_transfer_batches(id) ON DELETE CASCADE,
      shop_id INTEGER NOT NULL REFERENCES physical_shops(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      physical_uid TEXT NOT NULL UNIQUE,
      tracking_id TEXT NOT NULL UNIQUE,
      barcode_value TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'out_from_warehouse',
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT shop_physical_unit_status_check CHECK (status IN ('out_from_warehouse', 'in_shop', 'sold', 'returned', 'damaged', 'lost'))
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS shop_returns (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES shop_sales(id) ON DELETE CASCADE,
      receipt_code TEXT NOT NULL,
      refund_method TEXT NOT NULL,
      refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      reason TEXT,
      reusable BOOLEAN NOT NULL DEFAULT TRUE,
      processed_by INTEGER REFERENCES shop_staff(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await clientOrPool.query('CREATE INDEX IF NOT EXISTS idx_shop_inventory_shop_id ON shop_inventory(shop_id)');
  await clientOrPool.query('CREATE INDEX IF NOT EXISTS idx_shop_sales_shop_created ON shop_sales(shop_id, created_at DESC)');
  await clientOrPool.query('CREATE INDEX IF NOT EXISTS idx_shop_movements_shop_product ON shop_stock_movements(shop_id, product_id, created_at DESC)');
  await clientOrPool.query('CREATE INDEX IF NOT EXISTS idx_shop_shifts_open ON shop_shifts(shop_id, cashier_id) WHERE status = \'open\'');
  await clientOrPool.query('CREATE INDEX IF NOT EXISTS idx_shop_transfer_batches_shop ON shop_transfer_batches(shop_id, created_at DESC)');
  await clientOrPool.query('CREATE INDEX IF NOT EXISTS idx_shop_physical_units_batch ON shop_physical_units(batch_id)');
};

module.exports = {
  ensurePhysicalShopTables,
};

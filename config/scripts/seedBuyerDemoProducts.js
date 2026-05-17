const pool = require('../db');
const { ensureWholesaleTables } = require('../../utils/wholesaleFlow');

const demoProducts = [
  {
    uid: 'PHT-DEMO-BUYER-001',
    name: 'Poohter Signature Hoodie',
    price: 49,
    stock: 45,
    description: 'Soft everyday hoodie with a clean premium fit for casual wear.',
  },
  {
    uid: 'PHT-DEMO-BUYER-002',
    name: 'Urban Travel Backpack',
    price: 68,
    stock: 38,
    description: 'Durable multi-pocket backpack designed for school, office, and travel.',
  },
  {
    uid: 'PHT-DEMO-BUYER-003',
    name: 'Minimal Desk Lamp',
    price: 35,
    stock: 52,
    description: 'Modern LED desk lamp with a compact profile and focused lighting.',
  },
  {
    uid: 'PHT-DEMO-BUYER-004',
    name: 'Wireless Comfort Earbuds',
    price: 59,
    stock: 64,
    description: 'Lightweight wireless earbuds for calls, music, and everyday use.',
  },
  {
    uid: 'PHT-DEMO-BUYER-005',
    name: 'Premium Stainless Bottle',
    price: 24,
    stock: 80,
    description: 'Insulated stainless bottle that keeps drinks cold or warm for hours.',
  },
  {
    uid: 'PHT-DEMO-BUYER-006',
    name: 'Everyday Cotton Tee',
    price: 19,
    stock: 95,
    description: 'Breathable cotton tee with a smooth finish and relaxed fit.',
  },
  {
    uid: 'PHT-DEMO-BUYER-007',
    name: 'Smart Fitness Band',
    price: 42,
    stock: 41,
    description: 'Simple activity tracker for steps, sleep, heart rate, and daily goals.',
  },
  {
    uid: 'PHT-DEMO-BUYER-008',
    name: 'Home Organizer Set',
    price: 31,
    stock: 57,
    description: 'Stackable storage boxes for keeping daily essentials neat and visible.',
  },
];

const ensureBuyerProductColumns = async (client) => {
  await ensureWholesaleTables(client);

  await client.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS image_url TEXT,
      ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS product_uid TEXT,
      ADD COLUMN IF NOT EXISTS live_at TIMESTAMP
  `);

  await client.query(`
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

const upsertProduct = async (client, product) => {
  const existing = await client.query(
    'SELECT id FROM products WHERE product_uid = $1 OR name = $2 ORDER BY id LIMIT 1',
    [product.uid, product.name]
  );

  let row;
  if (existing.rows[0]) {
    const result = await client.query(
      `UPDATE products
       SET name = $1,
           price = $2,
           description = $3,
           status = 'live',
           stock = $4,
           product_uid = $5,
           live_at = COALESCE(live_at, NOW())
       WHERE id = $6
       RETURNING id, name, price, status`,
      [product.name, product.price, product.description, product.stock, product.uid, existing.rows[0].id]
    );
    row = { ...result.rows[0], action: 'updated' };
  } else {
    const result = await client.query(
      `INSERT INTO products (name, price, description, status, stock, product_uid, live_at)
       VALUES ($1, $2, $3, 'live', $4, $5, NOW())
       RETURNING id, name, price, status`,
      [product.name, product.price, product.description, product.stock, product.uid]
    );
    row = { ...result.rows[0], action: 'inserted' };
  }

  await client.query(
    `INSERT INTO inventory (product_id, warehouse_id, stock_quantity)
     VALUES ($1, 1, $2)
     ON CONFLICT (product_id, warehouse_id)
     DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity, updated_at = NOW()`,
    [row.id, product.stock]
  );

  return row;
};

const run = async () => {
  const client = await pool.connect();
  const seeded = [];

  try {
    await client.query('BEGIN');
    await ensureBuyerProductColumns(client);

    for (const product of demoProducts) {
      seeded.push(await upsertProduct(client, product));
    }

    await client.query('COMMIT');

    const summary = seeded.reduce((counts, product) => {
      counts[product.action] = (counts[product.action] || 0) + 1;
      return counts;
    }, {});

    console.log(JSON.stringify({ summary, products: seeded }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

run();

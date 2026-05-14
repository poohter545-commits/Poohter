const pool = require('../config/db');
const { ensureWholesaleTables } = require('../utils/wholesaleFlow');
const { ensureSellerPayoutTables } = require('../utils/sellerPayouts');
const { ensureSalesPlatformsTable } = require('../utils/salesPlatforms');

const ensureCoreTables = async (clientOrPool) => {
  await ensureWholesaleTables(clientOrPool);

  await clientOrPool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS phone TEXT,
      ADD COLUMN IF NOT EXISTS address TEXT,
      ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'buyer'
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, product_id)
    )
  `);

  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS delivery_updates (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await clientOrPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_code_unique
    ON orders(order_code)
    WHERE order_code IS NOT NULL
  `);

  await clientOrPool.query(`
    CREATE INDEX IF NOT EXISTS idx_products_seller_id
    ON products(seller_id)
  `);

  await clientOrPool.query(`
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id
    ON order_items(order_id)
  `);

  await clientOrPool.query(`
    CREATE INDEX IF NOT EXISTS idx_order_items_product_id
    ON order_items(product_id)
  `);

  await ensureSalesPlatformsTable(clientOrPool);
  await ensureSellerPayoutTables(clientOrPool);
};

const initProductionDb = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureCoreTables(client);
    await client.query('COMMIT');
    console.log('Production database schema is ready.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

if (require.main === module) {
  initProductionDb()
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = {
  ensureCoreTables,
  initProductionDb,
};

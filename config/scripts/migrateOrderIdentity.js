const pool = require('../config/db');

const makeOrderCode = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `POO-${date}-${random}`;
};

const run = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS order_code VARCHAR(40),
        ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'poohter',
        ADD COLUMN IF NOT EXISTS platform VARCHAR(80),
        ADD COLUMN IF NOT EXISTS external_order_ref VARCHAR(120),
        ADD COLUMN IF NOT EXISTS customer_name TEXT,
        ADD COLUMN IF NOT EXISTS customer_email TEXT,
        ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50),
        ADD COLUMN IF NOT EXISTS customer_address TEXT,
        ADD COLUMN IF NOT EXISTS out_for_delivery_at TIMESTAMP
    `);

    await client.query("UPDATE orders SET source = 'poohter' WHERE source IS NULL");

    try {
      await client.query('ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL');
    } catch (error) {
      if (error.code !== '42703') throw error;
    }

    const missingCodes = await client.query('SELECT id FROM orders WHERE order_code IS NULL');
    for (const row of missingCodes.rows) {
      let code = makeOrderCode();
      let exists = await client.query('SELECT 1 FROM orders WHERE order_code = $1', [code]);
      while (exists.rows.length > 0) {
        code = makeOrderCode();
        exists = await client.query('SELECT 1 FROM orders WHERE order_code = $1', [code]);
      }
      await client.query('UPDATE orders SET order_code = $1 WHERE id = $2', [code, row.id]);
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_code_unique
      ON orders(order_code)
    `);

    await client.query('COMMIT');
    console.log(`Order identity migration complete. Updated ${missingCodes.rows.length} existing orders.`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

run();

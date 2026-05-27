const dotenv = require('dotenv');
const { Pool } = require('pg');
const { ensureCoreTables } = require('../config/scripts/initProductionDb');

dotenv.config();

const tablesToClear = [
  'account_deletion_requests',
  'email_otps',
  'marketing_spend',
  'business_targets',
  'seller_payouts',
  'wholesale_payouts',
  'wholesale_orders',
  'wholesale_product_media',
  'wholesale_products',
  'wholesalers',
  'return_requests',
  'delivery_updates',
  'cart_items',
  'order_finance',
  'order_items',
  'orders',
  'product_platform_pricing',
  'product_finance',
  'product_media',
  'inventory',
  'products',
  'sellers',
  'users',
];

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
const confirmed = process.argv.includes('--yes');

const pool = new Pool({
  connectionString,
  ssl: /supabase\.com/i.test(connectionString || '') ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 10000,
});

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;

const existingTables = async (client) => {
  const result = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [tablesToClear]
  );
  return result.rows.map((row) => row.table_name);
};

const countRows = async (client, tables) => {
  const summary = {};
  for (const table of tables) {
    const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdent(table)}`);
    summary[table] = Number(result.rows[0].count || 0);
  }
  return summary;
};

const totalRows = (summary) => Object.values(summary).reduce((sum, count) => sum + count, 0);

const main = async () => {
  if (!connectionString) {
    throw new Error('Set DIRECT_URL or DATABASE_URL before clearing data.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureCoreTables(client);

    const tables = await existingTables(client);
    const before = await countRows(client, tables);

    if (!confirmed) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({
        dry_run: true,
        message: 'Run `node scripts/clearOperationalData.js --yes` to clear these rows.',
        rows_that_would_be_removed: totalRows(before),
        table_counts: before,
        preserved_tables: ['sales_platforms'],
      }, null, 2));
      return;
    }

    if (tables.length) {
      await client.query(`TRUNCATE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`);
    }

    const after = await countRows(client, tables);
    await client.query('COMMIT');

    console.log(JSON.stringify({
      cleared: true,
      rows_removed: totalRows(before),
      before,
      after,
      preserved_tables: ['sales_platforms'],
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

const pool = require('../config/db');
const { ensureWholesaleTables, seedDummyWholesaler } = require('../utils/wholesaleFlow');

const run = async () => {
  await ensureWholesaleTables(pool);
  await seedDummyWholesaler(pool);
  const wholesaler = await pool.query(
    "SELECT id, email, shop_name, status FROM wholesalers WHERE email = 'wholesale@poohter.local'"
  );
  const product = await pool.query(
    "SELECT product_uid, name, wholesale_price, min_order_quantity, available_stock FROM wholesale_products WHERE product_uid = 'WHP-DEMO-001'"
  );
  console.log(JSON.stringify({
    wholesaler: wholesaler.rows[0],
    product: product.rows[0],
  }, null, 2));
};

run()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

const pool = require('../config/db');

const buyerDemoProductUids = [
  'PHT-DEMO-BUYER-001',
  'PHT-DEMO-BUYER-002',
  'PHT-DEMO-BUYER-003',
  'PHT-DEMO-BUYER-004',
  'PHT-DEMO-BUYER-005',
  'PHT-DEMO-BUYER-006',
  'PHT-DEMO-BUYER-007',
  'PHT-DEMO-BUYER-008',
];

const buyerDemoProductNames = [
  'Poohter Signature Hoodie',
  'Urban Travel Backpack',
  'Minimal Desk Lamp',
  'Wireless Comfort Earbuds',
  'Premium Stainless Bottle',
  'Everyday Cotton Tee',
  'Smart Fitness Band',
  'Home Organizer Set',
];

const tableExists = async (client, tableName) => {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
};

const deleteFromTableByProducts = async (client, tableName, productIds, summary) => {
  if (!productIds.length || !(await tableExists(client, tableName))) return;
  const result = await client.query(`DELETE FROM ${tableName} WHERE product_id = ANY($1::int[])`, [productIds]);
  summary[tableName] = Number(result.rowCount || 0);
};

const run = async () => {
  const client = await pool.connect();
  const summary = {};

  try {
    await client.query('BEGIN');

    if (await tableExists(client, 'wholesale_products') && await tableExists(client, 'wholesalers')) {
      const wholesalerResult = await client.query(
        `SELECT id
         FROM wholesalers
         WHERE email = $1
            OR cnic_number = $2
            OR LOWER(TRIM(shop_name)) = LOWER($3)`,
        ['wholesale@poohter.local', '35202-0000000-1', 'poohter demo wholesale']
      );
      const demoWholesalerIds = wholesalerResult.rows.map((row) => Number(row.id)).filter(Boolean);

      const wholesaleProductResult = await client.query(
        `SELECT id
         FROM wholesale_products
         WHERE product_uid = $1
            OR (wholesaler_id = ANY($2::int[]) AND LOWER(TRIM(name)) = LOWER($3))`,
        ['WHP-DEMO-001', demoWholesalerIds, 'Cotton T-Shirts Wholesale Pack']
      );
      const demoWholesaleProductIds = wholesaleProductResult.rows.map((row) => Number(row.id)).filter(Boolean);

      if (demoWholesaleProductIds.length || demoWholesalerIds.length) {
        if (await tableExists(client, 'wholesale_orders')) {
          const orderResult = await client.query(
            `SELECT id
             FROM wholesale_orders
             WHERE wholesale_product_id = ANY($1::int[])
                OR wholesaler_id = ANY($2::int[])`,
            [demoWholesaleProductIds, demoWholesalerIds]
          );
          const demoWholesaleOrderIds = orderResult.rows.map((row) => Number(row.id)).filter(Boolean);

          if (demoWholesaleOrderIds.length && await tableExists(client, 'wholesale_payouts')) {
            const payouts = await client.query(
              'DELETE FROM wholesale_payouts WHERE wholesale_order_id = ANY($1::int[])',
              [demoWholesaleOrderIds]
            );
            summary.wholesale_payouts = Number(payouts.rowCount || 0);
          }

          if (demoWholesaleOrderIds.length) {
            const orders = await client.query(
              'DELETE FROM wholesale_orders WHERE id = ANY($1::int[])',
              [demoWholesaleOrderIds]
            );
            summary.wholesale_orders = Number(orders.rowCount || 0);
          }
        }

        if (demoWholesaleProductIds.length && await tableExists(client, 'wholesale_product_media')) {
          const media = await client.query(
            'DELETE FROM wholesale_product_media WHERE wholesale_product_id = ANY($1::int[])',
            [demoWholesaleProductIds]
          );
          summary.wholesale_product_media = Number(media.rowCount || 0);
        }

        if (demoWholesaleProductIds.length) {
          const products = await client.query(
            'DELETE FROM wholesale_products WHERE id = ANY($1::int[])',
            [demoWholesaleProductIds]
          );
          summary.wholesale_products = Number(products.rowCount || 0);
        }

        if (demoWholesalerIds.length) {
          const wholesalers = await client.query(
            'DELETE FROM wholesalers WHERE id = ANY($1::int[])',
            [demoWholesalerIds]
          );
          summary.wholesalers = Number(wholesalers.rowCount || 0);
        }
      }
    }

    if (await tableExists(client, 'products')) {
      const productResult = await client.query(
        `SELECT id
         FROM products
         WHERE product_uid = ANY($1::text[])
            OR LOWER(TRIM(name)) = ANY($2::text[])`,
        [buyerDemoProductUids, buyerDemoProductNames.map((name) => name.toLowerCase())]
      );
      const demoProductIds = productResult.rows.map((row) => Number(row.id)).filter(Boolean);

      if (demoProductIds.length) {
        if (await tableExists(client, 'wholesale_orders')) {
          await client.query(
            'UPDATE wholesale_orders SET linked_product_id = NULL WHERE linked_product_id = ANY($1::int[])',
            [demoProductIds]
          );
        }

        await deleteFromTableByProducts(client, 'cart_items', demoProductIds, summary);
        await deleteFromTableByProducts(client, 'return_requests', demoProductIds, summary);
        await deleteFromTableByProducts(client, 'order_items', demoProductIds, summary);
        await deleteFromTableByProducts(client, 'product_media', demoProductIds, summary);
        await deleteFromTableByProducts(client, 'inventory', demoProductIds, summary);
        await deleteFromTableByProducts(client, 'product_finance', demoProductIds, summary);
        await deleteFromTableByProducts(client, 'product_platform_pricing', demoProductIds, summary);

        const products = await client.query(
          'DELETE FROM products WHERE id = ANY($1::int[])',
          [demoProductIds]
        );
        summary.products = Number(products.rowCount || 0);
      }
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({ removed_demo_data: summary }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

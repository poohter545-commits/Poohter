const pool = require('../config/db');
const { ensureCoreTables } = require('./initProductionDb');

const demoProducts = [
  {
    uid: 'PHT-DEMO-BUYER-001',
    receiptCode: 'RCT-DEMO-BUYER-001',
    name: 'Poohter Signature Hoodie',
    price: 3499,
    stock: 48,
    image: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?q=80&w=1200&auto=format&fit=crop',
    video: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    description: 'Soft fleece hoodie with a relaxed streetwear fit, ribbed cuffs, and a clean Poohter demo finish.',
  },
  {
    uid: 'PHT-DEMO-BUYER-002',
    receiptCode: 'RCT-DEMO-BUYER-002',
    name: 'Urban Travel Backpack',
    price: 4299,
    stock: 36,
    image: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?q=80&w=1200&auto=format&fit=crop',
    video: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    description: 'Everyday backpack with padded laptop storage, water-resistant fabric, and quick-access front pockets.',
  },
  {
    uid: 'PHT-DEMO-BUYER-003',
    receiptCode: 'RCT-DEMO-BUYER-003',
    name: 'Minimal Desk Lamp',
    price: 2199,
    stock: 52,
    image: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?q=80&w=1200&auto=format&fit=crop',
    video: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
    description: 'Compact LED desk lamp with a warm reading glow, matte finish, and adjustable tilt for focused work.',
  },
  {
    uid: 'PHT-DEMO-BUYER-004',
    receiptCode: 'RCT-DEMO-BUYER-004',
    name: 'Wireless Comfort Earbuds',
    price: 5499,
    stock: 41,
    image: 'https://images.unsplash.com/photo-1606220945770-b5b6c2c55bf1?q=80&w=1200&auto=format&fit=crop',
    video: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    description: 'Lightweight wireless earbuds with a compact charging case, touch controls, and balanced daily audio.',
  },
  {
    uid: 'PHT-DEMO-BUYER-005',
    receiptCode: 'RCT-DEMO-BUYER-005',
    name: 'Premium Stainless Bottle',
    price: 1799,
    stock: 64,
    image: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?q=80&w=1200&auto=format&fit=crop',
    video: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
    description: 'Double-wall stainless bottle designed to keep drinks cold or warm through long commutes and busy days.',
  },
  {
    uid: 'PHT-DEMO-BUYER-006',
    receiptCode: 'RCT-DEMO-BUYER-006',
    name: 'Everyday Cotton Tee',
    price: 1299,
    stock: 80,
    image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?q=80&w=1200&auto=format&fit=crop',
    video: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    description: 'Breathable cotton crew neck tee with a clean silhouette for layering, lounging, or everyday wear.',
  },
  {
    uid: 'PHT-DEMO-BUYER-007',
    receiptCode: 'RCT-DEMO-BUYER-007',
    name: 'Smart Fitness Band',
    price: 3999,
    stock: 33,
    image: 'https://images.unsplash.com/photo-1576243345690-4e4b79b63288?q=80&w=1200&auto=format&fit=crop',
    video: 'https://storage.googleapis.com/gtv-videos-bucket/sample/VolkswagenGTIReview.mp4',
    description: 'Slim activity band with step tracking, heart-rate monitoring, and a bright touch display.',
  },
  {
    uid: 'PHT-DEMO-BUYER-008',
    receiptCode: 'RCT-DEMO-BUYER-008',
    name: 'Home Organizer Set',
    price: 2599,
    stock: 57,
    image: 'https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?q=80&w=1200&auto=format&fit=crop',
    video: 'https://storage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    description: 'Stackable organizer bins for shelves, wardrobes, and pantry spaces with a neat modular footprint.',
  },
];

const upsertDemoProduct = async (client, product) => {
  const existing = await client.query(
    `SELECT id
     FROM products
     WHERE product_uid = $1
        OR LOWER(TRIM(name)) = LOWER(TRIM($2))
     ORDER BY CASE WHEN product_uid = $1 THEN 0 ELSE 1 END, id
     LIMIT 1`,
    [product.uid, product.name]
  );

  let productId;
  if (existing.rows.length) {
    productId = existing.rows[0].id;
    await client.query(
      `UPDATE products
       SET name = $2,
           price = $3,
           admin_price = $3,
           description = $4,
           image_url = $5,
           status = 'live',
           stock = $6,
           expected_stock = $6,
           admin_media_required = FALSE,
           product_uid = $7,
           receipt_code = $8,
           warehouse_received_at = COALESCE(warehouse_received_at, NOW()),
           live_at = COALESCE(live_at, NOW()),
           topteam_priced_at = COALESCE(topteam_priced_at, NOW())
       WHERE id = $1`,
      [
        productId,
        product.name,
        product.price,
        product.description,
        product.image,
        product.stock,
        product.uid,
        product.receiptCode,
      ]
    );
  } else {
    const inserted = await client.query(
      `INSERT INTO products (
        name, price, admin_price, description, image_url, status, stock,
        expected_stock, admin_media_required, product_uid, receipt_code,
        warehouse_received_at, live_at, topteam_priced_at
       )
       VALUES ($1, $2, $2, $3, $4, 'live', $5, $5, FALSE, $6, $7, NOW(), NOW(), NOW())
       RETURNING id`,
      [
        product.name,
        product.price,
        product.description,
        product.image,
        product.stock,
        product.uid,
        product.receiptCode,
      ]
    );
    productId = inserted.rows[0].id;
  }

  await client.query(
    `INSERT INTO inventory (product_id, warehouse_id, stock_quantity)
     VALUES ($1, 1, $2)
     ON CONFLICT (product_id, warehouse_id)
     DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity, updated_at = NOW()`,
    [productId, product.stock]
  );

  await client.query('DELETE FROM product_media WHERE product_id = $1', [productId]);
  await client.query(
    'INSERT INTO product_media (product_id, type, file_path) VALUES ($1, $2, $3), ($1, $4, $5)',
    [productId, 'image', product.image, 'video', product.video]
  );

  return productId;
};

const run = async () => {
  const client = await pool.connect();
  const seededProductIds = [];

  try {
    await client.query('BEGIN');
    await ensureCoreTables(client);

    for (const product of demoProducts) {
      seededProductIds.push(await upsertDemoProduct(client, product));
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({
      seeded_demo_products: seededProductIds.length,
      product_ids: seededProductIds,
    }, null, 2));
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

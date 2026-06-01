const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/auth');
const { createUniqueOrderCode, validateStatusTransition } = require('../utils/orderIdentity');
const { ensureSalesPlatformsTable, getSalesPlatforms } = require('../utils/salesPlatforms');
const { ensureWholesaleTables } = require('../utils/wholesaleFlow');
const { persistUploadedFiles, publicUploadPath, publicUploadPathFromValue } = require('../utils/uploads');
const {
  DEFAULT_DELIVERY_CHARGE,
  DEFAULT_PACKING_MATERIAL_COST,
  ensureOrderChargeColumns,
} = require('../utils/orderCharges');
const { sendOrderStatusEmailSafely } = require('../utils/orderNotifications');
const { requirePakistaniMobileNumber } = require('../utils/phoneValidation');
const { ensureSupportRequestsTable } = require('../utils/supportRequests');
const { ensureWarehouseReceivingTable } = require('../utils/warehouseReceiving');
const {
  ensureCnicUpdateColumns,
  cnicUpdateSelectFields,
  normalizeCnicUpdateFields,
} = require('../utils/cnicUpdates');
const {
  createReturnCode,
  ensureReturnsTable: ensureReturnRequestTable,
  getReturnWindow,
  isReturnStatus,
  normalizeReturnStatus,
} = require('../utils/returns');

const generateAdminToken = () => jwt.sign(
  { id: 'admin', email: 'admin@poohter.local', role: 'admin' },
  JWT_SECRET,
  { expiresIn: '12h' }
);

const updateOrderStatusColumns = (status) => (
  status === 'out_from_warehouse'
    ? 'status = $1, out_from_warehouse_at = NOW(), out_for_delivery_at = NOW()'
    : status === 'out_for_delivery'
      ? 'status = $1, out_for_delivery_at = NOW()'
      : status === 'delivered'
        ? 'status = $1, delivered_at = COALESCE(delivered_at, NOW())'
        : 'status = $1'
);

const ensureSellerReviewColumns = async () => {
  await pool.query(`
    ALTER TABLE sellers
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS rejected_reason TEXT,
      ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP
  `);
  await ensureCnicUpdateColumns(pool, 'sellers');
};

const ensureOrderPaymentColumns = async (clientOrPool = pool) => {
  await ensureOrderChargeColumns(clientOrPool);
  await clientOrPool.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS payment_received_amount NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS payment_received_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS payment_reference TEXT,
      ADD COLUMN IF NOT EXISTS payment_note TEXT,
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP
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
    ALTER TABLE delivery_updates
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()
  `);
  await clientOrPool.query(`
    DO $$
    DECLARE constraint_row record;
    BEGIN
      FOR constraint_row IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'orders'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
      LOOP
        EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', constraint_row.conname);
      END LOOP;
    END $$;
  `);
};

const ensureProductWorkflowColumns = async (clientOrPool = pool) => {
  await clientOrPool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS name_urdu TEXT,
      ADD COLUMN IF NOT EXISTS category TEXT,
      ADD COLUMN IF NOT EXISTS expected_stock INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS admin_media_required BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS image_url TEXT,
      ADD COLUMN IF NOT EXISTS product_uid TEXT,
      ADD COLUMN IF NOT EXISTS receipt_code TEXT,
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS warehouse_received_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS live_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS admin_price NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS topteam_priced_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS deleted_by TEXT
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
  await ensureSalesPlatformsTable(clientOrPool);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS product_platform_pricing (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      platform_id INTEGER NOT NULL REFERENCES sales_platforms(id) ON DELETE CASCADE,
      platform_selling_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      expected_receivable NUMERIC(12,2) NOT NULL DEFAULT 0,
      delivery_charge NUMERIC(12,2) NOT NULL DEFAULT ${DEFAULT_DELIVERY_CHARGE},
      packing_material_cost NUMERIC(12,2) NOT NULL DEFAULT ${DEFAULT_PACKING_MATERIAL_COST},
      note TEXT,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(product_id, platform_id)
    )
  `);
  await clientOrPool.query(`
    ALTER TABLE product_platform_pricing
      ADD COLUMN IF NOT EXISTS delivery_charge NUMERIC(12,2) NOT NULL DEFAULT ${DEFAULT_DELIVERY_CHARGE},
      ADD COLUMN IF NOT EXISTS packing_material_cost NUMERIC(12,2) NOT NULL DEFAULT ${DEFAULT_PACKING_MATERIAL_COST}
  `);
  await clientOrPool.query(`
    DO $$
    DECLARE constraint_row record;
    BEGIN
      FOR constraint_row IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'products'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
      LOOP
        EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', constraint_row.conname);
      END LOOP;
    END $$;
  `);
  await clientOrPool.query(`
    UPDATE products
    SET status = 'pending_sending',
        product_uid = COALESCE(product_uid, 'PHT-' || LPAD(id::text, 6, '0')),
        receipt_code = COALESCE(receipt_code, 'RCT-' || LPAD(id::text, 6, '0'))
    WHERE status = 'approved'
  `);
};

const ensureReturnsTable = async (clientOrPool = pool) => {
  await ensureSalesPlatformsTable(clientOrPool);
  await ensureReturnRequestTable(clientOrPool);
};

const hasWarehouseReceiptScan = async (clientOrPool, productId) => {
  await ensureWarehouseReceivingTable(clientOrPool);
  const result = await clientOrPool.query(
    `SELECT 1
     FROM warehouse_receiving_scans
     WHERE product_id = $1
       AND status NOT IN ('rejected', 'needs_correction')
     LIMIT 1`,
    [productId]
  );
  return result.rows.length > 0;
};

const login = async (req, res) => {
  const { password } = req.body;
  const allowedPasswords = new Set([
    process.env.ADMIN_PASSWORD,
    process.env.ADMIN_RECOVERY_PASSWORD,
    'admin123',
  ].filter(Boolean));

  if (!allowedPasswords.has(password)) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  res.json({
    token: generateAdminToken(),
    admin: { name: 'Poohter Admin', role: 'admin' }
  });
};

const getDashboardStats = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    await ensureSupportRequestsTable(pool);
    await ensureWarehouseReceivingTable(pool);
    const [
      userCount,
      sellerCount,
      orderCount,
      pendingSellers,
      pendingProducts,
      lowStock,
      wholesalerCount,
      pendingWholesalers,
      pendingWholesaleOrders,
      pendingSupportRequests,
      scannedInventory
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM sellers'),
      pool.query('SELECT COUNT(*) FROM orders'),
      pool.query("SELECT COUNT(*) FROM sellers WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*) FROM products WHERE COALESCE(status, 'pending') = 'pending'"),
      pool.query('SELECT COUNT(*) FROM inventory WHERE stock_quantity <= 5'),
      pool.query('SELECT COUNT(*) FROM wholesalers'),
      pool.query("SELECT COUNT(*) FROM wholesalers WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*) FROM wholesale_orders WHERE status = 'admin_review'"),
      pool.query("SELECT COUNT(*) FROM support_requests WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*) FROM warehouse_receiving_scans WHERE status IN ('scanned', 'pending_review')")
    ]);

    res.status(200).json({
      total_users: parseInt(userCount.rows[0].count, 10),
      total_sellers: parseInt(sellerCount.rows[0].count, 10),
      total_orders: parseInt(orderCount.rows[0].count, 10),
      pending_sellers: parseInt(pendingSellers.rows[0].count, 10),
      pending_products: parseInt(pendingProducts.rows[0].count, 10),
      low_stock: parseInt(lowStock.rows[0].count, 10),
      total_wholesalers: parseInt(wholesalerCount.rows[0].count, 10),
      pending_wholesalers: parseInt(pendingWholesalers.rows[0].count, 10),
      pending_wholesale_orders: parseInt(pendingWholesaleOrders.rows[0].count, 10),
      pending_support_requests: parseInt(pendingSupportRequests.rows[0].count, 10),
      scanned_inventory: parseInt(scannedInventory.rows[0].count, 10)
    });
  } catch (error) {
    next(error);
  }
};

const getAllUsers = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, address, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.status(200).json(result.rows);
  } catch (error) {
    next(error);
  }
};

const getAllSellers = async (req, res, next) => {
  try {
    await ensureSellerReviewColumns();
    const result = await pool.query(
      `SELECT id, cnic_number AS seller_id, name, email, phone, shop_name, business_type,
        warehouse_address, city, cnic_number, bank_name, account_title, account_number,
        mobile_wallet, cnic_front, cnic_back, status, rejected_reason, created_at,
        password_changed_at, ${cnicUpdateSelectFields}
       FROM sellers
       ORDER BY created_at DESC`
    );
    res.status(200).json(result.rows.map((seller) => ({
      ...seller,
      cnic_front: publicUploadPathFromValue(seller.cnic_front) || null,
      cnic_back: publicUploadPathFromValue(seller.cnic_back) || null,
      ...normalizeCnicUpdateFields(seller),
    })));
  } catch (error) {
    next(error);
  }
};

const requestSellerCnicUpdate = async (req, res, next) => {
  try {
    await ensureSellerReviewColumns();
    const note = String(req.body.note || '').trim();
    const result = await pool.query(
      `UPDATE sellers
       SET cnic_update_status = 'requested',
           cnic_update_requested_at = NOW(),
           cnic_update_requested_by = $1,
           cnic_update_note = $2,
           cnic_update_rejection_reason = NULL
       WHERE id = $3
       RETURNING id, name, email, shop_name, status, ${cnicUpdateSelectFields}`,
      [String(req.user?.email || req.user?.id || 'admin'), note || null, req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Seller not found' });
    res.json({
      message: 'CNIC update requested. Seller will see the request in their dashboard.',
      seller: { ...result.rows[0], ...normalizeCnicUpdateFields(result.rows[0]) },
    });
  } catch (error) {
    next(error);
  }
};

const reviewSellerCnicUpdate = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const status = String(req.body.status || '').trim().toLowerCase();
    const reason = String(req.body.reason || '').trim();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'CNIC update review status must be approved or rejected.' });
    }

    await client.query('BEGIN');
    await ensureCnicUpdateColumns(client, 'sellers');

    const current = await client.query(
      `SELECT id, pending_cnic_front, pending_cnic_back, cnic_update_status
       FROM sellers
       WHERE id = $1
       FOR UPDATE`,
      [req.params.id]
    );
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Seller not found' });
    }
    if (!current.rows[0].pending_cnic_front || !current.rows[0].pending_cnic_back) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Seller has not uploaded new CNIC images yet.' });
    }

    const result = status === 'approved'
      ? await client.query(
        `UPDATE sellers
         SET cnic_front = pending_cnic_front,
             cnic_back = pending_cnic_back,
             pending_cnic_front = NULL,
             pending_cnic_back = NULL,
             pending_cnic_uploaded_at = NULL,
             cnic_update_status = 'approved',
             cnic_update_reviewed_at = NOW(),
             cnic_update_rejection_reason = NULL
         WHERE id = $1
         RETURNING id, name, email, shop_name, status, cnic_front, cnic_back, ${cnicUpdateSelectFields}`,
        [req.params.id]
      )
      : await client.query(
        `UPDATE sellers
         SET cnic_update_status = 'rejected',
             cnic_update_reviewed_at = NOW(),
             cnic_update_rejection_reason = $1
         WHERE id = $2
         RETURNING id, name, email, shop_name, status, cnic_front, cnic_back, ${cnicUpdateSelectFields}`,
        [reason || 'CNIC images need correction', req.params.id]
      );

    await client.query('COMMIT');
    const seller = result.rows[0];
    res.json({
      message: status === 'approved' ? 'Seller CNIC update approved.' : 'Seller CNIC update rejected.',
      seller: {
        ...seller,
        cnic_front: publicUploadPathFromValue(seller.cnic_front) || null,
        cnic_back: publicUploadPathFromValue(seller.cnic_back) || null,
        ...normalizeCnicUpdateFields(seller),
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const getPlatforms = async (req, res, next) => {
  try {
    res.json(await getSalesPlatforms(pool, false));
  } catch (error) {
    next(error);
  }
};

const updateSellerStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid seller status' });
    }

    await ensureSellerReviewColumns();
    const result = await pool.query(
      `UPDATE sellers
       SET status = $1::text,
           approved_at = CASE WHEN $1::text = 'approved' THEN NOW() ELSE approved_at END,
           rejected_reason = CASE WHEN $1::text = 'rejected' THEN $2 ELSE NULL END
       WHERE id = $3
       RETURNING id, cnic_number AS seller_id, name, email, shop_name, status, rejected_reason`,
      [status, reason || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    res.json({
      seller: result.rows[0],
      message: status === 'rejected'
        ? 'Seller application rejected and moved out of active admin queues.'
        : undefined,
    });
  } catch (error) {
    next(error);
  }
};

const getAllProducts = async (req, res, next) => {
  try {
    await ensureProductWorkflowColumns(pool);
    const result = await pool.query(
      `SELECT p.id, p.product_uid, p.receipt_code, p.name, p.name_urdu, p.category, p.price, p.admin_price, p.description, p.image_url, p.created_at,
        p.expected_stock, p.admin_media_required,
        p.status, p.rejection_reason, p.warehouse_received_at, p.live_at, p.topteam_priced_at, p.seller_id,
        s.shop_name, s.name AS seller_name, s.cnic_number AS public_seller_id,
        COALESCE(i.stock_quantity, 0) AS stock_quantity,
        COALESCE(media.image_count, 0) AS image_count,
        COALESCE(media.video_count, 0) AS video_count,
        COALESCE(files.media_files, '[]'::json) AS media_files,
        COALESCE(platforms.platform_prices, '[]'::json) AS platform_prices
       FROM products p
       LEFT JOIN sellers s ON p.seller_id = s.id
       LEFT JOIN inventory i ON p.id = i.product_id
       LEFT JOIN (
         SELECT product_id,
          COUNT(*) FILTER (WHERE type = 'image') AS image_count,
          COUNT(*) FILTER (WHERE type = 'video') AS video_count
         FROM product_media
         GROUP BY product_id
       ) media ON p.id = media.product_id
       LEFT JOIN (
         SELECT product_id,
          json_agg(json_build_object('id', id, 'type', type, 'file_path', file_path) ORDER BY created_at, id) AS media_files
         FROM product_media
         GROUP BY product_id
       ) files ON p.id = files.product_id
       LEFT JOIN (
         SELECT
          ppp.product_id,
          json_agg(json_build_object(
            'id', ppp.id,
            'platform_id', sp.id,
            'platform_name', sp.name,
            'platform_code', sp.code,
            'platform_selling_price', ppp.platform_selling_price,
            'expected_receivable', ppp.expected_receivable,
            'delivery_charge', ppp.delivery_charge,
            'packing_material_cost', ppp.packing_material_cost,
            'note', ppp.note,
            'updated_at', ppp.updated_at
          ) ORDER BY ppp.updated_at DESC, sp.name) AS platform_prices
         FROM product_platform_pricing ppp
         JOIN sales_platforms sp ON ppp.platform_id = sp.id
         GROUP BY ppp.product_id
       ) platforms ON p.id = platforms.product_id
       WHERE p.deleted_at IS NULL
       ORDER BY p.created_at DESC`
    );

    res.status(200).json(result.rows.map(product => {
      const mediaFiles = Array.isArray(product.media_files)
        ? product.media_files.map((media) => ({
          ...media,
          file_path: publicUploadPathFromValue(media.file_path),
        }))
        : [];

      return {
        ...product,
        image_url: publicUploadPathFromValue(product.image_url) || null,
        media_files: mediaFiles,
        price: Number(product.price),
        admin_price: Number(product.admin_price || product.price || 0),
        stock_quantity: Number(product.stock_quantity || 0),
        platform_prices: Array.isArray(product.platform_prices) ? product.platform_prices.map((plan) => ({
        ...plan,
        platform_selling_price: Number(plan.platform_selling_price || 0),
        expected_receivable: Number(plan.expected_receivable || 0),
        delivery_charge: Number(plan.delivery_charge || 0),
        packing_material_cost: Number(plan.packing_material_cost || 0),
      })) : [],
        status: product.status || 'pending'
      };
    }));
  } catch (error) {
    next(error);
  }
};

const updateProductStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!['approved', 'rejected', 'pending', 'pending_sending', 'warehouse_received', 'topteam_pending', 'live'].includes(status)) {
      return res.status(400).json({ error: 'Invalid product status' });
    }

    await ensureProductWorkflowColumns(pool);
    const nextStatus = status === 'approved' ? 'pending_sending' : status;
    if (['warehouse_received', 'topteam_pending', 'live'].includes(nextStatus)) {
      const scanned = await hasWarehouseReceiptScan(pool, id);
      if (!scanned) {
        return res.status(400).json({
          error: 'Scan the product receipt in the Tracking app before changing warehouse status or sending this product to Top Team.',
        });
      }
    }

    const result = await pool.query(
      `UPDATE products
       SET status = $1::text,
           rejection_reason = CASE WHEN $1::text = 'rejected' THEN $2 ELSE NULL END,
           product_uid = CASE
             WHEN $1::text IN ('pending_sending', 'warehouse_received', 'topteam_pending', 'live') AND product_uid IS NULL THEN 'PHT-' || LPAD(id::text, 6, '0')
             ELSE product_uid
           END,
           receipt_code = CASE
             WHEN $1::text IN ('pending_sending', 'warehouse_received', 'topteam_pending', 'live') AND receipt_code IS NULL THEN 'RCT-' || LPAD(id::text, 6, '0')
             ELSE receipt_code
           END,
           warehouse_received_at = CASE WHEN $1::text = 'warehouse_received' THEN NOW() ELSE warehouse_received_at END,
           live_at = CASE WHEN $1::text = 'live' THEN NOW() ELSE live_at END
       WHERE id = $3
       RETURNING *`,
      [nextStatus, reason || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ product: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const finalizeWarehouseProduct = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { name, name_urdu, category, description, price, stock } = req.body;
    const sendToTopTeam = ['true', '1', 'on', true].includes(req.body.send_to_topteam);
    const parsedPrice = Number(price);
    const parsedStock = Number(stock);

    if (!name || !Number.isFinite(parsedPrice) || parsedPrice < 0 || !Number.isFinite(parsedStock) || parsedStock < 0) {
      return res.status(400).json({ error: 'Name, non-negative admin price, and non-negative stock are required' });
    }

    if (sendToTopTeam && !String(description || '').trim()) {
      return res.status(400).json({ error: 'Description is required before sending this product to Top Team.' });
    }
    if (sendToTopTeam && !String(category || '').trim()) {
      return res.status(400).json({ error: 'Category is required before sending this product to Top Team.' });
    }
    if (sendToTopTeam && parsedPrice <= 0) {
      return res.status(400).json({ error: 'Admin price must be greater than zero before sending this product to Top Team.' });
    }
    if (sendToTopTeam && parsedStock <= 0) {
      return res.status(400).json({ error: 'Warehouse stock must be greater than zero before sending this product to Top Team.' });
    }

    await client.query('BEGIN');
    await ensureProductWorkflowColumns(client);

    const existing = await client.query('SELECT id, price, admin_price FROM products WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }
    const scanned = await hasWarehouseReceiptScan(client, id);
    if (!scanned) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Scan the product receipt in the Tracking app before editing warehouse details or sending this product to Top Team.',
      });
    }
    const sellerSubmittedPrice = Number(existing.rows[0].price || existing.rows[0].admin_price || 0);
    if (parsedPrice > sellerSubmittedPrice + 0.01) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Admin price cannot be higher than the seller submitted price' });
    }

    const productImages = req.files?.product_images || [];
    const productVideo = req.files?.product_video?.[0] || null;
    const videoDurationSeconds = Number(req.body.product_video_duration_seconds);
    if (
      sendToTopTeam
      && productVideo
      && Number.isFinite(videoDurationSeconds)
      && videoDurationSeconds > 10.25
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Product video must be 10 seconds or shorter before sending to Top Team.' });
    }
    const imagePaths = productImages.map(publicUploadPath).filter(Boolean);
    const videoPath = publicUploadPath(productVideo);

    await persistUploadedFiles([...productImages, ...(productVideo ? [productVideo] : [])], client);

    const mediaQueries = [];
    if (imagePaths.length) {
      imagePaths.forEach(filePath => {
        mediaQueries.push(client.query(
          'INSERT INTO product_media (product_id, type, file_path) VALUES ($1, $2, $3)',
          [id, 'image', filePath]
        ));
      });
    }
    if (videoPath) {
      mediaQueries.push(client.query(
        'INSERT INTO product_media (product_id, type, file_path) VALUES ($1, $2, $3)',
        [id, 'video', videoPath]
      ));
    }
    await Promise.all(mediaQueries);

    const mediaCount = await client.query(
      `SELECT
        COUNT(*) FILTER (WHERE type = 'image') AS image_count,
        COUNT(*) FILTER (WHERE type = 'video') AS video_count
       FROM product_media
       WHERE product_id = $1`,
      [id]
    );

    if (sendToTopTeam && (Number(mediaCount.rows[0].image_count) < 5 || Number(mediaCount.rows[0].video_count) < 1)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Five product images and one 10 second MP4 video are required before going live' });
    }

    await client.query(
      `INSERT INTO inventory (product_id, warehouse_id, stock_quantity)
       VALUES ($1, 1, $2)
       ON CONFLICT (product_id, warehouse_id)
       DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity, updated_at = NOW()`,
      [id, parsedStock]
    );

    const result = await client.query(
      `UPDATE products
       SET name = $1,
           name_urdu = $2,
           category = $3,
           description = $4,
           admin_price = $5,
           stock = $6,
           image_url = COALESCE(
             NULLIF(image_url, ''),
             $7,
             (SELECT pm.file_path FROM product_media pm WHERE pm.product_id = products.id AND pm.type = 'image' ORDER BY pm.created_at, pm.id LIMIT 1)
           ),
           status = CASE WHEN $9::boolean THEN 'topteam_pending' ELSE 'warehouse_received' END,
           warehouse_received_at = COALESCE(warehouse_received_at, NOW()),
           live_at = NULL,
           topteam_priced_at = CASE WHEN $9::boolean THEN NULL ELSE topteam_priced_at END
       WHERE id = $8
       RETURNING *`,
      [
        name.trim(),
        (name_urdu || '').trim(),
        String(category || '').trim() || null,
        String(description || '').trim() || null,
        parsedPrice,
        parsedStock,
        imagePaths[0] || null,
        id,
        sendToTopTeam,
      ]
    );

    await client.query('COMMIT');
    res.json({
      product: result.rows[0],
      message: sendToTopTeam
        ? 'Product details completed and sent to Top Team pricing.'
        : 'Warehouse product details saved. Product remains received in warehouse until admin completes setup.',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const updateProductStock = async (req, res, next) => {
  try {
    const { id } = req.params;
    const stock = Number(req.body.stock);

    if (!Number.isFinite(stock) || stock < 0) {
      return res.status(400).json({ error: 'Stock must be a non-negative number' });
    }

    const product = await pool.query('SELECT id FROM products WHERE id = $1', [id]);
    if (product.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const result = await pool.query(
      `INSERT INTO inventory (product_id, warehouse_id, stock_quantity)
       VALUES ($1, 1, $2)
       ON CONFLICT (product_id, warehouse_id)
       DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity, updated_at = NOW()
       RETURNING *`,
      [id, stock]
    );

    await pool.query('UPDATE products SET stock = $1 WHERE id = $2', [stock, id]);

    res.json({ inventory: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const deleteProductById = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const productId = req.params.id;

    await client.query('BEGIN');
    await ensureProductWorkflowColumns(client);

    const productResult = await client.query(
      `SELECT id, name, product_uid, status
       FROM products
       WHERE id = $1
         AND deleted_at IS NULL
       FOR UPDATE`,
      [productId]
    );

    if (productResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found or already deleted.' });
    }

    const product = productResult.rows[0];
    await client.query('DELETE FROM inventory WHERE product_id = $1', [product.id]);
    await client.query('DELETE FROM product_platform_pricing WHERE product_id = $1', [product.id]);
    const result = await client.query(
      `UPDATE products
       SET status = 'deleted',
           deleted_at = NOW(),
           deleted_by = $1,
           live_at = NULL
       WHERE id = $2
       RETURNING id, product_uid, name, status, deleted_at`,
      [String(req.user?.email || req.user?.id || 'admin'), product.id]
    );

    await client.query('COMMIT');
    res.json({
      message: `Product "${product.name}" was deleted safely.`,
      product: result.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const getAllOrders = async (req, res, next) => {
  try {
    await ensureOrderPaymentColumns(pool);
    const query = `
      SELECT 
        o.id, 
        o.order_code,
        o.source,
        o.platform,
        o.external_order_ref,
        o.status, 
        o.total_price,
        o.delivery_charge,
        o.packing_material_cost,
        o.payment_status,
        o.created_at,
        o.out_for_delivery_at,
        o.delivered_at,
        COALESCE(o.customer_name, u.name) as customer_name,
        COALESCE(o.customer_email, u.email) as customer_email,
        COALESCE(o.customer_phone, u.phone) as customer_phone,
        COALESCE(o.customer_address, u.address) as customer_address,
        o.customer_city,
        o.customer_address_notes,
        o.address_updated_by_admin,
        o.address_updated_at,
        COALESCE(json_agg(json_build_object(
          'product_id', p.id,
          'product_uid', p.product_uid,
          'product_name', p.name,
          'seller_id', s.id,
          'seller_name', COALESCE(s.shop_name, s.name),
          'quantity', oi.quantity
        )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN products p ON oi.product_id = p.id
      LEFT JOIN sellers s ON p.seller_id = s.id
      GROUP BY o.id, u.id
      ORDER BY o.created_at DESC
    `;
    const result = await pool.query(query);
    
    res.status(200).json(result.rows);
  } catch (error) {
    next(error);
  }
};

const recordOrderPayment = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const receivedAmount = Number(req.body.payment_received_amount ?? req.body.amount_received ?? req.body.amount);
    const reference = String(req.body.reference || '').trim();
    const note = String(req.body.note || '').trim();

    if (!Number.isFinite(receivedAmount) || receivedAmount <= 0) {
      return res.status(400).json({ error: 'Payment received amount must be greater than zero' });
    }

    await ensureOrderPaymentColumns(client);
    await client.query('BEGIN');

    const orderResult = await client.query(
      `SELECT id, order_code, total_price, status
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    if (order.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cancelled orders cannot be closed as successful' });
    }

    const totalPrice = Number(order.total_price || 0);
    if (receivedAmount < totalPrice - 0.01) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Received payment cannot be less than the order total' });
    }

    const result = await client.query(
      `UPDATE orders
       SET status = 'successful',
           payment_status = 'received',
           payment_received_amount = $1,
           payment_received_at = NOW(),
           payment_reference = $2,
           payment_note = $3,
           delivered_at = COALESCE(delivered_at, NOW()),
           closed_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [receivedAmount, reference || null, note || null, id]
    );

    await client.query(
      'INSERT INTO delivery_updates (order_id, status) VALUES ($1, $2)',
      [id, 'successful']
    );

    await client.query('COMMIT');
    res.json({ order: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const updateOrderStatus = async (req, res, next) => {
  const client = await pool.connect();
  let updatedOrder = null;
  let shouldNotifyCustomer = false;

  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['pending', 'accepted', 'out_from_warehouse', 'delivered', 'cancelled'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid order status' });
    }

    await ensureOrderPaymentColumns(client);
    await client.query('BEGIN');

    const orderResult = await client.query(
      `SELECT
         o.id,
         o.order_code,
         o.status,
         COALESCE(o.customer_email, u.email) AS customer_email,
         COALESCE(o.customer_name, u.name) AS customer_name
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.id = $1
       FOR UPDATE OF o`,
      [id]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const currentOrder = orderResult.rows[0];
    const transition = validateStatusTransition(currentOrder.status, status);
    if (!transition.valid) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: transition.message });
    }

    const result = await client.query(
      `UPDATE orders SET ${updateOrderStatusColumns(status)} WHERE id = $2 RETURNING *`,
      [status, id]
    );

    await client.query(
      'INSERT INTO delivery_updates (order_id, status) VALUES ($1, $2)',
      [id, status]
    );

    updatedOrder = {
      ...result.rows[0],
      customer_email: currentOrder.customer_email,
      customer_name: currentOrder.customer_name,
    };
    shouldNotifyCustomer = ['accepted', 'out_from_warehouse', 'delivered'].includes(status);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }

  const email = shouldNotifyCustomer
    ? await sendOrderStatusEmailSafely({ order: updatedOrder, status: updatedOrder.status })
    : { sent: false, skipped: true, reason: 'status_not_notified' };

  return res.json({ order: updatedOrder, email });
};

const updateOrderAddress = async (req, res, next) => {
  try {
    const { id } = req.params;
    const name = String(req.body.name ?? req.body.customer_name ?? '').trim();
    const phone = requirePakistaniMobileNumber(req.body.phone ?? req.body.customer_phone, 'Customer phone');
    const city = String(req.body.city ?? req.body.customer_city ?? '').trim();
    const address = String(req.body.full_address ?? req.body.address ?? req.body.customer_address ?? '').trim();
    const notes = String(req.body.notes ?? req.body.customer_address_notes ?? '').trim();

    if (!name || !city || !address) {
      return res.status(400).json({ error: 'Customer name, phone, city, and full address are required' });
    }

    await ensureOrderPaymentColumns(pool);
    const updatedBy = req.user?.email || req.user?.id || 'admin';
    const result = await pool.query(
      `UPDATE orders
       SET customer_name = $1,
           customer_phone = $2,
           customer_city = $3,
           customer_address = $4,
           customer_address_notes = $5,
           address_updated_by_admin = $6,
           address_updated_at = NOW()
       WHERE id = $7
       RETURNING id, order_code, customer_name, customer_phone, customer_city,
         customer_address, customer_address_notes, address_updated_by_admin, address_updated_at`,
      [name, phone, city, address, notes || null, String(updatedBy), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    return res.json({ message: 'Delivery address updated', order: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const createManualOrder = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      user_id,
      customer_name,
      customer_email,
      customer_phone,
      customer_address,
      platform,
      external_order_ref,
      items
    } = req.body;
    const cleanPlatform = String(platform || '').trim();

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    if (!cleanPlatform) {
      return res.status(400).json({ error: 'Select a sales platform for this manual order' });
    }

    if (!user_id && (!customer_name || !customer_phone || !customer_address)) {
      return res.status(400).json({ error: 'Customer name, phone, and address are required for manual platform orders' });
    }

    await client.query('BEGIN');
    await ensureOrderPaymentColumns(client);
    await ensureSalesPlatformsTable(client);

    const platformResult = await client.query(
      'SELECT name FROM sales_platforms WHERE name = $1 AND active = TRUE LIMIT 1',
      [cleanPlatform]
    );
    if (platformResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Selected sales platform is not active' });
    }
    const platformName = platformResult.rows[0].name;

    let customer = {
      name: customer_name || null,
      email: customer_email || null,
      phone: customer_phone || null,
      address: customer_address || null
    };

    if (user_id) {
      const userResult = await client.query('SELECT name, email, phone, address FROM users WHERE id = $1', [user_id]);
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Selected customer was not found' });
      }
      customer = {
        name: customer.name || userResult.rows[0].name,
        email: customer.email || userResult.rows[0].email,
        phone: customer.phone || userResult.rows[0].phone,
        address: customer.address || userResult.rows[0].address
      };
    }

    customer.phone = requirePakistaniMobileNumber(customer.phone, 'Customer phone');

    let total = 0;
    const orderItems = [];

    for (const item of items) {
      const quantity = Number(item.quantity);
      const productKey = String(item.product_uid || item.product_id || '').trim();
      const productResult = await client.query(
        `SELECT id, product_uid, name, price
         FROM products
         WHERE (product_uid = $1 OR id::text = $1)
           AND status = 'live'
         LIMIT 1`,
        [productKey]
      );
      const product = productResult.rows[0];

      if (!product || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('Invalid live product unique ID or quantity in manual order');
      }

      const price = Number(product.price);
      total += price * quantity;
      orderItems.push({ productId: product.id, quantity, price });
    }

    const deliveryCharge = DEFAULT_DELIVERY_CHARGE;
    const packingMaterialCost = DEFAULT_PACKING_MATERIAL_COST;
    total += deliveryCharge;

    const orderCode = await createUniqueOrderCode(client);
    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id, total_price, status, order_code, source, platform, external_order_ref,
        customer_name, customer_email, customer_phone, customer_address,
        delivery_charge, packing_material_cost
       ) VALUES ($1, $2, 'accepted', $3, 'manual', $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        user_id || null,
        total,
        orderCode,
        platformName,
        external_order_ref || null,
        customer.name,
        customer.email,
        customer.phone,
        customer.address,
        deliveryCharge,
        packingMaterialCost
      ]
    );
    const order = orderResult.rows[0];

    for (const item of orderItems) {
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)',
        [order.id, item.productId, item.quantity, item.price]
      );
      await client.query(
        `UPDATE inventory
         SET stock_quantity = GREATEST(stock_quantity - $1, 0), updated_at = NOW()
         WHERE product_id = $2 AND warehouse_id = 1`,
        [item.quantity, item.productId]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ order });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const getAllReturns = async (req, res, next) => {
  try {
    await ensureReturnsTable();
    const result = await pool.query(`
      SELECT
        rr.id, rr.return_code, rr.order_id, rr.product_id, rr.quantity, rr.reason,
        COALESCE(rr.platform, o.platform, CASE WHEN o.source = 'manual' THEN 'Manual' ELSE 'Poohter app' END) AS platform,
        rr.status, rr.refund_amount, rr.created_at, rr.processed_at, rr.processed_by, rr.admin_note,
        o.order_code, o.created_at AS order_created_at,
        COALESCE(o.customer_name, u.name) AS customer_name,
        COALESCE(o.customer_email, u.email) AS customer_email,
        COALESCE(o.customer_phone, u.phone) AS customer_phone,
        COALESCE(o.customer_address, u.address) AS customer_address,
        p.name AS product_name, p.product_uid,
        s.id AS seller_id, COALESCE(s.shop_name, s.name) AS seller_name
      FROM return_requests rr
      JOIN orders o ON rr.order_id = o.id
      LEFT JOIN users u ON o.user_id = u.id
      JOIN products p ON rr.product_id = p.id
      LEFT JOIN sellers s ON p.seller_id = s.id
      ORDER BY rr.created_at DESC
    `);

    res.json(result.rows.map(item => ({
      ...item,
      refund_amount: Number(item.refund_amount || 0)
    })));
  } catch (error) {
    next(error);
  }
};

const createManualReturn = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { order_code, product_uid, quantity, reason, platform } = req.body;
    const parsedQuantity = Number(quantity || 1);
    const returnStatus = 'completed';
    const cleanPlatform = String(platform || '').trim();
    const restockStatuses = ['completed'];

    if (!order_code || !product_uid || !cleanPlatform || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      return res.status(400).json({ error: 'Platform, order code, product unique ID, and quantity are required' });
    }

    await client.query('BEGIN');
    await ensureReturnsTable(client);

    const platformResult = await client.query(
      'SELECT name FROM sales_platforms WHERE name = $1 AND active = TRUE LIMIT 1',
      [cleanPlatform]
    );
    if (platformResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Selected sales platform is not active' });
    }
    const platformName = platformResult.rows[0].name;

    const orderResult = await client.query(
      `SELECT id, order_code, status, COALESCE(delivered_at, closed_at) AS delivered_at
       FROM orders
       WHERE order_code = $1 OR id::text = $1
       LIMIT 1
       FOR UPDATE`,
      [String(order_code).trim()]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    if (!['delivered', 'successful'].includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Returns are available after successful delivery only.' });
    }
    const returnWindow = getReturnWindow(order.delivered_at);
    if (!returnWindow.eligible) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Return window is closed. Buyers can return items within 7 days only.' });
    }

    const itemResult = await client.query(
      `SELECT oi.product_id, oi.quantity, oi.price, p.product_uid, p.name
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1
         AND (p.product_uid = $2 OR p.id::text = $2)
       LIMIT 1`,
      [order.id, String(product_uid).trim()]
    );

    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product was not found in this order' });
    }

    const item = itemResult.rows[0];
    const alreadyReturned = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS quantity
       FROM return_requests
       WHERE order_id = $1
         AND product_id = $2
         AND status != 'rejected'`,
      [order.id, item.product_id]
    );
    const availableToReturn = Number(item.quantity) - Number(alreadyReturned.rows[0].quantity || 0);

    if (parsedQuantity > availableToReturn) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Return quantity cannot exceed remaining returnable quantity (${availableToReturn})` });
    }

    const returnCode = createReturnCode();
    const refundAmount = Number(item.price) * parsedQuantity;
    const result = await client.query(
      `INSERT INTO return_requests (
        return_code, order_id, product_id, quantity, reason, status, refund_amount, platform,
        processed_at, inventory_reversed_at
       ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        CASE WHEN $6 != 'pending' THEN NOW() ELSE NULL END,
        CASE WHEN $9 THEN NOW() ELSE NULL END
       )
       RETURNING *`,
      [returnCode, order.id, item.product_id, parsedQuantity, reason || null, returnStatus, refundAmount, platformName, restockStatuses.includes(returnStatus)]
    );

    if (restockStatuses.includes(returnStatus)) {
      await client.query(
        `INSERT INTO inventory (product_id, warehouse_id, stock_quantity)
         VALUES ($1, 1, $2)
         ON CONFLICT (product_id, warehouse_id)
         DO UPDATE SET stock_quantity = inventory.stock_quantity + EXCLUDED.stock_quantity, updated_at = NOW()`,
        [item.product_id, parsedQuantity]
      );
      await client.query(
        `UPDATE products
         SET stock = COALESCE(stock, 0) + $1
         WHERE id = $2`,
        [parsedQuantity, item.product_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ return_request: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const updateReturnStatus = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const status = normalizeReturnStatus(req.body.status);
    const adminNote = String(req.body.note || req.body.admin_note || '').trim();

    if (!isReturnStatus(status)) {
      return res.status(400).json({ error: 'Return status must be pending, approved, rejected, or completed' });
    }

    await client.query('BEGIN');
    await ensureReturnsTable(client);

    const existingResult = await client.query(
      `SELECT id, product_id, quantity, status, inventory_reversed_at
       FROM return_requests
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Return request not found' });
    }

    const existing = existingResult.rows[0];
    const shouldRestock = status === 'completed' && !existing.inventory_reversed_at;

    if (shouldRestock) {
      await client.query(
        `INSERT INTO inventory (product_id, warehouse_id, stock_quantity)
         VALUES ($1, 1, $2)
         ON CONFLICT (product_id, warehouse_id)
         DO UPDATE SET stock_quantity = inventory.stock_quantity + EXCLUDED.stock_quantity, updated_at = NOW()`,
        [existing.product_id, existing.quantity]
      );
      await client.query(
        'UPDATE products SET stock = COALESCE(stock, 0) + $1 WHERE id = $2',
        [existing.quantity, existing.product_id]
      );
    }

    const result = await client.query(
      `UPDATE return_requests
       SET status = $1,
           processed_at = CASE WHEN $1 = 'pending' THEN NULL ELSE NOW() END,
           processed_by = CASE WHEN $1 = 'pending' THEN NULL ELSE $2 END,
           admin_note = $3,
           inventory_reversed_at = CASE
             WHEN $4::boolean THEN NOW()
             ELSE inventory_reversed_at
           END
       WHERE id = $5
       RETURNING *`,
      [status, String(req.user?.email || req.user?.id || 'admin'), adminNote || null, shouldRestock, id]
    );

    await client.query('COMMIT');
    return res.json({ return_request: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

module.exports = {
  login,
  getDashboardStats,
  getAllUsers,
  getAllSellers,
  getPlatforms,
  updateSellerStatus,
  requestSellerCnicUpdate,
  reviewSellerCnicUpdate,
  getAllProducts,
  updateProductStatus,
  finalizeWarehouseProduct,
  updateProductStock,
  deleteProductById,
  getAllOrders,
  updateOrderStatus,
  recordOrderPayment,
  createManualOrder,
  getAllReturns,
  createManualReturn,
  updateOrderAddress,
  updateReturnStatus
};

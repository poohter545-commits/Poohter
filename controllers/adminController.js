const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createUniqueOrderCode } = require('../utils/orderIdentity');
const { ensureSalesPlatformsTable, getSalesPlatforms } = require('../utils/salesPlatforms');
const { ensureWholesaleTables } = require('../utils/wholesaleFlow');

const generateAdminToken = () => jwt.sign(
  { id: 'admin', email: 'admin@poohter.local', role: 'admin' },
  process.env.JWT_SECRET || 'your_jwt_secret_here',
  { expiresIn: '12h' }
);

const updateOrderStatusColumns = (status) => (
  status === 'out_for_delivery'
    ? 'status = $1, out_for_delivery_at = NOW()'
    : 'status = $1'
);

const ensureSellerReviewColumns = async () => {
  await pool.query(`
    ALTER TABLE sellers
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS rejected_reason TEXT,
      ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP
  `);
};

const ensureOrderPaymentColumns = async (clientOrPool = pool) => {
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

const ensureProductWorkflowColumns = async () => {
  await pool.query(`
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
      ADD COLUMN IF NOT EXISTS topteam_priced_at TIMESTAMP
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_media (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
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
  await pool.query(`
    UPDATE products
    SET status = 'pending_sending',
        product_uid = COALESCE(product_uid, 'PHT-' || LPAD(id::text, 6, '0')),
        receipt_code = COALESCE(receipt_code, 'RCT-' || LPAD(id::text, 6, '0'))
    WHERE status = 'approved'
  `);
};

const ensureReturnsTable = async (clientOrPool = pool) => {
  await ensureSalesPlatformsTable(clientOrPool);
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS return_requests (
      id SERIAL PRIMARY KEY,
      return_code TEXT UNIQUE,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'requested',
      refund_amount NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      processed_at TIMESTAMP
    )
  `);
  await clientOrPool.query(`
    ALTER TABLE return_requests
      ADD COLUMN IF NOT EXISTS inventory_reversed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS platform TEXT
  `);
};

const login = async (req, res) => {
  const { password } = req.body;
  const expectedPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (password !== expectedPassword) {
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
    const [
      userCount,
      sellerCount,
      orderCount,
      revenueSum,
      pendingSellers,
      pendingProducts,
      lowStock,
      wholesalerCount,
      pendingWholesalers,
      pendingWholesaleOrders
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM sellers'),
      pool.query('SELECT COUNT(*) FROM orders'),
      pool.query('SELECT SUM(total_price) FROM orders WHERE status != $1', ['cancelled']),
      pool.query("SELECT COUNT(*) FROM sellers WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*) FROM products WHERE COALESCE(status, 'pending') = 'pending'"),
      pool.query('SELECT COUNT(*) FROM inventory WHERE stock_quantity <= 5'),
      pool.query('SELECT COUNT(*) FROM wholesalers'),
      pool.query("SELECT COUNT(*) FROM wholesalers WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*) FROM wholesale_orders WHERE status = 'admin_review'")
    ]);

    res.status(200).json({
      total_users: parseInt(userCount.rows[0].count, 10),
      total_sellers: parseInt(sellerCount.rows[0].count, 10),
      total_orders: parseInt(orderCount.rows[0].count, 10),
      total_revenue: parseFloat(revenueSum.rows[0].sum || 0),
      pending_sellers: parseInt(pendingSellers.rows[0].count, 10),
      pending_products: parseInt(pendingProducts.rows[0].count, 10),
      low_stock: parseInt(lowStock.rows[0].count, 10),
      total_wholesalers: parseInt(wholesalerCount.rows[0].count, 10),
      pending_wholesalers: parseInt(pendingWholesalers.rows[0].count, 10),
      pending_wholesale_orders: parseInt(pendingWholesaleOrders.rows[0].count, 10)
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
        password_changed_at
       FROM sellers
       ORDER BY created_at DESC`
    );
    res.status(200).json(result.rows);
  } catch (error) {
    next(error);
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

    res.json({ seller: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const updateSellerPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const passwordRegex = /^(?=.*[0-9])(?=.*[!@#$%^&*(),.?":{}|<>]).*$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one number and one special character.' });
    }

    await ensureSellerReviewColumns();
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `UPDATE sellers
       SET password = $1,
           password_changed_at = NOW()
       WHERE id = $2
       RETURNING id, cnic_number AS seller_id, name, email, shop_name, status, password_changed_at`,
      [hashedPassword, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    res.json({ seller: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const getAllProducts = async (req, res, next) => {
  try {
    await ensureProductWorkflowColumns();
    const result = await pool.query(
      `SELECT p.id, p.product_uid, p.receipt_code, p.name, p.name_urdu, p.price, p.admin_price, p.description, p.image_url, p.created_at,
        p.expected_stock, p.admin_media_required,
        p.status, p.rejection_reason, p.warehouse_received_at, p.live_at, p.seller_id,
        s.shop_name, s.name AS seller_name, s.cnic_number AS public_seller_id,
        COALESCE(i.stock_quantity, 0) AS stock_quantity,
        COALESCE(media.image_count, 0) AS image_count,
        COALESCE(media.video_count, 0) AS video_count
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
       ORDER BY p.created_at DESC`
    );

    res.status(200).json(result.rows.map(product => ({
      ...product,
      price: Number(product.price),
      admin_price: Number(product.admin_price || product.price || 0),
      stock_quantity: Number(product.stock_quantity || 0),
      status: product.status || 'pending'
    })));
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

    await ensureProductWorkflowColumns();
    const nextStatus = status === 'approved' ? 'pending_sending' : status;

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
    const { name, name_urdu, description, price, stock } = req.body;
    const parsedPrice = Number(price);
    const parsedStock = Number(stock);

    if (!name || !description || !Number.isFinite(parsedPrice) || parsedPrice < 0 || !Number.isFinite(parsedStock) || parsedStock < 0) {
      return res.status(400).json({ error: 'Name, description, non-negative admin price, and non-negative stock are required' });
    }

    await client.query('BEGIN');
    await ensureProductWorkflowColumns();

    const existing = await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }

    const mediaQueries = [];
    if (req.files && req.files['product_images']) {
      req.files['product_images'].forEach(file => {
        mediaQueries.push(client.query(
          'INSERT INTO product_media (product_id, type, file_path) VALUES ($1, $2, $3)',
          [id, 'image', file.path]
        ));
      });
    }
    if (req.files && req.files['product_video']) {
      mediaQueries.push(client.query(
        'INSERT INTO product_media (product_id, type, file_path) VALUES ($1, $2, $3)',
        [id, 'video', req.files['product_video'][0].path]
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

    if (Number(mediaCount.rows[0].image_count) < 5 || Number(mediaCount.rows[0].video_count) < 1) {
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
           description = $3,
           price = $4,
           admin_price = $4,
           stock = $5,
           status = 'topteam_pending',
           warehouse_received_at = COALESCE(warehouse_received_at, NOW()),
           live_at = NULL,
           topteam_priced_at = NULL
       WHERE id = $6
       RETURNING *`,
      [name.trim(), (name_urdu || '').trim(), description.trim(), parsedPrice, parsedStock, id]
    );

    await client.query('COMMIT');
    res.json({ product: result.rows[0] });
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

const getAllOrders = async (req, res, next) => {
  try {
    await ensureOrderPaymentColumns();
    const query = `
      SELECT 
        o.id, 
        o.order_code,
        o.source,
        o.platform,
        o.external_order_ref,
        o.total_price, 
        o.status, 
        o.payment_status,
        o.payment_received_amount,
        o.payment_received_at,
        o.payment_reference,
        o.payment_note,
        o.closed_at,
        o.created_at,
        o.out_for_delivery_at,
        COALESCE(o.customer_name, u.name) as customer_name,
        COALESCE(o.customer_email, u.email) as customer_email,
        COALESCE(o.customer_phone, u.phone) as customer_phone,
        COALESCE(o.customer_address, u.address) as customer_address,
        COALESCE(json_agg(json_build_object(
          'product_id', p.id,
          'product_uid', p.product_uid,
          'product_name', p.name,
          'seller_id', s.id,
          'seller_name', COALESCE(s.shop_name, s.name),
          'quantity', oi.quantity,
          'price', oi.price
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
    
    // Normalize numeric values
    const orders = result.rows.map(order => ({
      ...order,
      total_price: parseFloat(order.total_price),
      payment_received_amount: parseFloat(order.payment_received_amount || 0)
    }));

    res.status(200).json(orders);
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
  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['pending', 'accepted', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid order status' });
    }

    const result = await pool.query(
      `UPDATE orders SET ${updateOrderStatusColumns(status)} WHERE id = $2 RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order: result.rows[0] });
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

    const orderCode = await createUniqueOrderCode(client);
    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id, total_price, status, order_code, source, platform, external_order_ref,
        customer_name, customer_email, customer_phone, customer_address
       ) VALUES ($1, $2, 'accepted', $3, 'manual', $4, $5, $6, $7, $8, $9)
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
        customer.address
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
        rr.status, rr.refund_amount, rr.created_at, rr.processed_at,
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
    const { order_code, product_uid, quantity, reason, status, platform } = req.body;
    const parsedQuantity = Number(quantity || 1);
    const returnStatus = status || 'requested';
    const cleanPlatform = String(platform || '').trim();
    const restockStatuses = ['approved', 'received', 'refunded'];

    if (!order_code || !product_uid || !cleanPlatform || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      return res.status(400).json({ error: 'Platform, order code, product unique ID, and quantity are required' });
    }

    if (!['requested', ...restockStatuses].includes(returnStatus)) {
      return res.status(400).json({ error: 'Invalid return status' });
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
      `SELECT id, order_code, created_at
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
    const daysSinceOrder = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceOrder > 7) {
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

    const returnCode = `RET-${Date.now().toString().slice(-8)}`;
    const refundAmount = Number(item.price) * parsedQuantity;
    const result = await client.query(
      `INSERT INTO return_requests (
        return_code, order_id, product_id, quantity, reason, status, refund_amount, platform,
        processed_at, inventory_reversed_at
       ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        CASE WHEN $6 != 'requested' THEN NOW() ELSE NULL END,
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

module.exports = {
  login,
  getDashboardStats,
  getAllUsers,
  getAllSellers,
  getPlatforms,
  updateSellerStatus,
  updateSellerPassword,
  getAllProducts,
  updateProductStatus,
  finalizeWarehouseProduct,
  updateProductStock,
  getAllOrders,
  updateOrderStatus,
  recordOrderPayment,
  createManualOrder,
  getAllReturns,
  createManualReturn
};

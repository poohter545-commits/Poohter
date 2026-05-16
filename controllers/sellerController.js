const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { getPayoutSummary } = require('../utils/sellerPayouts');
const { createEmailOtp, normalizeEmail, verifyEmailOtp } = require('../utils/emailOtp');

/**
 * Helper to generate JWT for Sellers
 */
const generateToken = (seller) => {
  return jwt.sign(
    { id: seller.id, email: seller.email, role: 'seller' },
    process.env.JWT_SECRET || 'your_default_secret',
    { expiresIn: '24h' }
  );
};

const ensureProductMetadataColumns = async (clientOrPool = pool) => {
  await clientOrPool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS name_urdu TEXT,
      ADD COLUMN IF NOT EXISTS expected_stock INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS admin_media_required BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS product_uid TEXT,
      ADD COLUMN IF NOT EXISTS receipt_code TEXT,
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS warehouse_received_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS live_at TIMESTAMP
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

// --- AUTHENTICATION ---

const register = async (req, res, next) => {
  try {
    const {
      name, email, password, confirmPassword, phone,
      shop_name, business_type, warehouse_address, city,
      cnic_number,
      bank_name, account_title, account_number, mobile_wallet
    } = req.body;

    // Get file paths from multer
    const cnic_front = req.files && req.files['cnic_front'] ? req.files['cnic_front'][0].path : null;
    const cnic_back = req.files && req.files['cnic_back'] ? req.files['cnic_back'][0].path : null;

    // Server-side validation for mandatory fields
    const requiredFields = [
      'name', 'email', 'password', 'confirmPassword', 'phone', 'shop_name', 
      'city', 'cnic_number'
    ];
    for (const field of requiredFields) {
      if (!req.body[field]) {
        return res.status(400).json({ error: `Field '${field}' is required.` });
      }
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    // Password complexity check: At least one number and one special character
    const passwordRegex = /^(?=.*[0-9])(?=.*[!@#$%^&*(),.?":{}|<>]).*$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one number and one special character.' });
    }

    const cleanEmail = normalizeEmail(email);
    const sellerExists = await pool.query('SELECT id FROM sellers WHERE LOWER(email) = LOWER($1)', [cleanEmail]);
    if (sellerExists.rows.length > 0) {
      return res.status(400).json({ error: 'A seller with this email already exists' });
    }
    const cnicExists = await pool.query('SELECT id FROM sellers WHERE cnic_number = $1', [cnic_number]);
    if (cnicExists.rows.length > 0) {
      return res.status(400).json({ error: 'A seller with this CNIC already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await createEmailOtp({
      email: cleanEmail,
      purpose: 'signup',
      accountType: 'seller',
      displayName: name,
      payload: {
        name,
        email: cleanEmail,
        password_hash: hashedPassword,
        phone,
        shop_name,
        business_type,
        warehouse_address: warehouse_address || city || '',
        city,
        cnic_number,
        cnic_front,
        cnic_back,
        bank_name,
        account_title,
        account_number,
        mobile_wallet,
      },
    });

    res.status(202).json({
      message: 'Verification code sent to your email. Enter the OTP to submit your seller application.',
      requiresOtp: true,
      email: cleanEmail,
    });
  } catch (error) {
    next(error);
  }
};

const verifySellerRegistration = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    const pendingSeller = await verifyEmailOtp({
      email,
      purpose: 'signup',
      accountType: 'seller',
      otp,
    });

    const sellerExists = await pool.query('SELECT id FROM sellers WHERE LOWER(email) = LOWER($1)', [pendingSeller.email]);
    if (sellerExists.rows.length > 0) {
      return res.status(400).json({ error: 'A seller with this email already exists' });
    }
    const cnicExists = await pool.query('SELECT id FROM sellers WHERE cnic_number = $1', [pendingSeller.cnic_number]);
    if (cnicExists.rows.length > 0) {
      return res.status(400).json({ error: 'A seller with this CNIC already exists' });
    }

    const query = `
      INSERT INTO sellers (
        name, email, password, phone,
        shop_name, business_type, warehouse_address, city,
        cnic_number, cnic_front, cnic_back,
        bank_name, account_title, account_number, mobile_wallet,
        status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      ) RETURNING id, cnic_number, name, email, shop_name, status;
    `;

    const values = [
      pendingSeller.name,
      pendingSeller.email,
      pendingSeller.password_hash,
      pendingSeller.phone,
      pendingSeller.shop_name,
      pendingSeller.business_type,
      pendingSeller.warehouse_address || pendingSeller.city || '',
      pendingSeller.city,
      pendingSeller.cnic_number,
      pendingSeller.cnic_front,
      pendingSeller.cnic_back,
      pendingSeller.bank_name,
      pendingSeller.account_title,
      pendingSeller.account_number,
      pendingSeller.mobile_wallet,
      'pending'
    ];

    const result = await pool.query(query, values);

    res.status(201).json({ 
      message: 'Email verified. Seller registration submitted successfully. Your account is currently pending approval.',
      seller: result.rows[0],
      requiresApproval: true
    });
  } catch (error) {
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM sellers WHERE email = $1', [email]);
    const seller = result.rows[0];

    if (!seller || !(await bcrypt.compare(password, seller.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (seller.status !== 'approved') {
      return res.status(403).json({
        error: `Your seller account is ${seller.status || 'pending'}. Admin approval is required before login.`
      });
    }

    const token = generateToken(seller);
    res.json({
      message: 'Login successful',
      seller: {
        id: seller.id,
        seller_id: seller.cnic_number,
        name: seller.name,
        email: seller.email,
        shop_name: seller.shop_name,
        status: seller.status
      },
      token
    });
  } catch (error) {
    next(error);
  }
};

const getProfile = async (req, res, next) => {
  try {
    const sellerId = req.user.id;
    const result = await pool.query(
      `SELECT 
        id, name, email, phone, shop_name, business_type, warehouse_address, city,
        cnic_number, bank_name, account_title, account_number, mobile_wallet,
        status, created_at, approved_at, rejected_reason
       FROM sellers
       WHERE id = $1`,
      [sellerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Seller profile not found' });
    }

    res.json({ seller: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

// --- PRODUCT MANAGEMENT ---

const createProduct = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, name_urdu, price, description, expected_stock, admin_media_required } = req.body;
    const sellerId = req.user.id;

    // Basic text sanitization
    const cleanName = name.trim();
    const cleanUrduName = (name_urdu || '').trim();
    const expectedStock = Math.max(0, Number.parseInt(expected_stock || '0', 10) || 0);
    const needsAdminMedia = admin_media_required === 'true' || admin_media_required === 'on' || admin_media_required === true;

    await client.query('BEGIN');
    await ensureProductMetadataColumns(client);

    // 1. Insert product (Stock is NOT initialized by seller)
    const productResult = await client.query(
      `INSERT INTO products (
        name, name_urdu, price, description, seller_id, status, expected_stock, admin_media_required
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [cleanName, cleanUrduName, price, description, sellerId, 'pending', expectedStock, needsAdminMedia]
    );
    const product = productResult.rows[0];

    const mediaQueries = [];
    if (req.files && req.files['product_images']) {
      req.files['product_images'].forEach(file => {
        mediaQueries.push(client.query(
          'INSERT INTO product_media (product_id, type, file_path) VALUES ($1, $2, $3)',
          [product.id, 'image', file.path]
        ));
      });
    }
    if (req.files && req.files['product_video']) {
      mediaQueries.push(client.query(
        'INSERT INTO product_media (product_id, type, file_path) VALUES ($1, $2, $3)',
        [product.id, 'video', req.files['product_video'][0].path]
      ));
    }
    await Promise.all(mediaQueries);

    // Initialize inventory so sellers can update stock immediately
    await client.query(
      'INSERT INTO inventory (product_id, warehouse_id, stock_quantity) VALUES ($1, $2, $3)',
      [product.id, 1, expectedStock]
    );

    await client.query('COMMIT');
    res.status(201).json({ product });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const getMyProducts = async (req, res, next) => {
  try {
    await ensureProductMetadataColumns();
    const sellerId = req.user.id;
    const result = await pool.query(
      `SELECT
        p.id, p.product_uid, p.receipt_code, p.name, p.name_urdu, p.price, p.description, p.status,
        p.expected_stock, p.admin_media_required, p.created_at,
        p.rejection_reason, p.warehouse_received_at, p.live_at, i.stock_quantity
       FROM products p 
       LEFT JOIN inventory i ON p.id = i.product_id 
       WHERE p.seller_id = $1`,
      [sellerId]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

// --- STOCK MANAGEMENT ---

const updateStock = async (req, res, next) => {
  const { id } = req.params; // product_id
  const { stock } = req.body;
  const sellerId = req.user.id;

  if (stock < 0) return res.status(400).json({ error: 'Stock cannot be negative' });

  try {
    // Verify Ownership
    const ownershipCheck = await pool.query('SELECT id FROM products WHERE id = $1 AND seller_id = $2', [id, sellerId]);
    if (ownershipCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied: You do not own this product' });
    }

    // Update Inventory
    const result = await pool.query(
      'UPDATE inventory SET stock_quantity = $1 WHERE product_id = $2 RETURNING *',
      [stock, id]
    );

    if (result.rows.length === 0) {
      const insertResult = await pool.query(
        'INSERT INTO inventory (product_id, warehouse_id, stock_quantity) VALUES ($1, $2, $3) RETURNING *',
        [id, 1, stock]
      );
      return res.json({ message: 'Stock updated', inventory: insertResult.rows[0] });
    }

    res.json({ message: 'Stock updated', inventory: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

// --- ORDER MANAGEMENT ---

const getSellerOrders = async (req, res, next) => {
  try {
    const sellerId = req.user.id;

    /**
     * Fetches orders that contain at least one item belonging to the seller.
     * We join order_items and products to filter by seller_id.
     */
    const query = `
      SELECT 
        o.id AS order_id,
        o.order_code,
        o.status,
        o.created_at,
        o.total_price,
        json_agg(json_build_object(
          'product_id', p.id,
          'name', p.name,
          'quantity', oi.quantity,
          'unit_price', oi.price
        )) AS seller_items
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
      WHERE p.seller_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `;

    const result = await pool.query(query, [sellerId]);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

const updateSellerOrderStatus = async (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body;
  const sellerId = req.user.id;
  const allowedStatuses = ['shipped', 'delivered'];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Sellers can only mark orders as shipped or delivered' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ownership = await client.query(
      `SELECT o.id, o.status
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       JOIN products p ON oi.product_id = p.id
       WHERE o.id = $1 AND p.seller_id = $2
       LIMIT 1
       FOR UPDATE`,
      [id, sellerId]
    );

    if (ownership.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Seller order not found' });
    }

    const currentStatus = ownership.rows[0].status;
    const validTransition =
      (currentStatus === 'pending' && status === 'shipped') ||
      (currentStatus === 'accepted' && status === 'shipped') ||
      (currentStatus === 'packed' && status === 'shipped') ||
      (currentStatus === 'shipped' && status === 'delivered');

    if (!validTransition) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot change order from ${currentStatus} to ${status}` });
    }

    const result = await client.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    await client.query(
      'INSERT INTO delivery_updates (order_id, status) VALUES ($1, $2)',
      [id, status]
    ).catch(() => null);

    await client.query('COMMIT');
    res.json({ message: 'Order status updated', order: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const getSellerPayouts = async (req, res, next) => {
  try {
    const sellerId = req.user.id;
    const payouts = await getPayoutSummary(pool, sellerId);
    res.json({
      summary: {
        commission_rate: payouts.commission_rate,
        seller_payout_rate: payouts.seller_payout_rate,
        pending_payout: payouts.total_pending,
        total_paid: payouts.total_paid,
        total_earned: payouts.total_seller_earning,
      },
      account: payouts.rows[0] || null,
      payouts: payouts.recent,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  verifySellerRegistration,
  login,
  getProfile,
  createProduct,
  getMyProducts,
  updateStock,
  getSellerOrders,
  updateSellerOrderStatus,
  getSellerPayouts
};

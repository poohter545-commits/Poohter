const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('../config/auth');
const { getPayoutSummary } = require('../utils/sellerPayouts');
const { createEmailOtp, normalizeEmail, verifyEmailOtp } = require('../utils/emailOtp');
const { persistUploadedFiles, publicUploadPath } = require('../utils/uploads');
const { LEGACY_ORDER_STATUS_ALIASES } = require('../utils/orderIdentity');
const { ensureOrderChargeColumns } = require('../utils/orderCharges');
const {
  ensureCnicUpdateColumns,
  cnicUpdateSelectFields,
  normalizeCnicUpdateFields,
} = require('../utils/cnicUpdates');
const {
  ensureRefreshTokenColumns,
  issueTokenPair,
  storeRefreshToken,
  verifyRefreshToken,
} = require('../utils/refreshTokens');

/**
 * Helper to generate JWT for Sellers
 */
const generateToken = (seller) => {
  return jwt.sign(
    { id: seller.id, email: seller.email, role: 'seller' },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
};

const sellerApprovalPendingMessage = 'Waiting for admin approval. Your seller application was submitted successfully and is still under review. You can log in after admin approves your account.';

const ensureProductMetadataColumns = async (clientOrPool = pool) => {
  await clientOrPool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS name_urdu TEXT,
      ADD COLUMN IF NOT EXISTS expected_stock INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS admin_media_required BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS image_url TEXT,
      ADD COLUMN IF NOT EXISTS product_uid TEXT,
      ADD COLUMN IF NOT EXISTS receipt_code TEXT,
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS warehouse_received_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS live_at TIMESTAMP,
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
    const cnicFrontFile = req.files?.cnic_front?.[0];
    const cnicBackFile = req.files?.cnic_back?.[0];
    const cnic_front = publicUploadPath(cnicFrontFile);
    const cnic_back = publicUploadPath(cnicBackFile);

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
    await persistUploadedFiles([cnicFrontFile, cnicBackFile].filter(Boolean), pool);
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
      message: 'Email verified. Seller registration submitted successfully. Waiting for admin approval before login.',
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
    await ensureCnicUpdateColumns(pool, 'sellers');
    await ensureRefreshTokenColumns(pool, 'sellers');
    const result = await pool.query('SELECT * FROM sellers WHERE email = $1', [email]);
    const seller = result.rows[0];

    if (!seller || !(await bcrypt.compare(password, seller.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (seller.status !== 'approved') {
      return res.status(403).json({
        error: sellerApprovalPendingMessage,
        status: seller.status || 'pending',
        requiresApproval: true
      });
    }

    const { accessToken, refreshToken, jti } = issueTokenPair({ id: seller.id, email: seller.email, role: 'seller' });
    await storeRefreshToken(pool, 'sellers', seller.id, jti);
    res.json({
      message: 'Login successful',
      seller: {
        id: seller.id,
        seller_id: seller.cnic_number,
        name: seller.name,
        email: seller.email,
        shop_name: seller.shop_name,
        status: seller.status,
        ...normalizeCnicUpdateFields(seller)
      },
      token: accessToken,
      refreshToken,
    });
  } catch (error) {
    next(error);
  }
};

const refreshSellerToken = async (req, res, next) => {
  try {
    const refreshToken = String(req.body?.refreshToken || '').trim();
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token is required' });

    await ensureRefreshTokenColumns(pool, 'sellers');
    const seller = await verifyRefreshToken(pool, 'sellers', 'seller', refreshToken);
    if (!seller) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    if (seller.status !== 'approved') {
      return res.status(403).json({ error: sellerApprovalPendingMessage, status: seller.status || 'pending', requiresApproval: true });
    }

    const { accessToken, refreshToken: nextRefreshToken, jti } = issueTokenPair({ id: seller.id, email: seller.email, role: 'seller' });
    await storeRefreshToken(pool, 'sellers', seller.id, jti);
    res.json({ token: accessToken, refreshToken: nextRefreshToken });
  } catch (error) {
    next(error);
  }
};

const logoutSeller = async (req, res, next) => {
  try {
    await ensureRefreshTokenColumns(pool, 'sellers');
    await pool.query(
      `UPDATE sellers SET refresh_token_jti = NULL, refresh_token_expires_at = NULL WHERE id = $1`,
      [req.user.id]
    );
    res.json({ message: 'Logged out' });
  } catch (error) {
    next(error);
  }
};

const getProfile = async (req, res, next) => {
  try {
    const sellerId = req.user.id;
    await ensureCnicUpdateColumns(pool, 'sellers');
    const result = await pool.query(
      `SELECT 
        id, name, email, phone, shop_name, business_type, warehouse_address, city,
        cnic_number, bank_name, account_title, account_number, mobile_wallet,
        status, created_at, approved_at, rejected_reason,
        ${cnicUpdateSelectFields}
       FROM sellers
       WHERE id = $1`,
      [sellerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Seller profile not found' });
    }

    res.json({ seller: { ...result.rows[0], ...normalizeCnicUpdateFields(result.rows[0]) } });
  } catch (error) {
    next(error);
  }
};

const uploadCnicUpdate = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const sellerId = req.user.id;
    const cnicFrontFile = req.files?.cnic_front?.[0];
    const cnicBackFile = req.files?.cnic_back?.[0];

    if (!cnicFrontFile || !cnicBackFile) {
      return res.status(400).json({ error: 'Upload both front and back CNIC images.' });
    }

    const pendingFront = publicUploadPath(cnicFrontFile);
    const pendingBack = publicUploadPath(cnicBackFile);

    await client.query('BEGIN');
    await ensureCnicUpdateColumns(client, 'sellers');
    await persistUploadedFiles([cnicFrontFile, cnicBackFile], client);

    const current = await client.query(
      `SELECT id, cnic_update_status
       FROM sellers
       WHERE id = $1
       FOR UPDATE`,
      [sellerId]
    );
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Seller profile not found' });
    }

    const allowed = ['requested', 'rejected', 'uploaded'];
    if (!allowed.includes(current.rows[0].cnic_update_status || 'clear')) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Admin has not requested a CNIC update for this account.' });
    }

    const result = await client.query(
      `UPDATE sellers
       SET pending_cnic_front = $1,
           pending_cnic_back = $2,
           pending_cnic_uploaded_at = NOW(),
           cnic_update_status = 'uploaded',
           cnic_update_rejection_reason = NULL
       WHERE id = $3
       RETURNING id, ${cnicUpdateSelectFields}`,
      [pendingFront, pendingBack, sellerId]
    );

    await client.query('COMMIT');
    res.json({
      message: 'CNIC images uploaded for admin review. Your current approved CNIC remains active until approval.',
      cnic_update: normalizeCnicUpdateFields(result.rows[0]),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
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
    const productImages = req.files?.product_images || [];
    const productVideo = req.files?.product_video?.[0] || null;
    const imagePaths = productImages.map(publicUploadPath).filter(Boolean);
    const videoPath = publicUploadPath(productVideo);

    await client.query('BEGIN');
    await ensureOrderChargeColumns(client);
    await ensureProductMetadataColumns(client);
    await persistUploadedFiles([...productImages, ...(productVideo ? [productVideo] : [])], client);

    // 1. Insert product (Stock is NOT initialized by seller)
    const productResult = await client.query(
      `INSERT INTO products (
        name, name_urdu, price, description, seller_id, status, expected_stock, admin_media_required, image_url
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [cleanName, cleanUrduName, price, description, sellerId, 'pending', expectedStock, needsAdminMedia, imagePaths[0] || null]
    );
    const product = productResult.rows[0];

    const mediaQueries = [];
    if (imagePaths.length) {
      imagePaths.forEach(filePath => {
        mediaQueries.push(client.query(
          'INSERT INTO product_media (product_id, type, file_path) VALUES ($1, $2, $3)',
          [product.id, 'image', filePath]
        ));
      });
    }
    if (videoPath) {
      mediaQueries.push(client.query(
        'INSERT INTO product_media (product_id, type, file_path) VALUES ($1, $2, $3)',
        [product.id, 'video', videoPath]
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
        p.id, p.product_uid, p.receipt_code, p.name, p.name_urdu, p.price, p.description,
        COALESCE(NULLIF(p.image_url, ''), image_files.first_image_url) AS image_url,
        p.expected_stock, p.admin_media_required, p.created_at,
        p.rejection_reason, p.warehouse_received_at, p.live_at, i.stock_quantity,
        COALESCE(image_files.product_images, ARRAY[]::TEXT[]) AS product_images,
        COALESCE(media.media_files, '[]'::json) AS media_files,
        COALESCE(media.image_count, 0) AS image_count,
        COALESCE(media.video_count, 0) AS video_count
       FROM products p 
       LEFT JOIN inventory i ON p.id = i.product_id 
       LEFT JOIN LATERAL (
        SELECT
          COALESCE(array_agg(pm.file_path ORDER BY pm.created_at, pm.id), ARRAY[]::TEXT[]) AS product_images,
          (array_agg(pm.file_path ORDER BY pm.created_at, pm.id))[1] AS first_image_url
        FROM product_media pm
        WHERE pm.product_id = p.id AND pm.type = 'image'
       ) image_files ON TRUE
       LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            json_agg(json_build_object('id', pm.id, 'type', pm.type, 'file_path', pm.file_path) ORDER BY pm.created_at, pm.id),
            '[]'::json
          ) AS media_files,
          COUNT(*) FILTER (WHERE pm.type = 'image') AS image_count,
          COUNT(*) FILTER (WHERE pm.type = 'video') AS video_count
        FROM product_media pm
        WHERE pm.product_id = p.id
       ) media ON TRUE
       WHERE p.seller_id = $1
         AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.id DESC`,
      [sellerId]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

const deleteMyProduct = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const sellerId = req.user.id;
    const productId = req.params.id;
    const typedName = String(req.body?.name || req.body?.product_name || '').trim();

    await client.query('BEGIN');
    await ensureProductMetadataColumns(client);

    const productResult = await client.query(
      `SELECT id, name, product_uid
       FROM products
       WHERE id = $1
         AND seller_id = $2
         AND deleted_at IS NULL
       FOR UPDATE`,
      [productId, sellerId]
    );

    if (!productResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found or already deleted.' });
    }

    const product = productResult.rows[0];
    if (typedName !== String(product.name || '').trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Type the exact English product name to delete this product.' });
    }

    const result = await client.query(
      `UPDATE products
       SET status = 'deleted',
           deleted_at = NOW(),
           deleted_by = $1,
           live_at = NULL
       WHERE id = $2
       RETURNING id, product_uid, name, status, deleted_at`,
      [String(req.user?.email || sellerId), product.id]
    );

    await client.query('COMMIT');
    return res.json({
      message: `Product "${product.name}" deleted.`,
      product: result.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    return next(error);
  } finally {
    client.release();
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
  const allowedStatuses = ['delivered'];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Sellers can only mark orders as delivered after warehouse dispatch' });
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
    const normalizedCurrentStatus = LEGACY_ORDER_STATUS_ALIASES[currentStatus] || currentStatus;
    const validTransition =
      normalizedCurrentStatus === 'out_from_warehouse' && status === 'delivered';

    if (!validTransition) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot change order from ${currentStatus} to ${status}` });
    }

    const result = await client.query(
      'UPDATE orders SET status = $1, delivered_at = COALESCE(delivered_at, NOW()) WHERE id = $2 RETURNING *',
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
  refreshSellerToken,
  logoutSeller,
  getProfile,
  uploadCnicUpdate,
  createProduct,
  getMyProducts,
  deleteMyProduct,
  updateStock,
  getSellerOrders,
  updateSellerOrderStatus,
  getSellerPayouts
};

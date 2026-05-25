const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('../config/auth');
const { createEmailOtp, normalizeEmail, verifyEmailOtp } = require('../utils/emailOtp');
const { ensureStoredUploadsTable, persistUploadedFiles, publicUploadPath, publicUploadPathFromValue } = require('../utils/uploads');
const {
  createCode,
  ensureWholesaleTables,
  normalizeWholesaler,
  normalizeWholesaleProduct,
  normalizeWholesaleOrder,
  textValue,
  numberValue,
  wholesaleOrderSelect,
  createSellerProductFromWholesaleOrder,
  receiptLinesForWholesaleOrder,
} = require('../utils/wholesaleFlow');

const MIN_WHOLESALE_PRODUCT_IMAGES = 3;
const MIN_WHOLESALE_ORDER_QUANTITY = 1;
const truthyBodyValue = (value) => ['true', '1', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const wholesaleProductLiveWhere = `
  COALESCE(NULLIF(TRIM(wp.description), ''), '') <> ''
  AND (
    SELECT COUNT(DISTINCT media_path)
    FROM (
      SELECT wpm.file_path AS media_path
      FROM wholesale_product_media wpm
      WHERE wpm.wholesale_product_id = wp.id
      UNION
      SELECT wp.image_url AS media_path
      WHERE COALESCE(wp.image_url, '') <> ''
    ) wholesale_product_images
    JOIN uploaded_files uf ON uf.file_path = wholesale_product_images.media_path
  ) >= ${MIN_WHOLESALE_PRODUCT_IMAGES}
`;

const generateWholesalerToken = (wholesaler) => jwt.sign(
  { id: wholesaler.id, email: wholesaler.email, role: 'wholesaler' },
  JWT_SECRET,
  { expiresIn: '24h' }
);

const publicWholesaler = (row) => ({
  id: row.id,
  wholesaler_id: row.cnic_number,
  cnic_number: row.cnic_number,
  name: row.name,
  email: row.email,
  phone: row.phone,
  shop_name: row.shop_name,
  business_type: row.business_type,
  warehouse_address: row.warehouse_address,
  city: row.city,
  bank_name: row.bank_name,
  account_title: row.account_title,
  account_number: row.account_number,
  mobile_wallet: row.mobile_wallet,
  cnic_front: publicUploadPathFromValue(row.cnic_front) || null,
  cnic_back: publicUploadPathFromValue(row.cnic_back) || null,
  status: row.status,
  rejected_reason: row.rejected_reason,
  topteam_report_status: row.topteam_report_status,
  topteam_report_reason: row.topteam_report_reason,
  topteam_reported_at: row.topteam_reported_at,
  topteam_reported_by: row.topteam_reported_by,
  topteam_reviewed_at: row.topteam_reviewed_at,
  ban_reason: row.ban_reason,
  banned_at: row.banned_at,
  approved_at: row.approved_at,
  created_at: row.created_at,
});

const normalizeWholesaleProductUploads = (row) => {
  const product = normalizeWholesaleProduct(row);
  const mediaFiles = product.media_files.map((media) => ({
    ...media,
    file_path: publicUploadPathFromValue(media.file_path),
  }));

  return {
    ...product,
    image_url: publicUploadPathFromValue(product.image_url) || null,
    media_files: mediaFiles,
    product_images: product.product_images.map(publicUploadPathFromValue).filter(Boolean),
  };
};

const countWholesaleProductImages = async (clientOrPool, productId) => {
  const result = await clientOrPool.query(
    `SELECT
       wp.image_url,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT wpm.file_path), NULL) AS media_files
     FROM wholesale_products wp
     LEFT JOIN wholesale_product_media wpm ON wpm.wholesale_product_id = wp.id
     WHERE wp.id = $1
     GROUP BY wp.id`,
    [productId]
  );
  const row = result.rows[0];
  if (!row) return 0;
  const paths = new Set(Array.isArray(row.media_files) ? row.media_files.filter(Boolean) : []);
  if (row.image_url) paths.add(row.image_url);
  return paths.size;
};

const wholesaleProductUploadPaths = async (client, productId) => {
  const result = await client.query(
    `SELECT ARRAY_REMOVE(ARRAY_AGG(DISTINCT file_path), NULL) AS file_paths
     FROM (
       SELECT image_url AS file_path
       FROM wholesale_products
       WHERE id = $1
       UNION
       SELECT file_path
       FROM wholesale_product_media
       WHERE wholesale_product_id = $1
     ) product_uploads`,
    [productId]
  );

  return (result.rows[0]?.file_paths || [])
    .map(publicUploadPathFromValue)
    .filter(Boolean);
};

const clearWholesaleProductMedia = async (client, productId) => {
  const uploadPaths = await wholesaleProductUploadPaths(client, productId);
  await client.query('DELETE FROM wholesale_product_media WHERE wholesale_product_id = $1', [productId]);

  if (uploadPaths.length) {
    await ensureStoredUploadsTable(client);
    await client.query('DELETE FROM uploaded_files WHERE file_path = ANY($1::text[])', [uploadPaths]);
  }

  return uploadPaths.length;
};

const resetWholesaleProductFolderData = async (client, productId) => {
  const removedUploadCount = await clearWholesaleProductMedia(client, productId);
  const result = await client.query(
    `UPDATE wholesale_products
     SET name_urdu = NULL,
         description = NULL,
         image_url = NULL,
         status = 'pending',
         admin_description_note = NULL,
         admin_price_note = NULL,
         admin_reviewed_at = NULL,
         admin_reviewed_by = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [productId]
  );

  return {
    product: result.rows[0],
    removedUploadCount,
  };
};

const registerWholesaler = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const {
      name, email, password, confirmPassword, phone, shop_name, business_type,
      warehouse_address, city, cnic_number, bank_name, account_title,
      account_number, mobile_wallet,
    } = req.body;

    const requiredFields = ['name', 'email', 'password', 'confirmPassword', 'phone', 'shop_name', 'city', 'cnic_number'];
    for (const field of requiredFields) {
      if (!textValue(req.body[field])) {
        return res.status(400).json({ error: `Field '${field}' is required.` });
      }
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (!/^(?=.*[0-9])(?=.*[!@#$%^&*(),.?":{}|<>]).*$/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one number and one special character.' });
    }

    const cleanEmail = normalizeEmail(email);
    const duplicate = await pool.query(
      'SELECT id FROM wholesalers WHERE email = $1 OR cnic_number = $2 LIMIT 1',
      [cleanEmail, textValue(cnic_number)]
    );
    if (duplicate.rows.length) {
      return res.status(400).json({ error: 'A wholesaler with this email or CNIC already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await createEmailOtp({
      email: cleanEmail,
      purpose: 'signup',
      accountType: 'wholesaler',
      displayName: name,
      payload: {
        name: textValue(name),
        email: cleanEmail,
        password_hash: hashedPassword,
        phone: textValue(phone),
        shop_name: textValue(shop_name),
        business_type: textValue(business_type),
        warehouse_address: textValue(warehouse_address) || textValue(city),
        city: textValue(city),
        cnic_number: textValue(cnic_number),
        cnic_front: publicUploadPath(req.files?.cnic_front?.[0]),
        cnic_back: publicUploadPath(req.files?.cnic_back?.[0]),
        bank_name: textValue(bank_name),
        account_title: textValue(account_title),
        account_number: textValue(account_number),
        mobile_wallet: textValue(mobile_wallet),
      },
    });

    res.status(202).json({
      message: 'Verification code sent to your email. Enter the OTP to submit your wholesaler application.',
      requiresOtp: true,
      email: cleanEmail,
    });
  } catch (error) {
    next(error);
  }
};

const verifyWholesalerRegistration = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const pendingWholesaler = await verifyEmailOtp({
      email: req.body.email,
      purpose: 'signup',
      accountType: 'wholesaler',
      otp: req.body.otp,
    });

    const duplicate = await pool.query(
      'SELECT id FROM wholesalers WHERE email = $1 OR cnic_number = $2 LIMIT 1',
      [pendingWholesaler.email, pendingWholesaler.cnic_number]
    );
    if (duplicate.rows.length) {
      return res.status(400).json({ error: 'A wholesaler with this email or CNIC already exists' });
    }

    const result = await pool.query(
      `INSERT INTO wholesalers (
        name, email, password, phone, shop_name, business_type, warehouse_address, city,
        cnic_number, cnic_front, cnic_back, bank_name, account_title, account_number,
        mobile_wallet, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')
       RETURNING *`,
      [
        pendingWholesaler.name,
        pendingWholesaler.email,
        pendingWholesaler.password_hash,
        pendingWholesaler.phone,
        pendingWholesaler.shop_name,
        pendingWholesaler.business_type,
        pendingWholesaler.warehouse_address || pendingWholesaler.city,
        pendingWholesaler.city,
        pendingWholesaler.cnic_number,
        pendingWholesaler.cnic_front,
        pendingWholesaler.cnic_back,
        pendingWholesaler.bank_name,
        pendingWholesaler.account_title,
        pendingWholesaler.account_number,
        pendingWholesaler.mobile_wallet,
      ]
    );

    const wholesaler = publicWholesaler(result.rows[0]);
    res.status(201).json({
      message: 'Email verified. Wholesaler registration submitted. Admin approval is required before dashboard access.',
      wholesaler,
    });
  } catch (error) {
    next(error);
  }
};

const loginWholesaler = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM wholesalers WHERE email = $1', [textValue(email)]);
    const wholesaler = result.rows[0];

    if (!wholesaler || !(await bcrypt.compare(password || '', wholesaler.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (wholesaler.status === 'banned') {
      return res.status(403).json({ error: `Your wholesaler account was banned by Top Team. Reason: ${wholesaler.ban_reason || 'Policy review failed.'}` });
    }
    if (wholesaler.status !== 'approved') {
      return res.status(403).json({ error: `Your wholesaler account is ${wholesaler.status}. Admin approval is required before login.` });
    }

    res.json({
      message: 'Login successful',
      wholesaler: publicWholesaler(wholesaler),
      token: generateWholesalerToken(wholesaler),
    });
  } catch (error) {
    next(error);
  }
};

const getWholesalerProfile = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const result = await pool.query('SELECT * FROM wholesalers WHERE id = $1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Wholesaler profile not found' });
    if (result.rows[0].status === 'banned') {
      return res.status(403).json({ error: `This wholesaler account is banned by Top Team. Reason: ${result.rows[0].ban_reason || 'Policy review failed.'}` });
    }
    res.json({ wholesaler: publicWholesaler(result.rows[0]) });
  } catch (error) {
    next(error);
  }
};

const requireApprovedWholesaler = async (wholesalerId) => {
  const result = await pool.query('SELECT id, status FROM wholesalers WHERE id = $1', [wholesalerId]);
  if (!result.rows.length) throw Object.assign(new Error('Wholesaler profile not found'), { status: 404 });
  if (result.rows[0].status === 'banned') {
    throw Object.assign(new Error('This wholesaler account is banned by Top Team'), { status: 403 });
  }
  if (result.rows[0].status !== 'approved') {
    throw Object.assign(new Error('Admin approval is required before using wholesaler operations'), { status: 403 });
  }
};

const createWholesalerProduct = async (req, res, next) => {
  let client;
  try {
    await ensureWholesaleTables(pool);
    client = await pool.connect();
    await client.query('BEGIN');
    await requireApprovedWholesaler(req.user.id);

    const name = textValue(req.body.name);
    const wholesalePrice = Number(req.body.wholesale_price);
    const minOrder = Number.parseInt(req.body.min_order_quantity, 10);
    const stock = Number.parseInt(req.body.available_stock, 10);
    const images = req.files?.product_images || [];

    if (
      !name
      || !Number.isFinite(wholesalePrice)
      || wholesalePrice <= 0
      || !Number.isInteger(minOrder)
      || minOrder < MIN_WHOLESALE_ORDER_QUANTITY
      || !Number.isInteger(stock)
      || stock < minOrder
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Product name, positive wholesale price, positive minimum order, and stock at least equal to minimum order are required' });
    }
    await persistUploadedFiles(images, client);

    const result = await client.query(
      `INSERT INTO wholesale_products (
        wholesaler_id, name, name_urdu, description, wholesale_price,
        base_price, top_team_extra_cost, final_price, pricing_status,
        min_order_quantity, available_stock, image_url, status
       ) VALUES ($1, $2, $3, $4, $5, $5, 0, NULL, 'pending_top_team', $6, $7, $8, 'pending')
       RETURNING *`,
      [
        req.user.id,
        name,
        textValue(req.body.name_urdu) || null,
        textValue(req.body.description) || null,
        wholesalePrice,
        minOrder,
        stock,
        publicUploadPath(images[0]),
      ]
    );

    const product = result.rows[0];
    const productUid = `WHP-${String(product.id).padStart(6, '0')}`;
    for (const image of images) {
      await client.query(
        'INSERT INTO wholesale_product_media (wholesale_product_id, file_path) VALUES ($1, $2)',
        [product.id, publicUploadPath(image)]
      );
    }
    const update = await client.query(
      'UPDATE wholesale_products SET product_uid = $1 WHERE id = $2 RETURNING *',
      [productUid, product.id]
    );
    await client.query('COMMIT');

    res.status(201).json({
      product: normalizeWholesaleProduct(update.rows[0]),
      message: 'Wholesale product submitted for admin review.',
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => null);
    next(error.status ? error : error);
  } finally {
    if (client) client.release();
  }
};

const getMyWholesaleProducts = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    await requireApprovedWholesaler(req.user.id);
    const result = await pool.query(
      `SELECT wp.*, COALESCE(w.shop_name, w.name) AS wholesaler_shop
       FROM wholesale_products wp
       JOIN wholesalers w ON wp.wholesaler_id = w.id
       WHERE wp.wholesaler_id = $1
       ORDER BY wp.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows.map(normalizeWholesaleProduct));
  } catch (error) {
    next(error.status ? error : error);
  }
};

const updateMyWholesaleProduct = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWholesaleTables(client);
    await requireApprovedWholesaler(req.user.id);

    const wholesalePrice = Number(req.body.wholesale_price);
    const minOrder = Number.parseInt(req.body.min_order_quantity, 10);
    const stock = Number.parseInt(req.body.available_stock, 10);
    const status = ['active', 'paused'].includes(req.body.status) ? req.body.status : 'active';

    if (!Number.isFinite(wholesalePrice) || wholesalePrice <= 0 || !Number.isInteger(minOrder) || minOrder < MIN_WHOLESALE_ORDER_QUANTITY || !Number.isInteger(stock) || stock < minOrder) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Wholesale price, positive minimum order, and stock at least equal to minimum order are required' });
    }

    const currentResult = await client.query(
      `SELECT wp.*
       FROM wholesale_products wp
       WHERE wp.id = $1 AND wp.wholesaler_id = $2
       FOR UPDATE`,
      [req.params.id, req.user.id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wholesale product not found' });
    }

    if (!['active', 'paused', 'topteam_pending'].includes(current.status)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Admin review is required before this wholesale product can go live.' });
    }

    if (status === 'active') {
      const imageCount = await countWholesaleProductImages(client, current.id);
      if (!current.admin_reviewed_at || !textValue(current.description) || imageCount < MIN_WHOLESALE_PRODUCT_IMAGES) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A wholesale product needs admin review, a description, and at least 3 images before it can go live.' });
      }
    }

    const result = await client.query(
      `UPDATE wholesale_products
       SET wholesale_price = $1,
           base_price = $1,
           top_team_extra_cost = 0,
           final_price = NULL,
           pricing_status = 'pending_top_team',
           priced_by_top_team_id = NULL,
           priced_at = NULL,
           min_order_quantity = $2,
           available_stock = $3,
           status = CASE WHEN $4 = 'active' THEN 'topteam_pending' ELSE $4 END,
           updated_at = NOW()
       WHERE id = $5 AND wholesaler_id = $6
       RETURNING *`,
      [wholesalePrice, minOrder, stock, status, req.params.id, req.user.id]
    );

    await client.query('COMMIT');
    res.json({ product: normalizeWholesaleProduct(result.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error.status ? error : error);
  } finally {
    client.release();
  }
};

const getWholesalerOrders = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    await requireApprovedWholesaler(req.user.id);
    const result = await pool.query(
      `${wholesaleOrderSelect}
       WHERE wo.wholesaler_id = $1
       ORDER BY wo.requested_at DESC`,
      [req.user.id]
    );
    res.json(result.rows.map(normalizeWholesaleOrder));
  } catch (error) {
    next(error.status ? error : error);
  }
};

const acceptWholesaleOrderForActor = async (req, res, next, { admin = false } = {}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWholesaleTables(client);

    const orderLookup = textValue(req.params.id);
    const whereClause = admin
      ? '(wo.id::text = $1 OR wo.order_code = $1)'
      : '(wo.id::text = $1 OR wo.order_code = $1) AND wo.wholesaler_id = $2';
    const params = admin ? [orderLookup] : [orderLookup, req.user.id];
    const orderResult = await client.query(
      `${wholesaleOrderSelect}
       WHERE ${whereClause}
       FOR UPDATE OF wo`,
      params
    );
    const order = orderResult.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wholesale order not found' });
    }
    if (order.status === 'rejected') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Rejected orders cannot be accepted' });
    }
    const allowedStatuses = admin ? ['admin_review', 'approved_by_admin', 'accepted'] : ['approved_by_admin', 'accepted'];
    if (!allowedStatuses.includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: admin ? 'This wholesale order cannot be accepted by admin in its current status' : 'Admin must approve this wholesale order before acceptance' });
    }

    if (!order.linked_product_id && numberValue(order.available_stock) < numberValue(order.quantity)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Available wholesale stock is lower than requested quantity' });
    }

    const linkedProductId = await createSellerProductFromWholesaleOrder(client, normalizeWholesaleOrder(order));
    if (!order.linked_product_id) {
      await client.query(
        `UPDATE wholesale_products
         SET available_stock = GREATEST(available_stock - $1, 0),
             updated_at = NOW()
         WHERE id = $2`,
        [order.quantity, order.wholesale_product_id]
      );
    }

    const body = req.body || {};
    const note = textValue(body.note) || (admin ? 'Admin accepted this wholesale order for the wholesaler.' : null);
    await client.query(
      `UPDATE wholesale_orders
       SET status = 'accepted',
           linked_product_id = $1,
           accepted_at = COALESCE(accepted_at, NOW()),
           wholesaler_note = CASE WHEN $2::boolean THEN wholesaler_note ELSE COALESCE($3, wholesaler_note) END,
           admin_note = CASE WHEN $2::boolean THEN COALESCE($3, admin_note) ELSE admin_note END,
           admin_reviewed_at = CASE WHEN $2::boolean THEN COALESCE(admin_reviewed_at, NOW()) ELSE admin_reviewed_at END
       WHERE id = $4`,
      [linkedProductId, admin, note, order.id]
    );

    await client.query(
      `INSERT INTO wholesale_payouts (
        payout_code, wholesaler_id, wholesale_order_id, amount, reference, note, paid_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (wholesale_order_id)
       DO UPDATE SET amount = EXCLUDED.amount, status = 'paid', paid_at = COALESCE(wholesale_payouts.paid_at, NOW())
       RETURNING *`,
      [createCode('WSP'), order.wholesaler_id, order.id, order.total_price, order.order_code, 'Instant payout after wholesale order acceptance']
    );

    const refreshed = await client.query(`${wholesaleOrderSelect} WHERE wo.id = $1`, [order.id]);
    await client.query('COMMIT');
    const normalized = normalizeWholesaleOrder(refreshed.rows[0]);
    res.json({ order: normalized, receipt_lines: receiptLinesForWholesaleOrder(normalized) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const acceptWholesaleOrder = (req, res, next) => acceptWholesaleOrderForActor(req, res, next);

const acceptWholesaleOrderByAdmin = (req, res, next) => acceptWholesaleOrderForActor(req, res, next, { admin: true });

const rejectWholesaleOrderByWholesaler = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const result = await pool.query(
      `UPDATE wholesale_orders
       SET status = 'rejected',
           wholesaler_note = $1,
           rejected_at = NOW()
       WHERE id = $2
         AND wholesaler_id = $3
         AND status = 'approved_by_admin'
       RETURNING *`,
      [textValue(req.body?.note) || 'Wholesaler rejected this request', req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Approved wholesale order not found' });
    res.json({ order: normalizeWholesaleOrder(result.rows[0]) });
  } catch (error) {
    next(error);
  }
};

const getWholesalerPayouts = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const result = await pool.query(
      `SELECT wp.*, wo.order_code
       FROM wholesale_payouts wp
       JOIN wholesale_orders wo ON wp.wholesale_order_id = wo.id
       WHERE wp.wholesaler_id = $1
       ORDER BY wp.paid_at DESC`,
      [req.user.id]
    );
    res.json(result.rows.map(row => ({
      ...row,
      amount: numberValue(row.amount),
    })));
  } catch (error) {
    next(error);
  }
};

const getWholesaleCatalogForSeller = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    await ensureStoredUploadsTable(pool);
    const result = await pool.query(
      `SELECT
        wp.*,
        COALESCE(w.shop_name, w.name) AS wholesaler_shop,
        w.city AS wholesaler_city,
        w.phone AS wholesaler_phone,
        COALESCE(
          COUNT(DISTINCT wpm.file_path)
          + CASE
              WHEN COALESCE(wp.image_url, '') <> ''
                AND COUNT(wpm.id) FILTER (WHERE wpm.file_path = wp.image_url) = 0
              THEN 1
              ELSE 0
            END,
          0
        ) AS image_count,
        COALESCE(
          json_agg(
            json_build_object('id', wpm.id, 'type', 'image', 'file_path', wpm.file_path)
            ORDER BY wpm.id
          ) FILTER (WHERE wpm.id IS NOT NULL),
          '[]'::json
        ) AS media_files
       FROM wholesale_products wp
       JOIN wholesalers w ON wp.wholesaler_id = w.id
       LEFT JOIN wholesale_product_media wpm ON wpm.wholesale_product_id = wp.id
       WHERE wp.status = 'active'
         AND ${wholesaleProductLiveWhere}
         AND COALESCE(wp.pricing_status, 'pending_top_team') = 'approved'
         AND COALESCE(wp.final_price, 0) > 0
         AND w.status = 'approved'
         AND wp.available_stock >= wp.min_order_quantity
       GROUP BY wp.id, w.id
       ORDER BY wp.created_at DESC`
    );
    res.json(result.rows.map(row => ({
      ...normalizeWholesaleProductUploads(row),
      image_count: numberValue(row.image_count),
      wholesale_price: numberValue(row.final_price ?? row.wholesale_price),
      final_price: row.final_price == null ? null : numberValue(row.final_price),
      base_price: numberValue(row.base_price ?? row.wholesale_price),
      top_team_extra_cost: numberValue(row.top_team_extra_cost),
    })));
  } catch (error) {
    next(error);
  }
};

const createWholesaleOrderForSeller = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const productId = Number(req.body.product_id || req.body.wholesale_product_id);
    const quantity = Number(req.body.quantity);
    const sellerNote = textValue(req.body.note);

    if (!Number.isInteger(productId) || productId <= 0 || !Number.isFinite(quantity)) {
      return res.status(400).json({ error: 'Wholesale product and quantity are required' });
    }

    await client.query('BEGIN');
    await ensureWholesaleTables(client);
    await ensureStoredUploadsTable(client);
    const productResult = await client.query(
      `SELECT wp.*, w.status AS wholesaler_status
       FROM wholesale_products wp
       JOIN wholesalers w ON wp.wholesaler_id = w.id
       WHERE wp.id = $1
         AND wp.status = 'active'
         AND ${wholesaleProductLiveWhere}
         AND COALESCE(wp.pricing_status, 'pending_top_team') = 'approved'
         AND COALESCE(wp.final_price, 0) > 0
       LIMIT 1`,
      [productId]
    );
    const product = productResult.rows[0];
    if (!product || product.wholesaler_status !== 'approved') {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active wholesale product not found' });
    }

    const minOrder = Math.max(MIN_WHOLESALE_ORDER_QUANTITY, Number(product.min_order_quantity || MIN_WHOLESALE_ORDER_QUANTITY));
    if (quantity < minOrder) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Minimum wholesale order is ${minOrder} units` });
    }
    if (quantity > Number(product.available_stock || 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Requested quantity is higher than available wholesale stock' });
    }

    const unitPrice = Number(product.final_price || product.wholesale_price || product.base_price || 0);
    const totalPrice = unitPrice * quantity;
    const orderCode = createCode('WSO');
    const orderResult = await client.query(
      `INSERT INTO wholesale_orders (
        order_code, seller_id, wholesaler_id, wholesale_product_id,
        quantity, wholesale_unit_price, total_price, seller_note
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [orderCode, req.user.id, product.wholesaler_id, product.id, quantity, unitPrice, totalPrice, sellerNote || null]
    );

    await client.query('COMMIT');
    res.status(201).json({ order: normalizeWholesaleOrder(orderResult.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const getSellerWholesaleOrders = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const result = await pool.query(
      `${wholesaleOrderSelect}
       WHERE wo.seller_id = $1
       ORDER BY wo.requested_at DESC`,
      [req.user.id]
    );
    res.json(result.rows.map(normalizeWholesaleOrder));
  } catch (error) {
    next(error);
  }
};

const getAdminWholesaleProducts = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const result = await pool.query(
      `SELECT
        wp.*,
        COALESCE(w.shop_name, w.name) AS wholesaler_shop,
        w.name AS wholesaler_name,
        w.email AS wholesaler_email,
        w.phone AS wholesaler_phone,
        w.city AS wholesaler_city,
        w.cnic_number AS wholesaler_cnic_number,
        COUNT(DISTINCT wpm.file_path)
          + CASE
              WHEN COALESCE(wp.image_url, '') <> ''
                AND COUNT(wpm.id) FILTER (WHERE wpm.file_path = wp.image_url) = 0
              THEN 1
              ELSE 0
            END AS image_count,
        COALESCE(
          json_agg(
            json_build_object('id', wpm.id, 'type', 'image', 'file_path', wpm.file_path)
            ORDER BY wpm.id
          ) FILTER (WHERE wpm.id IS NOT NULL),
          '[]'
        ) AS media_files
       FROM wholesale_products wp
       JOIN wholesalers w ON wp.wholesaler_id = w.id
       LEFT JOIN wholesale_product_media wpm ON wpm.wholesale_product_id = wp.id
       GROUP BY wp.id, w.id
       ORDER BY
         CASE WHEN wp.status = 'pending' THEN 0 WHEN wp.status = 'topteam_pending' THEN 1 WHEN wp.status = 'active' THEN 2 ELSE 3 END,
         wp.created_at DESC`
    );
    res.json(result.rows.map(row => ({
      ...normalizeWholesaleProductUploads(row),
      image_count: numberValue(row.image_count),
    })));
  } catch (error) {
    next(error);
  }
};

const reviewAdminWholesaleProduct = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWholesaleTables(client);

    const status = ['active', 'rejected', 'pending', 'paused', 'topteam_pending'].includes(req.body.status)
      ? req.body.status
      : 'active';
    const nextStatus = status === 'active' ? 'topteam_pending' : status;
    const name = textValue(req.body.name);
    const description = textValue(req.body.description);
    const wholesalePrice = Number(req.body.wholesale_price);
    const minOrder = Number.parseInt(req.body.min_order_quantity, 10);
    const stock = Number.parseInt(req.body.available_stock, 10);
    const images = req.files?.product_images || [];
    const replaceImages = truthyBodyValue(req.body.replace_images) || images.length === MIN_WHOLESALE_PRODUCT_IMAGES;

    const currentResult = await client.query(
      'SELECT * FROM wholesale_products WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wholesale product not found' });
    }

    const finalName = name || current.name;
    const finalDescription = description || current.description;
    const finalWholesalePrice = Number.isFinite(wholesalePrice) && wholesalePrice > 0
      ? wholesalePrice
      : Number(current.wholesale_price);
    const finalMinOrder = Number.isInteger(minOrder) && minOrder >= MIN_WHOLESALE_ORDER_QUANTITY
      ? minOrder
      : Number(current.min_order_quantity);
    const finalStock = Number.isInteger(stock) && stock >= 0
      ? stock
      : Number(current.available_stock);
    const existingImageCount = await countWholesaleProductImages(client, current.id);
    const finalImageCount = replaceImages ? images.length : existingImageCount + images.length;

    if (replaceImages && images.length !== MIN_WHOLESALE_PRODUCT_IMAGES) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Re-upload the wholesale product folder with exactly 3 JPG or PNG images.' });
    }

    if (status === 'active') {
      if (
        !textValue(finalName)
        || !textValue(finalDescription)
        || !Number.isFinite(finalWholesalePrice)
        || finalWholesalePrice <= 0
        || !Number.isInteger(finalMinOrder)
        || finalMinOrder < MIN_WHOLESALE_ORDER_QUANTITY
        || !Number.isInteger(finalStock)
        || finalStock < finalMinOrder
      ) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Name, description, positive price, positive minimum order, and stock at least equal to minimum order are required to activate a wholesale product.' });
      }
      if (finalImageCount < MIN_WHOLESALE_PRODUCT_IMAGES) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'At least 3 product images are required before this wholesale product can go live.' });
      }
    }
    await persistUploadedFiles(images, client);

    let firstImage = replaceImages ? null : current.image_url;
    if (replaceImages) {
      await clearWholesaleProductMedia(client, current.id);
    }

    for (const image of images) {
      const filePath = publicUploadPath(image);
      if (!firstImage) firstImage = filePath;
      await client.query(
        'INSERT INTO wholesale_product_media (wholesale_product_id, file_path) VALUES ($1, $2)',
        [current.id, filePath]
      );
    }

    const result = await client.query(
      `UPDATE wholesale_products
       SET name = COALESCE($1, name),
           name_urdu = COALESCE($2, name_urdu),
           description = COALESCE($3, description),
           wholesale_price = COALESCE($4, wholesale_price),
           base_price = COALESCE($4, base_price, wholesale_price),
           top_team_extra_cost = CASE WHEN $8 = 'topteam_pending' THEN 0 ELSE top_team_extra_cost END,
           final_price = CASE WHEN $8 = 'topteam_pending' THEN NULL ELSE final_price END,
           pricing_status = CASE WHEN $8 = 'topteam_pending' THEN 'pending_top_team' ELSE pricing_status END,
           priced_by_top_team_id = CASE WHEN $8 = 'topteam_pending' THEN NULL ELSE priced_by_top_team_id END,
           priced_at = CASE WHEN $8 = 'topteam_pending' THEN NULL ELSE priced_at END,
           min_order_quantity = COALESCE($5, min_order_quantity),
           available_stock = COALESCE($6, available_stock),
           image_url = COALESCE($7, image_url),
           status = $8,
           admin_reviewed_at = NOW(),
           admin_reviewed_by = COALESCE($9, 'admin'),
           updated_at = NOW()
       WHERE id = $10
       RETURNING *`,
      [
        name || null,
        textValue(req.body.name_urdu) || null,
        description || null,
        Number.isFinite(wholesalePrice) && wholesalePrice > 0 ? wholesalePrice : null,
        Number.isInteger(minOrder) && minOrder >= MIN_WHOLESALE_ORDER_QUANTITY ? minOrder : null,
        Number.isInteger(stock) && stock >= 0 ? stock : null,
        firstImage || null,
        nextStatus,
        req.user?.email || req.user?.role || 'admin',
        req.params.id,
      ]
    );
    const imageCount = await countWholesaleProductImages(client, current.id);

    await client.query('COMMIT');
    res.json({
      product: {
        ...normalizeWholesaleProduct(result.rows[0]),
        image_count: imageCount,
      },
      message: replaceImages
        ? 'Wholesale product folder reuploaded and images replaced.'
        : nextStatus === 'topteam_pending' ? 'Wholesale product sent to Top Team pricing before seller visibility.' : `Wholesale product marked ${nextStatus}.`,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error);
  } finally {
    client.release();
  }
};

const uploadAdminWholesaleProductImages = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWholesaleTables(client);

    const images = req.files?.product_images || [];
    const replaceImages = truthyBodyValue(req.body.replace_images);
    if (!images.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Select at least one JPG or PNG image to upload.' });
    }
    if (replaceImages && images.length !== MIN_WHOLESALE_PRODUCT_IMAGES) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Re-upload the wholesale product folder with exactly 3 JPG or PNG images.' });
    }

    const currentResult = await client.query(
      'SELECT * FROM wholesale_products WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wholesale product not found' });
    }
    await persistUploadedFiles(images, client);

    let firstImage = replaceImages ? null : current.image_url;
    if (replaceImages) {
      await clearWholesaleProductMedia(client, current.id);
    }

    for (const image of images) {
      const filePath = publicUploadPath(image);
      if (!firstImage) firstImage = filePath;
      await client.query(
        'INSERT INTO wholesale_product_media (wholesale_product_id, file_path) VALUES ($1, $2)',
        [current.id, filePath]
      );
    }

    const result = await client.query(
      `UPDATE wholesale_products
       SET image_url = COALESCE($1, image_url),
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [firstImage || null, current.id]
    );
    const imageCount = await countWholesaleProductImages(client, current.id);

    await client.query('COMMIT');
    res.json({
      product: {
        ...normalizeWholesaleProduct(result.rows[0]),
        image_count: imageCount,
      },
      message: replaceImages
        ? `Reuploaded wholesale product folder. Product now has ${imageCount} images.`
        : `Uploaded ${images.length} wholesale product image${images.length === 1 ? '' : 's'}. Product now has ${imageCount} image${imageCount === 1 ? '' : 's'}.`,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error);
  } finally {
    client.release();
  }
};

const resetAdminWholesaleProductFolderData = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWholesaleTables(client);

    const productKey = textValue(req.params.id);
    const currentResult = await client.query(
      `SELECT id, name, product_uid
       FROM wholesale_products
       WHERE id::text = $1 OR product_uid = $1
       FOR UPDATE`,
      [productKey]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wholesale product not found' });
    }

    const resetResult = await resetWholesaleProductFolderData(client, current.id);
    await client.query('COMMIT');

    return res.json({
      product: {
        ...normalizeWholesaleProduct(resetResult.product),
        image_count: 0,
      },
      message: `Old folder data removed for ${current.name}. Upload the wholesale folder again.`,
      removed_uploads: resetResult.removedUploadCount,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    return next(error);
  } finally {
    client.release();
  }
};

const resetAllAdminWholesaleProductFolderData = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWholesaleTables(client);

    const productsResult = await client.query(
      `SELECT id
       FROM wholesale_products wp
       WHERE wp.admin_reviewed_at IS NOT NULL
          OR wp.admin_reviewed_by IS NOT NULL
          OR COALESCE(wp.admin_description_note, '') <> ''
          OR COALESCE(wp.admin_price_note, '') <> ''
       ORDER BY wp.id
       FOR UPDATE`
    );

    let removedUploadCount = 0;
    for (const product of productsResult.rows) {
      const resetResult = await resetWholesaleProductFolderData(client, product.id);
      removedUploadCount += resetResult.removedUploadCount;
    }

    await client.query('COMMIT');
    const resetCount = productsResult.rows.length;
    return res.json({
      reset_count: resetCount,
      removed_uploads: removedUploadCount,
      message: resetCount
        ? `Old folder data removed for ${resetCount} wholesale product${resetCount === 1 ? '' : 's'}. Upload the folders again from admin.`
        : 'No wholesale products had admin folder data to reset.',
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    return next(error);
  } finally {
    client.release();
  }
};

const deleteAdminWholesaleProduct = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWholesaleTables(client);

    const productKey = textValue(req.params.id);
    const confirmationName = textValue(req.body?.confirmation_name || req.body?.name);
    let currentResult = await client.query(
      `SELECT id, product_uid, name
       FROM wholesale_products
       WHERE id::text = $1 OR product_uid = $1
       FOR UPDATE`,
      [productKey]
    );
    if (!currentResult.rows.length && confirmationName) {
      currentResult = await client.query(
        `SELECT id, product_uid, name
         FROM wholesale_products
         WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
         FOR UPDATE`,
        [confirmationName]
      );
      if (currentResult.rows.length > 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'More than one wholesale product has this name. Refresh the admin panel and delete using the product ID.',
        });
      }
    }
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wholesale product not found' });
    }
    if (confirmationName.toLowerCase() !== textValue(current.name).toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Type the exact product name to delete this wholesale product.' });
    }

    const linkedOrders = await client.query(
      'SELECT COUNT(*) FROM wholesale_orders WHERE wholesale_product_id = $1',
      [current.id]
    );
    if (Number(linkedOrders.rows[0].count || 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This product has wholesale orders linked to it. Pause liveness instead of deleting it.',
      });
    }

    await client.query('DELETE FROM wholesale_product_media WHERE wholesale_product_id = $1', [current.id]);
    await client.query('DELETE FROM wholesale_products WHERE id = $1', [current.id]);

    await client.query('COMMIT');
    res.json({ message: `${current.name} deleted from wholesale products.` });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error);
  } finally {
    client.release();
  }
};

const getAdminWholesalers = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const result = await pool.query(
      `SELECT
        w.*,
        COUNT(DISTINCT wp.id) AS product_count,
        COUNT(DISTINCT wo.id) AS order_count,
        COALESCE(SUM(wpayout.amount) FILTER (WHERE wpayout.status = 'paid'), 0) AS paid_amount
       FROM wholesalers w
       LEFT JOIN wholesale_products wp ON wp.wholesaler_id = w.id
       LEFT JOIN wholesale_orders wo ON wo.wholesaler_id = w.id
       LEFT JOIN wholesale_payouts wpayout ON wpayout.wholesaler_id = w.id
       GROUP BY w.id
       ORDER BY w.created_at DESC`
    );
    res.json(result.rows.map(row => ({
      ...normalizeWholesaler(row),
      product_count: numberValue(row.product_count),
      order_count: numberValue(row.order_count),
      paid_amount: numberValue(row.paid_amount),
    })));
  } catch (error) {
    next(error);
  }
};

const updateAdminWholesalerStatus = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const status = textValue(req.body.status);
    const reason = textValue(req.body.reason);
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid wholesaler status' });
    }
    if (status === 'rejected') {
      const result = await pool.query(
        `DELETE FROM wholesalers
         WHERE id = $1
         RETURNING id, cnic_number, name, email, shop_name`,
        [req.params.id]
      );

      if (!result.rows.length) return res.status(404).json({ error: 'Wholesaler not found' });

      return res.json({
        wholesaler: {
          ...publicWholesaler({ ...result.rows[0], status: 'rejected' }),
          deleted: true,
        },
        message: 'Wholesaler application rejected and removed. Wholesaler can register again with fresh details.',
      });
    }

    const result = await pool.query(
      `UPDATE wholesalers
       SET status = $1,
           approved_at = CASE WHEN $1 = 'approved' THEN NOW() ELSE approved_at END,
           rejected_reason = CASE WHEN $1 = 'rejected' THEN $2 ELSE NULL END
       WHERE id = $3
       RETURNING *`,
      [status, reason || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Wholesaler not found' });
    res.json({ wholesaler: publicWholesaler(result.rows[0]) });
  } catch (error) {
    next(error);
  }
};

const reportWholesalerToTopTeam = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const reason = textValue(req.body.reason);

    if (!reason) {
      return res.status(400).json({ error: 'Report reason is required' });
    }

    const result = await pool.query(
      `UPDATE wholesalers
       SET topteam_report_status = 'pending',
           topteam_report_reason = $1,
           topteam_reported_at = NOW(),
           topteam_reported_by = COALESCE($2, 'admin'),
           topteam_reviewed_at = NULL
       WHERE id = $3
         AND status = 'approved'
       RETURNING *`,
      [reason, req.user?.email || req.user?.role || 'admin', req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Approved wholesaler not found' });
    }

    res.json({
      wholesaler: publicWholesaler(result.rows[0]),
      message: 'Wholesaler problem reported to Top Team.',
    });
  } catch (error) {
    next(error);
  }
};

const getAdminWholesaleOrders = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const result = await pool.query(
      `${wholesaleOrderSelect}
       ORDER BY wo.requested_at DESC`
    );
    res.json(result.rows.map(normalizeWholesaleOrder));
  } catch (error) {
    next(error);
  }
};

const reviewWholesaleOrderByAdmin = async (req, res, next) => {
  try {
    await ensureWholesaleTables(pool);
    const body = req.body || {};
    const status = textValue(body.status);
    const note = textValue(body.note);
    if (!['approved_by_admin', 'rejected', 'accepted'].includes(status)) {
      return res.status(400).json({ error: 'Admin can approve, reject, or accept wholesale orders only' });
    }

    if (status === 'accepted') {
      return acceptWholesaleOrderForActor(req, res, next, { admin: true });
    }

    const result = await pool.query(
      `UPDATE wholesale_orders
       SET status = $1,
           admin_note = $2,
           admin_reviewed_at = NOW(),
           rejected_at = CASE WHEN $1 = 'rejected' THEN NOW() ELSE rejected_at END
       WHERE (id::text = $3 OR order_code = $3)
         AND status = 'admin_review'
       RETURNING *`,
      [status, note || null, req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Wholesale order pending admin review was not found' });
    }

    const refreshed = await pool.query(`${wholesaleOrderSelect} WHERE wo.id = $1`, [result.rows[0].id]);
    res.json({ order: normalizeWholesaleOrder(refreshed.rows[0]) });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  registerWholesaler,
  verifyWholesalerRegistration,
  loginWholesaler,
  getWholesalerProfile,
  createWholesalerProduct,
  getMyWholesaleProducts,
  updateMyWholesaleProduct,
  getWholesalerOrders,
  acceptWholesaleOrder,
  acceptWholesaleOrderByAdmin,
  rejectWholesaleOrderByWholesaler,
  getWholesalerPayouts,
  getWholesaleCatalogForSeller,
  createWholesaleOrderForSeller,
  getSellerWholesaleOrders,
  getAdminWholesaleProducts,
  reviewAdminWholesaleProduct,
  uploadAdminWholesaleProductImages,
  resetAdminWholesaleProductFolderData,
  resetAllAdminWholesaleProductFolderData,
  deleteAdminWholesaleProduct,
  getAdminWholesalers,
  updateAdminWholesalerStatus,
  reportWholesalerToTopTeam,
  getAdminWholesaleOrders,
  reviewWholesaleOrderByAdmin,
};

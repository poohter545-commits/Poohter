const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
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

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here';

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
  status: row.status,
  rejected_reason: row.rejected_reason,
  approved_at: row.approved_at,
  created_at: row.created_at,
});

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

    const duplicate = await pool.query(
      'SELECT id FROM wholesalers WHERE email = $1 OR cnic_number = $2 LIMIT 1',
      [textValue(email), textValue(cnic_number)]
    );
    if (duplicate.rows.length) {
      return res.status(400).json({ error: 'A wholesaler with this email or CNIC already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO wholesalers (
        name, email, password, phone, shop_name, business_type, warehouse_address, city,
        cnic_number, cnic_front, cnic_back, bank_name, account_title, account_number,
        mobile_wallet, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')
       RETURNING *`,
      [
        textValue(name),
        textValue(email),
        hashedPassword,
        textValue(phone),
        textValue(shop_name),
        textValue(business_type),
        textValue(warehouse_address) || textValue(city),
        textValue(city),
        textValue(cnic_number),
        req.files?.cnic_front?.[0]?.path || null,
        req.files?.cnic_back?.[0]?.path || null,
        textValue(bank_name),
        textValue(account_title),
        textValue(account_number),
        textValue(mobile_wallet),
      ]
    );

    const wholesaler = publicWholesaler(result.rows[0]);
    res.status(201).json({
      message: 'Wholesaler registration submitted. Admin approval is required before dashboard access.',
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
    res.json({ wholesaler: publicWholesaler(result.rows[0]) });
  } catch (error) {
    next(error);
  }
};

const requireApprovedWholesaler = async (wholesalerId) => {
  const result = await pool.query('SELECT id, status FROM wholesalers WHERE id = $1', [wholesalerId]);
  if (!result.rows.length) throw Object.assign(new Error('Wholesaler profile not found'), { status: 404 });
  if (result.rows[0].status !== 'approved') {
    throw Object.assign(new Error('Admin approval is required before using wholesaler operations'), { status: 403 });
  }
};

const createWholesalerProduct = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWholesaleTables(client);
    await requireApprovedWholesaler(req.user.id);

    const name = textValue(req.body.name);
    const wholesalePrice = Number(req.body.wholesale_price);
    const minOrder = Math.max(25, Number.parseInt(req.body.min_order_quantity || '25', 10) || 25);
    const stock = Number.parseInt(req.body.available_stock || '0', 10) || 0;
    const images = req.files?.product_images || [];

    if (!name || !Number.isFinite(wholesalePrice) || wholesalePrice <= 0 || stock < minOrder) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Product name, positive wholesale price, and stock of at least 25 units are required' });
    }
    if (images.length < 5) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Minimum 5 photos of wholesale product are required' });
    }

    const result = await client.query(
      `INSERT INTO wholesale_products (
        wholesaler_id, name, name_urdu, description, wholesale_price,
        min_order_quantity, available_stock, image_url, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
       RETURNING *`,
      [
        req.user.id,
        name,
        textValue(req.body.name_urdu) || null,
        textValue(req.body.description) || null,
        wholesalePrice,
        minOrder,
        stock,
        images[0]?.path || null,
      ]
    );

    const product = result.rows[0];
    const productUid = `WHP-${String(product.id).padStart(6, '0')}`;
    for (const image of images) {
      await client.query(
        'INSERT INTO wholesale_product_media (wholesale_product_id, file_path) VALUES ($1, $2)',
        [product.id, image.path]
      );
    }
    const update = await client.query(
      'UPDATE wholesale_products SET product_uid = $1 WHERE id = $2 RETURNING *',
      [productUid, product.id]
    );
    await client.query('COMMIT');

    res.status(201).json({ product: normalizeWholesaleProduct(update.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error.status ? error : error);
  } finally {
    client.release();
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
  try {
    await ensureWholesaleTables(pool);
    await requireApprovedWholesaler(req.user.id);

    const wholesalePrice = Number(req.body.wholesale_price);
    const minOrder = Math.max(25, Number.parseInt(req.body.min_order_quantity || '25', 10) || 25);
    const stock = Number.parseInt(req.body.available_stock || '0', 10) || 0;
    const status = ['active', 'paused'].includes(req.body.status) ? req.body.status : 'active';

    if (!Number.isFinite(wholesalePrice) || wholesalePrice <= 0 || stock < 0) {
      return res.status(400).json({ error: 'Wholesale price and stock must be valid numbers' });
    }

    const result = await pool.query(
      `UPDATE wholesale_products
       SET wholesale_price = $1,
           min_order_quantity = $2,
           available_stock = $3,
           status = $4,
           updated_at = NOW()
       WHERE id = $5 AND wholesaler_id = $6
       RETURNING *`,
      [wholesalePrice, minOrder, stock, status, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Wholesale product not found' });
    res.json({ product: normalizeWholesaleProduct(result.rows[0]) });
  } catch (error) {
    next(error.status ? error : error);
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

const acceptWholesaleOrder = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWholesaleTables(client);

    const orderResult = await client.query(
      `${wholesaleOrderSelect}
       WHERE wo.id = $1 AND wo.wholesaler_id = $2
       FOR UPDATE OF wo`,
      [req.params.id, req.user.id]
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
    if (!['approved_by_admin', 'accepted'].includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Admin must approve this wholesale order before acceptance' });
    }

    if (!order.linked_product_id && numberValue(order.available_stock) < numberValue(order.quantity)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Available wholesale stock is lower than requested quantity' });
    }

    let linkedProductId = order.linked_product_id;
    if (!linkedProductId) {
      linkedProductId = await createSellerProductFromWholesaleOrder(client, normalizeWholesaleOrder(order));
      await client.query(
        `UPDATE wholesale_products
         SET available_stock = GREATEST(available_stock - $1, 0),
             updated_at = NOW()
         WHERE id = $2`,
        [order.quantity, order.wholesale_product_id]
      );
    }

    await client.query(
      `UPDATE wholesale_orders
       SET status = 'accepted',
           linked_product_id = $1,
           accepted_at = COALESCE(accepted_at, NOW()),
           wholesaler_note = COALESCE($2, wholesaler_note)
       WHERE id = $3`,
      [linkedProductId, textValue(req.body.note) || null, order.id]
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
      [textValue(req.body.note) || 'Wholesaler rejected this request', req.params.id, req.user.id]
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
    const result = await pool.query(
      `SELECT
        wp.*,
        COALESCE(w.shop_name, w.name) AS wholesaler_shop,
        w.city AS wholesaler_city,
        w.phone AS wholesaler_phone
       FROM wholesale_products wp
       JOIN wholesalers w ON wp.wholesaler_id = w.id
       WHERE wp.status = 'active'
         AND w.status = 'approved'
         AND wp.available_stock >= wp.min_order_quantity
       ORDER BY wp.created_at DESC`
    );
    res.json(result.rows.map(normalizeWholesaleProduct));
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
    const productResult = await client.query(
      `SELECT wp.*, w.status AS wholesaler_status
       FROM wholesale_products wp
       JOIN wholesalers w ON wp.wholesaler_id = w.id
       WHERE wp.id = $1
         AND wp.status = 'active'
       LIMIT 1`,
      [productId]
    );
    const product = productResult.rows[0];
    if (!product || product.wholesaler_status !== 'approved') {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active wholesale product not found' });
    }

    const minOrder = Math.max(25, Number(product.min_order_quantity || 25));
    if (quantity < minOrder) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Minimum wholesale order is ${minOrder} units` });
    }
    if (quantity > Number(product.available_stock || 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Requested quantity is higher than available wholesale stock' });
    }

    const totalPrice = Number(product.wholesale_price) * quantity;
    const orderCode = createCode('WSO');
    const orderResult = await client.query(
      `INSERT INTO wholesale_orders (
        order_code, seller_id, wholesaler_id, wholesale_product_id,
        quantity, wholesale_unit_price, total_price, seller_note
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [orderCode, req.user.id, product.wholesaler_id, product.id, quantity, product.wholesale_price, totalPrice, sellerNote || null]
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
    const status = textValue(req.body.status);
    const note = textValue(req.body.note);
    if (!['approved_by_admin', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Admin can approve or reject wholesale orders only' });
    }

    const result = await pool.query(
      `UPDATE wholesale_orders
       SET status = $1,
           admin_note = $2,
           admin_reviewed_at = NOW(),
           rejected_at = CASE WHEN $1 = 'rejected' THEN NOW() ELSE rejected_at END
       WHERE id = $3
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
  loginWholesaler,
  getWholesalerProfile,
  createWholesalerProduct,
  getMyWholesaleProducts,
  updateMyWholesaleProduct,
  getWholesalerOrders,
  acceptWholesaleOrder,
  rejectWholesaleOrderByWholesaler,
  getWholesalerPayouts,
  getWholesaleCatalogForSeller,
  createWholesaleOrderForSeller,
  getSellerWholesaleOrders,
  getAdminWholesalers,
  updateAdminWholesalerStatus,
  getAdminWholesaleOrders,
  reviewWholesaleOrderByAdmin,
};

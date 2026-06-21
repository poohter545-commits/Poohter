const bcrypt = require('bcrypt');
const pool = require('../config/db');
const { ensurePhysicalShopTables } = require('../utils/physicalShop');

const SHOP_PAYMENT_METHODS = new Set(['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer']);
const STOCK_MOVEMENTS = new Set(['transfer_in', 'transfer_out', 'adjustment', 'damage']);

const numberValue = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const intValue = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const textValue = (value) => String(value || '').trim();

const normalizeMoney = (value) => Number(numberValue(value).toFixed(2));

const codeDate = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

const createBatchCode = async (client) => {
  const prefix = `PST-${codeDate()}`;
  const result = await client.query(
    `SELECT batch_code
     FROM shop_transfer_batches
     WHERE batch_code LIKE $1
     ORDER BY batch_code DESC
     LIMIT 1`,
    [`${prefix}-%`]
  );
  const lastNumber = result.rows[0]?.batch_code?.split('-').pop();
  return `${prefix}-${String((Number(lastNumber) || 0) + 1).padStart(4, '0')}`;
};

const createPhysicalUnitCode = (batchCode, sequence) => (
  `${batchCode}-U${String(sequence).padStart(4, '0')}`
);

const getProductSearchColumns = async (clientOrPool) => {
  const result = await clientOrPool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'products'
       AND column_name = ANY($1::text[])`,
    [['sku', 'barcode', 'product_uid']]
  );
  return new Set(result.rows.map((row) => row.column_name));
};

const createReceiptCode = async (client) => {
  const prefix = `POS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const result = await client.query(
    `SELECT receipt_code
     FROM shop_sales
     WHERE receipt_code LIKE $1
     ORDER BY receipt_code DESC
     LIMIT 1`,
    [`${prefix}-%`]
  );
  const lastNumber = result.rows[0]?.receipt_code?.split('-').pop();
  const nextNumber = String((Number(lastNumber) || 0) + 1).padStart(4, '0');
  return `${prefix}-${nextNumber}`;
};

const fetchSaleByReceipt = async (clientOrPool, receiptCode) => {
  const result = await clientOrPool.query(
    `SELECT
       ss.*,
       ps.name AS shop_name,
       st.user_name AS cashier_name,
       COALESCE(json_agg(json_build_object(
         'id', ssi.id,
         'product_id', p.id,
         'product_uid', p.product_uid,
         'product_name', p.name,
         'quantity', ssi.quantity,
         'returned_quantity', ssi.returned_quantity,
         'unit_price', ssi.unit_price,
         'discount_amount', ssi.discount_amount,
         'total_price', ssi.total_price
       ) ORDER BY ssi.id) FILTER (WHERE ssi.id IS NOT NULL), '[]') AS items
     FROM shop_sales ss
     JOIN physical_shops ps ON ps.id = ss.shop_id
     LEFT JOIN shop_staff st ON st.id = ss.cashier_id
     LEFT JOIN shop_sale_items ssi ON ssi.sale_id = ss.id
     LEFT JOIN products p ON p.id = ssi.product_id
     WHERE LOWER(ss.receipt_code) = LOWER($1)
     GROUP BY ss.id, ps.id, st.id`,
    [receiptCode]
  );
  return result.rows[0] || null;
};

const listShops = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const result = await pool.query('SELECT * FROM physical_shops ORDER BY active DESC, name ASC');
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

const createShop = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const name = textValue(req.body.name);
    if (!name) return res.status(400).json({ error: 'Shop name is required' });
    const result = await pool.query(
      `INSERT INTO physical_shops (name, city, address, phone, active)
       VALUES ($1, $2, $3, $4, COALESCE($5, TRUE))
       RETURNING *`,
      [name, textValue(req.body.city) || null, textValue(req.body.address) || null, textValue(req.body.phone) || null, req.body.active]
    );
    res.status(201).json({ shop: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const updateShop = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const result = await pool.query(
      `UPDATE physical_shops
       SET name = COALESCE(NULLIF($1, ''), name),
           city = $2,
           address = $3,
           phone = $4,
           active = COALESCE($5, active)
       WHERE id = $6
       RETURNING *`,
      [textValue(req.body.name), textValue(req.body.city) || null, textValue(req.body.address) || null, textValue(req.body.phone) || null, req.body.active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json({ shop: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const listStaff = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const result = await pool.query(
      `SELECT st.id, st.shop_id, ps.name AS shop_name, st.user_name, st.role, st.active, st.created_at
       FROM shop_staff st
       JOIN physical_shops ps ON ps.id = st.shop_id
       WHERE ($1::int IS NULL OR st.shop_id = $1)
       ORDER BY st.active DESC, st.user_name ASC`,
      [req.query.shop_id ? Number(req.query.shop_id) : null]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

const createStaff = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const userName = textValue(req.body.user_name);
    const role = textValue(req.body.role) || 'cashier';
    if (!userName) return res.status(400).json({ error: 'Staff user name is required' });
    if (!['cashier', 'manager', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid staff role' });
    const pin = textValue(req.body.pin_code);
    const password = textValue(req.body.password);
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const result = await pool.query(
      `INSERT INTO shop_staff (shop_id, user_name, role, pin_code, password_hash, active)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE))
       RETURNING id, shop_id, user_name, role, active, created_at`,
      [req.body.shop_id, userName, role, pin || null, passwordHash, req.body.active]
    );
    res.status(201).json({ staff: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const updateStaff = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const role = textValue(req.body.role);
    if (role && !['cashier', 'manager', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid staff role' });
    const password = textValue(req.body.password);
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const result = await pool.query(
      `UPDATE shop_staff
       SET user_name = COALESCE(NULLIF($1, ''), user_name),
           role = COALESCE(NULLIF($2, ''), role),
           pin_code = COALESCE(NULLIF($3, ''), pin_code),
           password_hash = COALESCE($4, password_hash),
           active = COALESCE($5, active)
       WHERE id = $6
       RETURNING id, shop_id, user_name, role, active, created_at`,
      [textValue(req.body.user_name), role, textValue(req.body.pin_code), passwordHash, req.body.active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Staff not found' });
    res.json({ staff: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const searchProducts = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const query = textValue(req.query.q);
    const shopId = req.query.shop_id ? Number(req.query.shop_id) : null;
    const warehouseOnly = req.query.warehouse_only === 'true';
    const columns = await getProductSearchColumns(pool);
    const extraChecks = [];
    if (columns.has('product_uid')) extraChecks.push('LOWER(COALESCE(p.product_uid, \'\')) LIKE LOWER($1)');
    if (columns.has('sku')) extraChecks.push('LOWER(COALESCE(p.sku, \'\')) LIKE LOWER($1)');
    if (columns.has('barcode')) extraChecks.push('LOWER(COALESCE(p.barcode, \'\')) LIKE LOWER($1)');
    const searchable = [
      'p.id::text = $2',
      'LOWER(p.name) LIKE LOWER($1)',
      ...extraChecks,
    ].join(' OR ');
    const result = await pool.query(
      `SELECT
         p.id, p.name, p.product_uid, p.price, p.admin_price, p.image_url, p.status,
         COALESCE(si.quantity_available, 0) AS shop_stock,
         COALESCE(si.reorder_level, 0) AS reorder_level,
         COALESCE(i.stock_quantity, 0) AS warehouse_stock
       FROM products p
       LEFT JOIN shop_inventory si ON si.product_id = p.id AND ($3::int IS NULL OR si.shop_id = $3)
       LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
       WHERE ($4::boolean OR COALESCE(p.status, 'pending') = 'live')
         AND ($5::boolean = FALSE OR COALESCE(i.stock_quantity, 0) > 0)
         AND (${searchable})
       ORDER BY COALESCE(i.stock_quantity, 0) DESC, p.name ASC
       LIMIT 30`,
      [`%${query}%`, query, shopId, req.query.include_all === 'true', warehouseOnly]
    );
    res.json(result.rows.map((row) => ({
      ...row,
      price: Number(row.admin_price || row.price || 0),
      shop_stock: Number(row.shop_stock || 0),
      reorder_level: Number(row.reorder_level || 0),
      warehouse_stock: Number(row.warehouse_stock || 0),
    })));
  } catch (error) {
    next(error);
  }
};

const getShopInventory = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const result = await pool.query(
      `SELECT
         si.*,
         p.name AS product_name,
         p.product_uid,
         p.price,
         p.admin_price,
         p.image_url,
         ps.name AS shop_name,
         COALESCE(i.stock_quantity, 0) AS warehouse_stock
       FROM shop_inventory si
       JOIN products p ON p.id = si.product_id
       JOIN physical_shops ps ON ps.id = si.shop_id
       LEFT JOIN inventory i ON i.product_id = si.product_id AND i.warehouse_id = 1
       WHERE ($1::int IS NULL OR si.shop_id = $1)
       ORDER BY ps.name ASC, p.name ASC`,
      [req.query.shop_id ? Number(req.query.shop_id) : null]
    );
    res.json(result.rows.map((row) => ({
      ...row,
      quantity_available: Number(row.quantity_available || 0),
      reorder_level: Number(row.reorder_level || 0),
      warehouse_stock: Number(row.warehouse_stock || 0),
      low_stock: Number(row.quantity_available || 0) <= Number(row.reorder_level || 0),
    })));
  } catch (error) {
    next(error);
  }
};

const getTransferBatch = async (clientOrPool, batchIdOrCode) => {
  const result = await clientOrPool.query(
    `SELECT
       stb.*,
       ps.name AS shop_name,
       ps.city AS shop_city,
       p.name AS product_name,
       p.product_uid,
       p.price,
       p.admin_price,
       COALESCE(json_agg(json_build_object(
         'id', spu.id,
         'physical_uid', spu.physical_uid,
         'tracking_id', spu.tracking_id,
         'barcode_value', spu.barcode_value,
         'status', spu.status,
         'stock_added', spu.stock_added,
         'received_at', spu.received_at
       ) ORDER BY spu.id) FILTER (WHERE spu.id IS NOT NULL), '[]') AS units
     FROM shop_transfer_batches stb
     JOIN physical_shops ps ON ps.id = stb.shop_id
     JOIN products p ON p.id = stb.product_id
     LEFT JOIN shop_physical_units spu ON spu.batch_id = stb.id
     WHERE stb.id::text = $1 OR LOWER(stb.batch_code) = LOWER($1)
     GROUP BY stb.id, ps.id, p.id`,
    [String(batchIdOrCode || '').trim()]
  );
  return result.rows[0] || null;
};

const listTransfers = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const result = await pool.query(
      `SELECT
         stb.*,
         ps.name AS shop_name,
         p.name AS product_name,
         p.product_uid
       FROM shop_transfer_batches stb
       JOIN physical_shops ps ON ps.id = stb.shop_id
       JOIN products p ON p.id = stb.product_id
       WHERE ($1::int IS NULL OR stb.shop_id = $1)
       ORDER BY stb.created_at DESC
       LIMIT 100`,
      [req.query.shop_id ? Number(req.query.shop_id) : null]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

const createWarehouseTransfer = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const shopId = Number(req.body.shop_id);
    const productId = Number(req.body.product_id);
    const quantity = intValue(req.body.quantity);
    const reorderLevel = Math.max(0, intValue(req.body.reorder_level));
    const note = textValue(req.body.note);

    if (!Number.isInteger(shopId) || !Number.isInteger(productId) || quantity <= 0) {
      return res.status(400).json({ error: 'Shop, product, and positive quantity are required' });
    }

    await client.query('BEGIN');
    await ensurePhysicalShopTables(client);

    const productResult = await client.query(
      'SELECT id, name, product_uid FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );
    if (!productResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }

    const shopResult = await client.query('SELECT id FROM physical_shops WHERE id = $1 AND active = TRUE', [shopId]);
    if (!shopResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active physical shop not found' });
    }

    const warehouse = await client.query(
      'SELECT stock_quantity FROM inventory WHERE product_id = $1 AND warehouse_id = 1 FOR UPDATE',
      [productId]
    );
    const available = Number(warehouse.rows[0]?.stock_quantity || 0);
    if (available < quantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Warehouse has only ${available} units available` });
    }

    await client.query(
      'UPDATE inventory SET stock_quantity = stock_quantity - $1, updated_at = NOW() WHERE product_id = $2 AND warehouse_id = 1',
      [quantity, productId]
    );

    const batchCode = await createBatchCode(client);
    const batch = await client.query(
      `INSERT INTO shop_transfer_batches (batch_code, shop_id, product_id, quantity, reorder_level, created_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [batchCode, shopId, productId, quantity, reorderLevel, String(req.user?.email || req.user?.id || 'admin'), note || null]
    );

    const batchId = batch.rows[0].id;
    for (let index = 1; index <= quantity; index += 1) {
      const physicalUid = createPhysicalUnitCode(batchCode, index);
      const trackingId = `PHTR-${codeDate()}-${String(batchId).padStart(5, '0')}-${String(index).padStart(4, '0')}`;
      await client.query(
        `INSERT INTO shop_physical_units (
          batch_id, shop_id, product_id, physical_uid, tracking_id, barcode_value
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [batchId, shopId, productId, physicalUid, trackingId, trackingId]
      );
    }

    await client.query('COMMIT');
    const transfer = await getTransferBatch(pool, batchCode);
    res.status(201).json({ transfer });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error);
  } finally {
    client.release();
  }
};

const getTransfer = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const transfer = await getTransferBatch(pool, req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer batch not found' });
    res.json({ transfer });
  } catch (error) {
    next(error);
  }
};

const receiveTransferScan = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const code = textValue(req.body.barcode_value || req.body.barcode || req.body.tracking_id || req.body.physical_uid);
    const shopId = req.body.shop_id ? Number(req.body.shop_id) : null;
    if (!code) return res.status(400).json({ error: 'Barcode, tracking ID, or physical ID is required' });

    await client.query('BEGIN');
    await ensurePhysicalShopTables(client);

    const unitResult = await client.query(
      `SELECT
         spu.*,
         stb.batch_code,
         stb.status AS batch_status,
         stb.reorder_level,
         p.name AS product_name,
         ps.name AS shop_name
       FROM shop_physical_units spu
       JOIN shop_transfer_batches stb ON stb.id = spu.batch_id
       JOIN products p ON p.id = spu.product_id
       JOIN physical_shops ps ON ps.id = spu.shop_id
       WHERE LOWER(spu.barcode_value) = LOWER($1)
          OR LOWER(spu.tracking_id) = LOWER($1)
          OR LOWER(spu.physical_uid) = LOWER($1)
       FOR UPDATE OF spu, stb`,
      [code]
    );
    const unit = unitResult.rows[0];
    if (!unit) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No physical shop transfer unit found for this scan' });
    }
    if (shopId && Number(unit.shop_id) !== shopId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `This barcode belongs to ${unit.shop_name}, not the selected shop` });
    }
    if (['sold', 'damaged', 'lost'].includes(unit.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `This unit is already marked ${unit.status}` });
    }

    if (unit.status !== 'in_shop') {
      if (!unit.stock_added) {
        await client.query(
          `INSERT INTO shop_inventory (shop_id, product_id, quantity_available, reorder_level)
           VALUES ($1, $2, 1, $3)
           ON CONFLICT (shop_id, product_id)
           DO UPDATE SET quantity_available = shop_inventory.quantity_available + 1,
                         reorder_level = GREATEST(shop_inventory.reorder_level, EXCLUDED.reorder_level),
                         updated_at = NOW()`,
          [unit.shop_id, unit.product_id, Math.max(0, Number(unit.reorder_level || 0))]
        );
        await client.query(
          `INSERT INTO shop_stock_movements (shop_id, product_id, movement_type, quantity_change, reference_type, reference_id, note)
           VALUES ($1, $2, 'transfer_in', 1, 'shop_physical_unit', $3, $4)`,
          [unit.shop_id, unit.product_id, unit.id, unit.batch_code]
        );
      }
      await client.query(
        `UPDATE shop_physical_units
         SET status = 'in_shop',
             stock_added = TRUE,
             received_at = COALESCE(received_at, NOW())
         WHERE id = $1`,
        [unit.id]
      );
    }

    const counts = await client.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status IN ('in_shop', 'sold', 'returned', 'damaged', 'lost'))::int AS received
       FROM shop_physical_units
       WHERE batch_id = $1`,
      [unit.batch_id]
    );
    const total = Number(counts.rows[0]?.total || 0);
    const received = Number(counts.rows[0]?.received || 0);
    if (total > 0 && received >= total) {
      await client.query(
        `UPDATE shop_transfer_batches
         SET status = 'received',
             received_at = COALESCE(received_at, NOW())
         WHERE id = $1`,
        [unit.batch_id]
      );
    }

    await client.query('COMMIT');
    const transfer = await getTransferBatch(pool, unit.batch_code);
    res.json({
      message: `${unit.product_name} received by ${unit.shop_name}`,
      unit: {
        id: unit.id,
        physical_uid: unit.physical_uid,
        tracking_id: unit.tracking_id,
        barcode_value: unit.barcode_value,
        status: 'in_shop',
      },
      received_count: received,
      total_count: total,
      transfer,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error);
  } finally {
    client.release();
  }
};

const adjustStock = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const movementType = textValue(req.body.movement_type);
    const productId = Number(req.body.product_id);
    const shopId = Number(req.body.shop_id);
    const quantity = intValue(req.body.quantity);
    const reorderLevel = Math.max(0, intValue(req.body.reorder_level));
    const note = textValue(req.body.note);
    if (!STOCK_MOVEMENTS.has(movementType)) return res.status(400).json({ error: 'Invalid stock movement type' });
    if (!Number.isInteger(productId) || !Number.isInteger(shopId) || quantity <= 0) return res.status(400).json({ error: 'Shop, product, and positive quantity are required' });

    await client.query('BEGIN');
    await ensurePhysicalShopTables(client);

    const signedQuantity = ['transfer_in', 'adjustment'].includes(movementType) ? quantity : -quantity;
    if (movementType === 'transfer_in') {
      const warehouse = await client.query(
        'SELECT stock_quantity FROM inventory WHERE product_id = $1 AND warehouse_id = 1 FOR UPDATE',
        [productId]
      );
      const available = Number(warehouse.rows[0]?.stock_quantity || 0);
      if (available < quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Warehouse has only ${available} units available` });
      }
      await client.query(
        'UPDATE inventory SET stock_quantity = stock_quantity - $1, updated_at = NOW() WHERE product_id = $2 AND warehouse_id = 1',
        [quantity, productId]
      );
    }

    const current = await client.query(
      `INSERT INTO shop_inventory (shop_id, product_id, quantity_available, reorder_level)
       VALUES ($1, $2, 0, $3)
       ON CONFLICT (shop_id, product_id)
       DO UPDATE SET reorder_level = COALESCE(NULLIF($3, 0), shop_inventory.reorder_level)
       RETURNING *`,
      [shopId, productId, reorderLevel]
    );
    const currentQty = Number(current.rows[0].quantity_available || 0);
    if (currentQty + signedQuantity < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Shop stock cannot go below zero' });
    }
    const inventory = await client.query(
      `UPDATE shop_inventory
       SET quantity_available = quantity_available + $1,
           reorder_level = CASE WHEN $4::int > 0 THEN $4 ELSE reorder_level END,
           updated_at = NOW()
       WHERE shop_id = $2 AND product_id = $3
       RETURNING *`,
      [signedQuantity, shopId, productId, reorderLevel]
    );
    await client.query(
      `INSERT INTO shop_stock_movements (shop_id, product_id, movement_type, quantity_change, reference_type, note)
       VALUES ($1, $2, $3, $4, 'manual', $5)`,
      [shopId, productId, movementType, signedQuantity, note || null]
    );
    await client.query('COMMIT');
    res.json({ inventory: inventory.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error);
  } finally {
    client.release();
  }
};

const completeSale = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const shopId = Number(req.body.shop_id);
    const cashierId = Number(req.body.cashier_id);
    const paymentMethod = textValue(req.body.payment_method) || 'cash';
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const discountAmount = Math.max(0, normalizeMoney(req.body.discount_amount));
    const taxAmount = Math.max(0, normalizeMoney(req.body.tax_amount));

    if (!Number.isInteger(shopId) || !Number.isInteger(cashierId)) return res.status(400).json({ error: 'Shop and cashier are required' });
    if (!SHOP_PAYMENT_METHODS.has(paymentMethod)) return res.status(400).json({ error: 'Invalid payment method' });
    if (!items.length) return res.status(400).json({ error: 'POS cart cannot be empty' });

    await client.query('BEGIN');
    await ensurePhysicalShopTables(client);
    const staff = await client.query(
      'SELECT id FROM shop_staff WHERE id = $1 AND shop_id = $2 AND active = TRUE',
      [cashierId, shopId]
    );
    if (!staff.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Active cashier does not belong to selected shop' });
    }

    const productIds = [...new Set(items.map((item) => Number(item.product_id)).filter(Number.isInteger))];
    const productResult = await client.query(
      `SELECT id, name, COALESCE(admin_price, price, 0) AS price
       FROM products
       WHERE id = ANY($1)
       FOR UPDATE`,
      [productIds]
    );
    const productMap = new Map(productResult.rows.map((product) => [Number(product.id), product]));
    const stockResult = await client.query(
      `SELECT product_id, quantity_available
       FROM shop_inventory
       WHERE shop_id = $1 AND product_id = ANY($2)
       FOR UPDATE`,
      [shopId, productIds]
    );
    const stockMap = new Map(stockResult.rows.map((row) => [Number(row.product_id), Number(row.quantity_available || 0)]));

    let subtotal = 0;
    const processedItems = [];
    for (const item of items) {
      const productId = Number(item.product_id);
      const quantity = intValue(item.quantity);
      const product = productMap.get(productId);
      if (!product || quantity <= 0) throw Object.assign(new Error('Invalid product or quantity in POS cart'), { status: 400 });
      const available = stockMap.get(productId) || 0;
      if (available < quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `${product.name} has only ${available} units in shop stock` });
      }
      const unitPrice = normalizeMoney(item.unit_price ?? product.price);
      const lineDiscount = Math.max(0, normalizeMoney(item.discount_amount));
      const totalPrice = Math.max(0, normalizeMoney((unitPrice * quantity) - lineDiscount));
      subtotal += totalPrice;
      processedItems.push({ productId, quantity, unitPrice, lineDiscount, totalPrice });
    }

    const totalAmount = Math.max(0, normalizeMoney(subtotal - discountAmount + taxAmount));
    const receiptCode = await createReceiptCode(client);
    const sale = await client.query(
      `INSERT INTO shop_sales (
        shop_id, cashier_id, receipt_code, subtotal, discount_amount, tax_amount,
        total_amount, payment_method, payment_status, external_order_ref
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', $9)
       RETURNING *`,
      [shopId, cashierId, receiptCode, subtotal, discountAmount, taxAmount, totalAmount, paymentMethod, textValue(req.body.external_order_ref) || null]
    );
    const saleId = sale.rows[0].id;

    for (const item of processedItems) {
      await client.query(
        `INSERT INTO shop_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, total_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [saleId, item.productId, item.quantity, item.unitPrice, item.lineDiscount, item.totalPrice]
      );
      await client.query(
        `UPDATE shop_inventory
         SET quantity_available = quantity_available - $1, updated_at = NOW()
         WHERE shop_id = $2 AND product_id = $3`,
        [item.quantity, shopId, item.productId]
      );
      await client.query(
        `INSERT INTO shop_stock_movements (shop_id, product_id, movement_type, quantity_change, reference_type, reference_id, note)
         VALUES ($1, $2, 'sale', $3, 'shop_sale', $4, $5)`,
        [shopId, item.productId, -item.quantity, saleId, receiptCode]
      );
    }

    await client.query('COMMIT');
    const receipt = await fetchSaleByReceipt(pool, receiptCode);
    res.status(201).json({ sale: receipt });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error.status ? error : error);
  } finally {
    client.release();
  }
};

const listSales = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const result = await pool.query(
      `SELECT ss.*, ps.name AS shop_name, st.user_name AS cashier_name
       FROM shop_sales ss
       JOIN physical_shops ps ON ps.id = ss.shop_id
       LEFT JOIN shop_staff st ON st.id = ss.cashier_id
       WHERE ($1::int IS NULL OR ss.shop_id = $1)
       ORDER BY ss.created_at DESC
       LIMIT 200`,
      [req.query.shop_id ? Number(req.query.shop_id) : null]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

const getReceipt = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const sale = await fetchSaleByReceipt(pool, textValue(req.params.receiptCode));
    if (!sale) return res.status(404).json({ error: 'Receipt not found' });
    res.json({ sale });
  } catch (error) {
    next(error);
  }
};

const processReturn = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const receiptCode = textValue(req.params.receiptCode || req.body.receipt_code);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const refundMethod = textValue(req.body.refund_method) || 'cash';
    const reason = textValue(req.body.reason);
    const reusable = req.body.reusable !== false;
    const processedBy = req.body.processed_by ? Number(req.body.processed_by) : null;
    if (!receiptCode || !items.length) return res.status(400).json({ error: 'Receipt and return items are required' });
    if (!SHOP_PAYMENT_METHODS.has(refundMethod)) return res.status(400).json({ error: 'Invalid refund method' });

    await client.query('BEGIN');
    await ensurePhysicalShopTables(client);
    const saleResult = await client.query('SELECT * FROM shop_sales WHERE LOWER(receipt_code) = LOWER($1) FOR UPDATE', [receiptCode]);
    const sale = saleResult.rows[0];
    if (!sale) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Receipt not found' });
    }

    const saleItems = await client.query(
      'SELECT * FROM shop_sale_items WHERE sale_id = $1 FOR UPDATE',
      [sale.id]
    );
    const itemMap = new Map(saleItems.rows.map((item) => [Number(item.product_id), item]));
    let refundAmount = 0;
    let returnedCount = 0;

    for (const item of items) {
      const productId = Number(item.product_id);
      const quantity = intValue(item.quantity);
      const saleItem = itemMap.get(productId);
      if (!saleItem || quantity <= 0) throw Object.assign(new Error('Invalid return item or quantity'), { status: 400 });
      const availableToReturn = Number(saleItem.quantity || 0) - Number(saleItem.returned_quantity || 0);
      if (quantity > availableToReturn) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Only ${availableToReturn} units can be returned for product ${productId}` });
      }
      const lineRefund = normalizeMoney((Number(saleItem.total_price || 0) / Number(saleItem.quantity || 1)) * quantity);
      refundAmount += lineRefund;
      returnedCount += quantity;
      await client.query(
        'UPDATE shop_sale_items SET returned_quantity = returned_quantity + $1 WHERE id = $2',
        [quantity, saleItem.id]
      );
      if (reusable) {
        await client.query(
          `UPDATE shop_inventory
           SET quantity_available = quantity_available + $1, updated_at = NOW()
           WHERE shop_id = $2 AND product_id = $3`,
          [quantity, sale.shop_id, productId]
        );
      }
      await client.query(
        `INSERT INTO shop_stock_movements (shop_id, product_id, movement_type, quantity_change, reference_type, reference_id, note)
         VALUES ($1, $2, 'return', $3, 'shop_return', $4, $5)`,
        [sale.shop_id, productId, reusable ? quantity : 0, sale.id, reason || receiptCode]
      );
    }

    const totalSoldQuantity = saleItems.rows.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const alreadyReturnedQuantity = saleItems.rows.reduce((sum, item) => sum + Number(item.returned_quantity || 0), 0);
    const totalReturnedQuantity = alreadyReturnedQuantity + returnedCount;
    const returnStatus = totalReturnedQuantity >= totalSoldQuantity ? 'returned' : 'partial_return';
    const paymentStatus = returnStatus === 'returned' ? 'refunded' : 'partial_refund';
    const normalizedRefund = normalizeMoney(refundAmount);

    await client.query(
      `UPDATE shop_sales
       SET return_status = $1,
           payment_status = $2,
           refund_amount = refund_amount + $3
       WHERE id = $4`,
      [returnStatus, paymentStatus, normalizedRefund, sale.id]
    );
    await client.query(
      `INSERT INTO shop_returns (sale_id, receipt_code, refund_method, refund_amount, reason, reusable, processed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sale.id, sale.receipt_code, refundMethod, normalizedRefund, reason || null, reusable, processedBy]
    );
    await client.query('COMMIT');
    const receipt = await fetchSaleByReceipt(pool, receiptCode);
    res.json({ sale: receipt });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error.status ? error : error);
  } finally {
    client.release();
  }
};

const openShift = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const existing = await pool.query(
      'SELECT id FROM shop_shifts WHERE shop_id = $1 AND cashier_id = $2 AND status = \'open\'',
      [req.body.shop_id, req.body.cashier_id]
    );
    if (existing.rows.length) return res.status(400).json({ error: 'Cashier already has an open shift for this shop' });
    const result = await pool.query(
      `INSERT INTO shop_shifts (shop_id, cashier_id, opening_cash, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING *`,
      [req.body.shop_id, req.body.cashier_id, normalizeMoney(req.body.opening_cash)]
    );
    res.status(201).json({ shift: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const closeShift = async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensurePhysicalShopTables(client);
    const shiftResult = await client.query('SELECT * FROM shop_shifts WHERE id = $1 AND status = \'open\' FOR UPDATE', [req.params.id]);
    const shift = shiftResult.rows[0];
    if (!shift) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Open shift not found' });
    }
    const totals = await client.query(
      `SELECT
         COALESCE(SUM(total_amount) FILTER (WHERE payment_method = 'cash' AND payment_status IN ('paid', 'partial_refund')), 0) AS cash_sales,
         COALESCE(SUM(refund_amount) FILTER (WHERE payment_method = 'cash'), 0) AS cash_refunds
       FROM shop_sales
       WHERE shop_id = $1
         AND cashier_id = $2
         AND created_at >= $3`,
      [shift.shop_id, shift.cashier_id, shift.opened_at]
    );
    const closingCash = normalizeMoney(req.body.closing_cash);
    const expectedCash = normalizeMoney(Number(shift.opening_cash || 0) + Number(totals.rows[0].cash_sales || 0) - Number(totals.rows[0].cash_refunds || 0));
    const difference = normalizeMoney(closingCash - expectedCash);
    const result = await client.query(
      `UPDATE shop_shifts
       SET closed_at = NOW(),
           closing_cash = $1,
           expected_cash = $2,
           difference = $3,
           status = 'closed'
       WHERE id = $4
       RETURNING *`,
      [closingCash, expectedCash, difference, shift.id]
    );
    await client.query('COMMIT');
    res.json({ shift: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error);
  } finally {
    client.release();
  }
};

const getShifts = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const result = await pool.query(
      `SELECT sh.*, ps.name AS shop_name, st.user_name AS cashier_name
       FROM shop_shifts sh
       JOIN physical_shops ps ON ps.id = sh.shop_id
       JOIN shop_staff st ON st.id = sh.cashier_id
       WHERE ($1::int IS NULL OR sh.shop_id = $1)
       ORDER BY sh.opened_at DESC
       LIMIT 120`,
      [req.query.shop_id ? Number(req.query.shop_id) : null]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

const getReports = async (req, res, next) => {
  try {
    await ensurePhysicalShopTables(pool);
    const shopId = req.query.shop_id ? Number(req.query.shop_id) : null;
    const since = req.query.since || new Date().toISOString().slice(0, 10);
    const [summary, payments, bestSellers, movements] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) AS sale_count,
           COALESCE(SUM(total_amount), 0) AS gross_sales,
           COALESCE(SUM(discount_amount), 0) AS discounts,
           COALESCE(SUM(tax_amount), 0) AS tax,
           COALESCE(SUM(refund_amount), 0) AS refunds
         FROM shop_sales
         WHERE ($1::int IS NULL OR shop_id = $1)
           AND created_at::date >= $2::date`,
        [shopId, since]
      ),
      pool.query(
        `SELECT payment_method, COUNT(*) AS sale_count, COALESCE(SUM(total_amount), 0) AS total
         FROM shop_sales
         WHERE ($1::int IS NULL OR shop_id = $1)
           AND created_at::date >= $2::date
         GROUP BY payment_method
         ORDER BY total DESC`,
        [shopId, since]
      ),
      pool.query(
        `SELECT p.id, p.name, p.product_uid, SUM(ssi.quantity) AS quantity_sold, SUM(ssi.total_price) AS sales_total
         FROM shop_sale_items ssi
         JOIN shop_sales ss ON ss.id = ssi.sale_id
         JOIN products p ON p.id = ssi.product_id
         WHERE ($1::int IS NULL OR ss.shop_id = $1)
           AND ss.created_at::date >= $2::date
         GROUP BY p.id
         ORDER BY quantity_sold DESC, sales_total DESC
         LIMIT 10`,
        [shopId, since]
      ),
      pool.query(
        `SELECT sm.*, ps.name AS shop_name, p.name AS product_name, p.product_uid
         FROM shop_stock_movements sm
         JOIN physical_shops ps ON ps.id = sm.shop_id
         JOIN products p ON p.id = sm.product_id
         WHERE ($1::int IS NULL OR sm.shop_id = $1)
           AND sm.created_at::date >= $2::date
         ORDER BY sm.created_at DESC
         LIMIT 80`,
        [shopId, since]
      ),
    ]);
    const row = summary.rows[0] || {};
    res.json({
      summary: {
        sale_count: Number(row.sale_count || 0),
        gross_sales: Number(row.gross_sales || 0),
        discounts: Number(row.discounts || 0),
        tax: Number(row.tax || 0),
        refunds: Number(row.refunds || 0),
        net_sales: Number(row.gross_sales || 0) - Number(row.refunds || 0),
      },
      payments: payments.rows.map((item) => ({ ...item, sale_count: Number(item.sale_count || 0), total: Number(item.total || 0) })),
      best_sellers: bestSellers.rows.map((item) => ({ ...item, quantity_sold: Number(item.quantity_sold || 0), sales_total: Number(item.sales_total || 0) })),
      movements: movements.rows,
    });
  } catch (error) {
    next(error);
  }
};

const receiveAll = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const transferId = Number(req.params.id);
    const shopId = req.body.shop_id ? Number(req.body.shop_id) : null;
    if (!Number.isInteger(transferId) || transferId <= 0) return res.status(400).json({ error: 'Transfer ID is required' });

    await client.query('BEGIN');
    await ensurePhysicalShopTables(client);

    const batchResult = await client.query(
      `SELECT stb.*, p.name AS product_name, ps.name AS shop_name
       FROM shop_transfer_batches stb
       JOIN products p ON p.id = stb.product_id
       JOIN physical_shops ps ON ps.id = stb.shop_id
       WHERE stb.id = $1
       FOR UPDATE OF stb`,
      [transferId]
    );
    const batch = batchResult.rows[0];
    if (!batch) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transfer batch not found' });
    }
    if (shopId && Number(batch.shop_id) !== shopId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `This batch belongs to ${batch.shop_name}, not the selected shop` });
    }
    if (batch.status === 'received') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This batch has already been received' });
    }

    const unitCheck = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE stock_added = TRUE)::int AS already_added
       FROM shop_physical_units WHERE batch_id = $1`,
      [batch.id]
    );
    const existingUnits = Number(unitCheck.rows[0]?.total || 0);
    const alreadyAdded = Number(unitCheck.rows[0]?.already_added || 0);
    const quantity = Number(batch.quantity || 0);

    const unitsToAdd = existingUnits === 0 ? quantity : Math.max(0, existingUnits - alreadyAdded);

    if (unitsToAdd > 0) {
      await client.query(
        `INSERT INTO shop_inventory (shop_id, product_id, quantity_available, reorder_level)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (shop_id, product_id)
         DO UPDATE SET quantity_available = shop_inventory.quantity_available + EXCLUDED.quantity_available,
                       reorder_level = GREATEST(shop_inventory.reorder_level, EXCLUDED.reorder_level),
                       updated_at = NOW()`,
        [batch.shop_id, batch.product_id, unitsToAdd, Math.max(0, Number(batch.reorder_level || 0))]
      );
      await client.query(
        `INSERT INTO shop_stock_movements (shop_id, product_id, movement_type, quantity_change, reference_type, reference_id, note)
         VALUES ($1, $2, 'transfer_in', $3, 'shop_transfer_batch', $4, $5)`,
        [batch.shop_id, batch.product_id, unitsToAdd, batch.id, `Batch receive: ${batch.batch_code || batch.id}`]
      );
    }

    if (existingUnits > 0) {
      await client.query(
        `UPDATE shop_physical_units
         SET status = 'in_shop', stock_added = TRUE, received_at = COALESCE(received_at, NOW())
         WHERE batch_id = $1 AND status = 'out_from_warehouse'`,
        [batch.id]
      );
    }

    await client.query(
      `UPDATE shop_transfer_batches
       SET status = 'received', received_at = COALESCE(received_at, NOW())
       WHERE id = $1`,
      [batch.id]
    );

    await client.query('COMMIT');
    let transfer = null;
    try { transfer = await getTransferBatch(pool, String(batch.id)); } catch (_) { /* best-effort */ }
    res.json({
      message: `${batch.product_name} — ${quantity} unit(s) received and added to inventory`,
      transfer,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    next(error);
  } finally {
    client.release();
  }
};

module.exports = {
  listShops,
  createShop,
  updateShop,
  listStaff,
  createStaff,
  updateStaff,
  searchProducts,
  getShopInventory,
  listTransfers,
  createWarehouseTransfer,
  getTransfer,
  receiveTransferScan,
  receiveAll,
  adjustStock,
  completeSale,
  listSales,
  getReceipt,
  processReturn,
  openShift,
  closeShift,
  getShifts,
  getReports,
};

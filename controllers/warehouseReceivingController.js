const pool = require('../config/db');
const { extractOrderLookupValue } = require('../utils/orderLookup');
const { ensureWholesaleTables } = require('../utils/wholesaleFlow');
const {
  ensureWarehouseReceivingTable,
  isReceivingStatus,
  normalizeReceivingStatus,
} = require('../utils/warehouseReceiving');

const receiveWarehouseScan = async (req, res, next) => {
  const lookup = extractOrderLookupValue(
    req.body?.productUid
    || req.body?.product_uid
    || req.body?.receiptCode
    || req.body?.receipt_code
    || req.body?.trackingId
    || req.body?.tracking_id
    || req.body?.orderId
    || req.body?.order_id
    || ''
  );

  if (!lookup) {
    return res.status(400).json({ error: 'Product UID, receipt code, order ID, or tracking ID is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWarehouseReceivingTable(client);
    await ensureWholesaleTables(client);

    const productResult = await client.query(
      `SELECT p.id, p.product_uid, p.receipt_code, p.name, p.status, p.expected_stock,
        s.shop_name AS seller_shop, s.name AS seller_name
       FROM products p
       LEFT JOIN sellers s ON p.seller_id = s.id
       WHERE p.id::text = $1
          OR LOWER(COALESCE(p.product_uid, '')) = LOWER($1)
          OR LOWER(COALESCE(p.receipt_code, '')) = LOWER($1)
          OR EXISTS (
            SELECT 1
            FROM warehouse_receiving_scans previous_scan
            WHERE previous_scan.product_id = p.id
              AND LOWER(COALESCE(previous_scan.tracking_id, '')) = LOWER($1)
          )
       FOR UPDATE OF p`,
      [lookup]
    );

    let product = productResult.rows[0] || null;
    let wholesaleOrder = null;

    if (!product) {
      const wholesaleResult = await client.query(
        `SELECT
           wo.id AS wholesale_order_id,
           wo.order_code,
           wo.quantity,
           p.id,
           p.product_uid,
           p.receipt_code,
           p.name,
           p.status,
           p.expected_stock,
           COALESCE(s.shop_name, s.name) AS seller_shop,
           s.name AS seller_name
         FROM wholesale_orders wo
         JOIN products p ON p.id = wo.linked_product_id
         LEFT JOIN sellers s ON p.seller_id = s.id
         WHERE wo.id::text = $1
            OR LOWER(COALESCE(wo.order_code, '')) = LOWER($1)
            OR LOWER(COALESCE(p.product_uid, '')) = LOWER($1)
            OR LOWER(COALESCE(p.receipt_code, '')) = LOWER($1)
         LIMIT 1
         FOR UPDATE OF p`,
        [lookup]
      );
      if (wholesaleResult.rows.length) {
        const row = wholesaleResult.rows[0];
        wholesaleOrder = {
          id: row.wholesale_order_id,
          order_code: row.order_code,
          quantity: row.quantity,
        };
        product = {
          id: row.id,
          product_uid: row.product_uid,
          receipt_code: row.receipt_code,
          name: row.name,
          status: row.status,
          expected_stock: row.expected_stock || row.quantity,
          seller_shop: row.seller_shop,
          seller_name: row.seller_name,
        };
      }
    }

    const quantity = Number(req.body?.quantity || product?.expected_stock || 0);
    const sourceAccountType = String(req.body?.source_account_type || req.body?.sourceAccountType || (product ? 'seller' : 'unknown')).trim().toLowerCase();

    const scanResult = await client.query(
      `INSERT INTO warehouse_receiving_scans (
        product_id, tracking_id, product_uid, receipt_code, source_account_type,
        source_name, quantity, status, notes, scanned_by, order_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'scanned', $8, $9, $10)
       RETURNING *`,
      [
        product?.id || null,
        lookup,
        product?.product_uid || null,
        product?.receipt_code || null,
        wholesaleOrder ? 'wholesale' : sourceAccountType || 'unknown',
        product?.seller_shop || product?.seller_name || null,
        Number.isFinite(quantity) && quantity >= 0 ? quantity : 0,
        String(req.body?.notes || '').trim() || null,
        String(req.body?.scanned_by || req.body?.scannedBy || 'tracking-app').trim() || 'tracking-app',
        null,
      ]
    );

    if (wholesaleOrder) {
      await client.query(
        `UPDATE warehouse_receiving_scans
         SET wholesale_order_id = $1,
             source_name = COALESCE(source_name, $2)
         WHERE id = $3`,
        [wholesaleOrder.id, wholesaleOrder.order_code || `Wholesale order #${wholesaleOrder.id}`, scanResult.rows[0].id]
      );
      scanResult.rows[0].wholesale_order_id = wholesaleOrder.id;
      scanResult.rows[0].source_account_type = 'wholesale';
      scanResult.rows[0].source_name = scanResult.rows[0].source_name || wholesaleOrder.order_code || `Wholesale order #${wholesaleOrder.id}`;
    }

    let updatedProduct = product;
    if (product && !['warehouse_received', 'topteam_pending', 'live'].includes(String(product.status || ''))) {
      const updated = await client.query(
        `UPDATE products
         SET status = 'warehouse_received',
             warehouse_received_at = NOW(),
             product_uid = COALESCE(product_uid, 'PHT-' || LPAD(id::text, 6, '0')),
             receipt_code = COALESCE(receipt_code, 'RCT-' || LPAD(id::text, 6, '0'))
         WHERE id = $1
         RETURNING id, product_uid, receipt_code, name, status, warehouse_received_at`,
        [product.id]
      );
      updatedProduct = updated.rows[0];
    }

    let order = null;
    if (!product) {
      const orderResult = await client.query(
        `SELECT id, order_code, status
         FROM orders
         WHERE id::text = $1 OR LOWER(COALESCE(order_code, '')) = LOWER($1)
         LIMIT 1`,
        [lookup]
      );
      order = orderResult.rows[0] || null;
      if (order) {
        await client.query(
          `UPDATE warehouse_receiving_scans
           SET order_id = $1,
               source_account_type = 'order',
               source_name = COALESCE(source_name, $2)
           WHERE id = $3`,
          [order.id, order.order_code || `Order #${order.id}`, scanResult.rows[0].id]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: product
        ? 'Product received and moved into the existing admin warehouse workflow.'
        : order
          ? 'Order receipt scan saved for admin review. Product receiving was not changed.'
          : 'Scan saved for admin review. No matching product was found yet.',
      scan: scanResult.rows[0],
      product: updatedProduct,
      wholesale_order: wholesaleOrder,
      order,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const getWarehouseReceivingScans = async (req, res, next) => {
  try {
    await ensureWarehouseReceivingTable(pool);
    const result = await pool.query(
      `SELECT wrs.*,
        p.name AS product_name,
        p.status AS product_status,
        p.stock,
        s.shop_name AS seller_shop,
        s.name AS seller_name
       FROM warehouse_receiving_scans wrs
       LEFT JOIN products p ON wrs.product_id = p.id
       LEFT JOIN sellers s ON p.seller_id = s.id
       ORDER BY wrs.scanned_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

const updateWarehouseReceivingStatus = async (req, res, next) => {
  try {
    await ensureWarehouseReceivingTable(pool);
    const status = normalizeReceivingStatus(req.body?.status);
    if (!isReceivingStatus(status)) {
      return res.status(400).json({ error: 'Invalid receiving status' });
    }

    const result = await pool.query(
      `UPDATE warehouse_receiving_scans
       SET status = $1, notes = COALESCE($2, notes), updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [status, String(req.body?.notes || '').trim() || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Receiving scan not found' });
    }

    res.json({ scan: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  receiveWarehouseScan,
  getWarehouseReceivingScans,
  updateWarehouseReceivingStatus,
};

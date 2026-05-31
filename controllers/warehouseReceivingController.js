const pool = require('../config/db');
const { extractOrderLookupValue } = require('../utils/orderLookup');
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

    const productResult = await client.query(
      `SELECT p.id, p.product_uid, p.receipt_code, p.name, p.status, p.expected_stock,
        s.shop_name AS seller_shop, s.name AS seller_name
       FROM products p
       LEFT JOIN sellers s ON p.seller_id = s.id
       WHERE p.id::text = $1
          OR LOWER(COALESCE(p.product_uid, '')) = LOWER($1)
          OR LOWER(COALESCE(p.receipt_code, '')) = LOWER($1)
       FOR UPDATE OF p`,
      [lookup]
    );

    const product = productResult.rows[0] || null;
    const quantity = Number(req.body?.quantity || product?.expected_stock || 0);
    const sourceAccountType = String(req.body?.source_account_type || req.body?.sourceAccountType || (product ? 'seller' : 'unknown')).trim().toLowerCase();

    const scanResult = await client.query(
      `INSERT INTO warehouse_receiving_scans (
        product_id, tracking_id, product_uid, receipt_code, source_account_type,
        source_name, quantity, status, notes, scanned_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'scanned', $8, $9)
       RETURNING *`,
      [
        product?.id || null,
        lookup,
        product?.product_uid || null,
        product?.receipt_code || null,
        sourceAccountType || 'unknown',
        product?.seller_shop || product?.seller_name || null,
        Number.isFinite(quantity) && quantity >= 0 ? quantity : 0,
        String(req.body?.notes || '').trim() || null,
        String(req.body?.scanned_by || req.body?.scannedBy || 'tracking-app').trim() || 'tracking-app',
      ]
    );

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

    await client.query('COMMIT');
    res.status(201).json({
      message: product
        ? 'Product received and moved into the existing admin warehouse workflow.'
        : 'Scan saved for admin review. No matching product was found yet.',
      scan: scanResult.rows[0],
      product: updatedProduct,
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

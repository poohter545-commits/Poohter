const pool = require('../config/db');
const {
  LEGACY_ORDER_STATUS_ALIASES,
  createUniqueOrderCode,
  validateStatusTransition,
} = require('../utils/orderIdentity');
const {
  DEFAULT_DELIVERY_CHARGE,
  DEFAULT_PACKING_MATERIAL_COST,
  ensureOrderChargeColumns,
} = require('../utils/orderCharges');
const { sendOrderStatusEmailSafely } = require('../utils/orderNotifications');
const { extractOrderLookupValue } = require('../utils/orderLookup');
const { requirePakistaniMobileNumber } = require('../utils/phoneValidation');
const { getPagination } = require('../utils/pagination');
const { createReturnCode, ensureReturnsTable, getReturnWindow } = require('../utils/returns');

const getBuyerSnapshot = async (client, buyerId) => {
  const result = await client.query(
    'SELECT name, email, phone, address FROM users WHERE id = $1',
    [buyerId]
  );
  return result.rows[0] || {};
};

const ensureBuyerCheckoutContact = async (client, buyerId, buyer = {}) => {
  const normalizedPhone = requirePakistaniMobileNumber(buyer.phone, 'Your saved phone number');
  if (normalizedPhone !== buyer.phone) {
    await client.query('UPDATE users SET phone = $1 WHERE id = $2', [normalizedPhone, buyerId]);
  }
  return {
    ...buyer,
    phone: normalizedPhone,
  };
};

const updateOrderStatusColumns = (status) => (
  status === 'out_from_warehouse'
    ? 'status = $1, out_from_warehouse_at = NOW(), out_for_delivery_at = NOW()'
    : status === 'out_for_delivery'
      ? 'status = $1, out_for_delivery_at = NOW()'
      : status === 'delivered'
        ? 'status = $1, delivered_at = COALESCE(delivered_at, NOW())'
        : 'status = $1'
);

const createOrder = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const buyerId = req.user?.id;
    const { items } = req.body;

    if (!buyerId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required and cannot be empty' });
    }

    await client.query('BEGIN');
    await ensureOrderChargeColumns(client);

    // 1. Fetch all products in one query to avoid N+1 overhead
    const uniqueProductIds = [...new Set(items.map(i => i.product_id))];
    const productData = await client.query(
      'SELECT id, name, price FROM products WHERE id = ANY($1)',
      [uniqueProductIds]
    );
    const productMap = new Map(productData.rows.map(p => [p.id, p]));

    const orderCode = await createUniqueOrderCode(client);
    const buyer = await getBuyerSnapshot(client, buyerId);

    // 2. Create the order record first
    const buyerWithValidContact = await ensureBuyerCheckoutContact(client, buyerId, buyer);
    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id, total_price, status, order_code, source,
        customer_name, customer_email, customer_phone, customer_address
       ) VALUES ($1, $2, 'pending', $3, 'poohter', $4, $5, $6, $7)
       RETURNING id, order_code, created_at`,
      [
        buyerId,
        0,
        orderCode,
        buyerWithValidContact.name || null,
        buyerWithValidContact.email || null,
        buyerWithValidContact.phone,
        buyerWithValidContact.address || null
      ]
    );
    const orderId = orderResult.rows[0].id;

    let totalOrderPrice = 0;
    const processedItems = [];
    const bulkValues = [];
    const queryPlaceholders = [];

    // 3. Process each item using the pre-fetched product data
    items.forEach((item, index) => {
      const { product_id, quantity } = item;
      const product = productMap.get(product_id);

      if (!product) {
        throw new Error(`Product with ID ${product_id} not found`);
      }

      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(`Invalid quantity for product ID ${product_id}`);
      }

      const productPrice = Number(product.price);
      const itemTotal = productPrice * quantity;
      totalOrderPrice += itemTotal;

      // Prepare values for bulk insert: [order_id, product_id, quantity, price]
      const offset = index * 4;
      queryPlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
      bulkValues.push(orderId, product_id, quantity, productPrice);

      processedItems.push({
        product_name: product.name,
        product_price: productPrice,
        quantity: Number(quantity)
      });
    });

    // 4. Perform Bulk Insert for all items in one query
    const bulkInsertQuery = `
      INSERT INTO order_items (order_id, product_id, quantity, price)
      VALUES ${queryPlaceholders.join(', ')}
      RETURNING id
    `;
    const itemInsertResult = await client.query(bulkInsertQuery, bulkValues);
    
    // Add the generated IDs back to our response object
    itemInsertResult.rows.forEach((row, i) => {
      processedItems[i].id = row.id;
    });

    // 5. Update the order with the final calculated total_price
    const deliveryCharge = DEFAULT_DELIVERY_CHARGE;
    const packingMaterialCost = DEFAULT_PACKING_MATERIAL_COST;
    const finalTotal = totalOrderPrice + deliveryCharge;
    await client.query(
      `UPDATE orders
       SET total_price = $1,
           delivery_charge = $2,
           packing_material_cost = $3
       WHERE id = $4`,
      [finalTotal, deliveryCharge, packingMaterialCost, orderId]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Order created successfully',
      order: {
        id: orderId,
        order_code: orderResult.rows[0].order_code,
        total_price: finalTotal,
        delivery_charge: deliveryCharge,
        packing_material_cost: packingMaterialCost,
        created_at: orderResult.rows[0].created_at,
        items: processedItems
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('Invalid quantity')) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  } finally {
    client.release();
  }
};

const getOrders = async (req, res, next) => {
  try {
    const buyerId = req.user?.id;
    if (!buyerId) return res.status(401).json({ error: 'Authentication required' });
    const { limit, offset } = getPagination(req.query, { defaultLimit: 50, maxLimit: 100 });

    await ensureOrderChargeColumns(pool);
    await ensureReturnsTable(pool);

    const result = await pool.query(
      `SELECT 
         o.id, 
         o.order_code,
         o.status,
         o.source,
         o.platform,
         o.external_order_ref,
         o.total_price,
         o.delivery_charge,
         o.packing_material_cost,
         o.created_at,
         o.delivered_at,
         COALESCE(return_summary.return_statuses, ARRAY[]::TEXT[]) AS return_statuses,
         return_summary.latest_return_at,
         COALESCE(json_agg(json_build_object(
           'product_id', p.id, -- Product ID from the products table
           'product_name', p.name, -- Product name from the products table
           'product_price', oi.price, -- Price at the time of order from order_items
           'quantity', oi.quantity -- Quantity from order_items
         )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN LATERAL (
         SELECT
           array_agg(DISTINCT rr.status) FILTER (WHERE rr.status IS NOT NULL AND rr.status != 'rejected') AS return_statuses,
           MAX(rr.created_at) AS latest_return_at
         FROM return_requests rr
         WHERE rr.order_id = o.id
       ) return_summary ON TRUE
       WHERE o.user_id = $1
       GROUP BY o.id, return_summary.return_statuses, return_summary.latest_return_at
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [buyerId, limit, offset]
    );

    const orders = result.rows.map(order => {
      const returnStatuses = Array.isArray(order.return_statuses)
        ? order.return_statuses.filter(Boolean)
        : [];
      const deliveredStatus = ['delivered', 'successful'].includes(order.status);
      const returnWindow = getReturnWindow(order.delivered_at);
      const hasOpenReturn = returnStatuses.some((status) => ['pending', 'approved', 'completed'].includes(status));

      return {
        id: order.id,
        order_code: order.order_code,
        status: order.status,
        source: order.source,
        platform: order.platform,
        external_order_ref: order.external_order_ref,
        total_price: Number(order.total_price),
        delivery_charge: Number(order.delivery_charge || 0),
        packing_material_cost: Number(order.packing_material_cost || 0),
        created_at: order.created_at,
        delivered_at: order.delivered_at,
        return_status: returnStatuses[0] || null,
        return_statuses: returnStatuses,
        return_requested_at: order.latest_return_at,
        return_period_expires_at: returnWindow.expiresAt,
        return_eligible: deliveredStatus && returnWindow.eligible && !hasOpenReturn,
        return_period_expired: deliveredStatus && !returnWindow.eligible && !hasOpenReturn,
        items: (order.items || []).map(item => ({
          product_id: item.product_id,
          product_name: item.product_name,
          product_price: Number(item.product_price),
          quantity: Number(item.quantity)
        }))
      };
    });

    return res.status(200).json(orders); // Return as an array directly
  } catch (error) {
    next(error);
  }
};

const checkout = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;

    await client.query('BEGIN');
    await ensureOrderChargeColumns(client);

    // 1. Get all cart items for logged-in user joined with products for fresh prices
    const cartItemsResult = await client.query(
      `SELECT ci.product_id, ci.quantity, p.price 
       FROM cart_items ci 
       JOIN products p ON ci.product_id = p.id 
       WHERE ci.user_id = $1`,
      [userId]
    );

    const cartItems = cartItemsResult.rows;

    // 2. If cart is empty → return error
    if (cartItems.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // 3. Verify and Lock Inventory for these products (FOR UPDATE prevents race conditions)
    const productIds = cartItems.map(item => item.product_id);
    const inventoryResult = await client.query(
      'SELECT product_id, stock_quantity AS total_stock FROM inventory WHERE product_id = ANY($1) AND warehouse_id = 1 FOR UPDATE',
      [productIds]
    );

    const stockMap = new Map(inventoryResult.rows.map(row => [row.product_id, Number(row.total_stock)]));

    for (const item of cartItems) {
      const available = stockMap.get(item.product_id) || 0;
      if (available < item.quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: `Stock for product ${item.product_id} changed. Only ${available} units left.` 
        });
      }
    }

    // 4. Calculate total price from DB prices (never trust frontend prices)
    let subtotal = 0;
    cartItems.forEach(item => {
      subtotal += Number(item.price) * item.quantity;
    });
    const deliveryCharge = DEFAULT_DELIVERY_CHARGE;
    const packingMaterialCost = DEFAULT_PACKING_MATERIAL_COST;
    const total_price = subtotal + deliveryCharge;

    // 5. Create a new order with a public code for scanning or manual lookup.
    const orderCode = await createUniqueOrderCode(client);
    const buyer = await getBuyerSnapshot(client, userId);
    const buyerWithValidContact = await ensureBuyerCheckoutContact(client, userId, buyer);
    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id, total_price, order_code, source, status,
        customer_name, customer_email, customer_phone, customer_address,
        delivery_charge, packing_material_cost
       ) VALUES ($1, $2, $3, 'poohter', 'pending', $4, $5, $6, $7, $8, $9)
       RETURNING id, order_code`,
      [
        userId,
        total_price,
        orderCode,
        buyerWithValidContact.name || null,
        buyerWithValidContact.email || null,
        buyerWithValidContact.phone,
        buyerWithValidContact.address || null,
        deliveryCharge,
        packingMaterialCost
      ]
    );
    const order_id = orderResult.rows[0].id;

    // 7. Insert all items into order_items table using bulk insert
    const bulkValues = [];
    const queryPlaceholders = [];
    cartItems.forEach((item, index) => {
      const offset = index * 4;
      queryPlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
      bulkValues.push(order_id, item.product_id, item.quantity, item.price);
    });

    const bulkInsertQuery = `
      INSERT INTO order_items (order_id, product_id, quantity, price)
      VALUES ${queryPlaceholders.join(', ')}
    `;
    await client.query(bulkInsertQuery, bulkValues);

    // 8. Deduct stock from inventory
    // Note: In a multi-warehouse setup, you'd have logic to pick which warehouse to deduct from.
    // Here we deduct from the primary warehouse (ID 1) as per standard simple implementation.
    for (const item of cartItems) {
      await client.query(
        'UPDATE inventory SET stock_quantity = stock_quantity - $1 WHERE product_id = $2 AND warehouse_id = 1',
        [item.quantity, item.product_id]
      );
    }

    // 8.5 Log initial status to delivery history
    await client.query(
      'INSERT INTO delivery_updates (order_id, status) VALUES ($1, $2)',
      [order_id, 'pending']
    );

    // 9. Clear cart_items for that user after successful order creation
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);

    await client.query('COMMIT');

    // 10. Return response
    return res.status(201).json({
      message: 'Order placed successfully',
      order_id,
      total_price,
      delivery_charge: deliveryCharge,
      packing_material_cost: packingMaterialCost,
      order_code: orderResult.rows[0].order_code
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const updateOrderStatus = async (req, res, next) => {
  const { id } = req.params;
  const { status: newStatus } = req.body;
  const userRole = req.user.role;

  // Authorization Check
  const authorizedRoles = ['admin', 'warehouse', 'delivery'];
  if (!authorizedRoles.includes(userRole)) {
    return res.status(403).json({ error: 'Unauthorized: Only admin, warehouse, or delivery roles can update status' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureOrderChargeColumns(client);

    // Fetch current status and lock row
    const orderRes = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [id]);
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const currentStatus = orderRes.rows[0].status;
    const transition = validateStatusTransition(currentStatus, newStatus);

    if (!transition.valid) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: transition.message });
    }

    // Update Order
    const result = await client.query(
      `UPDATE orders SET ${updateOrderStatusColumns(newStatus)} WHERE id = $2 RETURNING *`,
      [newStatus, id]
    );

    // Log History
    await client.query(
      'INSERT INTO delivery_updates (order_id, status) VALUES ($1, $2)',
      [id, newStatus]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Status updated', order: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const deliveryUpdate = async (req, res, next) => {
  const { order_code, tracking_id, status: newStatus } = req.body;
  const userRole = req.user.role;

  if (!['admin', 'warehouse', 'delivery'].includes(userRole)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureOrderChargeColumns(client);

    const lookupCode = extractOrderLookupValue(order_code || tracking_id);
    if (!lookupCode) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order code or tracking ID is required' });
    }
    const orderRes = await client.query(
      `SELECT id, order_code, status
       FROM orders
       WHERE id::text = $1
          OR LOWER(order_code) = LOWER($1)
          OR LOWER(COALESCE(external_order_ref, '')) = LOWER($1)
       FOR UPDATE`,
      [lookupCode]
    );
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order code not found' });
    }

    const order = orderRes.rows[0];
    const transition = validateStatusTransition(order.status, newStatus);

    if (!transition.valid) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: transition.message });
    }

    await client.query(`UPDATE orders SET ${updateOrderStatusColumns(newStatus)} WHERE id = $2`, [newStatus, order.id]);

    await client.query(
      'INSERT INTO delivery_updates (order_id, status) VALUES ($1, $2)',
      [order.id, newStatus]
    );

    await client.query('COMMIT');
    res.status(200).json({
      message: 'Delivery status synchronized successfully',
      order_code: order.order_code,
      status: newStatus
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const warehouseScan = async (req, res, next) => {
  const orderId = extractOrderLookupValue(
    req.body?.orderId
    || req.body?.order_id
    || req.body?.orderCode
    || req.body?.order_code
    || req.body?.trackingId
    || req.body?.tracking_id
    || ''
  );

  if (!orderId) {
    return res.status(400).json({ error: 'Order ID or tracking ID is required.' });
  }

  const client = await pool.connect();
  let updatedOrder = null;
  let notificationOrder = null;
  try {
    await client.query('BEGIN');
    await ensureOrderChargeColumns(client);

    const orderRes = await client.query(
      `SELECT
         o.id,
         o.order_code,
         o.external_order_ref,
         o.status,
         COALESCE(o.customer_email, u.email) AS customer_email,
         COALESCE(o.customer_name, u.name) AS customer_name
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.id::text = $1
          OR LOWER(o.order_code) = LOWER($1)
          OR LOWER(COALESCE(o.external_order_ref, '')) = LOWER($1)
       FOR UPDATE OF o`,
      [orderId]
    );

    const order = orderRes.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found. Check the ID and try again.' });
    }

    const normalizedStatus = LEGACY_ORDER_STATUS_ALIASES[order.status] || order.status;

    if (normalizedStatus === 'out_from_warehouse') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        warning: true,
        code: 'already_out_from_warehouse',
        message: 'This order is already out from warehouse.',
        order: {
          id: order.id,
          order_code: order.order_code,
          status: 'out_from_warehouse',
        },
      });
    }

    if (normalizedStatus !== 'accepted') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'This order is not accepted/ready yet. Admin must accept it before warehouse scan.',
        currentStatus: order.status,
      });
    }

    const result = await client.query(
      `UPDATE orders
       SET status = 'out_from_warehouse',
           out_from_warehouse_at = NOW(),
           out_for_delivery_at = NOW()
       WHERE id = $1
       RETURNING id, order_code, status, total_price, created_at, out_from_warehouse_at, out_for_delivery_at, delivered_at`,
      [order.id]
    );

    await client.query(
      'INSERT INTO delivery_updates (order_id, status) VALUES ($1, $2)',
      [order.id, 'out_from_warehouse']
    );

    updatedOrder = result.rows[0];
    notificationOrder = {
      ...result.rows[0],
      customer_email: order.customer_email,
      customer_name: order.customer_name,
    };

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }

  const email = await sendOrderStatusEmailSafely({ order: notificationOrder, status: 'out_from_warehouse' });
  return res.status(200).json({
    message: 'Order marked as out from warehouse.',
    order: updatedOrder,
    email,
  });
};

const requestReturn = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const buyerId = req.user?.id;
    const orderLookup = extractOrderLookupValue(req.params.id);
    const reason = String(req.body?.reason || '').trim();

    if (!buyerId) return res.status(401).json({ error: 'Authentication required' });
    if (!reason) return res.status(400).json({ error: 'Return reason is required' });

    await client.query('BEGIN');
    await ensureOrderChargeColumns(client);
    await ensureReturnsTable(client);

    const orderResult = await client.query(
      `SELECT id, order_code, status, COALESCE(delivered_at, closed_at) AS delivered_at
       FROM orders
       WHERE user_id = $1
         AND (id::text = $2 OR LOWER(order_code) = LOWER($2))
       FOR UPDATE`,
      [buyerId, orderLookup]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    if (!['delivered', 'successful'].includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Returns are available after delivery only' });
    }

    const returnWindow = getReturnWindow(order.delivered_at);
    if (!returnWindow.eligible) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Return period expired' });
    }

    const duplicateResult = await client.query(
      `SELECT id, status
       FROM return_requests
       WHERE order_id = $1
         AND status != 'rejected'
       LIMIT 1`,
      [order.id]
    );
    if (duplicateResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Return request already submitted for this order' });
    }

    const itemsResult = await client.query(
      `SELECT product_id, quantity, price
       FROM order_items
       WHERE order_id = $1
       ORDER BY id`,
      [order.id]
    );
    if (itemsResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This order has no returnable items' });
    }

    const created = [];
    for (const item of itemsResult.rows) {
      const result = await client.query(
        `INSERT INTO return_requests (
          return_code, order_id, product_id, quantity, reason, status, refund_amount, platform
         ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, 'Poohter app')
         RETURNING id, return_code, order_id, status, created_at`,
        [
          createReturnCode(),
          order.id,
          item.product_id,
          item.quantity,
          reason,
          Number(item.price || 0) * Number(item.quantity || 0),
        ]
      );
      created.push(result.rows[0]);
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Return request submitted',
      order_code: order.order_code,
      return_requests: created,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

module.exports = {
  createOrder,
  getOrders,
  checkout,
  updateOrderStatus,
  deliveryUpdate,
  warehouseScan,
  requestReturn
};

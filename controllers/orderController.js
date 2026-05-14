const pool = require('../config/db');
const { createUniqueOrderCode, validateStatusTransition } = require('../utils/orderIdentity');

const getBuyerSnapshot = async (client, buyerId) => {
  const result = await client.query(
    'SELECT name, email, phone, address FROM users WHERE id = $1',
    [buyerId]
  );
  return result.rows[0] || {};
};

const updateOrderStatusColumns = (status) => (
  status === 'out_for_delivery'
    ? 'status = $1, out_for_delivery_at = NOW()'
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
    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id, total_price, status, order_code, source,
        customer_name, customer_email, customer_phone, customer_address
       ) VALUES ($1, $2, 'pending', $3, 'poohter', $4, $5, $6, $7)
       RETURNING id, order_code, created_at`,
      [buyerId, 0, orderCode, buyer.name || null, buyer.email || null, buyer.phone || null, buyer.address || null]
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
    await client.query('UPDATE orders SET total_price = $1 WHERE id = $2', [totalOrderPrice, orderId]);

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Order created successfully',
      order: {
        id: orderId,
        order_code: orderResult.rows[0].order_code,
        total_price: totalOrderPrice,
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

    const result = await pool.query(
      `SELECT 
         o.id, 
         o.order_code,
         o.status,
         o.source,
         o.platform,
         o.external_order_ref,
         o.total_price, 
         o.created_at,
         COALESCE(json_agg(json_build_object(
           'product_id', p.id, -- Product ID from the products table
           'product_name', p.name, -- Product name from the products table
           'product_price', oi.price, -- Price at the time of order from order_items
           'quantity', oi.quantity -- Quantity from order_items
         )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [buyerId]
    );

    const orders = result.rows.map(order => ({
      id: order.id,
      order_code: order.order_code,
      status: order.status,
      source: order.source,
      platform: order.platform,
      external_order_ref: order.external_order_ref,
      total_price: Number(order.total_price),
      created_at: order.created_at,
      items: (order.items || []).map(item => ({ // Ensure items is an array, even if empty
        product_id: item.product_id,
        product_name: item.product_name,
        product_price: Number(item.product_price), // Convert to number
        quantity: Number(item.quantity)
      }))
    }));

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
    let total_price = 0;
    cartItems.forEach(item => {
      total_price += Number(item.price) * item.quantity;
    });

    // 5. Create a new order with a public code for scanning or manual lookup.
    const orderCode = await createUniqueOrderCode(client);
    const buyer = await getBuyerSnapshot(client, userId);
    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id, total_price, order_code, source, status,
        customer_name, customer_email, customer_phone, customer_address
       ) VALUES ($1, $2, $3, 'poohter', 'pending', $4, $5, $6, $7)
       RETURNING id, order_code`,
      [userId, total_price, orderCode, buyer.name || null, buyer.email || null, buyer.phone || null, buyer.address || null]
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

    const lookupCode = order_code || tracking_id;
    const orderRes = await client.query('SELECT id, order_code, status FROM orders WHERE order_code = $1 FOR UPDATE', [lookupCode]);
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

module.exports = {
  createOrder,
  getOrders,
  checkout,
  updateOrderStatus,
  deliveryUpdate
};

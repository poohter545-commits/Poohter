const pool = require('../config/db');

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

    // 2. Create the order record first
    const orderResult = await client.query(
      'INSERT INTO orders (user_id, total_price) VALUES ($1, $2) RETURNING id, created_at',
      [buyerId, 0]
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

    // 4. Calculate total price from DB prices (never trust frontend prices)
    let total_price = 0;
    cartItems.forEach(item => {
      total_price += Number(item.price) * item.quantity;
    });

    // 5. Create a new order
    const orderResult = await client.query(
      'INSERT INTO orders (user_id, total_price) VALUES ($1, $2) RETURNING id',
      [userId, total_price]
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

    // 9. Clear cart_items for that user after successful order creation
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);

    await client.query('COMMIT');

    // 10. Return response
    return res.status(201).json({
      message: 'Order placed successfully',
      order_id,
      total_price
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
};

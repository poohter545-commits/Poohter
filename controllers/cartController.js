const pool = require('../config/db');

const addToCart = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { product_id, quantity } = req.body;

    if (!product_id || typeof quantity !== 'number' || quantity === 0) {
      return res.status(400).json({ error: 'Valid product_id and a non-zero quantity are required' });
    }

    // 1. Validate product exists in products table
    const productResult = await pool.query('SELECT id FROM products WHERE id = $1', [product_id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (quantity > 0) { // Adding or incrementing
      // Check current stock and what's already in cart
      const stockResult = await pool.query(
        `SELECT 
          COALESCE((SELECT SUM(stock_quantity) FROM inventory WHERE product_id = $1), 0) as stock,
          COALESCE((SELECT quantity FROM cart_items WHERE user_id = $2 AND product_id = $1), 0) as in_cart`,
        [product_id, userId]
      );

      const availableStock = Number(stockResult.rows[0].stock);
      const currentInCart = Number(stockResult.rows[0].in_cart);

      if (currentInCart + quantity > availableStock) {
        return res.status(400).json({ 
          error: `Insufficient stock. Only ${availableStock} available, and you already have ${currentInCart} in your cart.` 
        });
      }

      // 2. Upsert logic: If product exists in cart for this user, increase quantity, else insert new row
      const upsertQuery = `
        INSERT INTO cart_items (user_id, product_id, quantity)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, product_id)
        DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
        RETURNING id, product_id, quantity
      `;

      const result = await pool.query(upsertQuery, [userId, product_id, quantity]);

      return res.status(200).json({
        message: 'Cart updated successfully',
        cartItem: result.rows[0]
      });
    } else { // Decrementing (quantity < 0, typically -1 from frontend)
      // Get current quantity
      const currentCartItem = await pool.query(
        'SELECT quantity FROM cart_items WHERE user_id = $1 AND product_id = $2',
        [userId, product_id]
      );

      if (currentCartItem.rows.length === 0) {
        // Item not in cart, cannot decrement
        return res.status(404).json({ error: 'Item not found in cart' });
      }

      const currentQuantity = currentCartItem.rows[0].quantity;
      const newQuantity = currentQuantity + quantity; // quantity is negative, so this is subtraction

      if (newQuantity < 1) {
        // If new quantity would be less than 1, remove the item instead
        await pool.query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [userId, product_id]);
        return res.status(200).json({ message: 'Item removed from cart' });
      } else {
        // Update quantity
        const updateQuery = `
          UPDATE cart_items
          SET quantity = $3
          WHERE user_id = $1 AND product_id = $2
          RETURNING id, product_id, quantity
        `;
        const result = await pool.query(updateQuery, [userId, product_id, newQuantity]);
        return res.status(200).json({
          message: 'Cart updated successfully',
          cartItem: result.rows[0]
        });
      }
    }
  } catch (error) {
    next(error);
  }
};

const getCart = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const query = `
      SELECT 
        ci.product_id,
        p.name AS product_name,
        p.price AS product_price,
        ci.quantity,
        (p.price * ci.quantity) AS total_price
      FROM cart_items ci
      JOIN products p ON ci.product_id = p.id
      WHERE ci.user_id = $1
      ORDER BY ci.created_at ASC
    `;

    const result = await pool.query(query, [userId]);

    // Normalize numeric fields
    const cart = result.rows.map(item => ({
      ...item,
      product_price: Number(item.product_price),
      total_price: Number(item.total_price),
      quantity: Number(item.quantity)
    }));

    return res.status(200).json(cart);
  } catch (error) {
    next(error);
  }
};

const removeFromCart = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { product_id } = req.params;

    await pool.query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [userId, product_id]);
    return res.status(200).json({ message: 'Item removed from cart' });
  } catch (error) {
    next(error);
  }
};

const clearCart = async (req, res, next) => {
  try {
    const userId = req.user.id;
    await pool.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
    return res.status(200).json({ message: 'Cart cleared successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = { addToCart, getCart, removeFromCart, clearCart };
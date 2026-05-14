const pool = require('../config/db');

const normalizeProduct = (product) => ({
  ...product,
  // Convert PostgreSQL numeric/decimal fields to JavaScript numbers
  price: Number(product.price),
});

const createProduct = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, price, description } = req.body;

    if (!name || name.toString().trim().length === 0 || price === undefined || price === null) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const parsedPrice = Number(price);
    if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ error: 'Price must be a non-negative integer' });
    }

    await client.query('BEGIN');

    const result = await client.query(
      'INSERT INTO products (name, price, description) VALUES ($1, $2, $3) RETURNING id, name, price, description, created_at',
      [name.toString().trim(), parsedPrice, description || null]
    );

    const newProduct = result.rows[0];

    // Initialize inventory with 0 stock for a default warehouse (ID 1)
    await client.query(
      'INSERT INTO inventory (product_id, warehouse_id, stock_quantity) VALUES ($1, $2, $3)',
      [newProduct.id, 1, 0]
    );

    await client.query('COMMIT');
    return res.status(201).json({ product: normalizeProduct(newProduct) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const getProducts = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, price, description, created_at
       FROM products
       WHERE status = 'live'
       ORDER BY created_at DESC`
    );

    return res.status(200).json({
      products: result.rows.map(normalizeProduct),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createProduct,
  getProducts,
};

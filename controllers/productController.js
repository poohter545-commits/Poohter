const pool = require('../config/db');

const normalizeProduct = (product) => ({
  ...product,
  // Convert PostgreSQL numeric/decimal fields to JavaScript numbers
  price: Number(product.price),
});

const createProduct = async (req, res, next) => {
  try {
    const { name, price, description } = req.body;

    if (!name || name.toString().trim().length === 0 || price === undefined || price === null) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const parsedPrice = Number(price);
    if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ error: 'Price must be a non-negative integer' });
    }

    const result = await pool.query(
      'INSERT INTO products (name, price, description) VALUES ($1, $2, $3) RETURNING id, name, price, description, created_at',
      [name.toString().trim(), parsedPrice, description || null]
    );

    return res.status(201).json({ product: normalizeProduct(result.rows[0]) });
  } catch (error) {
    next(error);
  }
};

const getProducts = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, name, price, description, created_at FROM products ORDER BY created_at DESC'
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

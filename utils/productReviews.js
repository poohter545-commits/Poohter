const pool = require('../config/db');

const ensureProductReviewsTable = async (clientOrPool = pool) => {
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS product_reviews (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(product_id, user_id)
    )
  `);
  await clientOrPool.query(`
    CREATE INDEX IF NOT EXISTS idx_product_reviews_product_created
    ON product_reviews(product_id, created_at DESC)
  `);
};

module.exports = {
  ensureProductReviewsTable,
};

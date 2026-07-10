const pool = require('../config/db');
const { getPagination } = require('../utils/pagination');
const { ensureProductReviewsTable } = require('../utils/productReviews');

const DELIVERED_STATUSES = ['delivered', 'successful'];

const hasPurchasedProduct = async (userId, productId) => {
  const result = await pool.query(
    `SELECT 1
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.user_id = $1
       AND oi.product_id = $2
       AND o.status = ANY($3)
     LIMIT 1`,
    [userId, productId, DELIVERED_STATUSES]
  );
  return result.rows.length > 0;
};

const getProductReviews = async (req, res, next) => {
  try {
    await ensureProductReviewsTable(pool);
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const { limit, offset, nextOffset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 });

    const [summaryResult, reviewsResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::INT AS review_count, COALESCE(ROUND(AVG(rating)::NUMERIC, 1), 0) AS average_rating
         FROM product_reviews
         WHERE product_id = $1`,
        [productId]
      ),
      pool.query(
        `SELECT pr.id, pr.rating, pr.comment, pr.created_at, pr.updated_at, pr.user_id, u.name AS reviewer_name
         FROM product_reviews pr
         JOIN users u ON u.id = pr.user_id
         WHERE pr.product_id = $1
         ORDER BY pr.created_at DESC, pr.id DESC
         LIMIT $2 OFFSET $3`,
        [productId, limit, offset]
      ),
    ]);

    const summary = summaryResult.rows[0] || {};

    return res.status(200).json({
      product_id: productId,
      average_rating: Number(summary.average_rating || 0),
      review_count: Number(summary.review_count || 0),
      reviews: reviewsResult.rows.map((review) => ({
        id: review.id,
        rating: Number(review.rating),
        comment: review.comment,
        reviewer_name: review.reviewer_name || 'Poohter buyer',
        is_mine: Boolean(req.user?.id && Number(req.user.id) === Number(review.user_id)),
        created_at: review.created_at,
        updated_at: review.updated_at,
      })),
      pagination: {
        limit,
        offset,
        next_offset: reviewsResult.rows.length === limit ? nextOffset : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

const submitProductReview = async (req, res, next) => {
  try {
    await ensureProductReviewsTable(pool);

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
    }

    const comment = String(req.body?.comment || '').trim().slice(0, 2000) || null;

    const productResult = await pool.query(
      "SELECT id FROM products WHERE id = $1 AND COALESCE(status, 'live') = 'live' LIMIT 1",
      [productId]
    );
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const purchased = await hasPurchasedProduct(userId, productId);
    if (!purchased) {
      return res.status(403).json({ error: 'You can only review products from your delivered orders' });
    }

    const result = await pool.query(
      `INSERT INTO product_reviews (product_id, user_id, rating, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id, user_id)
       DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = NOW()
       RETURNING id, product_id, rating, comment, created_at, updated_at`,
      [productId, userId, rating, comment]
    );

    return res.status(201).json({ review: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

const deleteMyProductReview = async (req, res, next) => {
  try {
    await ensureProductReviewsTable(pool);

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const result = await pool.query(
      'DELETE FROM product_reviews WHERE product_id = $1 AND user_id = $2 RETURNING id',
      [productId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }

    return res.json({ message: 'Review deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getProductReviews,
  submitProductReview,
  deleteMyProductReview,
};

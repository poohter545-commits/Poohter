const express = require('express');
const {
  createProduct,
  deleteProduct,
  getProductById,
  getProducts,
  updateProduct,
} = require('../controllers/productController');
const {
  getProductReviews,
  submitProductReview,
  deleteMyProductReview,
} = require('../controllers/reviewController');
const authMiddleware = require('../middleware/authMiddleware');
const { isAdmin } = require('../middleware/roles');

const router = express.Router();

router.get('/products', getProducts);
router.get('/products/:id', getProductById);
router.get('/products/:id/reviews', getProductReviews);
router.post('/products/:id/reviews', authMiddleware, submitProductReview);
router.delete('/products/:id/reviews/mine', authMiddleware, deleteMyProductReview);
router.post('/products', authMiddleware, isAdmin, createProduct);
router.put('/products/:id', authMiddleware, isAdmin, updateProduct);
router.delete('/products/:id', authMiddleware, isAdmin, deleteProduct);

module.exports = router;

const express = require('express');
const router = express.Router();
const { getOrders, checkout } = require('../controllers/orderController');
const { addToCart, getCart, removeFromCart, clearCart } = require('../controllers/cartController');
const { signup, login } = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware'); // Assuming you have an authMiddleware

// Auth routes
router.post('/auth/signup', signup);
router.post('/auth/login', login);

// Route to get all orders for the authenticated user
// Protected by authMiddleware to ensure req.user.id is available
router.get('/orders', authMiddleware, getOrders);

// Cart routes
router.post('/cart', authMiddleware, addToCart);
router.get('/cart', authMiddleware, getCart);
router.delete('/cart/:product_id', authMiddleware, removeFromCart);
router.delete('/cart', authMiddleware, clearCart);

// Checkout route
router.post('/checkout', authMiddleware, checkout);

module.exports = router;

// Generic error handling middleware for API routes
// This should be placed after all other routes to catch errors
router.use((err, req, res, next) => {
  console.error(err.stack); // Log the error stack to the server console for debugging
  // Send a standardized error response to the client
  res.status(err.statusCode || 500).json({
    error: err.message || 'An unexpected error occurred on the server.'
  });
});
const express = require('express');
const router = express.Router();
const { getOrders, checkout, updateOrderStatus, deliveryUpdate, warehouseScan, requestReturn } = require('../controllers/orderController');
const { addToCart, getCart, removeFromCart, clearCart } = require('../controllers/cartController');
const { createSupportRequest } = require('../controllers/supportController');
const { receiveWarehouseScan } = require('../controllers/warehouseReceivingController');
const { proxyMedia } = require('../utils/uploads');
const {
  signup,
  verifySignup,
  login,
  resendOtp,
  requestPasswordReset,
  resetPassword,
  getUserProfile,
  updateUserProfile,
  getUsers,
} = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware'); // Assuming you have an authMiddleware

router.get('/test', (req, res) => {
  res.json({ status: 'ok', message: 'API is reachable' });
});
router.get('/media', proxyMedia);

// Auth routes
router.post('/auth/signup', signup);
router.post('/auth/signup/verify', verifySignup);
router.post('/auth/login', login);
router.post('/auth/otp/resend', resendOtp);
router.post('/auth/password/forgot', requestPasswordReset);
router.post('/auth/password/reset', resetPassword);

// Buyer profile routes used by the mobile app
router.get('/user/:id', authMiddleware, getUserProfile);
router.put('/user/:id', authMiddleware, updateUserProfile);
router.get('/users', authMiddleware, getUsers);

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

// Order Tracking & Delivery Status
router.patch('/orders/:id/status', authMiddleware, updateOrderStatus);
router.post('/orders/:id/return-request', authMiddleware, requestReturn);
router.post('/delivery/update', authMiddleware, deliveryUpdate);
router.post('/orders/warehouse-scan', warehouseScan);
router.post('/warehouse/receive-scan', receiveWarehouseScan);
router.post('/support/request-call', createSupportRequest);

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

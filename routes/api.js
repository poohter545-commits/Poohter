const express = require('express');
const rateLimit = require('express-rate-limit');
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
const authMiddleware = require('../middleware/authMiddleware');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many signup attempts. Please try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const supportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many support requests. Please try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/test', (req, res) => {
  res.json({ status: 'ok', message: 'API is reachable' });
});
router.get('/media', proxyMedia);

// Auth routes
router.post('/auth/signup', signupLimiter, signup);
router.post('/auth/signup/verify', otpLimiter, verifySignup);
router.post('/auth/login', loginLimiter, login);
router.post('/auth/otp/resend', otpLimiter, resendOtp);
router.post('/auth/password/forgot', otpLimiter, requestPasswordReset);
router.post('/auth/password/reset', otpLimiter, resetPassword);

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
router.post('/orders/warehouse-scan', authMiddleware, warehouseScan);
router.post('/warehouse/receive-scan', authMiddleware, receiveWarehouseScan);
router.post('/support/request-call', supportLimiter, createSupportRequest);

router.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.statusCode || 500).json({
    error: err.message || 'An unexpected error occurred on the server.'
  });
});

module.exports = router;

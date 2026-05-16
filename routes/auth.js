const express = require('express');
const {
  signup,
  verifySignup,
  login,
  requestPasswordReset,
  resetPassword,
} = require('../controllers/authController');

const router = express.Router();

router.post('/signup', signup);
router.post('/signup/verify', verifySignup);
router.post('/login', login);
router.post('/password/forgot', requestPasswordReset);
router.post('/password/reset', resetPassword);

module.exports = router;

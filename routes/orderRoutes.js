const express = require('express');
const verifyToken = require('../middleware/authMiddleware');
const { isBuyer } = require('../middleware/roleMiddleware');
const { createOrder, getOrders } = require('../controllers/orderController');

const router = express.Router();

router.post('/', verifyToken, isBuyer, createOrder);
router.get('/', verifyToken, isBuyer, getOrders);

module.exports = router;

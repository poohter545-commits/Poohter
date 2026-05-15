const express = require('express');
const router = express.Router();
const topteamController = require('../controllers/topteamController');
const authMiddleware = require('../middleware/authMiddleware');
const { isTopTeam } = require('../middleware/roles');

router.post('/login', topteamController.login);
router.get('/overview', authMiddleware, isTopTeam, topteamController.getOverview);
router.post('/payouts/:sellerId/pay', authMiddleware, isTopTeam, topteamController.markSellerPayoutPaid);
router.post('/wholesalers/:id/ban', authMiddleware, isTopTeam, topteamController.banWholesaler);
router.post('/platforms', authMiddleware, isTopTeam, topteamController.saveSalesPlatform);
router.post('/finance/product-cost', authMiddleware, isTopTeam, topteamController.saveProductCost);
router.post('/finance/order-cost', authMiddleware, isTopTeam, topteamController.saveOrderCost);
router.post('/marketing-spend', authMiddleware, isTopTeam, topteamController.addMarketingSpend);
router.post('/targets', authMiddleware, isTopTeam, topteamController.addBusinessTarget);

module.exports = router;

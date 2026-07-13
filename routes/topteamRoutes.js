const express = require('express');
const router = express.Router();
const topteamController = require('../controllers/topteamController');
const physicalShopRoutes = require('./physicalShopRoutes');
const authMiddleware = require('../middleware/authMiddleware');
const { isTopTeam } = require('../middleware/roles');

router.post('/login', topteamController.login);
router.post('/refresh', authMiddleware, isTopTeam, topteamController.refreshToken);
router.use('/physical-shop-pos', authMiddleware, isTopTeam, physicalShopRoutes);
router.get('/overview', authMiddleware, isTopTeam, topteamController.getOverview);
router.post('/orders/:id/payment', authMiddleware, isTopTeam, topteamController.recordOrderPayment);
router.post('/payouts/:sellerId/pay', authMiddleware, isTopTeam, topteamController.markSellerPayoutPaid);
router.post('/wholesalers/:id/ban', authMiddleware, isTopTeam, topteamController.banWholesaler);
router.post('/platforms', authMiddleware, isTopTeam, topteamController.saveSalesPlatform);
router.post('/finance/product-cost', authMiddleware, isTopTeam, topteamController.saveProductCost);
router.post('/products/:id/platform-plan', authMiddleware, isTopTeam, topteamController.submitProductPlatformPlan);
router.post('/wholesale/products/:id/pricing', authMiddleware, isTopTeam, topteamController.approveWholesaleProductPricing);
router.post('/finance/order-cost', authMiddleware, isTopTeam, topteamController.saveOrderCost);
router.post('/marketing-spend', authMiddleware, isTopTeam, topteamController.addMarketingSpend);
router.post('/targets', authMiddleware, isTopTeam, topteamController.addBusinessTarget);
router.get('/physical-shop/reports', authMiddleware, isTopTeam, topteamController.getPhysicalShopReports);
router.get('/physical-shop-pricing', authMiddleware, isTopTeam, topteamController.listPhysicalShopPricing);
router.post('/products/:id/physical-shop-price', authMiddleware, isTopTeam, topteamController.setPhysicalShopPrice);
router.use('/physical-shop', authMiddleware, isTopTeam, physicalShopRoutes);

module.exports = router;

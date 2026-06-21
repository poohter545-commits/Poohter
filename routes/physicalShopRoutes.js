const express = require('express');
const physicalShopController = require('../controllers/physicalShopController');

const router = express.Router();

router.get('/shops', physicalShopController.listShops);
router.post('/shops', physicalShopController.createShop);
router.patch('/shops/:id', physicalShopController.updateShop);

router.get('/staff', physicalShopController.listStaff);
router.post('/staff', physicalShopController.createStaff);
router.patch('/staff/:id', physicalShopController.updateStaff);

router.get('/products/search', physicalShopController.searchProducts);

router.get('/inventory', physicalShopController.getShopInventory);
router.post('/inventory/adjust', physicalShopController.adjustStock);
router.get('/transfers', physicalShopController.listTransfers);
router.post('/transfers', physicalShopController.createWarehouseTransfer);
router.post('/transfers/receive-scan', physicalShopController.receiveTransferScan);
router.post('/transfers/:id/receive-all', physicalShopController.receiveAll);
router.get('/transfers/:id', physicalShopController.getTransfer);

router.post('/sales', physicalShopController.completeSale);
router.get('/sales', physicalShopController.listSales);
router.get('/receipts/:receiptCode', physicalShopController.getReceipt);
router.post('/receipts/:receiptCode/return', physicalShopController.processReturn);

router.get('/shifts', physicalShopController.getShifts);
router.post('/shifts/open', physicalShopController.openShift);
router.post('/shifts/:id/close', physicalShopController.closeShift);

router.get('/reports', physicalShopController.getReports);

module.exports = router;

const express = require('express');
const multer = require('multer');
const path = require('path');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const adminController = require('../controllers/adminController');
const wholesaleController = require('../controllers/wholesaleController');
const supportController = require('../controllers/supportController');
const warehouseReceivingController = require('../controllers/warehouseReceivingController');
const physicalShopRoutes = require('./physicalShopRoutes');
const authMiddleware = require('../middleware/authMiddleware');
const { isAdmin } = require('../middleware/roles');
const { ensureUploadDir } = require('../utils/uploads');

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many admin login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const PRODUCT_MEDIA_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

const productMediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'product_video') {
      cb(null, ensureUploadDir('products/videos'));
    } else if (file.fieldname === 'product_images' && req.originalUrl.includes('/wholesale/')) {
      cb(null, ensureUploadDir('wholesale/products'));
    } else {
      cb(null, ensureUploadDir('products/images'));
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadProductMedia = multer({
  storage: productMediaStorage,
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'product_images') {
      const isImage = /image\/(jpeg|jpg|png)/.test(file.mimetype);
      return isImage ? cb(null, true) : cb(new Error('Only JPG and PNG images are allowed'));
    }
    if (file.fieldname === 'product_video') {
      return file.mimetype === 'video/mp4' ? cb(null, true) : cb(new Error('Only MP4 videos are allowed'));
    }
    return cb(null, true);
  },
  limits: { fileSize: PRODUCT_MEDIA_UPLOAD_LIMIT_BYTES }
});

const productMediaFields = (fields) => (req, res, next) => {
  uploadProductMedia.fields(fields)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'File exceeds the 50MB upload limit.'
        : `Upload error: ${err.message}`;
      return res.status(400).json({ error: message });
    }
    if (err) return res.status(400).json({ error: err.message });
    return next();
  });
};

router.post('/login', adminLoginLimiter, adminController.login);
router.get('/documents/:accountType/:id/cnic/:side', adminController.getSignedCnicDocument);

// Protect review and operations routes
router.use(authMiddleware, isAdmin);

router.post('/refresh', adminController.refreshToken);

router.use('/physical-shop', physicalShopRoutes);

router.get('/dashboard', adminController.getDashboardStats);
router.get('/users', adminController.getAllUsers);
router.get('/support-requests', supportController.getSupportRequests);
router.patch('/support-requests/:id/status', supportController.updateSupportRequestStatus);
router.get('/warehouse/receiving-scans', warehouseReceivingController.getWarehouseReceivingScans);
router.patch('/warehouse/receiving-scans/:id/status', warehouseReceivingController.updateWarehouseReceivingStatus);
router.get('/sellers', adminController.getAllSellers);
router.get('/wholesalers', wholesaleController.getAdminWholesalers);
router.get('/platforms', adminController.getPlatforms);
router.get('/sellers/:id/cnic/:side', adminController.getSellerCnicDocument);
router.get('/wholesalers/:id/cnic/:side', adminController.getWholesalerCnicDocument);
router.patch('/sellers/:id/status', adminController.updateSellerStatus);
router.post('/sellers/:id/cnic-update-request', adminController.requestSellerCnicUpdate);
router.patch('/sellers/:id/cnic-update', adminController.reviewSellerCnicUpdate);
router.patch('/wholesalers/:id/status', wholesaleController.updateAdminWholesalerStatus);
router.post('/wholesalers/:id/cnic-update-request', wholesaleController.requestWholesalerCnicUpdate);
router.patch('/wholesalers/:id/cnic-update', wholesaleController.reviewWholesalerCnicUpdate);
router.post('/wholesalers/:id/report', wholesaleController.reportWholesalerToTopTeam);
router.get('/wholesale/products', wholesaleController.getAdminWholesaleProducts);
router.get('/wholesale/min-order-rules', wholesaleController.getMinOrderRules);
router.post('/wholesale/min-order-rules', wholesaleController.createMinOrderRule);
router.patch('/wholesale/min-order-rules/:id', wholesaleController.updateMinOrderRule);
router.delete('/wholesale/min-order-rules/:id', wholesaleController.deleteMinOrderRule);
router.post('/wholesale/min-order-rules/apply-to-all-products', wholesaleController.applyMinOrderRulesToAllProducts);
router.patch('/wholesalers/:id/wholesale-profit', wholesaleController.applyWholesalerExpectedProfitPercent);
router.patch(
  '/wholesale/products/:id/images',
  productMediaFields([{ name: 'product_images', maxCount: 3 }]),
  wholesaleController.uploadAdminWholesaleProductImages
);
router.patch(
  '/wholesale/products/:id/review',
  productMediaFields([{ name: 'product_images', maxCount: 3 }]),
  wholesaleController.reviewAdminWholesaleProduct
);
router.delete('/wholesale/products/:id/folder-data', wholesaleController.resetAdminWholesaleProductFolderData);
router.delete('/wholesale/products/:id', wholesaleController.deleteAdminWholesaleProduct);
router.get('/products', adminController.getAllProducts);
router.delete('/products/:id', adminController.deleteProductById);
router.patch('/products/:id/status', adminController.updateProductStatus);
router.patch('/products/:id/stock', adminController.updateProductStock);
router.patch(
  '/products/:id/warehouse',
  productMediaFields([
    { name: 'product_images', maxCount: 5 },
    { name: 'product_video', maxCount: 1 }
  ]),
  adminController.finalizeWarehouseProduct
);
router.get('/orders', adminController.getAllOrders);
router.post('/orders/manual', adminController.createManualOrder);
router.patch('/orders/:id/status', adminController.updateOrderStatus);
router.patch('/orders/:id/address', adminController.updateOrderAddress);
router.get('/returns', adminController.getAllReturns);
router.post('/returns/manual', adminController.createManualReturn);
router.patch('/returns/:id/status', adminController.updateReturnStatus);
router.get('/wholesale/orders', wholesaleController.getAdminWholesaleOrders);
router.post('/wholesale/orders/:id/accept', wholesaleController.acceptWholesaleOrderByAdmin);
router.patch('/wholesale/orders/:id/status', wholesaleController.reviewWholesaleOrderByAdmin);

module.exports = router;

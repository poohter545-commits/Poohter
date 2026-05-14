const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const adminController = require('../controllers/adminController');
const wholesaleController = require('../controllers/wholesaleController');
const authMiddleware = require('../middleware/authMiddleware');
const { isAdmin } = require('../middleware/roles');

const productMediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'product_video') {
      cb(null, 'uploads/products/videos/');
    } else {
      cb(null, 'uploads/products/images/');
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
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/login', adminController.login);

// Protect review and operations routes
router.use(authMiddleware, isAdmin);

router.get('/dashboard', adminController.getDashboardStats);
router.get('/users', adminController.getAllUsers);
router.get('/sellers', adminController.getAllSellers);
router.get('/wholesalers', wholesaleController.getAdminWholesalers);
router.get('/platforms', adminController.getPlatforms);
router.patch('/sellers/:id/status', adminController.updateSellerStatus);
router.patch('/wholesalers/:id/status', wholesaleController.updateAdminWholesalerStatus);
router.patch('/sellers/:id/password', adminController.updateSellerPassword);
router.get('/products', adminController.getAllProducts);
router.patch('/products/:id/status', adminController.updateProductStatus);
router.patch('/products/:id/stock', adminController.updateProductStock);
router.patch(
  '/products/:id/warehouse',
  uploadProductMedia.fields([
    { name: 'product_images', maxCount: 5 },
    { name: 'product_video', maxCount: 1 }
  ]),
  adminController.finalizeWarehouseProduct
);
router.get('/orders', adminController.getAllOrders);
router.post('/orders/manual', adminController.createManualOrder);
router.patch('/orders/:id/status', adminController.updateOrderStatus);
router.post('/orders/:id/payment', adminController.recordOrderPayment);
router.get('/returns', adminController.getAllReturns);
router.post('/returns/manual', adminController.createManualReturn);
router.get('/wholesale/orders', wholesaleController.getAdminWholesaleOrders);
router.patch('/wholesale/orders/:id/status', wholesaleController.reviewWholesaleOrderByAdmin);

module.exports = router;

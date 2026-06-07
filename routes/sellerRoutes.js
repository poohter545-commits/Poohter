const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const sellerController = require('../controllers/sellerController');
const wholesaleController = require('../controllers/wholesaleController');
const authMiddleware = require('../middleware/authMiddleware');
const pool = require('../config/db');
const { ensureUploadDir } = require('../utils/uploads');

const PRODUCT_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const PRODUCT_VIDEO_LIMIT_BYTES = 10 * 1024 * 1024;
const CNIC_UPLOAD_LIMIT_BYTES = 6 * 1024 * 1024;

// Multer Storage Configuration for Products
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'product_images') {
      cb(null, ensureUploadDir('products/images'));
    } else if (file.fieldname === 'product_video') {
      cb(null, ensureUploadDir('products/videos'));
    } else {
      cb(null, ensureUploadDir('sellers/cnic'));
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const productUpload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'product_images') {
        const filetypes = /jpeg|jpg|png|webp/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) return cb(null, true);
        return cb(new Error('Only JPG, JPEG, PNG, and WEBP images are allowed for products'));
    } else if (file.fieldname === 'product_video') {
        if (file.mimetype === 'video/mp4') return cb(null, true);
        return cb(new Error('Only MP4 videos are allowed'));
    } else if (file.fieldname === 'cnic_front' || file.fieldname === 'cnic_back') {
        const isPhoto = /image\/(jpeg|jpg|png)/.test(file.mimetype);
        if (isPhoto) return cb(null, true);
        return cb(new Error('CNIC must be a JPG or PNG image'));
    }
    cb(new Error(`Unexpected upload field: ${file.fieldname}`));
  },
  limits: {
    fileSize: PRODUCT_UPLOAD_LIMIT_BYTES
  }
});

// Custom wrapper for size validation
const uploadProductMedia = (req, res, next) => {
  const upload = productUpload.fields([
    { name: 'product_images', maxCount: 5 },
    { name: 'product_video', maxCount: 1 }
  ]);

  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    // Seller product images are accepted up to the roomy global upload limit.
    if (req.files && req.files['product_video']) {
      const video = req.files['product_video'][0];
      if (video.size > PRODUCT_VIDEO_LIMIT_BYTES) return res.status(400).json({ error: 'Video exceeds 10MB limit' });
    }

    next();
  });
};

const uploadCnicFields = (req, res, next) => {
  const upload = productUpload.fields([
    { name: 'cnic_front', maxCount: 1 },
    { name: 'cnic_back', maxCount: 1 }
  ]);

  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) return res.status(400).json({ error: err.message });

    const files = Object.values(req.files || {}).flat();
    if (files.some((file) => file.size > CNIC_UPLOAD_LIMIT_BYTES)) {
      return res.status(400).json({ error: 'CNIC images must be 6MB or smaller' });
    }
    return next();
  });
};

// Helper middleware to ensure role is seller
const isSeller = (req, res, next) => {
  if (req.user && req.user.role === 'seller') {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden: Seller access required' });
};

const ensureApprovedSeller = async (req, res, next) => {
  try {
    const result = await pool.query('SELECT status FROM sellers WHERE id = $1', [req.user.id]);
    const seller = result.rows[0];

    if (!seller) {
      return res.status(404).json({ error: 'Seller profile not found' });
    }

    if (seller.status !== 'approved') {
      return res.status(403).json({ error: 'Admin approval is required before using seller operations' });
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Public Seller Auth
router.post(
  '/register', 
  uploadCnicFields,
  sellerController.register
); 
router.post('/register/verify', sellerController.verifySellerRegistration);
router.post('/login', sellerController.login);       // Publicly accessible login

// Protected Seller Routes
router.get('/profile', authMiddleware, isSeller, ensureApprovedSeller, sellerController.getProfile);
router.post(
  '/cnic-update',
  authMiddleware,
  isSeller,
  ensureApprovedSeller,
  uploadCnicFields,
  sellerController.uploadCnicUpdate
);
router.post('/products', authMiddleware, isSeller, ensureApprovedSeller, uploadProductMedia, sellerController.createProduct);
router.get('/products', authMiddleware, isSeller, ensureApprovedSeller, sellerController.getMyProducts);
router.delete('/products/:id', authMiddleware, isSeller, ensureApprovedSeller, sellerController.deleteMyProduct);
router.patch('/products/:id/stock', authMiddleware, isSeller, ensureApprovedSeller, sellerController.updateStock);
router.get('/orders', authMiddleware, isSeller, ensureApprovedSeller, sellerController.getSellerOrders);
router.patch('/orders/:id/status', authMiddleware, isSeller, ensureApprovedSeller, sellerController.updateSellerOrderStatus);
router.get('/payouts', authMiddleware, isSeller, ensureApprovedSeller, sellerController.getSellerPayouts);
router.get('/wholesale/products', authMiddleware, isSeller, ensureApprovedSeller, wholesaleController.getWholesaleCatalogForSeller);
router.get('/wholesale/orders', authMiddleware, isSeller, ensureApprovedSeller, wholesaleController.getSellerWholesaleOrders);
router.post('/wholesale/orders', authMiddleware, isSeller, ensureApprovedSeller, wholesaleController.createWholesaleOrderForSeller);

module.exports = router;

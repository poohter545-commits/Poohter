const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const sellerController = require('../controllers/sellerController');
const wholesaleController = require('../controllers/wholesaleController');
const authMiddleware = require('../middleware/authMiddleware');

// Multer Storage Configuration for Products
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'product_images') {
      cb(null, 'uploads/products/images/');
    } else if (file.fieldname === 'product_video') {
      cb(null, 'uploads/products/videos/');
    } else {
      cb(null, 'uploads/sellers/cnic/');
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
        const filetypes = /jpeg|jpg|png/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) return cb(null, true);
        return cb(new Error('Only JPG, JPEG, and PNG images are allowed for products'));
    } else if (file.fieldname === 'product_video') {
        if (file.mimetype === 'video/mp4') return cb(null, true);
        return cb(new Error('Only MP4 videos are allowed'));
    } else if (file.fieldname === 'cnic_front' || file.fieldname === 'cnic_back') {
        const isPhoto = /image\/(jpeg|jpg|png)/.test(file.mimetype);
        if (isPhoto) return cb(null, true);
        return cb(new Error('CNIC must be a JPG or PNG image'));
    }
    cb(null, true); // Fallback to allow other potential fields
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB default global limit
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

    // Post-upload size validation (Multer limits are global, we need field-specific)
    if (req.files && req.files['product_images']) {
      for (const f of req.files['product_images']) {
        if (f.size > 4 * 1024 * 1024) return res.status(400).json({ error: 'Image exceeds 4MB limit' });
      }
    }
    if (req.files && req.files['product_video']) {
      const video = req.files['product_video'][0];
      if (video.size > 10 * 1024 * 1024) return res.status(400).json({ error: 'Video exceeds 10MB limit' });
    }

    next();
  });
};

// Helper middleware to ensure role is seller
const isSeller = (req, res, next) => {
  if (req.user && req.user.role === 'seller') {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden: Seller access required' });
};

// Public Seller Auth
router.post(
  '/register', 
  productUpload.fields([
    { name: 'cnic_front', maxCount: 1 }, 
    { name: 'cnic_back', maxCount: 1 }
  ]), 
  sellerController.register
); 
router.post('/login', sellerController.login);       // Publicly accessible login

// Protected Seller Routes
router.get('/profile', authMiddleware, isSeller, sellerController.getProfile);
router.post('/products', authMiddleware, isSeller, uploadProductMedia, sellerController.createProduct);
router.get('/products', authMiddleware, isSeller, sellerController.getMyProducts);
router.patch('/products/:id/stock', authMiddleware, isSeller, sellerController.updateStock);
router.get('/orders', authMiddleware, isSeller, sellerController.getSellerOrders);
router.patch('/orders/:id/status', authMiddleware, isSeller, sellerController.updateSellerOrderStatus);
router.get('/payouts', authMiddleware, isSeller, sellerController.getSellerPayouts);
router.get('/wholesale/products', authMiddleware, isSeller, wholesaleController.getWholesaleCatalogForSeller);
router.get('/wholesale/orders', authMiddleware, isSeller, wholesaleController.getSellerWholesaleOrders);
router.post('/wholesale/orders', authMiddleware, isSeller, wholesaleController.createWholesaleOrderForSeller);

module.exports = router;

const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const wholesaleController = require('../controllers/wholesaleController');
const authMiddleware = require('../middleware/authMiddleware');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'product_images') {
      cb(null, 'uploads/wholesale/products/');
    } else {
      cb(null, 'uploads/wholesalers/cnic/');
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const isImage = /image\/(jpeg|jpg|png)/.test(file.mimetype);
    if (['cnic_front', 'cnic_back', 'product_images'].includes(file.fieldname)) {
      return isImage ? cb(null, true) : cb(new Error('Only JPG and PNG images are allowed'));
    }
    return cb(null, true);
  },
  limits: { fileSize: 6 * 1024 * 1024 }
});

const uploadWholesaleProductImages = (req, res, next) => {
  const handler = upload.fields([{ name: 'product_images', maxCount: 8 }]);
  handler(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    const images = req.files?.product_images || [];
    if (images.length < 5) {
      return res.status(400).json({ error: 'Minimum 5 photos of wholesale product are required' });
    }
    next();
  });
};

const isWholesaler = (req, res, next) => {
  if (req.user && req.user.role === 'wholesaler') return next();
  return res.status(403).json({ error: 'Forbidden: Wholesaler access required' });
};

router.post(
  '/register',
  upload.fields([
    { name: 'cnic_front', maxCount: 1 },
    { name: 'cnic_back', maxCount: 1 }
  ]),
  wholesaleController.registerWholesaler
);
router.post('/login', wholesaleController.loginWholesaler);

router.use(authMiddleware, isWholesaler);

router.get('/profile', wholesaleController.getWholesalerProfile);
router.get('/products', wholesaleController.getMyWholesaleProducts);
router.post('/products', uploadWholesaleProductImages, wholesaleController.createWholesalerProduct);
router.patch('/products/:id', wholesaleController.updateMyWholesaleProduct);
router.get('/orders', wholesaleController.getWholesalerOrders);
router.post('/orders/:id/accept', wholesaleController.acceptWholesaleOrder);
router.post('/orders/:id/reject', wholesaleController.rejectWholesaleOrderByWholesaler);
router.get('/payouts', wholesaleController.getWholesalerPayouts);

module.exports = router;

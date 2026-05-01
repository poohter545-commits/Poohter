const express = require('express');
const { createProduct, getProducts } = require('../controllers/productController');

const router = express.Router();

router.post('/products', createProduct);
router.get('/products', getProducts);

module.exports = router;

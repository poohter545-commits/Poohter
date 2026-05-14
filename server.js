const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const pool = require('./config/db');
const apiRoutes = require('./routes/api');
const productRoutes = require('./routes/productRoutes');
const sellerRoutes = require('./routes/sellerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const topteamRoutes = require('./routes/topteamRoutes');
const wholesalerRoutes = require('./routes/wholesalerRoutes');
const logger = require('./middleware/logger');

dotenv.config();

const app = express();

const productionOrigins = [
  'https://poohter.com',
  'https://www.poohter.com',
  'https://seller.poohter.com',
  'https://buyer.poohter.com',
  'https://admin.poohter.com',
  'https://topteam.poohter.com',
  'https://wholesaler.poohter.com',
];

const localOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:8083',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:8083',
];

const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = new Set([
  ...productionOrigins,
  ...localOrigins,
  ...envOrigins,
]);

// Ensure required upload directories exist on startup
const uploadDirs = [
  'uploads/products/images/',
  'uploads/products/videos/',
  'uploads/sellers/cnic/',
  'uploads/wholesalers/cnic/',
  'uploads/wholesale/products/'
];
uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
});

// Configure CORS for better security
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(logger);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api', productRoutes);
app.use('/api', apiRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/topteam', topteamRoutes);
app.use('/api/wholesaler', wholesalerRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Backend is running' });
});

app.get('/health', async (req, res, next) => {
  res.json({ status: 'ok' });
});

app.get('/db-health', async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  // Use a conditional check for error logging to keep the console clean during tests
  if (process.env.NODE_ENV !== 'test') {
    console.error(err.stack);
  }
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    try {
      await pool.query('SELECT 1');
      console.log('Connected to PostgreSQL');
    } catch (error) {
      console.error('PostgreSQL connection check failed:', error.message);
      console.error('Set DATABASE_URL in Render before using API routes that require the database.');
    }
  });
};

startServer();

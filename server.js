const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const pool = require('./config/db');
const apiRoutes = require('./routes/api');
const productRoutes = require('./routes/productRoutes');
const sellerRoutes = require('./routes/sellerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const topteamRoutes = require('./routes/topteamRoutes');
const wholesalerRoutes = require('./routes/wholesalerRoutes');
const legalRoutes = require('./routes/legalRoutes');
const logger = require('./middleware/logger');
const { initProductionDb } = require('./scripts/initProductionDb');
const { UPLOAD_ROOT, ensureUploadDir, isPrivateCnicPath, serveStoredUpload } = require('./utils/uploads');

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
  'https://wholeseller.poohter.com',
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

const isAllowedOrigin = (origin) => {
  if (!origin || allowedOrigins.has(origin)) return true;
  if (origin === 'null') return true;

  try {
    const { hostname, protocol } = new URL(origin);
    if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return true;

    const isPoohterDeployHost = hostname.includes('poohter') && [
      '.onrender.com',
      '.vercel.app',
      '.netlify.app',
      '.github.io',
    ].some((suffix) => hostname.endsWith(suffix));

    return protocol === 'https:' && (hostname === 'poohter.com' || hostname.endsWith('.poohter.com') || isPoohterDeployHost);
  } catch (error) {
    return false;
  }
};

// Ensure required upload directories exist on startup
const uploadDirs = [
  'products/images',
  'products/videos',
  'sellers/cnic',
  'wholesalers/cnic',
  'wholesale/products',
  'wholesale/payment-receipts'
];
uploadDirs.forEach(dir => {
  ensureUploadDir(dir);
});

// Configure CORS for better security
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));
app.use(express.urlencoded({ extended: false, limit: process.env.FORM_BODY_LIMIT || '1mb' }));
app.use(logger);
app.use('/uploads', (req, res, next) => {
  if (isPrivateCnicPath(`uploads/${String(req.path || '').replace(/^\/+/, '')}`)) {
    return res.status(404).json({ error: 'Not found' });
  }
  return next();
});
app.use('/uploads', express.static(UPLOAD_ROOT, {
  immutable: true,
  maxAge: '365d',
}));
const legacyUploadRoot = path.resolve(process.cwd(), 'uploads');
if (legacyUploadRoot !== UPLOAD_ROOT) {
  app.use('/uploads', express.static(legacyUploadRoot, {
    immutable: true,
    maxAge: '365d',
  }));
}
app.get(/^\/uploads\/(.+)/, serveStoredUpload);
app.use('/api', productRoutes);
app.use('/api', apiRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/topteam', topteamRoutes);
app.use('/api/wholesaler', wholesalerRoutes);
app.use('/api/legal', legalRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Backend is running' });
});

app.get('/health', async (req, res, next) => {
  res.json({ status: 'ok', version: '2026-05-15-expanded-cors' });
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
  const status = err.status || err.statusCode || 500;
  const message = status >= 500 ? 'Internal Server Error' : (err.message || 'Request failed');
  res.status(status).json({ error: message });
});

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    await initProductionDb();
    console.log('Connected to PostgreSQL');
  } catch (error) {
    console.error('PostgreSQL connection check failed:', error.message);
    console.error('Set DATABASE_URL in Render before using API routes that require the database.');
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();

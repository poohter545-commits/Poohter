const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const pool = require('./config/db');
const apiRoutes = require('./routes/api');
const productRoutes = require('./routes/productRoutes');
const logger = require('./middleware/logger');

dotenv.config();

const app = express();

// Configure CORS for better security
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(logger);
app.use('/api', productRoutes);
app.use('/api', apiRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Backend is running' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  // Use a conditional check for error logging to keep the console clean during tests
  if (process.env.NODE_ENV !== 'test') {
    console.error(err.stack);
  }
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    await pool.query('SELECT 1');
    console.log('Connected to PostgreSQL');
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to connect to PostgreSQL:', error.message);
    process.exit(1);
  }
};

startServer();
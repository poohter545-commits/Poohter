const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : undefined,
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'postgres',
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    };

const pool = new Pool(poolConfig);

module.exports = pool;

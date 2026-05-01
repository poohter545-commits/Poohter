const pool = require('../config/db');

const dbStatus = async (req, res, next) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'ok',
      databaseTime: result.rows[0].now,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  dbStatus,
};

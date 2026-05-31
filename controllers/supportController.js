const pool = require('../config/db');
const {
  ensureSupportRequestsTable,
  isSupportStatus,
  normalizeSupportStatus,
} = require('../utils/supportRequests');
const { requirePakistaniMobileNumber } = require('../utils/phoneValidation');

const createSupportRequest = async (req, res, next) => {
  try {
    await ensureSupportRequestsTable(pool);
    const phone = requirePakistaniMobileNumber(req.body?.phone, 'Phone number');
    const name = String(req.body?.name || '').trim();
    const message = String(req.body?.message || '').trim();
    const accountType = String(req.body?.account_type || req.body?.accountType || 'buyer').trim().toLowerCase();
    const source = String(req.body?.source || 'website').trim().toLowerCase();

    const result = await pool.query(
      `INSERT INTO support_requests (name, phone, message, account_type, source)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, phone, message, account_type, source, status, created_at`,
      [name || null, phone, message || null, accountType || 'buyer', source || 'website']
    );

    res.status(201).json({
      message: 'Call request received',
      request: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

const getSupportRequests = async (req, res, next) => {
  try {
    await ensureSupportRequestsTable(pool);
    const result = await pool.query(
      `SELECT id, name, phone, message, account_type, source, status, created_at, updated_at
       FROM support_requests
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

const updateSupportRequestStatus = async (req, res, next) => {
  try {
    await ensureSupportRequestsTable(pool);
    const status = normalizeSupportStatus(req.body?.status);
    if (!isSupportStatus(status)) {
      return res.status(400).json({ error: 'Invalid support request status' });
    }

    const result = await pool.query(
      `UPDATE support_requests
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, phone, message, account_type, source, status, created_at, updated_at`,
      [status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Support request not found' });
    }

    res.json({ request: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createSupportRequest,
  getSupportRequests,
  updateSupportRequestStatus,
};

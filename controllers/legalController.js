const pool = require('../config/db');
const { normalizeEmail } = require('../utils/emailOtp');

const ALLOWED_ACCOUNT_TYPES = new Set(['buyer', 'seller', 'wholesaler']);

const ensureAccountDeletionRequestsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_deletion_requests (
      id SERIAL PRIMARY KEY,
      account_type TEXT NOT NULL DEFAULT 'seller',
      name TEXT,
      email TEXT NOT NULL,
      phone TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMP DEFAULT NOW(),
      processed_at TIMESTAMP,
      metadata JSONB DEFAULT '{}'::jsonb
    )
  `);
};

const requestAccountDeletion = async (req, res, next) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    const accountType = String(req.body.accountType || req.body.account_type || 'seller').trim().toLowerCase();
    const safeAccountType = ALLOWED_ACCOUNT_TYPES.has(accountType) ? accountType : 'seller';
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const reason = String(req.body.reason || '').trim();
    const confirmed = req.body.confirmed === true || req.body.confirmed === 'true' || req.body.confirmed === 'on';

    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'A valid account email is required.' });
    }

    if (!confirmed) {
      return res.status(400).json({ error: 'Please confirm that you want to request account deletion.' });
    }

    await ensureAccountDeletionRequestsTable();

    const existing = await pool.query(
      `SELECT id, status, requested_at
       FROM account_deletion_requests
       WHERE LOWER(email) = LOWER($1)
         AND account_type = $2
         AND status = 'pending'
       ORDER BY requested_at DESC
       LIMIT 1`,
      [cleanEmail, safeAccountType]
    );

    if (existing.rows.length > 0) {
      return res.json({
        message: 'We already have a pending account deletion request for this email.',
        request: existing.rows[0],
      });
    }

    const result = await pool.query(
      `INSERT INTO account_deletion_requests (
        account_type, name, email, phone, reason, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, status, requested_at`,
      [
        safeAccountType,
        name,
        cleanEmail,
        phone,
        reason,
        {
          source: 'seller-delete-account-page',
          userAgent: req.get('user-agent') || '',
          ip: req.ip || '',
        },
      ]
    );

    res.status(201).json({
      message: 'Account deletion request received. Poohter support will review and process it.',
      request: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  ensureAccountDeletionRequestsTable,
  requestAccountDeletion,
};

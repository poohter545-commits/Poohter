const crypto = require('crypto');
const pool = require('../config/db');

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 10);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const OTP_RESEND_COOLDOWN_SECONDS = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);
const OTP_MAX_RESENDS = Number(process.env.OTP_MAX_RESENDS || 5);

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const normalizeAccountType = (accountType) => String(accountType || 'buyer').trim().toLowerCase();

const ensureEmailOtpTable = async (clientOrPool = pool) => {
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS email_otps (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'buyer',
      otp_hash TEXT NOT NULL,
      payload JSONB,
      attempts INTEGER NOT NULL DEFAULT 0,
      resend_count INTEGER NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      consumed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await clientOrPool.query(`
    ALTER TABLE email_otps
      ADD COLUMN IF NOT EXISTS resend_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMP DEFAULT NOW()
  `);

  await clientOrPool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_otps_lookup
    ON email_otps (LOWER(email), purpose, account_type, consumed_at, expires_at)
  `);
};

const getOtpSecret = () => (
  process.env.OTP_SECRET
  || process.env.JWT_SECRET
  || process.env.RESEND_API_KEY
  || 'poohter-local-otp-secret'
);

const hashOtp = ({ email, purpose, accountType, otp }) => (
  crypto
    .createHmac('sha256', getOtpSecret())
    .update(`${normalizeEmail(email)}:${purpose}:${normalizeAccountType(accountType)}:${String(otp || '').trim()}`)
    .digest('hex')
);

const generateOtp = () => String(crypto.randomInt(100000, 1000000));

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}[character]));

const sendEmail = async ({ to, subject, html, text }) => {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Email service is not configured. Set RESEND_API_KEY on the backend.');
  }

  const from = process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM || 'Poohter <noreply@poohter.com>';
  const replyTo = process.env.RESEND_REPLY_TO || process.env.SUPPORT_EMAIL || 'poohter545@gmail.com';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      text,
      reply_to: replyTo,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || data.error || 'Could not send verification email.';
    if (String(message).toLowerCase().includes('testing emails')) {
      throw new Error('Email service is in Resend testing mode. Verify poohter.com in Resend and set RESEND_FROM_EMAIL to Poohter <noreply@poohter.com>.');
    }
    throw new Error(message);
  }

  return data;
};

const otpEmailContent = ({ code, purpose, accountType, displayName }) => {
  const safeName = escapeHtml(displayName || 'there');
  const label = accountType === 'seller'
    ? 'seller'
    : accountType === 'wholesaler'
      ? 'wholesaler'
      : 'buyer';
  const isReset = purpose === 'password_reset';
  const title = isReset ? 'Reset your Poohter password' : 'Verify your Poohter email';
  const lead = isReset
    ? `Use this code to reset your ${label} account password.`
    : `Use this code to finish creating your ${label} account.`;
  const text = [
    `Hi ${displayName || 'there'},`,
    '',
    lead,
    `Your Poohter code is: ${code}`,
    `This code expires in ${OTP_TTL_MINUTES} minutes.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:28px">
        <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#2563eb;letter-spacing:.06em;text-transform:uppercase">Poohter</p>
        <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">${escapeHtml(title)}</h1>
        <p style="margin:0 0 18px;color:#475569;line-height:1.6">Hi ${safeName}, ${escapeHtml(lead)}</p>
        <div style="font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:18px 12px;color:#1d4ed8">${code}</div>
        <p style="margin:18px 0 0;color:#64748b;line-height:1.5">This code expires in ${OTP_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.</p>
      </div>
    </div>
  `;

  return { subject: title, html, text };
};

const createEmailOtp = async ({ email, purpose, accountType = 'buyer', displayName = '', payload = null }) => {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) throw new Error('Email is required.');

  const cleanAccountType = normalizeAccountType(accountType);
  const code = generateOtp();
  await ensureEmailOtpTable();
  await sendEmail({
    to: cleanEmail,
    ...otpEmailContent({ code, purpose, accountType: cleanAccountType, displayName }),
  });
  await pool.query(
    `UPDATE email_otps
     SET consumed_at = NOW()
     WHERE LOWER(email) = LOWER($1)
       AND purpose = $2
       AND account_type = $3
       AND consumed_at IS NULL`,
    [cleanEmail, purpose, cleanAccountType]
  );
  await pool.query(
    `INSERT INTO email_otps (email, purpose, account_type, otp_hash, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6::int * interval '1 minute'))`,
    [
      cleanEmail,
      purpose,
      cleanAccountType,
      hashOtp({ email: cleanEmail, purpose, accountType: cleanAccountType, otp: code }),
      payload ? JSON.stringify(payload) : null,
      OTP_TTL_MINUTES,
    ]
  );

  return { email: cleanEmail, expiresInMinutes: OTP_TTL_MINUTES };
};

const resendEmailOtp = async ({ email, purpose, accountType = 'buyer' }) => {
  const cleanEmail = normalizeEmail(email);
  const cleanAccountType = normalizeAccountType(accountType);
  if (!cleanEmail) throw new Error('Email is required.');

  await ensureEmailOtpTable();
  const result = await pool.query(
    `SELECT *
     FROM email_otps
     WHERE LOWER(email) = LOWER($1)
       AND purpose = $2
       AND account_type = $3
       AND consumed_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [cleanEmail, purpose, cleanAccountType]
  );

  const otpRow = result.rows[0];
  if (!otpRow) throw new Error('OTP is invalid or expired. Please request a new code.');

  const secondsSinceLastSend = Math.floor((Date.now() - new Date(otpRow.last_sent_at || otpRow.created_at).getTime()) / 1000);
  if (secondsSinceLastSend < OTP_RESEND_COOLDOWN_SECONDS) {
    const retryAfterSeconds = OTP_RESEND_COOLDOWN_SECONDS - secondsSinceLastSend;
    const error = new Error(`Please wait ${retryAfterSeconds} seconds before requesting another OTP.`);
    error.status = 429;
    error.retryAfterSeconds = retryAfterSeconds;
    throw error;
  }

  const resendCount = Number(otpRow.resend_count || 0);
  if (resendCount >= OTP_MAX_RESENDS) {
    const error = new Error('OTP resend limit reached. Please restart the signup or password reset flow.');
    error.status = 429;
    throw error;
  }

  const code = generateOtp();
  const payload = otpRow.payload || null;
  const displayName = payload?.name || payload?.shop_name || '';

  await sendEmail({
    to: cleanEmail,
    ...otpEmailContent({ code, purpose, accountType: cleanAccountType, displayName }),
  });

  await pool.query(
    `UPDATE email_otps
     SET otp_hash = $1,
         attempts = 0,
         resend_count = resend_count + 1,
         last_sent_at = NOW(),
         expires_at = NOW() + ($2::int * interval '1 minute')
     WHERE id = $3`,
    [
      hashOtp({ email: cleanEmail, purpose, accountType: cleanAccountType, otp: code }),
      OTP_TTL_MINUTES,
      otpRow.id,
    ]
  );

  return {
    email: cleanEmail,
    expiresInMinutes: OTP_TTL_MINUTES,
    resendCount: resendCount + 1,
    maxResends: OTP_MAX_RESENDS,
    cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
};

const verifyEmailOtp = async ({ email, purpose, accountType = 'buyer', otp }) => {
  const cleanEmail = normalizeEmail(email);
  const cleanAccountType = normalizeAccountType(accountType);
  const cleanOtp = String(otp || '').trim();
  if (!cleanEmail || !cleanOtp) throw new Error('Email and OTP are required.');

  await ensureEmailOtpTable();
  const result = await pool.query(
    `SELECT *
     FROM email_otps
     WHERE LOWER(email) = LOWER($1)
       AND purpose = $2
       AND account_type = $3
       AND consumed_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [cleanEmail, purpose, cleanAccountType]
  );

  const otpRow = result.rows[0];
  if (!otpRow) throw new Error('OTP is invalid or expired. Please request a new code.');
  if (Number(otpRow.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    throw new Error('Too many incorrect OTP attempts. Please request a new code.');
  }

  const expectedHash = hashOtp({ email: cleanEmail, purpose, accountType: cleanAccountType, otp: cleanOtp });
  if (expectedHash !== otpRow.otp_hash) {
    await pool.query('UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1', [otpRow.id]);
    throw new Error('Invalid OTP code.');
  }

  await pool.query('UPDATE email_otps SET consumed_at = NOW() WHERE id = $1', [otpRow.id]);
  return otpRow.payload || {};
};

module.exports = {
  createEmailOtp,
  ensureEmailOtpTable,
  normalizeEmail,
  resendEmailOtp,
  verifyEmailOtp,
};

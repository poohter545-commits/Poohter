const crypto = require('crypto');

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// Separate secret for short-lived CNIC document tokens so a leaked user JWT
// cannot be forged into a document access token (and vice-versa).
const CNIC_JWT_SECRET = process.env.CNIC_DOCUMENT_JWT_SECRET || JWT_SECRET;

module.exports = {
  JWT_SECRET,
  CNIC_JWT_SECRET,
};

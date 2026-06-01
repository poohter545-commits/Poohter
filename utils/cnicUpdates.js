const { publicUploadPathFromValue } = require('./uploads');

const CNIC_UPDATE_COLUMNS_SQL = `
  ADD COLUMN IF NOT EXISTS cnic_update_status TEXT DEFAULT 'clear',
  ADD COLUMN IF NOT EXISTS cnic_update_requested_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cnic_update_requested_by TEXT,
  ADD COLUMN IF NOT EXISTS cnic_update_note TEXT,
  ADD COLUMN IF NOT EXISTS pending_cnic_front TEXT,
  ADD COLUMN IF NOT EXISTS pending_cnic_back TEXT,
  ADD COLUMN IF NOT EXISTS pending_cnic_uploaded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cnic_update_reviewed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cnic_update_rejection_reason TEXT
`;

const ensureCnicUpdateColumns = async (clientOrPool, tableName) => {
  if (!['sellers', 'wholesalers'].includes(tableName)) {
    throw new Error('Unsupported CNIC update table');
  }
  await clientOrPool.query(`ALTER TABLE ${tableName} ${CNIC_UPDATE_COLUMNS_SQL}`);
};

const cnicUpdateSelectFields = `
  cnic_update_status,
  cnic_update_requested_at,
  cnic_update_requested_by,
  cnic_update_note,
  pending_cnic_front,
  pending_cnic_back,
  pending_cnic_uploaded_at,
  cnic_update_reviewed_at,
  cnic_update_rejection_reason
`;

const normalizeCnicUpdateFields = (row = {}) => ({
  cnic_update_status: row.cnic_update_status || 'clear',
  cnic_update_required: row.cnic_update_status === 'requested' || row.cnic_update_status === 'rejected',
  cnic_update_pending_review: row.cnic_update_status === 'uploaded',
  cnic_update_requested_at: row.cnic_update_requested_at || null,
  cnic_update_requested_by: row.cnic_update_requested_by || null,
  cnic_update_note: row.cnic_update_note || null,
  pending_cnic_front: publicUploadPathFromValue(row.pending_cnic_front) || null,
  pending_cnic_back: publicUploadPathFromValue(row.pending_cnic_back) || null,
  pending_cnic_uploaded_at: row.pending_cnic_uploaded_at || null,
  cnic_update_reviewed_at: row.cnic_update_reviewed_at || null,
  cnic_update_rejection_reason: row.cnic_update_rejection_reason || null,
});

module.exports = {
  ensureCnicUpdateColumns,
  cnicUpdateSelectFields,
  normalizeCnicUpdateFields,
};

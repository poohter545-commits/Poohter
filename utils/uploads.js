const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const defaultUploadRoot = path.resolve(__dirname, '..', 'uploads');
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || defaultUploadRoot);

const normalizeUploadPath = (value = '') => (
  String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
);

const ensureUploadDir = (relativeDir) => {
  const cleanDir = normalizeUploadPath(relativeDir).replace(/^uploads\//, '');
  const absoluteDir = path.join(UPLOAD_ROOT, cleanDir);
  fs.mkdirSync(absoluteDir, { recursive: true });
  return absoluteDir;
};

const publicUploadPath = (file) => {
  if (!file) return null;

  const rawPath = file.path || (file.destination && file.filename ? path.join(file.destination, file.filename) : '');
  const normalized = normalizeUploadPath(rawPath);
  const marker = 'uploads/';
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    return normalized.slice(markerIndex);
  }

  if (file.destination && file.filename) {
    const destination = normalizeUploadPath(file.destination);
    const destinationIndex = destination.lastIndexOf(marker);
    const publicDir = destinationIndex >= 0
      ? destination.slice(destinationIndex).replace(/\/+$/, '')
      : `uploads/${destination.replace(/^uploads\//, '').replace(/\/+$/, '')}`;
    return `${publicDir}/${file.filename}`;
  }

  return normalized || null;
};

const ensureStoredUploadsTable = async (clientOrPool = pool) => {
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS uploaded_files (
      file_path TEXT PRIMARY KEY,
      content_type TEXT,
      size_bytes INTEGER,
      data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
};

const persistUploadedFile = async (file, clientOrPool = pool) => {
  const filePath = publicUploadPath(file);
  if (!filePath || !file?.path) return filePath;

  await ensureStoredUploadsTable(clientOrPool);
  const data = await fs.promises.readFile(file.path);
  await clientOrPool.query(
    `INSERT INTO uploaded_files (file_path, content_type, size_bytes, data, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (file_path) DO UPDATE
     SET content_type = EXCLUDED.content_type,
         size_bytes = EXCLUDED.size_bytes,
         data = EXCLUDED.data,
         updated_at = NOW()`,
    [filePath, file.mimetype || 'application/octet-stream', Number(file.size || data.length), data]
  );

  return filePath;
};

const persistUploadedFiles = async (files = [], clientOrPool = pool) => (
  Promise.all((Array.isArray(files) ? files : []).map((file) => persistUploadedFile(file, clientOrPool)))
);

const serveStoredUpload = async (req, res, next) => {
  try {
    const pathPart = req.params?.[0] || req.path.replace(/^\/uploads\/?/, '');
    const filePath = normalizeUploadPath(`uploads/${pathPart}`);
    if (!filePath || filePath === 'uploads') return next();

    await ensureStoredUploadsTable(pool);
    const result = await pool.query(
      'SELECT content_type, data FROM uploaded_files WHERE file_path = $1 LIMIT 1',
      [filePath]
    );
    const file = result.rows[0];
    if (!file) return next();

    res.setHeader('Content-Type', file.content_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(file.data);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  UPLOAD_ROOT,
  ensureUploadDir,
  ensureStoredUploadsTable,
  normalizeUploadPath,
  persistUploadedFile,
  persistUploadedFiles,
  publicUploadPath,
  serveStoredUpload,
};

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

const publicUploadPathFromValue = (value = '') => {
  const normalized = normalizeUploadPath(value);
  if (!normalized) return '';

  const marker = 'uploads/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex);

  if (/^(products|sellers|wholesalers|wholesale)\//.test(normalized)) {
    return `uploads/${normalized}`;
  }

  return normalized;
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
    const requestPath = normalizeUploadPath(req.path);
    const filePath = publicUploadPathFromValue(requestPath);
    if (!filePath || filePath === 'uploads') return next();

    await ensureStoredUploadsTable(pool);
    const result = await pool.query(
      'SELECT content_type, data FROM uploaded_files WHERE file_path = $1 LIMIT 1',
      [filePath]
    );
    const file = result.rows[0];
    if (!file) return next();

    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const size = data.length;
    const contentType = file.content_type || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
      let end = match?.[2] ? Number.parseInt(match[2], 10) : size - 1;

      if (match && !match[1] && match[2]) {
        const suffixLength = Number.parseInt(match[2], 10);
        start = Math.max(size - suffixLength, 0);
        end = size - 1;
      }

      if (!match || !Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= size) {
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.status(416).end();
      }

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      return res.end(data.subarray(start, end + 1));
    }

    res.setHeader('Content-Length', size);
    return res.send(data);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  UPLOAD_ROOT,
  ensureUploadDir,
  ensureStoredUploadsTable,
  normalizeUploadPath,
  publicUploadPathFromValue,
  persistUploadedFile,
  persistUploadedFiles,
  publicUploadPath,
  serveStoredUpload,
};

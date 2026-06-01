const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const defaultUploadRoot = path.resolve(__dirname, '..', 'uploads');
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || defaultUploadRoot);
const SUPABASE_SIGNED_URL_TTL_SECONDS = Number(process.env.SUPABASE_SIGNED_URL_TTL_SECONDS || 3600);

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

  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const isExternalStorageUrl = /supabase\.(co|in)|supabase\.com|storage\.googleapis\.com|amazonaws\.com|cloudinary\.com/i.test(url.hostname)
        || /\/storage\/v1\/object\//i.test(url.pathname);
      if (isExternalStorageUrl) {
        if (url.protocol === 'http:') url.protocol = 'https:';
        return url.toString();
      }

      const pathName = url.pathname.replace(/^\/+/, '');
      const uploadIndex = pathName.lastIndexOf('uploads/');
      if (uploadIndex >= 0) return pathName.slice(uploadIndex);

      if (/^(products|sellers|wholesalers|wholesale)\//.test(pathName)) {
        return `uploads/${pathName}`;
      }

      return normalized;
    } catch {
      return normalized;
    }
  }

  const marker = 'uploads/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex);

  let publicPath = normalized;
  if (/^(products|sellers|wholesalers|wholesale)\//.test(publicPath)) {
    return `uploads/${publicPath}`;
  }

  return normalized;
};

const cleanSupabaseUrl = () => String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || '').replace(/\/+$/, '');
const supabaseServiceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabaseBucketCandidates = () => [
  process.env.SUPABASE_STORAGE_BUCKET,
  process.env.SUPABASE_BUCKET,
  process.env.SUPABASE_PRODUCT_IMAGES_BUCKET,
  process.env.SUPABASE_PUBLIC_BUCKET,
  ...(process.env.SUPABASE_STORAGE_BUCKETS || '').split(','),
  'product-images',
  'products',
  'uploads',
  'images',
].map((bucket) => String(bucket || '').trim()).filter(Boolean);

const parseSupabaseStorageSource = (source = '') => {
  const raw = String(source || '').trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const match = url.pathname.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/i);
    if (!match) return null;
    return {
      origin: url.origin,
      bucket: decodeURIComponent(match[1]),
      objectPath: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
};

const signSupabaseObjectUrl = async ({ origin, bucket, objectPath }) => {
  const baseUrl = cleanSupabaseUrl() || origin;
  const key = supabaseServiceKey();
  if (!baseUrl || !key || !bucket || !objectPath) return '';

  const cleanPath = String(objectPath).replace(/^\/+/, '');
  const signUrl = `${baseUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${cleanPath.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(signUrl, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: SUPABASE_SIGNED_URL_TTL_SECONDS }),
  });

  if (!response.ok) return '';
  const data = await response.json().catch(() => ({}));
  const signed = data.signedURL || data.signedUrl || data.url || '';
  if (!signed) return '';
  return /^https?:\/\//i.test(signed) ? signed : `${baseUrl}${signed.startsWith('/') ? '' : '/'}${signed}`;
};

const supabaseUrlCandidatesForPath = (source = '') => {
  const parsed = parseSupabaseStorageSource(source);
  if (parsed) return [parsed];

  const baseUrl = cleanSupabaseUrl();
  if (!baseUrl) return [];

  const normalized = publicUploadPathFromValue(source).replace(/^uploads\//, '').replace(/^\/+/, '');
  if (!normalized || /^https?:\/\//i.test(normalized)) return [];

  return supabaseBucketCandidates().map((bucket) => ({
    origin: baseUrl,
    bucket,
    objectPath: normalized,
  }));
};

const fetchRemoteMedia = async (source) => {
  const candidates = [];
  const normalizedSource = publicUploadPathFromValue(source);

  if (/^https?:\/\//i.test(normalizedSource)) {
    candidates.push(normalizedSource);
  }

  for (const candidate of supabaseUrlCandidatesForPath(source)) {
    const signedUrl = await signSupabaseObjectUrl(candidate);
    if (signedUrl) candidates.unshift(signedUrl);

    const baseUrl = cleanSupabaseUrl() || candidate.origin;
    if (baseUrl) {
      candidates.push(`${baseUrl}/storage/v1/object/public/${encodeURIComponent(candidate.bucket)}/${candidate.objectPath.split('/').map(encodeURIComponent).join('/')}`);
    }
  }

  const uniqueCandidates = [...new Set(candidates)];
  let lastResponse = null;
  for (const url of uniqueCandidates) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastResponse = response;
    } catch {
      // Try the next candidate; the route returns the final failure below.
    }
  }

  return lastResponse;
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

const sendStoredUploadByPath = async (filePath, res, next) => {
  await ensureStoredUploadsTable(pool);
  const result = await pool.query(
    'SELECT content_type, data FROM uploaded_files WHERE file_path = $1 LIMIT 1',
    [filePath]
  );
  const file = result.rows[0];
  if (!file) return false;

  const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
  const size = data.length;
  const contentType = file.content_type || 'application/octet-stream';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = res.req.headers.range;
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
      res.status(416).end();
      return true;
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    res.end(data.subarray(start, end + 1));
    return true;
  }

  res.setHeader('Content-Length', size);
  res.send(data);
  return true;
};

const sendFileUploadByPath = async (filePath, res) => {
  const cleanPath = publicUploadPathFromValue(filePath).replace(/^uploads\//, '');
  if (!cleanPath || cleanPath === filePath) return false;

  const roots = [UPLOAD_ROOT, path.resolve(process.cwd(), 'uploads')];
  for (const root of roots) {
    const absolutePath = path.resolve(root, cleanPath);
    if (!absolutePath.startsWith(path.resolve(root))) continue;
    if (!fs.existsSync(absolutePath)) continue;
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(absolutePath);
    return true;
  }

  return false;
};

const serveStoredUpload = async (req, res, next) => {
  try {
    const requestPath = normalizeUploadPath(req.path);
    const filePath = publicUploadPathFromValue(requestPath);
    if (!filePath || filePath === 'uploads') return next();

    if (await sendStoredUploadByPath(filePath, res, next)) return undefined;
    if (await sendFileUploadByPath(filePath, res)) return undefined;
    return next();
  } catch (error) {
    return next(error);
  }
};

const proxyMedia = async (req, res, next) => {
  try {
    const source = String(req.query.src || req.query.path || '').trim();
    if (!source) return res.status(400).json({ error: 'Media source is required' });

    const mediaPath = publicUploadPathFromValue(source);
    if (/^uploads\//.test(mediaPath)) {
      if (await sendStoredUploadByPath(mediaPath, res, next)) return undefined;
      if (await sendFileUploadByPath(mediaPath, res)) return undefined;
      return res.status(404).json({ error: 'Media file not found' });
    }

    if (/^https?:\/\//i.test(mediaPath) || supabaseUrlCandidatesForPath(source).length) {
      const response = await fetchRemoteMedia(source);
      if (!response) return res.status(502).json({ error: 'Remote media could not be reached' });
      if (!response.ok) return res.status(response.status).json({ error: 'Remote media could not be loaded' });

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const cacheControl = response.headers.get('cache-control') || 'public, max-age=3600';
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', cacheControl);
      res.setHeader('Content-Length', buffer.length);
      return res.send(buffer);
    }

    return res.status(404).json({ error: 'Media file not found' });
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
  proxyMedia,
  serveStoredUpload,
};

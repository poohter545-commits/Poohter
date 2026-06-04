const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const defaultUploadRoot = path.resolve(__dirname, '..', 'uploads');
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || defaultUploadRoot);
const SUPABASE_SIGNED_URL_TTL_SECONDS = Number(process.env.SUPABASE_SIGNED_URL_TTL_SECONDS || 3600);
const MAX_PROXY_MEDIA_BYTES = Number(process.env.MAX_PROXY_MEDIA_BYTES || 50 * 1024 * 1024);

const normalizeUploadPath = (value = '') => (
  String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
);

const decodePathSafely = (value = '') => {
  try {
    return decodeURIComponent(value);
  } catch {
    try {
      return decodeURI(value);
    } catch {
      return value;
    }
  }
};

const mediaLog = (message, details = {}) => {
  if (process.env.NODE_ENV === 'test') return;
  const payload = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  console.warn(`[media] ${message}${payload ? ` ${payload}` : ''}`);
};

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
  const normalized = normalizeUploadPath(decodePathSafely(value));
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

      const pathName = decodePathSafely(url.pathname).replace(/^\/+/, '');
      const uploadIndex = pathName.lastIndexOf('uploads/');
      if (uploadIndex >= 0) return pathName.slice(uploadIndex);

      const mediaSrc = url.searchParams.get('src') || url.searchParams.get('path');
      if (/\/api\/media$/i.test(url.pathname) && mediaSrc) {
        return publicUploadPathFromValue(mediaSrc);
      }

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

const storedPathCandidates = (value = '') => {
  const normalized = publicUploadPathFromValue(value);
  const candidates = new Set();
  const add = (candidate = '') => {
    const clean = publicUploadPathFromValue(candidate);
    if (clean) candidates.add(clean);
  };

  add(normalized);
  add(decodePathSafely(normalized));

  const withoutUploads = normalized.replace(/^uploads\//, '');
  if (withoutUploads && withoutUploads !== normalized) add(withoutUploads);
  if (withoutUploads && /^(products|sellers|wholesalers|wholesale)\//.test(withoutUploads)) add(`uploads/${withoutUploads}`);

  if (/^https?:\/\//i.test(String(value || ''))) {
    const parsed = parseSupabaseStorageSource(value);
    if (parsed) {
      add(parsed.objectPath);
      add(`uploads/${parsed.objectPath}`);
    }
  }

  return [...candidates];
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

  if (!response.ok) {
    mediaLog('Supabase signed URL failed', { bucket, objectPath: cleanPath, status: response.status });
    return '';
  }
  const data = await response.json().catch(() => ({}));
  const signed = data.signedURL || data.signedUrl || data.url || '';
  if (!signed) {
    mediaLog('Supabase signed URL response missing url', { bucket, objectPath: cleanPath });
    return '';
  }
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
    } catch (error) {
      mediaLog('Remote media candidate failed', { url, error: error.message });
    }
  }

  if (uniqueCandidates.length) {
    mediaLog('Remote media not loadable', { source, tried: uniqueCandidates.length, status: lastResponse?.status });
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

  const verify = await clientOrPool.query(
    'SELECT 1 FROM uploaded_files WHERE file_path = $1 LIMIT 1',
    [filePath]
  );
  if (!verify.rows.length) {
    mediaLog('Uploaded file was not persisted', { filePath });
    throw new Error(`Uploaded media could not be saved: ${filePath}`);
  }

  return filePath;
};

const persistUploadedFiles = async (files = [], clientOrPool = pool) => (
  Promise.all((Array.isArray(files) ? files : []).map((file) => persistUploadedFile(file, clientOrPool)))
);

const sendStoredUploadByPath = async (filePath, res, next) => {
  const candidates = storedPathCandidates(filePath);
  let result;
  try {
    await ensureStoredUploadsTable(pool);
    result = await pool.query(
      'SELECT content_type, data, file_path FROM uploaded_files WHERE file_path = ANY($1::text[]) LIMIT 1',
      [candidates]
    );
  } catch (error) {
    mediaLog('Stored media lookup failed, trying filesystem fallback', { filePath, error: error.message });
    return false;
  }
  const file = result.rows[0];
  if (!file) {
    mediaLog('Stored media not found', { filePath, candidates });
    return false;
  }

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
  const cleanPaths = storedPathCandidates(filePath)
    .map((candidate) => candidate.replace(/^uploads\//, ''))
    .filter(Boolean);
  if (!cleanPaths.length) return false;

  const roots = [UPLOAD_ROOT, path.resolve(process.cwd(), 'uploads')];
  for (const root of roots) {
    for (const cleanPath of cleanPaths) {
      const absolutePath = path.resolve(root, cleanPath);
      if (!absolutePath.startsWith(path.resolve(root))) continue;
      if (!fs.existsSync(absolutePath)) continue;
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.sendFile(absolutePath);
      return true;
    }
  }

  mediaLog('Filesystem media not found', { filePath, cleanPaths });
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
      mediaLog('Proxy media local missing', { source, mediaPath });
      return res.status(404).json({ error: 'Media file not found' });
    }

    if (/^https?:\/\//i.test(mediaPath) || supabaseUrlCandidatesForPath(source).length) {
      const response = await fetchRemoteMedia(source);
      if (!response) {
        mediaLog('Proxy remote media unreachable', { source });
        return res.status(502).json({ error: 'Remote media could not be reached' });
      }
      if (!response.ok) {
        mediaLog('Proxy remote media non-ok', { source, status: response.status });
        return res.status(response.status).json({ error: 'Remote media could not be loaded' });
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const cacheControl = response.headers.get('cache-control') || 'public, max-age=3600';
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength && contentLength > MAX_PROXY_MEDIA_BYTES) {
        mediaLog('Proxy remote media too large', { source, contentLength });
        return res.status(413).json({ error: 'Remote media is too large' });
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', cacheControl);
      if (contentLength) res.setHeader('Content-Length', contentLength);
      return response.body
        ? response.body.pipeTo(new WritableStream({
          write(chunk) {
            res.write(Buffer.from(chunk));
          },
          close() {
            res.end();
          },
          abort(error) {
            res.destroy(error);
          },
        }))
        : res.end();
    }

    mediaLog('Proxy media unsupported path', { source, mediaPath });
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
  storedPathCandidates,
  publicUploadPathFromValue,
  persistUploadedFile,
  persistUploadedFiles,
  publicUploadPath,
  proxyMedia,
  serveStoredUpload,
};

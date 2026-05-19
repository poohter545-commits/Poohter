const fs = require('fs');
const path = require('path');

const UPLOAD_ROOT = path.resolve(__dirname, '..', 'uploads');

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

module.exports = {
  UPLOAD_ROOT,
  ensureUploadDir,
  normalizeUploadPath,
  publicUploadPath,
};

const PAKISTANI_MOBILE_REGEX = /^\+923\d{9}$/;

const normalizePakistaniMobileNumber = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const compact = raw;
  if (/[^+\d]/.test(compact)) return null;

  let normalized = compact;
  if (/^03\d{9}$/.test(compact)) {
    normalized = `+92${compact.slice(1)}`;
  } else if (/^923\d{9}$/.test(compact)) {
    normalized = `+${compact}`;
  }

  return PAKISTANI_MOBILE_REGEX.test(normalized) ? normalized : null;
};

const requirePakistaniMobileNumber = (value, label = 'Phone number') => {
  const normalized = normalizePakistaniMobileNumber(value);
  if (!normalized) {
    const error = new Error(`${label} must be a valid Pakistani mobile number, for example 03XXXXXXXXX or +923XXXXXXXXX.`);
    error.status = 400;
    throw error;
  }
  return normalized;
};

module.exports = {
  normalizePakistaniMobileNumber,
  requirePakistaniMobileNumber,
};

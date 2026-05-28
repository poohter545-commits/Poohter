const ORDER_CODE_PATTERN = /POO-\d{8}-[A-Z0-9]+/i;

const extractOrderLookupValue = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return extractOrderLookupValue(
        parsed.order_code
        || parsed.orderCode
        || parsed.order_id
        || parsed.orderId
        || parsed.tracking_id
        || parsed.trackingId
        || parsed.id
      );
    }
  } catch {
    // Plain barcode text is the normal path.
  }

  try {
    const url = new URL(raw);
    const candidate = [
      'order_code',
      'orderCode',
      'order_id',
      'orderId',
      'tracking_id',
      'trackingId',
      'id',
    ].map((key) => url.searchParams.get(key)).find(Boolean);
    if (candidate) return extractOrderLookupValue(candidate);
  } catch {
    // Not a URL.
  }

  const codeMatch = raw.match(ORDER_CODE_PATTERN);
  if (codeMatch) return codeMatch[0].toUpperCase();

  const idMatch = raw.match(/\b\d{1,12}\b/);
  if (idMatch && raw.replace(idMatch[0], '').trim().length > 0) return idMatch[0];

  return raw.toUpperCase();
};

module.exports = {
  extractOrderLookupValue,
};

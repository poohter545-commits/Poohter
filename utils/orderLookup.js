const ORDER_CODE_PATTERN = /POO-\d{8}-[A-Z0-9]+/i;
const PRODUCT_UID_PATTERN = /PHT-\d{1,12}/i;
const RECEIPT_CODE_PATTERN = /RCT-\d{1,12}/i;

const extractOrderLookupValue = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return extractOrderLookupValue(
        parsed.product_uid
        || parsed.productUid
        || parsed.receipt_code
        || parsed.receiptCode
        || parsed.inventory_receipt
        || parsed.inventoryReceipt
        || parsed.receipt_id
        || parsed.receiptId
        || parsed.reference
        || parsed.ref
        || parsed.code
        || parsed.value
        || parsed.lookup
        || parsed.order_code
        || parsed.orderCode
        || parsed.order_id
        || parsed.orderId
        || parsed.wholesale_order_id
        || parsed.wholesaleOrderId
        || parsed.product_id
        || parsed.productId
        || parsed.inventory_id
        || parsed.inventoryId
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
      'product_uid',
      'productUid',
      'receipt_code',
      'receiptCode',
      'inventory_receipt',
      'inventoryReceipt',
      'receipt_id',
      'receiptId',
      'order_id',
      'orderId',
      'wholesale_order_id',
      'wholesaleOrderId',
      'product_id',
      'productId',
      'inventory_id',
      'inventoryId',
      'tracking_id',
      'trackingId',
      'reference',
      'ref',
      'code',
      'value',
      'lookup',
      'id',
    ].map((key) => url.searchParams.get(key)).find(Boolean);
    if (candidate) return extractOrderLookupValue(candidate);
  } catch {
    // Not a URL.
  }

  const codeMatch = raw.match(ORDER_CODE_PATTERN);
  if (codeMatch) return codeMatch[0].toUpperCase();

  const productUidMatch = raw.match(PRODUCT_UID_PATTERN);
  if (productUidMatch) return productUidMatch[0].toUpperCase();

  const receiptCodeMatch = raw.match(RECEIPT_CODE_PATTERN);
  if (receiptCodeMatch) return receiptCodeMatch[0].toUpperCase();

  const idMatch = raw.match(/\b\d{1,12}\b/);
  if (idMatch && raw.replace(idMatch[0], '').trim().length > 0) return idMatch[0];

  return raw.toUpperCase();
};

module.exports = {
  extractOrderLookupValue,
};

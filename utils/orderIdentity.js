const ORDER_STATUS_FLOW = ['pending', 'accepted', 'packed', 'shipped', 'out_for_delivery', 'delivered'];

const generateOrderCode = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `POO-${date}-${random}`;
};

const createUniqueOrderCode = async (client) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const orderCode = generateOrderCode();
    const existing = await client.query('SELECT 1 FROM orders WHERE order_code = $1', [orderCode]);
    if (existing.rows.length === 0) return orderCode;
  }

  return `POO-${Date.now()}`;
};

const validateStatusTransition = (currentStatus, newStatus) => {
  if (newStatus === 'cancelled') return { valid: true };

  const currentIndex = ORDER_STATUS_FLOW.indexOf(currentStatus);
  const nextIndex = ORDER_STATUS_FLOW.indexOf(newStatus);

  if (nextIndex === -1) return { valid: false, message: 'Invalid status value' };
  if (currentIndex === -1) return { valid: false, message: `Invalid current status: ${currentStatus}` };

  if (nextIndex !== currentIndex + 1) {
    return { valid: false, message: `Invalid jump: Cannot move from ${currentStatus} to ${newStatus}` };
  }

  return { valid: true };
};

module.exports = {
  ORDER_STATUS_FLOW,
  createUniqueOrderCode,
  validateStatusTransition
};

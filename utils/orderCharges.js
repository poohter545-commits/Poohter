const DEFAULT_DELIVERY_CHARGE = 99;
const DEFAULT_PACKING_MATERIAL_COST = 0;

const amountValue = (value, fallback = 0) => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ensureOrderChargeColumns = async (clientOrPool) => {
  await clientOrPool.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS delivery_charge NUMERIC(12,2) DEFAULT ${DEFAULT_DELIVERY_CHARGE},
      ADD COLUMN IF NOT EXISTS packing_material_cost NUMERIC(12,2) DEFAULT ${DEFAULT_PACKING_MATERIAL_COST},
      ADD COLUMN IF NOT EXISTS out_from_warehouse_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS out_for_delivery_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS customer_city TEXT,
      ADD COLUMN IF NOT EXISTS customer_address_notes TEXT,
      ADD COLUMN IF NOT EXISTS address_updated_by_admin TEXT,
      ADD COLUMN IF NOT EXISTS address_updated_at TIMESTAMP
  `);
};

const getOrderItemsSubtotal = async (clientOrPool, orderId) => {
  const result = await clientOrPool.query(
    `SELECT COALESCE(SUM(quantity * price), 0) AS subtotal
     FROM order_items
     WHERE order_id = $1`,
    [orderId]
  );
  return amountValue(result.rows[0]?.subtotal, 0);
};

module.exports = {
  DEFAULT_DELIVERY_CHARGE,
  DEFAULT_PACKING_MATERIAL_COST,
  amountValue,
  ensureOrderChargeColumns,
  getOrderItemsSubtotal,
};

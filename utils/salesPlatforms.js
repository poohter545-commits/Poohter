const slugify = (value) => String(value || 'platform')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'platform';

const ensureSalesPlatformsTable = async (clientOrPool) => {
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS sales_platforms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      code TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      default_commission_rate NUMERIC(7,4) DEFAULT 0,
      default_payment_fee_rate NUMERIC(7,4) DEFAULT 0,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await clientOrPool.query(`
    INSERT INTO sales_platforms (name, code, active, note)
    VALUES
      ('Poohter app', 'poohter-app', TRUE, 'Default Poohter owned storefront'),
      ('Daraz', 'daraz', TRUE, 'Default marketplace platform')
    ON CONFLICT (name) DO NOTHING
  `);
};

const getSalesPlatforms = async (clientOrPool, includeInactive = false) => {
  await ensureSalesPlatformsTable(clientOrPool);
  const result = await clientOrPool.query(
    `SELECT id, name, code, active, default_commission_rate, default_payment_fee_rate, note, created_at, updated_at
     FROM sales_platforms
     WHERE $1::boolean OR active = TRUE
     ORDER BY active DESC, name ASC`,
    [includeInactive]
  );
  return result.rows.map(row => ({
    ...row,
    default_commission_rate: Number(row.default_commission_rate || 0),
    default_payment_fee_rate: Number(row.default_payment_fee_rate || 0),
  }));
};

module.exports = {
  slugify,
  ensureSalesPlatformsTable,
  getSalesPlatforms,
};

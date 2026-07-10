const pool = require('../config/db');
const { getPagination } = require('../utils/pagination');
const { publicUploadPathFromValue } = require('../utils/uploads');

const getRequestOrigin = (req) => {
  const configuredOrigin = process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL;
  if (configuredOrigin) return configuredOrigin.replace(/\/+$/, '');

  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${protocol}://${req.get('host')}`;
};

const absoluteMediaUrl = (req, value) => {
  if (!value) return null;
  const rawValue = String(value).trim();
  const publicPath = publicUploadPathFromValue(rawValue);
  const source = publicPath || rawValue;
  if (!source) return null;
  return `${getRequestOrigin(req)}/api/media?src=${encodeURIComponent(source)}`;
};

const normalizeMediaFiles = (req, mediaFiles) => (
  Array.isArray(mediaFiles)
    ? mediaFiles.map((media) => ({
      ...media,
      file_path: publicUploadPathFromValue(media.file_path),
      url: absoluteMediaUrl(req, media.file_path),
    }))
    : []
);

const normalizeProduct = (req, product) => {
  const productImages = Array.isArray(product.product_images)
    ? product.product_images.map((image) => absoluteMediaUrl(req, image)).filter(Boolean)
    : [];
  const image = absoluteMediaUrl(req, product.image_url) || productImages[0] || null;

  return {
    ...product,
    price: Number(product.price || 0),
    stock_quantity: Number(product.stock_quantity || 0),
    image_url: publicUploadPathFromValue(product.image_url) || null,
    image,
    product_images: productImages,
    media_files: normalizeMediaFiles(req, product.media_files),
    rating: Number(product.rating || 0),
    review_count: Number(product.review_count || 0),
  };
};

const createProduct = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, price, description } = req.body;

    if (!name || name.toString().trim().length === 0 || price === undefined || price === null) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const parsedPrice = Number(price);
    if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ error: 'Price must be a non-negative integer' });
    }

    await client.query('BEGIN');

    const result = await client.query(
      'INSERT INTO products (name, price, description) VALUES ($1, $2, $3) RETURNING id, name, price, description, created_at',
      [name.toString().trim(), parsedPrice, description || null]
    );

    const newProduct = result.rows[0];

    // Initialize inventory with 0 stock for a default warehouse (ID 1)
    await client.query(
      'INSERT INTO inventory (product_id, warehouse_id, stock_quantity) VALUES ($1, $2, $3)',
      [newProduct.id, 1, 0]
    );

    await client.query('COMMIT');
    return res.status(201).json({ product: normalizeProduct(req, newProduct) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

const getProducts = async (req, res, next) => {
  try {
    const { limit, offset, nextOffset } = getPagination(req.query, { defaultLimit: 60, maxLimit: 100 });
    const result = await pool.query(
      `SELECT
        p.id,
        p.name,
        p.price,
        p.description,
        p.image_url,
        p.created_at,
        COALESCE(inventory_stock.stock_quantity, 0) AS stock_quantity,
        COALESCE(image_files.product_images, ARRAY[]::TEXT[]) AS product_images,
        COALESCE(media.media_files, '[]'::json) AS media_files,
        COALESCE(review_stats.rating, 0) AS rating,
        COALESCE(review_stats.review_count, 0) AS review_count
       FROM products p
       LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(i.stock_quantity), 0) AS stock_quantity
        FROM inventory i
        WHERE i.product_id = p.id
       ) inventory_stock ON TRUE
       LEFT JOIN LATERAL (
        SELECT COALESCE(array_agg(pm.file_path ORDER BY pm.created_at, pm.id), ARRAY[]::TEXT[]) AS product_images
        FROM product_media pm
        WHERE pm.product_id = p.id AND pm.type = 'image'
       ) image_files ON TRUE
       LEFT JOIN LATERAL (
        SELECT COALESCE(
          json_agg(json_build_object('id', pm.id, 'type', pm.type, 'file_path', pm.file_path) ORDER BY pm.created_at, pm.id),
          '[]'::json
        ) AS media_files
        FROM product_media pm
        WHERE pm.product_id = p.id
       ) media ON TRUE
       LEFT JOIN LATERAL (
        SELECT ROUND(AVG(pr.rating)::NUMERIC, 1) AS rating, COUNT(*)::INT AS review_count
        FROM product_reviews pr
        WHERE pr.product_id = p.id
       ) review_stats ON TRUE
       WHERE COALESCE(p.status, 'live') = 'live'
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return res.status(200).json({
      products: result.rows.map((product) => normalizeProduct(req, product)),
      pagination: {
        limit,
        offset,
        next_offset: result.rows.length === limit ? nextOffset : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

const getProductById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT
        p.id,
        p.name,
        p.price,
        p.description,
        p.image_url,
        p.created_at,
        COALESCE(inventory_stock.stock_quantity, 0) AS stock_quantity,
        COALESCE(image_files.product_images, ARRAY[]::TEXT[]) AS product_images,
        COALESCE(media.media_files, '[]'::json) AS media_files,
        COALESCE(review_stats.rating, 0) AS rating,
        COALESCE(review_stats.review_count, 0) AS review_count
       FROM products p
       LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(i.stock_quantity), 0) AS stock_quantity
        FROM inventory i
        WHERE i.product_id = p.id
       ) inventory_stock ON TRUE
       LEFT JOIN LATERAL (
        SELECT COALESCE(array_agg(pm.file_path ORDER BY pm.created_at, pm.id), ARRAY[]::TEXT[]) AS product_images
        FROM product_media pm
        WHERE pm.product_id = p.id AND pm.type = 'image'
       ) image_files ON TRUE
       LEFT JOIN LATERAL (
        SELECT COALESCE(
          json_agg(json_build_object('id', pm.id, 'type', pm.type, 'file_path', pm.file_path) ORDER BY pm.created_at, pm.id),
          '[]'::json
        ) AS media_files
        FROM product_media pm
        WHERE pm.product_id = p.id
       ) media ON TRUE
       LEFT JOIN LATERAL (
        SELECT ROUND(AVG(pr.rating)::NUMERIC, 1) AS rating, COUNT(*)::INT AS review_count
        FROM product_reviews pr
        WHERE pr.product_id = p.id
       ) review_stats ON TRUE
       WHERE p.id = $1 AND COALESCE(p.status, 'live') = 'live'
       LIMIT 1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.status(200).json(normalizeProduct(req, result.rows[0]));
  } catch (error) {
    next(error);
  }
};

const updateProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = [];
    const values = [];

    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
      values.push(name);
      updates.push(`name = $${values.length}`);
    }

    if (req.body.price !== undefined) {
      const price = Number(req.body.price);
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'Price must be a non-negative number' });
      }
      values.push(price);
      updates.push(`price = $${values.length}`);
    }

    if (req.body.description !== undefined) {
      values.push(req.body.description || null);
      updates.push(`description = $${values.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No product fields were provided' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE products
       SET ${updates.join(', ')}
       WHERE id = $${values.length}
       RETURNING id, name, price, description, image_url, created_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json({ product: normalizeProduct(req, result.rows[0]) });
  } catch (error) {
    next(error);
  }
};

const deleteProduct = async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE products
       SET status = 'archived'
       WHERE id = $1
       RETURNING id`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json({ message: 'Product archived successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
};

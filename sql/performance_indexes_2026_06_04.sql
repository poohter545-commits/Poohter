-- Safe, repeatable indexes for hot Poohter API lookup/list paths.
-- Run during a quiet deployment window; CONCURRENTLY is intentionally avoided
-- so this file can be pasted into Supabase SQL editor as a single script.

CREATE INDEX IF NOT EXISTS idx_orders_user_created
  ON orders(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_order_code_lower
  ON orders(LOWER(order_code));

CREATE INDEX IF NOT EXISTS idx_orders_external_ref_lower
  ON orders(LOWER(external_order_ref))
  WHERE external_order_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_created
  ON orders(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id
  ON order_items(order_id);

CREATE INDEX IF NOT EXISTS idx_order_items_product_id
  ON order_items(product_id);

CREATE INDEX IF NOT EXISTS idx_products_live_created
  ON products(created_at DESC, id DESC)
  WHERE COALESCE(status, 'live') = 'live';

CREATE INDEX IF NOT EXISTS idx_products_status_created
  ON products(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_seller_created
  ON products(seller_id, created_at DESC)
  WHERE seller_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_category_status
  ON products(category, status)
  WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_media_product_type_created
  ON product_media(product_id, type, created_at, id);

CREATE INDEX IF NOT EXISTS idx_inventory_product_warehouse
  ON inventory(product_id, warehouse_id);

CREATE INDEX IF NOT EXISTS idx_users_email_lower
  ON users(LOWER(email));

CREATE INDEX IF NOT EXISTS idx_users_phone
  ON users(phone);

CREATE INDEX IF NOT EXISTS idx_sellers_email_lower
  ON sellers(LOWER(email));

CREATE INDEX IF NOT EXISTS idx_sellers_cnic_number
  ON sellers(cnic_number);

CREATE INDEX IF NOT EXISTS idx_return_requests_order_status
  ON return_requests(order_id, status);

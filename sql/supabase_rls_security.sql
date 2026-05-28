-- Run this in the Supabase SQL editor for the production project.
-- It enables RLS across public tables and removes direct public access to
-- sensitive customer/order/seller data. The backend should continue using
-- DATABASE_URL/DIRECT_URL from server environment variables only.

BEGIN;

DO $$
DECLARE
  table_row record;
BEGIN
  FOR table_row IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tableowner IS NOT NULL
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', table_row.schemaname, table_row.tablename);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', 'service_role_manage_all', table_row.schemaname, table_row.tablename);
      EXECUTE format(
        'CREATE POLICY %I ON %I.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        'service_role_manage_all',
        table_row.schemaname,
        table_row.tablename
      );
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

GRANT USAGE ON SCHEMA public TO anon, authenticated;

DROP POLICY IF EXISTS public_read_live_products ON public.products;
CREATE POLICY public_read_live_products
  ON public.products
  FOR SELECT
  TO anon, authenticated
  USING (COALESCE(status, 'live') = 'live');

GRANT SELECT (
  id,
  name,
  price,
  description,
  image_url,
  created_at,
  status
) ON public.products TO anon, authenticated;

DROP POLICY IF EXISTS public_read_live_product_media ON public.product_media;
CREATE POLICY public_read_live_product_media
  ON public.product_media
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.products p
      WHERE p.id = product_media.product_id
        AND COALESCE(p.status, 'live') = 'live'
    )
  );

GRANT SELECT (
  id,
  product_id,
  type,
  file_path,
  created_at
) ON public.product_media TO anon, authenticated;

DROP POLICY IF EXISTS public_read_live_inventory ON public.inventory;
CREATE POLICY public_read_live_inventory
  ON public.inventory
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.products p
      WHERE p.id = inventory.product_id
        AND COALESCE(p.status, 'live') = 'live'
    )
  );

GRANT SELECT (
  product_id,
  warehouse_id,
  stock_quantity
) ON public.inventory TO anon, authenticated;

DROP POLICY IF EXISTS public_read_active_sales_platforms ON public.sales_platforms;
CREATE POLICY public_read_active_sales_platforms
  ON public.sales_platforms
  FOR SELECT
  TO anon, authenticated
  USING (active = true);

GRANT SELECT (
  id,
  name,
  code,
  active,
  created_at
) ON public.sales_platforms TO anon, authenticated;

-- No anon/authenticated direct access is granted for:
-- users, orders, order_items, cart_items, return_requests, delivery_updates,
-- sellers, wholesalers, payout/payment tables, OTP tables, or legal requests.
-- Those operations must go through the backend API.

COMMIT;

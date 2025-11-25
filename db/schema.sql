ALTER TABLE shopify_orders
  ADD COLUMN IF NOT EXISTS shipping_method TEXT;
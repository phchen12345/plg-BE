ALTER TABLE shopify_orders
  ADD COLUMN IF NOT EXISTS merchant_trade_no TEXT;
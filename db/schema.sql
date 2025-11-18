CREATE TABLE IF NOT EXISTS shopify_orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shopify_order_id BIGINT NOT NULL UNIQUE,
  shopify_order_name TEXT NOT NULL,
  shopify_order_number INTEGER,
  currency TEXT,
  subtotal_price TEXT,
  total_price TEXT,
  financial_status TEXT,
  fulfillment_status TEXT,
  status_url TEXT,
  line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_user_id
  ON shopify_orders(user_id);
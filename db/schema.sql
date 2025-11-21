CREATE TABLE IF NOT EXISTS ecpay_transactions (
  merchant_trade_no TEXT PRIMARY KEY,
  user_id TEXT,
  total_amount INTEGER NOT NULL,
  order_payload JSONB NOT NULL,
  shopify_order_id BIGINT,
  shopify_order_name TEXT,
  shopify_order_number INTEGER,
  allpay_logistics_id TEXT,
  logistics_subtype TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

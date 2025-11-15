BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT        NOT NULL UNIQUE,
  password_hash TEXT,
  email_verified BOOLEAN  NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT        NOT NULL UNIQUE,
  code       TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  is_used    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  tag         TEXT,
  price_cents INTEGER     NOT NULL CHECK (price_cents >= 0),
  image_url   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS carts (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT      NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cart_items (
  id         BIGSERIAL PRIMARY KEY,
  cart_id    BIGINT      NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id BIGINT      NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity   INTEGER     NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cart_items_unique_product UNIQUE (cart_id, product_id)
);
COMMIT;

INSERT INTO users (email, password_hash, email_verified, is_admin)
VALUES (
  'admin@example.com',
  crypt('123456', gen_salt('bf')),
  TRUE,
  TRUE
);
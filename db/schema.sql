ALTER TABLE ecpay_transactions
  ALTER COLUMN user_id TYPE TEXT USING user_id::text;
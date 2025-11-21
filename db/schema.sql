UPDATE ecpay_transactions
SET allpay_logistics_id = 'your-logistics-id',
    logistics_subtype = 'FAMIC2C',
    updated_at = NOW()
WHERE merchant_trade_no = 'EC1234567890';
// routes/ecpay.js
import express, { Router } from "express";
import crypto from "crypto";
import axios from "axios";
import pool from "../db/db.js";
import { requireAuth } from "../middleware/auth.js";
import { channel } from "diagnostics_channel";

const router = Router();
router.use(express.urlencoded({ extended: false }));

const ECPAY_MERCHANT_ID = process.env.ECPAY_MERCHANT_ID ?? "2000132";
const ECPAY_HASH_KEY = process.env.ECPAY_HASH_KEY ?? "5294y06JbISpM5x9";
const ECPAY_HASH_IV = process.env.ECPAY_HASH_IV ?? "v77hoKGq4kWxNNIS";
const ECPAY_BASE_URL =
  process.env.ECPAY_PAYMENT_URL ??
  "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2024-04";
const SERVER_BASE_URL =
  process.env.SERVER_BASE_URL ??
  process.env.BASE_URL ??
  "http://localhost:3001";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
  console.warn("[ecpay] Missing Shopify Admin API credentials.");
}

const shopifyClient = axios.create({
  baseURL: `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`,
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
  },
  timeout: 15000,
});

const internalClient = axios.create({
  baseURL: SERVER_BASE_URL,
  timeout: 15000,
});

const padZero = (num) => String(num).padStart(2, "0");

const formatDate = (date) => {
  const year = date.getFullYear();
  const month = padZero(date.getMonth() + 1);
  const day = padZero(date.getDate());
  const hours = padZero(date.getHours());
  const minutes = padZero(date.getMinutes());
  const seconds = padZero(date.getSeconds());
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
};

const encodeParams = (params) => {
  const query = Object.keys(params)
    .filter((key) => params[key] !== undefined) // 保留 ""
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  const raw = `HashKey=${ECPAY_HASH_KEY}&${query}&HashIV=${ECPAY_HASH_IV}`;

  const encoded = encodeURIComponent(raw)
    .toLowerCase()
    .replace(/%2d/g, "-")
    .replace(/%5f/g, "_")
    .replace(/%2e/g, ".")
    .replace(/%21/g, "!")
    .replace(/%2a/g, "*")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%20/g, "+");

  return crypto
    .createHash("sha256")
    .update(encoded)
    .digest("hex")
    .toUpperCase();
};

const persistPendingOrder = async ({
  tradeNo,
  userId,
  totalAmount,
  orderPayload,
}) => {
  await pool.query(
    `INSERT INTO ecpay_transactions (
       merchant_trade_no,
       user_id,
       total_amount,
       order_payload,
       created_at,
       updated_at
     )
     VALUES ($1,$2,$3,$4,NOW(),NOW())
     ON CONFLICT (merchant_trade_no)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       total_amount = EXCLUDED.total_amount,
       order_payload = EXCLUDED.order_payload,
       processed_at = NULL,
       shopify_order_id = NULL,
       shopify_order_name = NULL,
       shopify_order_number = NULL,
       updated_at = NOW()`,
    [tradeNo, userId, totalAmount, JSON.stringify(orderPayload)]
  );
};

const fetchPendingOrder = async (tradeNo) => {
  const { rows } = await pool.query(
    `SELECT merchant_trade_no,
            user_id,
            total_amount,
            order_payload,
            processed_at
       FROM ecpay_transactions
      WHERE merchant_trade_no = $1
      LIMIT 1`,
    [tradeNo]
  );
  return rows[0] ?? null;
};

const markTransactionProcessed = async (tradeNo, order) => {
  await pool.query(
    `UPDATE ecpay_transactions
        SET processed_at = NOW(),
            shopify_order_id = $2,
            shopify_order_name = $3,
            shopify_order_number = $4,
            updated_at = NOW()
      WHERE merchant_trade_no = $1`,
    [
      tradeNo,
      order?.id ?? null,
      order?.name ?? null,
      order?.order_number ?? null,
    ]
  );
};

const buildShopifyOrderPayload = (storedOrder = {}, paymentResult = {}) => {
  const shippingMethod = storedOrder?.shipping?.method ?? "home";
  const shippingAddress =
    shippingMethod === "home"
      ? {
          first_name: storedOrder.shipping?.address?.receiver ?? "PLG",
          address1: storedOrder.shipping?.address?.detail ?? "",
          city: storedOrder.shipping?.address?.city ?? "",
          province: storedOrder.shipping?.address?.district ?? "",
          country: "TW",
        }
      : {
          first_name: storedOrder.shipping?.store?.name ?? "CVS",
          last_name: storedOrder.shipping?.store?.id ?? "",
          address1: storedOrder.shipping?.store?.address ?? "",
          phone: storedOrder.shipping?.store?.phone ?? "",
          city: "便利商店",
          province: storedOrder.shipping?.store?.logisticsSubType ?? "",
          country: "TW",
        };

  const lineItems =
    storedOrder.items?.map((item) => ({
      title: item.name ?? `PLG 商品 #${item.productId ?? ""}`,
      quantity: item.quantity ?? 1,
      price: Number(item.priceCents ?? 0).toFixed(2),
      sku: item.productId ? String(item.productId) : undefined,
      variant_id: item.shopifyVariantId
        ? Number(item.shopifyVariantId)
        : undefined,
    })) ?? [];

  const amount =
    Number(storedOrder?.totals?.total ?? paymentResult.TotalAmount ?? 0) || 0;

  const baseOrder = {
    line_items: lineItems.length
      ? lineItems
      : [
          {
            title: storedOrder.description ?? "PLG order",
            quantity: 1,
            price: amount.toFixed(2),
          },
        ],
    currency: "TWD",
    financial_status: "paid",
    tags: `plg-ecpay,ship-${shippingMethod}`,
    shipping_address: shippingAddress,
    note: `ECPay TradeNo: ${paymentResult.MerchantTradeNo ?? ""}`,
    note_attributes: [
      { name: "ecpay_trade_no", value: paymentResult.TradeNo ?? "" },
      { name: "ecpay_rtn_msg", value: paymentResult.RtnMsg ?? "" },
    ],
    transactions: [
      {
        kind: "sale",
        status: "success",
        amount: amount.toFixed(2),
        gateway: "ECPay",
        authorization: paymentResult.TradeNo ?? "",
        processed_at: new Date().toISOString(),
      },
    ],
  };

  return { order: baseOrder };
};

const mapLineItems = (items = []) =>
  items.map((item) => ({
    id: item.id,
    title: item.title,
    quantity: item.quantity,
    price: item.price,
    sku: item.sku,
  }));

const saveShopifyOrderRecord = async (userId, order) => {
  if (!userId || !order?.id) {
    return;
  }
  const lineItemsSnapshot = mapLineItems(order.line_items ?? []);
  await pool.query(
    `INSERT INTO shopify_orders (
       user_id,
       shopify_order_id,
       shopify_order_name,
       shopify_order_number,
       currency,
       subtotal_price,
       total_price,
       financial_status,
       fulfillment_status,
       status_url,
       line_items
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (shopify_order_id)
     DO UPDATE SET
       currency = EXCLUDED.currency,
       subtotal_price = EXCLUDED.subtotal_price,
       total_price = EXCLUDED.total_price,
       financial_status = EXCLUDED.financial_status,
       fulfillment_status = EXCLUDED.fulfillment_status,
       status_url = EXCLUDED.status_url,
       line_items = EXCLUDED.line_items,
       user_id = EXCLUDED.user_id,
       shopify_order_name = EXCLUDED.shopify_order_name,
       shopify_order_number = EXCLUDED.shopify_order_number,
       updated_at = NOW()`,
    [
      userId,
      order.id,
      order.name,
      order.order_number,
      order.currency,
      order.subtotal_price,
      order.total_price,
      order.financial_status,
      order.fulfillment_status,
      order.order_status_url,
      JSON.stringify(lineItemsSnapshot),
    ]
  );
};

const saveLogisticsInfo = async (
  merchantTradeNo,
  logisticsId,
  logisticsSubType
) => {
  if (!merchantTradeNo || !logisticsId) {
    return;
  }
  await pool.query(
    `UPDATE ecpay_transactions
        SET allpay_logistics_id = $1,
            logistics_subtype = $2,
            updated_at = NOW()
      WHERE merchant_trade_no = $3`,
    [logisticsId, logisticsSubType ?? "", merchantTradeNo]
  );
};

const LOGISTICS_SUBTYPE_MAP = {
  seveneleven: "UNIMARTC2C",
  familymart: "FAMIC2C",
};

const createLogisticsOrder = async (tradeNo, pendingOrder) => {
  const shipping = pendingOrder.order_payload?.shipping;
  if (!shipping || shipping.method === "home" || !shipping.store?.id) {
    return null;
  }

  const subtype =
    LOGISTICS_SUBTYPE_MAP[shipping.method] ?? shipping.store?.logisticsSubType;

  if (!subtype) {
    return null;
  }

  const firstItem = pendingOrder.order_payload?.items?.[0];
  const goodsName = firstItem?.name ?? "PLG 商品";

  const payload = {
    merchantTradeNo: tradeNo,
    logisticsSubType: subtype,
    goodsAmount: pendingOrder.total_amount ?? 100,
    goodsName,
    receiverName: shipping.store?.name ?? "CVS Receiver",
    receiverPhone: shipping.store?.phone ?? "0911222333",
    receiverStoreId: shipping.store?.id,
  };

  try {
    const { data } = await internalClient.post(
      "/api/logistics/shipping-order",
      payload
    );
    console.log("[logistics] shipping-order response成功回應", data);

    let responseData = data?.response;
    if (typeof responseData === "string") {
      try {
        responseData = JSON.parse(responseData);
      } catch (_err) {
        responseData = null;
      }
    }

    return responseData;
  } catch (err) {
    console.error("[logistics] shipping-order failed失敗", err);
    return null;
  }
};

router.post("/checkout", requireAuth, async (req, res, next) => {
  try {
    const { tradeNo, totalAmount, description, returnURL, order } = req.body;

    if (!tradeNo || !totalAmount) {
      return res.status(400).json({ message: "缺少交易編號或金額" });
    }
    if (!order?.items?.length) {
      return res.status(400).json({ message: "缺少訂單明細" });
    }

    const total = Math.round(Number(totalAmount) || 0);
    await persistPendingOrder({
      tradeNo,
      userId: req.user.sub,
      totalAmount: total,
      orderPayload: order,
    });

    const payload = {
      MerchantID: ECPAY_MERCHANT_ID,
      MerchantTradeNo: tradeNo,
      MerchantTradeDate: formatDate(new Date()),
      PaymentType: "aio",
      TotalAmount: String(total),
      TradeDesc: description ?? "PLG order",
      ItemName: "PLG item",
      ReturnURL:
        returnURL ?? "https://plg-be.onrender.com/api/ecpay/payment-return",
      ChoosePayment: "Credit",
      EncryptType: "1",
    };

    const CheckMacValue = encodeParams(payload);

    res.json({
      action: ECPAY_BASE_URL,
      fields: { ...payload, CheckMacValue },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/payment-return", async (req, res) => {
  const payload = req.body;

  const receivedCheckMac = payload.CheckMacValue;
  const { CheckMacValue: _, ...others } = payload;
  const calculated = encodeParams(others);

  if (receivedCheckMac !== calculated) {
    console.warn("[payment-return] CheckMac mismatch", payload.MerchantTradeNo);
    return res.status(400).send("0|CheckMacValue Error");
  }

  if (payload.RtnCode !== "1") {
    console.log("[payment-return] non-success RtnCode", payload.RtnCode);
    return res.send("1|OK");
  }

  const pendingOrder = await fetchPendingOrder(payload.MerchantTradeNo);
  if (!pendingOrder) {
    return res.status(404).send("0|Order Not Found");
  }

  if (pendingOrder.processed_at) {
    return res.send("1|OK");
  }

  try {
    const shopifyPayload = buildShopifyOrderPayload(
      pendingOrder.order_payload,
      payload
    );

    const { data } = await shopifyClient.post("/orders.json", shopifyPayload);
    const shopifyOrder = data?.order;

    if (!shopifyOrder?.id) {
      throw new Error("Shopify did not return order id");
    }
    await markTransactionProcessed(payload.MerchantTradeNo, shopifyOrder);
    await saveShopifyOrderRecord(pendingOrder.user_id, shopifyOrder);
    const logisticsResult = await createLogisticsOrder(
      payload.MerchantTradeNo,
      pendingOrder
    );
    if (logisticsResult?.AllPayLogisticsID) {
      await saveLogisticsInfo(
        payload.MerchantTradeNo,
        logisticsResult.AllPayLogisticsID,
        logisticsResult.LogisticsSubType
      );
    }
    return res.send("1|OK");
  } catch (err) {
    console.error(
      "[ecpay] Shopify order creation failed",
      err.response?.data ?? err
    );
    return res.status(500).send("0|Shopify Order Failed");
  }
});

export default router;

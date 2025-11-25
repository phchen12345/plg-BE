// routes/ecpay.js
import express, { Router } from "express";
import crypto from "crypto";
import axios from "axios";
import pool from "../db/db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(express.urlencoded({ extended: false }));

const ECPAY_MERCHANT_ID = "2000132";
const ECPAY_HASH_KEY = "5294y06JbISpM5x9";
const ECPAY_HASH_IV = "v77hoKGq4kWxNNIS";
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
    .filter((key) => params[key] !== undefined)
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

const markTransactionProcessed = async (
  tradeNo,
  shopifyOrderId,
  shopifyOrderName,
  shopifyOrderNumber
) => {
  await pool.query(
    `UPDATE ecpay_transactions
        SET processed_at = NOW(),
            shopify_order_id = $2,
            shopify_order_name = $3,
            shopify_order_number = $4,
            updated_at = NOW()
      WHERE merchant_trade_no = $1`,
    [tradeNo, shopifyOrderId, shopifyOrderName, shopifyOrderNumber]
  );
};

const resolveShippingMethod = (order = {}, pendingOrder = {}) => {
  if (pendingOrder?.shipping?.method) {
    return pendingOrder.shipping.method;
  }
  const tags = (order.tags ?? "").toLowerCase();
  if (tags.includes("plg-cvs-seveneleven")) return "seveneleven";
  if (tags.includes("plg-cvs-familymart")) return "familymart";
  if (tags.includes("plg-home-delivery")) return "home";
  return null;
};

const saveShopifyOrderRecord = async (order, userId, pendingOrder = null) => {
  if (!order?.id) return;
  const lineItemsSnapshot = (order.line_items ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    quantity: item.quantity,
    price: item.price,
    sku: item.sku,
  }));

  const shippingMethod = resolveShippingMethod(
    order,
    pendingOrder?.order_payload
  );

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
       shipping_method,
       merchant_trade_no,
       line_items
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (shopify_order_id)
     DO UPDATE SET
       currency = EXCLUDED.currency,
       subtotal_price = EXCLUDED.subtotal_price,
       total_price = EXCLUDED.total_price,
       financial_status = EXCLUDED.financial_status,
       fulfillment_status = EXCLUDED.fulfillment_status,
       shipping_method = EXCLUDED.shipping_method,
       line_items = EXCLUDED.line_items,
       user_id = EXCLUDED.user_id,
       shopify_order_name = EXCLUDED.shopify_order_name,
       shopify_order_number = EXCLUDED.shopify_order_number,
       merchant_trade_no = EXCLUDED.merchant_trade_no,
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
      shippingMethod,
      merchantTradeNo,
      JSON.stringify(lineItemsSnapshot),
    ]
  );
};

const saveLogisticsInfo = async (
  merchantTradeNo,
  logisticsId,
  logisticsSubType,
  cvsPaymentNo,
  cvsValidationNo
) => {
  if (!merchantTradeNo || !logisticsId) {
    return;
  }
  await pool.query(
    `UPDATE ecpay_transactions
        SET allpay_logistics_id = $1,
            logistics_subtype = $2,
            cvs_payment_no = COALESCE($3, cvs_payment_no),
            cvs_validation_no = COALESCE($4, cvs_validation_no),
            updated_at = NOW()
      WHERE merchant_trade_no = $5`,
    [
      logisticsId,
      logisticsSubType ?? "",
      cvsPaymentNo ?? null,
      cvsValidationNo ?? null,
      merchantTradeNo,
    ]
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
  if (!subtype) return null;

  const firstItem = pendingOrder.order_payload?.items?.[0];
  const goodsName = firstItem?.name ?? "PLG 商品";

  const payload = {
    merchantTradeNo: tradeNo,
    logisticsSubType: subtype,
    MerchantTradeDate: formatDate(new Date()),
    goodsAmount: pendingOrder.total_amount ?? 500,
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

    let responseData = data?.response;
    if (typeof responseData === "string") {
      if (responseData.startsWith("1|")) {
        const [, kv] = responseData.split("|", 2);
        const parsed = {};
        kv.split("&").forEach((pair) => {
          const [k, v] = pair.split("=");
          parsed[k] = v ?? "";
        });
        responseData = parsed;
      } else {
        try {
          responseData = JSON.parse(responseData);
        } catch (_err) {
          responseData = null;
        }
      }
    }

    return responseData;
  } catch (err) {
    console.error("[logistics] shipping-order failed", err);
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
      ClientBackURL: "https://plg-test.vercel.app/orders",
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
  try {
    const {
      RtnCode,
      RtnMsg,
      MerchantTradeNo,
      TradeNo,
      TradeAmt,
      PaymentDate,
      PaymentType,
      SimulatePaid,
      CheckMacValue,
    } = req.body;

    console.log("[ecpay] payment-return", req.body);

    if (!MerchantTradeNo || !CheckMacValue) {
      return res.status(400).send("0|Fail");
    }

    const pendingOrder = await fetchPendingOrder(MerchantTradeNo);
    if (!pendingOrder) {
      console.warn("[ecpay] payment-return missing pending order");
      return res.status(404).send("0|Order Not Found");
    }
    if (pendingOrder.processed_at) {
      return res.send("1|OK");
    }

    const verifyParams = { ...req.body };
    const receivedMac = verifyParams.CheckMacValue;
    delete verifyParams.CheckMacValue;

    const calculatedMac = encodeParams(verifyParams);
    if (receivedMac !== calculatedMac) {
      console.error("[ecpay] payment-return CheckMacValue mismatch");
      return res.status(400).send("0|Invalid CheckMacValue");
    }

    if (Number(RtnCode) !== 1) {
      console.error("[ecpay] payment-return failed", RtnCode, RtnMsg);
      return res.status(400).send("0|Fail");
    }

    if (Number(TradeAmt) !== Number(pendingOrder.total_amount)) {
      console.error("[ecpay] payment-return amount mismatch");
      return res.status(400).send("0|Amount Mismatch");
    }

    const orderPayload = pendingOrder.order_payload ?? {};
    const lineItems = orderPayload.items ?? [];
    const shipping = orderPayload.shipping ?? {};
    const shippingStore = shipping.store ?? null;

    const shopifyOrderPayload = {
      order: {
        line_items: lineItems.map((item) => ({
          title: item.name ?? `PLG 商品 #${item.productId}`,
          quantity: item.quantity,
          price: (item.priceCents ?? 0 / 100).toFixed(2),
          sku: String(item.productId),
        })),
        financial_status: "paid",
        fulfillment_status: "unfulfilled",
        tags:
          shipping.method === "home"
            ? "plg-home-delivery"
            : `plg-cvs-${shipping.method}`,
        shipping_address:
          shipping.method === "home"
            ? {
                first_name: shipping.address?.receiver ?? "PLG",
                address1: shipping.address?.detail ?? "",
                city: shipping.address?.city ?? "",
                province: shipping.address?.district ?? "",
                zip: shipping.address?.postal ?? "",
                country: "TW",
              }
            : {
                first_name: shippingStore?.name ?? "CVS",
                last_name: shippingStore?.id ?? "",
                address1: shippingStore?.address ?? "",
                phone: shippingStore?.phone ?? "",
                city: "台灣",
                province: shippingStore?.logisticsSubType ?? "",
                country: "TW",
              },
        note: shipping.method === "home" ? "宅配" : "超商取貨付款",
        note_attributes:
          shipping.method === "home"
            ? []
            : [
                { name: "storeId", value: shippingStore?.id ?? "" },
                { name: "storeName", value: shippingStore?.name ?? "" },
                { name: "storeAddress", value: shippingStore?.address ?? "" },
                {
                  name: "logisticsSubType",
                  value: shippingStore?.logisticsSubType ?? "",
                },
              ],
      },
    };

    const shopifyResp = await shopifyClient.post(
      "/orders.json",
      shopifyOrderPayload
    );
    const shopifyOrder = shopifyResp.data?.order;
    if (!shopifyOrder?.id) {
      console.error("[ecpay] shopify order creation failed", shopifyResp.data);
      return res.status(502).send("0|Shopify Error");
    }

    await saveShopifyOrderRecord(
      shopifyOrder,
      pendingOrder.user_id,
      pendingOrder,
      MerchantTradeNo
    );
    await markTransactionProcessed(
      MerchantTradeNo,
      shopifyOrder.id,
      shopifyOrder.name,
      shopifyOrder.order_number
    );

    if (shipping.method !== "home") {
      const logisticsResponse = await createLogisticsOrder(
        MerchantTradeNo,
        pendingOrder
      );
      if (logisticsResponse && logisticsResponse.AllPayLogisticsID) {
        await saveLogisticsInfo(
          MerchantTradeNo,
          logisticsResponse.AllPayLogisticsID,
          logisticsResponse.LogisticsSubType,
          logisticsResponse.CVSPaymentNo,
          logisticsResponse.CVSValidationNo
        );
      }
    }

    res.send("1|OK");
  } catch (err) {
    console.error("[ecpay] payment-return error", err);
    res.status(500).send("0|Error");
  }
});

router.post("/client-return", (req, res) => {
  console.log("[ecpay] client-return body", req.body);
  res.redirect(302, "https://plg-test.vercel.app/orders");
});

export default router;

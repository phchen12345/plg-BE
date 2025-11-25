// routes/orders.js
import { Router } from "express";
import axios from "axios";
import { requireAuth } from "../middleware/auth.js";
import pool from "../db/db.js";

const router = Router();

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2024-04";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
  console.warn(
    "[orders] Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN – order creation will fail."
  );
}

const shopifyClient = axios.create({
  baseURL: `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`,
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
  },
  timeout: 15000,
});

const mapLineItems = (items = []) =>
  items.map((item) => ({
    id: item.id,
    title: item.title,
    quantity: item.quantity,
    price: item.price,
    sku: item.sku,
  }));

router.post("/orders", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { items, shipping } = req.body ?? {};
    if (!items?.length) {
      return res.status(400).json({ message: "缺少商品資料" });
    }
    if (!shipping?.method) {
      return res.status(400).json({ message: "缺少配送方式" });
    }
    if (
      shipping.method === "home" &&
      (!shipping.address?.city ||
        !shipping.address?.district ||
        !shipping.address?.detail)
    ) {
      return res.status(400).json({ message: "宅配地址不完整" });
    }
    if (shipping.method !== "home" && !shipping.store?.id) {
      return res.status(400).json({ message: "尚未選擇門市" });
    }

    const lineItems = items.map((item) => ({
      title: item.name ?? `PLG 商品 #${item.productId}`,
      quantity: item.quantity,
      price: item.priceCents.toFixed(2),
      sku: String(item.productId),
    }));

    const shippingAddress =
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
            first_name: shipping.store?.name ?? "CVS",
            last_name: shipping.store?.id ?? "",
            address1: shipping.store?.address ?? "",
            phone: shipping.store?.phone ?? "",
            city: "便利商店",
            province: shipping.store?.logisticsSubType ?? "",
            country: "TW",
          };

    const noteAttributes =
      shipping.method === "home"
        ? []
        : [
            { name: "storeId", value: shipping.store?.id ?? "" },
            { name: "storeName", value: shipping.store?.name ?? "" },
            { name: "storeAddress", value: shipping.store?.address ?? "" },
            {
              name: "logisticsSubType",
              value: shipping.store?.logisticsSubType ?? "",
            },
          ];

    const payload = {
      order: {
        line_items: lineItems,
        financial_status: "pending",
        fulfillment_status: "unfulfilled",
        tags:
          shipping.method === "home"
            ? "plg-home-delivery"
            : `plg-cvs-${shipping.method}`,
        shipping_address: shippingAddress,
        note: shipping.method === "home" ? "宅配訂單" : "超商取貨",
        note_attributes: noteAttributes,
      },
    };

    const { data } = await shopifyClient.post("/orders.json", payload);
    const order = data?.order;
    if (!order?.id) {
      return res.status(502).json({ message: "Shopify 未回傳訂單資訊" });
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
         line_items
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (shopify_order_id)
       DO UPDATE SET
         currency = EXCLUDED.currency,
         subtotal_price = EXCLUDED.subtotal_price,
         total_price = EXCLUDED.total_price,
         financial_status = EXCLUDED.financial_status,
         fulfillment_status = EXCLUDED.fulfillment_status,
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
        JSON.stringify(lineItemsSnapshot),
      ]
    );

    res.status(201).json({ orderId: order.id, order });
  } catch (err) {
    if (axios.isAxiosError(err)) {
      return res
        .status(err.response?.status ?? 500)
        .json({ message: err.response?.data?.errors ?? err.message });
    }
    next(err);
  }
});

router.get("/orders", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 10, 1),
      50
    );
    const { rows } = await pool.query(
      `SELECT
         shopify_order_id AS "id",
         shopify_order_name AS "name",
         shopify_order_number AS "number",
         currency,
         subtotal_price AS "subtotalPrice",
         total_price AS "totalPrice",
         financial_status AS "financialStatus",
         fulfillment_status AS "fulfillmentStatus",
         shipping_method AS "shippingMethod",
         line_items AS "lineItems",
         created_at AS "createdAt"
       FROM shopify_orders
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    const orders = rows.map((row) => ({
      ...row,
      lineItems: Array.isArray(row.lineItems)
        ? row.lineItems
        : mapLineItems(row.lineItems ?? []),
    }));

    res.json({ orders });
  } catch (err) {
    if (axios.isAxiosError(err)) {
      return res
        .status(err.response?.status ?? 500)
        .json({ message: err.response?.data?.errors ?? err.message });
    }
    next(err);
  }
});

export default router;

import { Router } from "express";
import crypto from "crypto";
import pool from "../db/db.js";

const router = Router();
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET ?? "";

function verifyShopifyHmac(rawBody, hmacHeader) {
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader ?? "", "utf8")
  );
}

router.post("/shopify", async (req, res) => {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  if (!verifyShopifyHmac(req.body, hmac)) {
    return res.status(401).send("Invalid signature");
  }

  const payload = JSON.parse(req.body.toString("utf8"));
  const shopifyOrderId = payload.id;
  if (!shopifyOrderId) return res.status(400).send("Missing order id");

  await pool.query(
    `UPDATE shopify_orders
         SET financial_status = $2,
             fulfillment_status = $3,
             total_price = $4,
             subtotal_price = $5,
             status_url = COALESCE($6, status_url),
             line_items = COALESCE($7, line_items),
             updated_at = NOW()
       WHERE shopify_order_id = $1`,
    [
      shopifyOrderId,
      payload.financial_status,
      payload.fulfillment_status,
      payload.total_price,
      payload.subtotal_price,
      payload.order_status_url,
      JSON.stringify(
        payload.line_items?.map((item) => ({
          id: item.id,
          title: item.title,
          quantity: item.quantity,
          price: item.price,
          sku: item.sku,
        })) ?? []
      ),
    ]
  );

  console.log("raw payload type:", typeof req.body);

  res.status(200).send("ok");
});

export default router;

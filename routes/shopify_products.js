// routes/shopify_products.js
import { Router } from "express";
import axios from "axios";

const router = Router();

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2024-04";

router.get("/:productId/variants", async (req, res, next) => {
  try {
    if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
      return res.status(500).json({ message: "Shopify Admin API 未設定" });
    }

    const productId = req.params.productId;
    const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products/${productId}.json`;

    const { data } = await axios.get(endpoint, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    });

    const variants =
      data?.product?.variants?.map((variant) => ({
        id: variant.id,
        gid: `gid://shopify/ProductVariant/${variant.id}`,
        title: variant.title,
        sku: variant.sku,
      })) ?? [];

    res.json({ productId, variants });
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

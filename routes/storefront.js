import { Router } from "express";
import axios from "axios";

const router = Router();

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_STOREFRONT_ACCESS_TOKEN =
  process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
const SHOPIFY_STOREFRONT_VERSION =
  process.env.SHOPIFY_STOREFRONT_VERSION ?? "2024-04";

const graphqlEndpoint = SHOPIFY_STORE_DOMAIN
  ? `https://${SHOPIFY_STORE_DOMAIN}/api/${SHOPIFY_STOREFRONT_VERSION}/graphql.json`
  : "";

const cartCreateMutation = `
  mutation cartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart {
        id
        checkoutUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

router.post("/checkout", async (req, res, next) => {
  try {
    if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_STOREFRONT_ACCESS_TOKEN) {
      return res
        .status(500)
        .json({ message: "Shopify Storefront API 未設定" });
    }

    const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!rawLines.length) {
      return res.status(400).json({ message: "缺少商品資料" });
    }

    const lines = rawLines
      .map((line) => ({
        merchandiseId: line.merchandiseId,
        quantity: Math.max(1, Number(line.quantity) || 1),
        sellingPlanId: line.sellingPlanId,
        attributes: line.attributes,
      }))
      .filter((line) => typeof line.merchandiseId === "string");

    if (!lines.length) {
      return res.status(400).json({ message: "缺少有效的商品變體" });
    }

    const cartInput = {
      lines: lines.map((line) => ({
        merchandiseId: line.merchandiseId,
        quantity: line.quantity,
        ...(line.sellingPlanId ? { sellingPlanId: line.sellingPlanId } : {}),
        ...(line.attributes ? { attributes: line.attributes } : {}),
      })),
      customAttributes: req.body?.customAttributes,
      buyerIdentity: req.body?.buyerIdentity,
      shippingAddress: req.body?.shippingAddress,
    };

    const { data } = await axios.post(
      graphqlEndpoint,
      {
        query: cartCreateMutation,
        variables: { input: cartInput },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_ACCESS_TOKEN,
        },
      }
    );

    const gqlErrors = data?.errors;
    const userErrors = data?.data?.cartCreate?.userErrors ?? [];

    if (gqlErrors?.length) {
      return res
        .status(400)
        .json({ message: gqlErrors.map((err) => err.message).join("; ") });
    }

    if (userErrors.length) {
      return res
        .status(400)
        .json({ message: userErrors.map((err) => err.message).join("; ") });
    }

    const cart = data?.data?.cartCreate?.cart;
    if (!cart?.checkoutUrl) {
      return res.status(502).json({ message: "Shopify 未回傳 checkout URL" });
    }

    res.json({
      checkoutUrl: cart.checkoutUrl,
      cartId: cart.id,
    });
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

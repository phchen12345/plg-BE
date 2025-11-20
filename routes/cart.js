import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import pool from "../db/db.js";

const router = Router();

async function fetchCartItems(userId) {
  const { rows } = await pool.query(
    `SELECT ci.product_id AS "productId",
            ci.quantity,
            p.name,
            p.price_cents AS "priceCents",
            p.image_url AS "imageUrl",
            p.shopify_variant_id AS "shopifyVariantId"
       FROM cart_items ci
       JOIN carts c ON c.id = ci.cart_id
       JOIN products p ON p.id = ci.product_id
      WHERE c.user_id = $1
      ORDER BY ci.id`,
    [userId]
  );
  return rows;
}

router.post("/items", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const productId = Number(req.body.productId);
    const quantity = Number(req.body.quantity);

    if (
      !Number.isInteger(productId) ||
      !Number.isInteger(quantity) ||
      quantity <= 0
    ) {
      return res.status(400).json({ message: "請提供正確的商品與數量" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const productRes = await client.query(
        "SELECT id FROM products WHERE id = $1 LIMIT 1",
        [productId]
      );
      if (productRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "商品不存在" });
      }

      const cartRes = await client.query(
        "SELECT id FROM carts WHERE user_id = $1 LIMIT 1",
        [userId]
      );
      let cartId = cartRes.rows[0]?.id;
      if (!cartId) {
        const insertCart = await client.query(
          "INSERT INTO carts (user_id) VALUES ($1) RETURNING id",
          [userId]
        );
        cartId = insertCart.rows[0].id;
      }

      await client.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (cart_id, product_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()`,
        [cartId, productId, quantity]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const cart = await fetchCartItems(userId);
    return res.json({ message: "商品已加入購物車", cart });
  } catch (err) {
    next(err);
  }
});

router.get("/items", requireAuth, async (req, res, next) => {
  try {
    const cart = await fetchCartItems(req.user.sub);
    return res.json({ cart });
  } catch (err) {
    next(err);
  }
});

router.get("/items/count", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM cart_items ci
         JOIN carts c ON c.id = ci.cart_id
        WHERE c.user_id = $1`,
      [req.user.sub]
    );
    return res.json({ count: rows[0]?.count ?? 0 });
  } catch (err) {
    next(err);
  }
});

router.delete("/items/:productId", requireAuth, async (req, res, next) => {
  const userId = req.user.sub;
  const productId = Number(req.params.productId);

  if (!Number.isInteger(productId)) {
    return res.status(400).json({ message: "商品編號不正確" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cartRes = await client.query(
      "SELECT id FROM carts WHERE user_id = $1 LIMIT 1",
      [userId]
    );
    const cartId = cartRes.rows[0]?.id;
    if (!cartId) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "購物車目前沒有商品" });
    }

    const deleteRes = await client.query(
      "DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2",
      [cartId, productId]
    );

    if (deleteRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "購物車中找不到此商品" });
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    return next(err);
  } finally {
    client.release();
  }

  try {
    const cart = await fetchCartItems(userId);
    return res.json({ message: "商品已從購物車移除", cart });
  } catch (err) {
    return next(err);
  }
});

export default router;

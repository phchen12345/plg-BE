// routes/logistics.js
import crypto from "crypto";
import express, { Router } from "express";

const router = Router();

const MERCHANT_ID = process.env.ECPAY_MERCHANT_ID ?? "";
const HASH_KEY = process.env.ECPAY_HASH_KEY ?? "";
const HASH_IV = process.env.ECPAY_HASH_IV ?? "";
const SERVER_BASE_URL =
  process.env.SERVER_BASE_URL ??
  process.env.BASE_URL ??
  "http://localhost:3001";
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL ?? "http://localhost:3000";

const ECPAY_MAP_URL =
  process.env.NODE_ENV === "production"
    ? "https://logistics.ecpay.com.tw/Express/map"
    : "https://logistics-stage.ecpay.com.tw/Express/map";

const SERVER_REPLY_URL = `${SERVER_BASE_URL}/api/logistics/map-callback`;

const sortAndEncode = (params) => {
  const sorted = Object.keys(params)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const raw = `HashKey=${HASH_KEY}&${sorted}&HashIV=${HASH_IV}`;
  return crypto
    .createHash("sha256")
    .update(encodeURIComponent(raw).toLowerCase())
    .digest("hex")
    .toUpperCase();
};

router.post(
  "/map-callback",
  express.urlencoded({ extended: false }), // 解析綠界傳來的 x-www-form-urlencoded
  (req, res) => {
    const params = new URLSearchParams();
    Object.entries(req.body ?? {}).forEach(([key, value]) => {
      if (typeof value === "string") {
        params.append(key, value);
      }
    });

    const redirectUrl = `${CLIENT_BASE_URL}/payment/store-callback?${params.toString()}`;
    const html = `<!DOCTYPE html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>門市資料回傳中</title>
    <style>
      body { font-family: sans-serif; min-height: 100vh; display:flex;
             align-items:center; justify-content:center; }
    </style>
  </head>
  <body>
    <p>門市資料回傳中，請稍候…</p>
    <script>window.location.replace(${JSON.stringify(redirectUrl)});</script>
  </body>
</html>`;

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  }
);

router.post("/map-token", (req, res, next) => {
  try {
    const logisticsSubType = req.body?.logisticsSubType || "FAMI";
    const extraData = req.body?.extraData || "";

    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ message: "ECPay 環境變數未設定" });
    }

    const baseParams = {
      MerchantID: MERCHANT_ID,
      LogisticsType: "CVS",
      LogisticsSubType: logisticsSubType,
      IsCollection: "N",
      ServerReplyURL: SERVER_REPLY_URL,
      ExtraData: extraData,
      Device: "0",
    };

    const CheckMacValue = sortAndEncode(baseParams);

    res.json({
      action: ECPAY_MAP_URL,
      fields: { ...baseParams, CheckMacValue },
    });
  } catch (err) {
    next(err);
  }
});

export default router;

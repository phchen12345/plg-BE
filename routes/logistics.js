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
const CLIENT_BASE_URL = process.env.CLIENT_ORIGIN ?? "http://localhost:3000";

const ECPAY_MAP_URL = "https://logistics-stage.ecpay.com.tw/Express/map";
const ECPAY_PRINT_DOC_URL =
  process.env.ECPAY_PRINT_DOC_URL ??
  "https://logistics-stage.ecpay.com.tw/Express/PrintFAMIC2COrderInfo";

const SERVER_REPLY_URL = `${SERVER_BASE_URL}/api/logistics/map-callback`;

const sortAndEncode = (params) => {
  const sorted = Object.keys(params)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${params[key] ?? ""}`)
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

/**
 * POST /api/logistics/fami/print-waybill
 * body: {
 *   logisticsId?: string;        // 綠界回傳的 AllPayLogisticsID
 *   merchantTradeNo?: string;    // 你在建立物流訂單時的商店訂單編號
 *   preview?: boolean;           // 是否預覽模式
 * }
 */
router.post("/fami/print-waybill", (req, res) => {
  try {
    const {
      logisticsId = "",
      merchantTradeNo = "",
      preview = false,
    } = req.body ?? {};

    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ message: "ECPay 環境變數未設定" });
    }
    if (!logisticsId && !merchantTradeNo) {
      return res.status(400).json({
        message: "請至少提供 AllPayLogisticsID 或 MerchantTradeNo",
      });
    }

    const payload = {
      MerchantID: MERCHANT_ID,
      AllPayLogisticsID: logisticsId,
      MerchantTradeNo: merchantTradeNo,
      LogisticsType: "CVS",
      LogisticsSubType: "FAMIC2C", // 全家店到店
      IsPreview: preview ? "1" : "0",
    };

    const CheckMacValue = sortAndEncode(payload);

    res.json({
      action: ECPAY_PRINT_DOC_URL,
      fields: { ...payload, CheckMacValue },
    });
  } catch (err) {
    console.error("[logistics] fami print error", err);
    res.status(500).json({ message: "建立託運單列印資料失敗" });
  }
});

export default router;

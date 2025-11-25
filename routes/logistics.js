// routes/logistics.js
import crypto from "crypto";
import express, { Router } from "express";
import axios from "axios";
import pool from "../db/db.js";

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
const ECPAY_PRINT_URLS = {
  FAMIC2C:
    process.env.ECPAY_PRINT_DOC_URL ??
    "https://logistics-stage.ecpay.com.tw/Express/PrintFAMIC2COrderInfo",
  UNIMARTC2C:
    process.env.ECPAY_PRINT_DOC_URL_711 ??
    "https://logistics-stage.ecpay.com.tw/Express/PrintUniMartC2COrderInfo",
};
const ECPAY_CREATE_SHIPPING_URL =
  process.env.ECPAY_CREATE_SHIPPING_URL ??
  "https://logistics-stage.ecpay.com.tw/Express/Create";

const SERVER_REPLY_URL = `${SERVER_BASE_URL}/api/logistics/map-callback`;

const ecpayUrlEncode = (value) =>
  encodeURIComponent(String(value))
    .replace(/%20/g, "+")
    .replace(/%2d/g, "-")
    .replace(/%5f/g, "_")
    .replace(/%2e/g, ".")
    .replace(/%21/g, "!")
    .replace(/%2a/g, "*")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")");

const sortAndEncode = (params, encryptType = "MD5") => {
  const query = Object.keys(params)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${params[key] ?? ""}`)
    .join("&");

  const raw = `HashKey=${HASH_KEY}&${query}&HashIV=${HASH_IV}`;
  const encoded = ecpayUrlEncode(raw).toLowerCase();
  const hashAlgo = encryptType === "SHA256" ? "sha256" : "md5";
  return crypto
    .createHash(hashAlgo)
    .update(encoded)
    .digest("hex")
    .toUpperCase();
};

router.post(
  "/map-callback",
  express.urlencoded({ extended: false }),
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
    <title>門市介面轉跳中</title>
    <style>
      body { font-family: sans-serif; min-height: 100vh; display:flex;
             align-items:center; justify-content:center; }
    </style>
  </head>
  <body>
    <p>門市資料傳回中，請稍候...</p>
    <script>window.location.replace(${JSON.stringify(redirectUrl)});</script>
  </body>
</html>`;

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  }
);

router.post("/map-token", (req, res, next) => {
  try {
    const logisticsSubType = req.body?.logisticsSubType || "FAMIC2C";
    const extraData = req.body?.extraData || "";

    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ message: "ECPay 變數未設定" });
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

    const CheckMacValue = sortAndEncode(baseParams, "MD5");

    res.json({
      action: ECPAY_MAP_URL,
      fields: { ...baseParams, CheckMacValue },
    });
  } catch (err) {
    next(err);
  }
});

const buildPrintFields = async ({
  logisticsSubType,
  merchantTradeNo = "",
  logisticsId = "",
  preview = false,
  cvsPaymentNo = "",
  cvsValidationNo = "",
}) => {
  if (!logisticsId && merchantTradeNo) {
    const { rows } = await pool.query(
      `SELECT allpay_logistics_id,
              logistics_subtype,
              cvs_payment_no,
              cvs_validation_no
         FROM ecpay_transactions
        WHERE merchant_trade_no = $1
        LIMIT 1`,
      [merchantTradeNo]
    );
    const row = rows[0] ?? {};
    logisticsId = row.allpay_logistics_id ?? "";
    logisticsSubType = logisticsSubType || row.logistics_subtype || "";
    cvsPaymentNo = cvsPaymentNo || row.cvs_payment_no || "";
    cvsValidationNo = cvsValidationNo || row.cvs_validation_no || "";
  }

  if (!logisticsId && !merchantTradeNo) {
    throw new Error("請至少提供 AllPayLogisticsID 或 MerchantTradeNo");
  }

  const payload = {
    MerchantID: MERCHANT_ID,
    AllPayLogisticsID: logisticsId,
    CVSPaymentNo: cvsPaymentNo,
    CVSValidationNo: cvsValidationNo,
    MerchantTradeNo: merchantTradeNo,
    LogisticsType: "CVS",
    LogisticsSubType: logisticsSubType,
    IsPreview: preview ? "1" : "0",
  };

  const CheckMacValue = sortAndEncode(payload, "MD5");
  return { payload: { ...payload, CheckMacValue }, logisticsSubType };
};

const createPrintWaybillHandler = (logisticsSubType) => async (req, res) => {
  try {
    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ message: "ECPay 變數未設定" });
    }

    const { payload } = await buildPrintFields({
      logisticsSubType,
      merchantTradeNo: req.body?.merchantTradeNo,
      logisticsId: req.body?.logisticsId,
      cvsPaymentNo: req.body?.CVSPaymentNo,
      cvsValidationNo: req.body?.CVSValidationNo,
      preview: Boolean(req.body?.preview),
    });

    res.json({
      action: ECPAY_PRINT_URLS[logisticsSubType],
      fields: payload,
    });
  } catch (err) {
    console.error(`[logistics] ${logisticsSubType} print error`, err);
    const message =
      err instanceof Error ? err.message : "建立託運單列印資料失敗";
    res.status(500).json({ message });
  }
};

router.post("/fami/print-waybill", createPrintWaybillHandler("FAMIC2C"));
router.post("/seven/print-waybill", createPrintWaybillHandler("UNIMARTC2C"));

router.post("/shipping-order", async (req, res) => {
  try {
    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ message: "ECPay 變數未設定" });
    }

    const {
      merchantTradeNo,
      logisticsSubType = "FAMIC2C",
      goodsAmount,
      goodsName,
      senderName,
      senderPhone,
      receiverName,
      receiverPhone,
      receiverCellPhone,
      receiverStoreId,
    } = req.body;

    if (!merchantTradeNo) {
      return res.status(400).json({ message: "缺少 MerchantTradeNo" });
    }
    if (!receiverStoreId) {
      return res.status(400).json({ message: "缺少 ReceiverStoreId" });
    }

    const basePayload = {
      MerchantID: MERCHANT_ID,
      MerchantTradeNo: merchantTradeNo,
      MerchantTradeDate: formatDate(new Date()),
      LogisticsSubType: logisticsSubType,
      LogisticsType: "CVS",
      GoodsAmount: Number(goodsAmount || 60),
      GoodsName: goodsName ?? "PLG 商品",
      SenderName: senderName ?? "PLGstore",
      SenderPhone: senderPhone ?? "021234567",
      ReceiverName: receiverName ?? "PLG 客戶",
      ReceiverPhone: receiverPhone ?? "021234567",
      ReceiverCellPhone: receiverCellPhone ?? "0911222333",
      ReceiverStoreID: receiverStoreId,
      ServerReplyURL: `${SERVER_BASE_URL}/api/logistics/shipping-callback`,
      ReceiverEmail: req.body?.receiverEmail ?? "",
      ReturnStoreID: req.body?.returnStoreId ?? "",
      TradeDesc: req.body?.tradeDesc ?? "PLG 訂單",
      LogisticsC2CReplyURL:
        req.body?.logisticsC2CReplyURL ??
        `${SERVER_BASE_URL}/api/logistics/shipping-callback`,
      ScheduledPickupTime: req.body?.scheduledPickupTime ?? "4",
      Temperature: req.body?.temperature ?? "0001",
      Specification: req.body?.specification ?? "0001",
      EnableSelectDeliveryTime: req.body?.enableSelectDeliveryTime ?? "Y",
      EnableSelectReceipt: req.body?.enableSelectReceipt ?? "Y",
      EnableSelectPickup: req.body?.enableSelectPickup ?? "Y",
      SenderZipCode: req.body?.senderZipCode ?? "",
      SenderAddress: req.body?.senderAddress ?? "",
      ReceiverZipCode: req.body?.receiverZipCode ?? "",
      ReceiverAddress: req.body?.receiverAddress ?? "",
      Remark: req.body?.remark ?? "",
    };

    const receiverSubTypes = [
      "UNIMARTC2C",
      "FAMIC2C",
      "HILIFEC2C",
      "OKMARTC2C",
    ];
    if (receiverSubTypes.includes(logisticsSubType)) {
      basePayload.ReceiverStoreID = receiverStoreId;
    }

    if (
      logisticsSubType === "UNIMARTC2C" ||
      logisticsSubType === "FAMIC2C" ||
      logisticsSubType === "HILIFEC2C"
    ) {
      basePayload.ReturnStoreID = req.body?.returnStoreId || receiverStoreId;
    }

    const CheckMacValue = sortAndEncode(basePayload, "MD5");
    const payload = { ...basePayload, CheckMacValue };

    console.log("[logistics] 建立物流訂單請求參數:", payload);

    const formData = new URLSearchParams();
    Object.entries(payload).forEach(([key, value]) => {
      formData.append(key, String(value));
    });

    console.log("[logistics] 發送請求到:", ECPAY_CREATE_SHIPPING_URL);

    const { data } = await axios.post(
      ECPAY_CREATE_SHIPPING_URL,
      formData.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        timeout: 30000,
      }
    );

    console.log("[logistics] 綠界回應CheckMacValue:", data);

    if (typeof data === "string") {
      const parts = data.split("|");
      if (parts[0] === "1" || parts[0] === "2") {
        return res.json({
          success: parts[0] === "1",
          message: parts[1] || "成功",
          response: data,
          request: basePayload,
        });
      }

      if (data.includes("<!DOCTYPE html>")) {
        return res.status(500).json({
          message: "綠界 API 回傳錯誤頁面，請檢查參數是否正確",
          hint: "可能原因：1. MerchantID 錯誤 2. CheckMacValue 計算錯誤 3. 參數格式不符",
          response: data.substring(0, 500),
        });
      }
    }

    res.json({
      success: true,
      request: basePayload,
      response: data,
    });
  } catch (err) {
    console.error("[logistics] 建立物流訂單失敗", err);

    if (axios.isAxiosError(err)) {
      const responseData = err.response?.data;

      if (
        typeof responseData === "string" &&
        responseData.includes("<!DOCTYPE html>")
      ) {
        return res.status(500).json({
          message: "綠界 API 回傳 HTML 錯誤頁面",
          hint: "請檢查：1. API URL 是否正確 2. MerchantID 是否有效 3. HashKey/HashIV 是否正確",
          url: ECPAY_CREATE_SHIPPING_URL,
          errorPreview: responseData.substring(0, 300),
        });
      }

      return res.status(err.response?.status ?? 500).json({
        message:
          err.response?.data?.RtnMsg ||
          err.response?.data?.message ||
          err.message,
        fullResponse: err.response?.data,
      });
    }

    res.status(500).json({
      message: "建立物流訂單失敗",
      error: err.message,
    });
  }
});

router.post(
  "/shipping-callback",
  express.urlencoded({ extended: false }),
  (req, res) => {
    console.log("[logistics] shipping callback 收到通知:", req.body);

    const receivedMac = req.body.CheckMacValue;
    if (receivedMac) {
      const params = { ...req.body };
      delete params.CheckMacValue;

      const calculatedMac = sortAndEncode(params, "MD5");

      if (calculatedMac !== receivedMac) {
        console.error("[logistics] CheckMacValue 驗證失敗");
        return res.send("0|CheckMacValue Error");
      }
    }

    res.send("1|OK");
  }
);

export default router;

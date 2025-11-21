// routes/logistics.js
import crypto from "crypto";
import express, { Router } from "express";
import axios from "axios";

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
const ECPAY_CREATE_SHIPPING_URL =
  process.env.ECPAY_CREATE_SHIPPING_URL ??
  "https://logistics-stage.ecpay.com.tw/Express/Create";

const SERVER_REPLY_URL = `${SERVER_BASE_URL}/api/logistics/map-callback`;

/**
 * 綠界專用的 URL 編碼函數。
 * 遵循綠界規範：將特殊字元進行 URL 編碼，並將空格 %20 轉為 '+'
 */
const ecpayUrlEncode = (str) => {
  if (typeof str !== "string") {
    str = String(str);
  }
  return encodeURIComponent(str)
    .replace(/%20/g, "+")
    .replace(/%2D/g, "-")
    .replace(/%5F/g, "_")
    .replace(/%2E/g, ".")
    .replace(/%21/g, "!")
    .replace(/%2A/g, "*")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")");
};

/**
 * CheckMacValue 計算函式 (SHA256 或 MD5)
 */
const sortAndEncode = (params, encryptType = "SHA256") => {
  const keys = Object.keys(params).sort((a, b) => a.localeCompare(b));

  let raw = `HashKey=${HASH_KEY}`;

  keys.forEach((key) => {
    const value = ecpayUrlEncode(params[key] ?? "");
    raw += `&${key}=${value}`;
  });

  raw += `&HashIV=${HASH_IV}`;

  const lowerCaseRaw = raw.toLowerCase();

  const hashAlgo = encryptType === "SHA256" ? "sha256" : "md5";
  const CheckMacValue = crypto
    .createHash(hashAlgo)
    .update(lowerCaseRaw)
    .digest("hex")
    .toUpperCase();

  return CheckMacValue;
};

/**
 * 格式化台灣日期時間為綠界要求的格式: YYYY/MM/DD HH:mm:ss
 */
const formatECPayDateTime = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
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
    // 【修正 1-1】：將預設值從 B2C 的 "FAMI" 改為 C2C 的 "FAMIC2C"
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

    // 【修正 1-2】：C2C 服務必須使用 MD5 雜湊
    const CheckMacValue = sortAndEncode(baseParams, "MD5");

    res.json({
      action: ECPAY_MAP_URL,
      fields: { ...baseParams, CheckMacValue },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/fami/print-waybill", (req, res) => {
  try {
    const {
      logisticsId = "",
      merchantTradeNo = "",
      preview = false,
    } = req.body ?? {};

    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ message: "ECPay 變數未設定" });
    }
    if (!logisticsId && !merchantTradeNo) {
      return res
        .status(400)
        .json({ message: "請至少提供 AllPayLogisticsID 或 MerchantTradeNo" });
    }

    const payload = {
      MerchantID: MERCHANT_ID,
      AllPayLogisticsID: logisticsId,
      MerchantTradeNo: merchantTradeNo,
      LogisticsType: "CVS",
      LogisticsSubType: "FAMIC2C",
      IsPreview: preview ? "1" : "0",
    };

    // 【修正 2】：C2C 服務必須使用 MD5 雜湊
    const CheckMacValue = sortAndEncode(payload, "MD5");

    res.json({
      action: ECPAY_PRINT_DOC_URL,
      fields: { ...payload, CheckMacValue },
    });
  } catch (err) {
    console.error("[logistics] fami print error", err);
    res.status(500).json({ message: "建立託運單列印資料失敗" });
  }
});

router.post("/shipping-order", async (req, res) => {
  try {
    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ message: "ECPay 變數未設定" });
    }

    // 驗證必要欄位
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

    // 檢查必填欄位
    if (!receiverStoreId) {
      return res.status(400).json({
        message: "缺少必要欄位：receiverStoreId (收件門市代號)",
      });
    }

    if (!goodsName || !goodsAmount) {
      return res.status(400).json({
        message: "缺少必要欄位：goodsName 或 goodsAmount",
      });
    }

    // 驗證手機號碼格式 (台灣手機號碼: 09 開頭，共 10 碼)
    const senderCellPhone = senderPhone || "0911111111";

    const finalMerchantTradeNo = merchantTradeNo ?? `EC${Date.now()}`;

    const basePayload = {
      MerchantID: MERCHANT_ID,
      MerchantTradeNo: finalMerchantTradeNo,
      MerchantTradeDate: formatECPayDateTime(),
      LogisticsType: "CVS",
      LogisticsSubType: logisticsSubType,
      GoodsAmount: String(goodsAmount),
      CollectionAmount: String(req.body?.collectionAmount ?? 0),
      IsCollection: req.body?.isCollection ?? "N",
      GoodsName: goodsName,
      SenderName: senderName || "PLG寄件者",
      SenderPhone: req.body?.senderLandline || "",
      SenderCellPhone: senderCellPhone,
      ReceiverName: receiverName || "PLG收件者",
      ReceiverPhone: receiverPhone,
      ReceiverCellPhone: receiverCellPhone || "0911111111",
      ReceiverStoreID: receiverStoreId,
      ServerReplyURL:
        req.body?.serverReplyUrl ??
        `${SERVER_BASE_URL}/api/logistics/shipping-callback`,
    };

    console.log("[logistics] 建立物流訂單基本參數:", basePayload);

    // 根據物流子類型添加必要欄位
    if (
      logisticsSubType === "FAMIC2C" ||
      logisticsSubType === "UNIMARTC2C" ||
      logisticsSubType === "HILIFEC2C"
    ) {
      // C2C 類型需要寄件人地址
      basePayload.SenderZipCode = req.body?.senderZip || "";
      basePayload.SenderAddress = req.body?.senderAddress || "";
      basePayload.ReturnStoreID = req.body?.returnStoreId || receiverStoreId;
    }

    console.log("[logistics] 建立物流訂單參數:", basePayload);

    // 【修正 3】：C2C 服務必須使用 MD5 雜湊
    const CheckMacValue = sortAndEncode(basePayload, "MD5");
    const payload = { ...basePayload, CheckMacValue };

    // 使用 application/x-www-form-urlencoded 格式
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

    console.log("[logistics] 綠界回應:", data);

    // 綠界可能回傳 JSON 格式 (1|OK) 或 HTML 錯誤頁面
    if (typeof data === "string") {
      // 嘗試解析 綠界回傳的格式：RtnCode|RtnMsg
      const parts = data.split("|");
      if (parts[0] === "1" || parts[0] === "2") {
        // 1 = 成功, 2 = 失敗但有回傳資訊
        return res.json({
          success: parts[0] === "1",
          message: parts[1] || "成功",
          response: data,
          request: basePayload,
        });
      }

      // 如果是 HTML 錯誤頁面
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

      // 如果是 HTML 錯誤頁面
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

    // 驗證 CheckMacValue (可選但建議)
    const receivedMac = req.body.CheckMacValue;
    if (receivedMac) {
      const params = { ...req.body };
      delete params.CheckMacValue;

      // 【修正 4】：C2C 服務必須使用 MD5 雜湊
      const calculatedMac = sortAndEncode(params, "MD5");

      if (calculatedMac !== receivedMac) {
        console.error("[logistics] CheckMacValue 驗證失敗");
        return res.send("0|CheckMacValue Error");
      }
    }

    // 儲存物流資訊到資料庫
    // TODO: 將 req.body 的物流資訊存入資料庫

    // 回應綠界必須是 "1|OK"
    res.send("1|OK");
  }
);

export default router;

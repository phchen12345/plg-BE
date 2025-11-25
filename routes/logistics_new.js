import express, { Router } from "express";
import crypto from "crypto";
import axios from "axios";
import pool from "../db/db.js";

const router = Router();
const PLATFORM_ID = process.env.ECPAY_PLATFORM_ID ?? "";
const MERCHANT_ID = process.env.ECPAY_MERCHANT_ID ?? "";
const HASH_KEY = process.env.ECPAY_HASH_KEY ?? "";
const HASH_IV = process.env.ECPAY_HASH_IV ?? "";
const SERVER_BASE_URL =
  process.env.SERVER_BASE_URL ??
  process.env.BASE_URL ??
  "http://localhost:3001";
const CLIENT_BASE_URL = process.env.CLIENT_ORIGIN ?? "http://localhost:3000";

const ECPAY_REDIRECT_V2_URL =
  process.env.ECPAY_REDIRECT_V2_URL ??
  "https://logistics-stage.ecpay.com.tw/Express/v2/RedirectToLogisticsSelection";

const DEFAULT_CALLBACK_URL = `${SERVER_BASE_URL}/api/logistics-new/selection-callback`;
const STORE_SELECTION_TTL_MINUTES = 30;

const ecpayUrlEncode = (value) =>
  encodeURIComponent(String(value))
    .replace(/%20/g, "%20")
    .replace(/%2d/gi, "%2D")
    .replace(/%5f/gi, "%5F")
    .replace(/%2e/gi, "%2E")
    .replace(/%21/g, "%21")
    .replace(/%2a/g, "%2A")
    .replace(/%28/g, "%28")
    .replace(/%29/g, "%29");

const encryptData = (payload) => {
  const key = Buffer.from(HASH_KEY, "utf8");
  const iv = Buffer.from(HASH_IV, "utf8");
  if (![16, 24, 32].includes(key.length) || iv.length !== 16) {
    throw new Error("HashKey/HashIV 長度不符 AES 要求");
  }
  const algorithm =
    key.length === 32
      ? "aes-256-cbc"
      : key.length === 24
      ? "aes-192-cbc"
      : "aes-128-cbc";
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const encoded = ecpayUrlEncode(JSON.stringify(payload));
  let encrypted = cipher.update(encoded, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
};

const decryptData = (encrypted) => {
  const key = Buffer.from(HASH_KEY, "utf8");
  const iv = Buffer.from(HASH_IV, "utf8");
  const algorithm =
    key.length === 32
      ? "aes-256-cbc"
      : key.length === 24
      ? "aes-192-cbc"
      : "aes-128-cbc";
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decodeURIComponent(decrypted);
};

const normalizeStoreInfo = (payload = {}) => ({
  storeId:
    payload.ReceiverStoreID ??
    payload.CVSStoreID ??
    payload.StoreID ??
    payload.storeid ??
    payload.storeId ??
    "",
  storeName:
    payload.ReceiverStoreName ??
    payload.CVSStoreName ??
    payload.StoreName ??
    payload.storename ??
    payload.storeName ??
    "",
  storeAddress:
    payload.ReceiverAddress ??
    payload.CVSAddress ??
    payload.storeaddress ??
    payload.storeAddress ??
    "",
  receiverPhone:
    payload.ReceiverPhone ?? payload.phone ?? payload.CVSTelephone ?? "",
  receiverCellPhone: payload.ReceiverCellPhone ?? payload.cellphone ?? "",
  logisticsSubType:
    payload.LogisticsSubType ??
    payload.logisticsSubType ??
    payload.SubType ??
    "",
  raw: payload,
});

const saveStoreSelection = async (token, payload) => {
  if (!token || !payload?.storeId) return;
  await pool.query(
    `INSERT INTO logistics_store_selections (token, store_info)
       VALUES ($1, $2)
       ON CONFLICT (token)
       DO UPDATE SET store_info = EXCLUDED.store_info, updated_at = NOW()`,
    [token, payload]
  );
};

router.post("/selection", async (req, res) => {
  try {
    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ message: "ECPay 變數未設定" });
    }

    const selectionToken =
      req.body?.selectionToken ||
      req.body?.extraData ||
      `SEL${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    const dataPayload = {
      TempLogisticsID: String(req.body?.tempLogisticsId ?? "0"),
      GoodsAmount: Number(req.body?.goodsAmount ?? 500),
      IsCollection: req.body?.isCollection ?? "N",
      GoodsName: req.body?.goodsName ?? "PLG 經典款",
      SenderName: req.body?.senderName ?? "PLG寄件",
      SenderZipCode: req.body?.senderZipCode ?? "100",
      SenderAddress: req.body?.senderAddress ?? "台北市信義區市府路45號",
      Remark: req.body?.remark ?? "",
      ServerReplyURL: req.body?.serverReplyUrl ?? DEFAULT_CALLBACK_URL,
      ClientReplyURL:
        req.body?.clientReplyUrl ??
        `${CLIENT_BASE_URL}/api/logistics/client-callback`,
      Temperature: req.body?.temperature ?? "0001",
      Specification: req.body?.specification ?? "0001",
      ScheduledPickupTime: req.body?.scheduledPickupTime ?? "4",
      ReceiverAddress: req.body?.receiverAddress ?? "",
      ReceiverCellPhone: req.body?.receiverCellPhone ?? "",
      ReceiverPhone: req.body?.receiverPhone ?? "",
      ReceiverName: req.body?.receiverName ?? "PLG收件",
      EnableSelectDeliveryTime: req.body?.enableSelectDeliveryTime ?? "Y",
      EshopMemberID: req.body?.eshopMemberId ?? "",
      ExtraData: selectionToken,
    };

    console.log("[logistics-new] selection payload", dataPayload);

    const encryptedData = encryptData(dataPayload);
    const payload = {
      MerchantID: MERCHANT_ID,
      RqHeader: { Timestamp: Math.floor(Date.now() / 1000).toString() },
      Data: encryptedData,
    };
    if (PLATFORM_ID) {
      payload.PlatformID = PLATFORM_ID;
    }

    const response = await axios.post(ECPAY_REDIRECT_V2_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
      responseType: "text",
    });
    console.log("[logistics-new] ECPay raw response", response.data);
    let responsePayload = response.data;
    if (typeof responsePayload === "string") {
      const trimmed = responsePayload.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          responsePayload = JSON.parse(trimmed);
        } catch (jsonErr) {
          console.warn("[logistics-new] 綠界回傳不是合法 JSON", jsonErr);
        }
      } else if (trimmed.includes("<html")) {
        return res.json({
          isHtml: true,
          html: responsePayload,
          selectionToken,
        });
      }
    }

    if (
      responsePayload &&
      typeof responsePayload === "object" &&
      responsePayload.Data
    ) {
      try {
        const decrypted = decryptData(responsePayload.Data);
        responsePayload = {
          ...responsePayload,
          Data: decrypted,
          ParsedData: JSON.parse(decrypted),
        };
      } catch (decodeErr) {
        console.warn("[logistics-new] decrypt response Data failed", decodeErr);
      }
    }

    return res.json({ ...responsePayload, selectionToken });
  } catch (err) {
    console.error("[logistics-new] selection error", err);
    if (axios.isAxiosError(err)) {
      return res
        .status(err.response?.status ?? 500)
        .json(err.response?.data ?? { message: err.message });
    }
    return res.status(500).json({ message: err.message });
  }
});

router.post(
  "/selection-callback",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const token = req.body?.ExtraData ?? req.body?.extraData ?? "";
    const storeInfo = normalizeStoreInfo(req.body);

    // 步驟 1: 立即回覆綠界，避免超時
    res.send("1|OK");

    try {
      // 步驟 2: 在回覆之後，再執行耗時的資料庫操作
      console.log("[logistics-new] selection callback", req.body);
      if (token && storeInfo.storeId) {
        await saveStoreSelection(token, storeInfo);
      }
      // 注意：錯誤處理需要獨立出來，避免影響 res.send("1|OK")
    } catch (err) {
      console.error(
        "[logistics-new] selection callback error during DB save",
        err
      );
      // 在這裡只能記錄錯誤，因為已經回覆綠界
    }
  }
);

router.get("/selection-result/:token", async (req, res) => {
  try {
    const token = req.params?.token ?? "";
    if (!token) {
      return res.status(400).json({ message: "缺少 selection token" });
    }

    const { rows } = await pool.query(
      `SELECT store_info, updated_at
         FROM logistics_store_selections
        WHERE token = $1
          AND updated_at >= NOW() - INTERVAL '${STORE_SELECTION_TTL_MINUTES} minutes'`,
      [token]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "尚未收到門市資訊" });
    }

    res.json({ store: rows[0].store_info });
  } catch (err) {
    console.error("[logistics-new] get selection result error", err);
    res.status(500).json({ message: "取得門市資訊失敗" });
  }
});

router.post(
  "/client-callback",
  express.urlencoded({ extended: false }),
  (req, res) => {
    const token =
      req.body?.ExtraData ??
      req.body?.selectionToken ??
      req.body?.extraData ??
      "";

    const redirectUrl = new URL("/payment/store-callback", CLIENT_BASE_URL);
    if (token) {
      redirectUrl.searchParams.set("token", token);
    }

    res.redirect(303, redirectUrl.toString());
  }
);

export default router;

// routes/ecpay.js
import { Router } from "express";
import crypto from "crypto";

const router = Router();

const ECPAY_MERCHANT_ID = process.env.ECPAY_MERCHANT_ID ?? "2000132";
const ECPAY_HASH_KEY = process.env.ECPAY_HASH_KEY ?? "5294y06JbISpM5x9";
const ECPAY_HASH_IV = process.env.ECPAY_HASH_IV ?? "v77hoKGq4kWxNNIS";
const ECPAY_BASE_URL =
  process.env.ECPAY_PAYMENT_URL ??
  "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5";

const padZero = (num) => String(num).padStart(2, "0");

const formatDate = (date) => {
  const year = date.getFullYear();
  const month = padZero(date.getMonth() + 1);
  const day = padZero(date.getDate());
  const hours = padZero(date.getHours());
  const minutes = padZero(date.getMinutes());
  const seconds = padZero(date.getSeconds());
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
};

const encodeParams = (params) => {
  // 1. 進行 A-Z 排序
  const sortedKeys = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== "")
    .sort((a, b) => a.localeCompare(b));

  // 2. 針對每個 "值" 進行 URL 編碼並替換特定字元
  const encodedParams = sortedKeys.map((key) => {
    const value = params[key];
    // 使用 encodeURIComponent 編碼值 (空格會被編碼成 %20)
    let encodedValue = encodeURIComponent(value);

    // 進行綠界要求的特定反向替換 (與 .NET 一致)
    encodedValue = encodedValue
      .replace(/%2d/g, "-") // -
      .replace(/%5f/g, "_") // _
      .replace(/%2e/g, ".") // .
      .replace(/%21/g, "!") // !
      .replace(/%2a/g, "*") // *
      .replace(/%28/g, "(") // (
      .replace(/%29/g, ")") // )
      // 【新增此行】將所有 URL 編碼後的百分號(%)後續的十六進位轉為小寫，以符合綠界要求
      .replace(/%([0-9A-F]{2})/g, (match, p1) => `%${p1.toLowerCase()}`);

    return `${key}=${encodedValue}`;
  });

  // 3. 組合完整的簽章字串
  const queryString = encodedParams.join("&");
  const raw = `HashKey=${ECPAY_HASH_KEY}&${queryString}&HashIV=${ECPAY_HASH_IV}`;

  console.log("Raw string for encryption:", raw); // 可選：用於除錯

  // 4. 進行 SHA256 加密並轉大寫
  return crypto.createHash("sha256").update(raw).digest("hex").toUpperCase();
};

router.post("/checkout", (req, res) => {
  const { tradeNo, totalAmount, description, returnURL } = req.body;

  const payload = {
    MerchantID: ECPAY_MERCHANT_ID,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: formatDate(new Date()),
    PaymentType: "aio",
    TotalAmount: String(Math.round(Number(totalAmount) || 0)),
    TradeDesc: description ?? "PLG order",
    ItemName: "PLG item",
    ReturnURL: returnURL ?? "http://localhost:3001/api/ecpay/payment-return",
    ChoosePayment: "Credit",
    EncryptType: "1",
  };

  console.log("ECPAY payload", payload);

  const CheckMacValue = encodeParams(payload);
  console.log("CheckMacValue", CheckMacValue);

  res.json({
    action: ECPAY_BASE_URL,
    fields: { ...payload, CheckMacValue },
  });
});

router.post("/payment-return", (req, res) => {
  const payload = req.body;
  const receivedCheckMac = payload.CheckMacValue;
  const { CheckMacValue: _, ...others } = payload;
  const calculated = encodeParams(others);

  if (receivedCheckMac !== calculated) {
    return res.status(400).send("0|CheckMacValue Error");
  }

  if (payload.RtnCode === "1") {
    // TODO: 更新訂單狀態
  }

  res.send("1|OK");
});

export default router;

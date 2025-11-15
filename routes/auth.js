// plg-backend/routes/auth.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";
import pool from "../db/db.js";
import { sendVerificationEmail } from "../util/emailService.js";

const router = Router();

const COOKIE_NAME = "auth_token";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const TAIWAN_PHONE_REGEX = /^09\d{8}$/;
const CODE_TTL_MS = 5 * 60 * 1000;

/* ---------- 共用 ---------- */
const signToken = (user) =>
  jwt.sign({ sub: user.id, email: user.email ?? null }, JWT_SECRET, {
    expiresIn: "7d",
  });

const sendAuthCookie = (res, token) =>
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);

/* ---------- 取得登入資訊 ---------- */
router.get("/me", (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ message: "未登入" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return res.json({ userId: payload.sub, email: payload.email });
  } catch {
    return res.status(401).json({ message: "登入狀態已失效" });
  }
});

/* ---------- Email 驗證碼 ---------- */
router.post("/send-email-code", async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "請輸入正確的 Email" });
    }

    const userResult = await pool.query(
      "SELECT id, email_verified FROM users WHERE email = $1 LIMIT 1",
      [email]
    );
    if (userResult.rowCount > 0 && userResult.rows[0].email_verified) {
      return res.status(409).json({ message: "此 Email 已完成註冊" });
    }

    const code = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    await pool.query(
      `INSERT INTO email_verifications (email, code, expires_at, is_used)
       VALUES ($1, $2, $3, FALSE)
       ON CONFLICT (email)
       DO UPDATE SET code = EXCLUDED.code,
                     expires_at = EXCLUDED.expires_at,
                     is_used = FALSE`,
      [email, code, expiresAt]
    );

    await sendVerificationEmail(email, code);
    res.json({ message: "驗證碼已寄出" });
  } catch (err) {
    next(err);
  }
});

/* ---------- Email 註冊 ---------- */
router.post("/register-email", async (req, res, next) => {
  try {
    const { email, password, verificationCode } = req.body ?? {};
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "請輸入正確的 Email" });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ message: "密碼至少需要 6 個字元" });
    }
    if (!verificationCode || !/^\d{6}$/.test(verificationCode)) {
      return res.status(400).json({ message: "請輸入 6 位數驗證碼" });
    }

    const verification = await pool.query(
      `SELECT code, expires_at, is_used
         FROM email_verifications
        WHERE email = $1`,
      [email]
    );
    if (verification.rowCount === 0) {
      return res.status(400).json({ message: "請先取得驗證碼" });
    }
    const record = verification.rows[0];
    if (record.is_used) {
      return res.status(400).json({ message: "驗證碼已使用，請重新取得" });
    }
    if (record.expires_at < new Date()) {
      return res.status(400).json({ message: "驗證碼已過期" });
    }
    if (record.code !== verificationCode) {
      return res.status(400).json({ message: "驗證碼錯誤" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const existingUser = await pool.query(
      "SELECT id, email_verified FROM users WHERE email = $1 LIMIT 1",
      [email]
    );

    let userId;
    if (existingUser.rowCount > 0) {
      if (existingUser.rows[0].email_verified) {
        return res.status(409).json({ message: "此 Email 已註冊" });
      }
      const updated = await pool.query(
        `UPDATE users
            SET password_hash = $1,
                email_verified = TRUE
          WHERE id = $2
        RETURNING id`,
        [passwordHash, existingUser.rows[0].id]
      );
      userId = updated.rows[0].id;
    } else {
      const inserted = await pool.query(
        `INSERT INTO users (email, password_hash, email_verified)
         VALUES ($1, $2, TRUE)
         RETURNING id`,
        [email, passwordHash]
      );
      userId = inserted.rows[0].id;
    }

    await pool.query(
      "UPDATE email_verifications SET is_used = TRUE WHERE email = $1",
      [email]
    );

    const token = signToken({ id: userId, email });
    sendAuthCookie(res, token).json({ message: "註冊成功", userId });
  } catch (err) {
    next(err);
  }
});

/* ---------- Email 登入 ---------- */
router.post("/login-email", async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !EMAIL_REGEX.test(email) || !password) {
      return res.status(400).json({ message: "Email 或密碼格式不正確" });
    }

    const { rows } = await pool.query(
      `SELECT id, password_hash
         FROM users
        WHERE email = $1 AND email_verified = TRUE
        LIMIT 1`,
      [email]
    );
    if (!rows.length) {
      return res.status(401).json({ message: "帳號不存在或未驗證" });
    }

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ message: "Email 或密碼錯誤" });

    const token = signToken({ id: user.id, email });
    sendAuthCookie(res, token).json({ userId: user.id });
  } catch (err) {
    next(err);
  }
});

/* ---------- 登出 ---------- */
router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS).json({ message: "已登出" });
});

export default router;

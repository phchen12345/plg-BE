import { Router } from "express";
import { google } from "googleapis";
import jwt from "jsonwebtoken";
import pool from "../db/db.js";

const router = Router();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const scopes = ["openid", "profile", "email"];

const COOKIE_NAME = "auth_token";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

router.get("/", (_req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
  });
  res.redirect(url);
});

router.get("/callback", async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.redirect(
        (process.env.CLIENT_ORIGIN ?? "http://localhost:3000") +
          "/login?error=google"
      );
    }

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload?.email;

    if (!email) {
      return res.redirect(
        (process.env.CLIENT_ORIGIN ?? "http://localhost:3000") +
          "/login?error=no-email"
      );
    }

    let userId;
    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1",
      [email]
    );
    if (existing.rowCount > 0) {
      userId = existing.rows[0].id;
    } else {
      const inserted = await pool.query(
        `INSERT INTO users (email, email_verified)
         VALUES ($1, TRUE)
         RETURNING id`,
        [email]
      );
      userId = inserted.rows[0].id;
    }

    const token = jwt.sign({ sub: userId, email }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res
      .cookie(COOKIE_NAME, token, COOKIE_OPTIONS)
      .redirect(process.env.CLIENT_ORIGIN ?? "http://localhost:3000");
  } catch (err) {
    next(err);
  }
});

export default router;

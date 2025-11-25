import jwt from "jsonwebtoken";

const COOKIE_NAME = "auth_token";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ message: "尚未登入" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      sub: payload.sub,
      email: payload.email ?? null,
      isAdmin: Boolean(payload.isAdmin),
    };
    return next();
  } catch (err) {
    return res.status(401).json({ message: "登入狀態已失效，請重新登入" });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ message: "??堒祇瘨?蝙????撠?賣?" });
  }
  return next();
}

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
    req.user = payload; // { sub, phoneCode, phone, iat, exp }
    return next();
  } catch (err) {
    return res.status(401).json({ message: "登入狀態已失效，請重新登入" });
  }
}

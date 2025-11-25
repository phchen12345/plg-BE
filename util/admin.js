const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

export const isAdminEmail = (email = "") =>
  ADMIN_EMAILS.includes(email.trim().toLowerCase());

export const hasAdminEmailsConfigured = ADMIN_EMAILS.length > 0;

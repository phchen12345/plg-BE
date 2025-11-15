import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const pool =
  process.env.DATABASE_URL != null
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ...(process.env.NODE_ENV === "production"
          ? { ssl: { rejectUnauthorized: false } }
          : {}),
      })
    : new Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 5432),
        database: process.env.DB_NAME ?? "plg",
        user: process.env.DB_USER ?? "postgres",
        password: process.env.DB_PASSWORD ?? "postgres",
      });

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL error", err);
  process.exit(1);
});

export default pool;

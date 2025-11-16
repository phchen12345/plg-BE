import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import cartRouter from "./routes/cart.js";
import AuthRouter from "./routes/auth.js";
import AuthGoogleRouter from "./routes/google_auth.js";

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  })
);
app.use(bodyParser.json());
app.use(cookieParser());

app.use("/api/cart", cartRouter);
app.use("/api/auth", AuthRouter);
app.use("/api/auth/google", AuthGoogleRouter);

app.get("/", (req, res) => {
  res.send("OK");
});

app.get("/api/dial-codes", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json([
    { label: "+886 臺灣", value: "+886" },
    { label: "+852 香港", value: "+852" },
    { label: "+853 澳門", value: "+853" },
  ]);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

import express from "express";
import compression from "compression";
import { ENV } from "./env.js";
import { buildRouter } from "./router.js";
import { errorMeta, log } from "./utils/log.js";

const app = express();
app.use(compression());

// Stremio addon protocol requires CORS for all addon routes (including /manifest.json).
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

app.use("/", buildRouter());

app.listen(ENV.PORT, () => {
  log.info("Addon started", {
    baseUrl: ENV.BASE_URL,
    port: ENV.PORT,
    manifest: `${ENV.BASE_URL.replace(/\/+$/g, "")}/manifest.json`,
    configure: `${ENV.BASE_URL.replace(/\/+$/g, "")}/configure`,
    logLevel: ENV.LOG_LEVEL,
  });
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", errorMeta(reason));
});

process.on("uncaughtException", (err) => {
  log.error("Uncaught exception", errorMeta(err));
});

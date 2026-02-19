import express from "express";
import compression from "compression";
import { ENV } from "./env.js";
import { buildRouter } from "./router.js";

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
  // eslint-disable-next-line no-console
  console.log(`Addon running at ${ENV.BASE_URL} (port ${ENV.PORT})`);
  console.log(`Manifest: ${ENV.BASE_URL.replace(/\/+$/g, "")}/manifest.json`);
  console.log(`Configure: ${ENV.BASE_URL.replace(/\/+$/g, "")}/configure`);
});

import express from "express";
import compression from "compression";
import { ENV } from "./env.js";
import { buildRouter } from "./router.js";

const app = express();
app.use(compression());

app.use("/", buildRouter());

app.listen(ENV.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Addon running at ${ENV.BASE_URL} (port ${ENV.PORT})`);
  console.log(`Manifest: ${ENV.BASE_URL.replace(/\/+$/g, "")}/manifest.json`);
  console.log(`Configure: ${ENV.BASE_URL.replace(/\/+$/g, "")}/configure`);
});

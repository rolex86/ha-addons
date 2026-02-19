import { ENV } from "./env.js";
import { CATALOGS } from "./catalogs.js";

export function buildManifest() {
  return {
    id: "org.prehrajto.addon.node",
    version: "0.1.1",
    name: "Prehraj.to (Node)",
    description: "TMDB katalog + stream resolver přes prehraj.to (scrape).",
    logo: "https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/logos/1.png",

    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: CATALOGS,

    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}

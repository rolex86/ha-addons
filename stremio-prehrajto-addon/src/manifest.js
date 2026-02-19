export function buildManifest() {
  return {
    id: "org.prehrajto.addon.node",
    version: "0.1.5",
    name: "Prehraj.to",
    description:
      "Dodatečný stream source přes prehraj.to pro Cinemeta položky.",
    logo: "https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/docs/logos/1.png",

    resources: [
      {
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["tt", "pt:"],
      },
    ],
    types: ["movie", "series"],

    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}

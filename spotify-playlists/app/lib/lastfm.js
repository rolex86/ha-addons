// app/lib/lastfm.js
const https = require("https");

function lastfmGet(apiKey, method, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      method,
      api_key: apiKey,
      format: "json",
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
    });

    const url = `https://ws.audioscrobbler.com/2.0/?${qs.toString()}`;

    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let j = null;
          try {
            j = JSON.parse(data);
          } catch {
            const err = new Error("Last.fm returned invalid JSON");
            err.status = res.statusCode;
            err.body = data;
            return reject(err);
          }

          if (res.statusCode >= 400 || j?.error) {
            const err = new Error(j?.message || "Last.fm error");
            err.status = j?.error || res.statusCode;
            err.body = j;
            return reject(err);
          }

          resolve(j);
        });
      })
      .on("error", (e) => {
        const err = new Error(`Last.fm request failed: ${e?.message || e}`);
        err.status = null;
        err.body = null;
        reject(err);
      });
  });
}

async function getSimilarArtists(apiKey, artistName, limit = 50) {
  const j = await lastfmGet(apiKey, "artist.getSimilar", {
    artist: artistName,
    limit,
  });

  const arr = j?.similarartists?.artist || [];
  return arr
    .map((a) => ({
      name: a?.name,
      match: Number(a?.match || 0),
    }))
    .filter((x) => x.name);
}

module.exports = {
  getSimilarArtists,
};

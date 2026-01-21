// app/lib/generator.js
// Generator with:
// - Spotify API retry/backoff on 429
// - Optional Last.fm discovery (new artists) via LASTFM_API_KEY
// - Fallback to configured Spotify sources pool
// - No-repeat via excludedSet + per-artist limit

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function spRetry(fn, { maxRetries = 6, baseDelayMs = 400 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.statusCode || e?.status;
      const headers = e?.headers || e?.response?.headers;
      const ra = headers?.["retry-after"] || headers?.["Retry-After"];
      const retryAfterMs = ra ? Number(ra) * 1000 : null;

      const isRetryable =
        status === 429 || status === 502 || status === 503 || status === 504;
      if (!isRetryable || attempt >= maxRetries) throw e;

      const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
      const waitMs = retryAfterMs ?? backoff;

      await sleep(waitMs);
      attempt += 1;
    }
  }
}

async function httpJsonRetry(url, { maxRetries = 5, baseDelayMs = 500 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.status === 429 || r.status >= 500) {
        const ra = r.headers.get("retry-after");
        const retryAfterMs = ra ? Number(ra) * 1000 : null;
        if (attempt >= maxRetries) throw new Error(`HTTP ${r.status}`);
        const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
        await sleep(retryAfterMs ?? backoff);
        attempt += 1;
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      const backoff = Math.round(baseDelayMs * Math.pow(2, attempt));
      await sleep(backoff);
      attempt += 1;
    }
  }
}

function parsePlaylistId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
  return m ? m[1] : s;
}

function parseYearFromReleaseDate(rd) {
  if (!rd) return null;
  const m = String(rd).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const k = String(x || "").trim();
    if (!k) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

function getRecipeSources(recipe) {
  const src = recipe.sources || {};
  return {
    playlists: Array.isArray(src.playlists) ? src.playlists : [],
    search: Array.isArray(src.search) ? src.search : [],
    liked: Boolean(src.liked),
    top_tracks:
      src.top_tracks && typeof src.top_tracks === "object"
        ? src.top_tracks
        : null,
    max_candidates: Number(src.max_candidates || 1500),
  };
}

function getRecipeFilters(recipe) {
  const f = recipe.filters || {};
  // explicit policy: "allow" | "exclude" | "only"
  const explicitPolicy = String(f.explicit ?? "allow").toLowerCase();

  return {
    explicit: explicitPolicy,
    year_min:
      f.year_min === null || f.year_min === "" || f.year_min === undefined
        ? null
        : Number(f.year_min),
    year_max:
      f.year_max === null || f.year_max === "" || f.year_max === undefined
        ? null
        : Number(f.year_max),
  };
}

function getRecipeLimits(recipe) {
  const d = recipe.diversity || {};
  const maxPerArtist = d.max_per_artist ?? null;

  return {
    max_per_artist:
      maxPerArtist === null || maxPerArtist === "" || maxPerArtist === undefined
        ? null
        : Number(maxPerArtist),
  };
}

function getDiscovery(recipe) {
  const d = recipe.discovery || {};
  return {
    enabled: Boolean(d.enabled),
    // Spotify seed: top artists
    seed_top_artists_limit: Number(d.seed_top_artists_limit ?? 5),
    seed_top_artists_time_range: String(
      d.seed_top_artists_time_range ?? "short_term",
    ),
    // Last.fm similar
    similar_per_seed: Number(d.similar_per_seed ?? 30),
    take_artists: Number(d.take_artists ?? 80),
    // Last.fm top tracks per artist to try
    tracks_per_artist: Number(d.tracks_per_artist ?? 2),
    // Spotify search cap per query (safety)
    search_limit_per_track: Number(d.search_limit_per_track ?? 5),
  };
}

function normalizeTrack(t) {
  return {
    id: t?.id,
    explicit: Boolean(t?.explicit),
    release_date: t?.album?.release_date || null,
    artists: Array.isArray(t?.artists)
      ? t.artists.map((a) => ({ id: a.id, name: a.name }))
      : [],
    name: t?.name || "",
  };
}

function applyFiltersAndDedup(rawTracks, { excludedSet, filters }) {
  const out = [];
  const seen = new Set();

  for (const rt of rawTracks) {
    const t = normalizeTrack(rt);
    if (!t.id) continue;

    if (seen.has(t.id)) continue;
    seen.add(t.id);

    if (excludedSet && excludedSet.has(t.id)) continue;

    if (filters.explicit === "exclude" && t.explicit) continue;
    if (filters.explicit === "only" && !t.explicit) continue;

    const y = parseYearFromReleaseDate(t.release_date);
    if (filters.year_min !== null && y !== null && y < filters.year_min)
      continue;
    if (filters.year_max !== null && y !== null && y > filters.year_max)
      continue;

    out.push(t);
  }

  return out;
}

function selectTracks(candidates, trackCount, maxPerArtist) {
  const chosen = [];
  const artistCounts = new Map();

  for (const t of candidates) {
    if (chosen.length >= trackCount) break;

    if (maxPerArtist && maxPerArtist > 0) {
      const a0 = t.artists?.[0]?.id || t.artists?.[0]?.name || null;
      if (a0) {
        const c = artistCounts.get(a0) || 0;
        if (c >= maxPerArtist) continue;
        artistCounts.set(a0, c + 1);
      }
    }

    chosen.push(t);
  }

  return chosen;
}

async function fetchAllPlaylistTrackItems(sp, playlistId, maxCandidates) {
  const items = [];
  let offset = 0;
  const limit = 100;

  while (items.length < maxCandidates) {
    const resp = await spRetry(() =>
      sp.getPlaylistTracks(playlistId, {
        limit,
        offset,
        fields:
          "items(track(id,uri,name,explicit,album(release_date),artists(id,name))),next",
      }),
    );

    const batch = resp.body?.items || [];
    for (const it of batch) {
      if (it?.track) items.push(it.track);
      if (items.length >= maxCandidates) break;
    }

    if (!resp.body?.next) break;
    offset += limit;
  }

  return items;
}

async function fetchLikedTracks(sp, maxCandidates) {
  const items = [];
  let offset = 0;
  const limit = 50;

  while (items.length < maxCandidates) {
    const resp = await spRetry(() => sp.getMySavedTracks({ limit, offset }));

    const batch = resp.body?.items || [];
    for (const it of batch) {
      if (it?.track) items.push(it.track);
      if (items.length >= maxCandidates) break;
    }

    if (!resp.body?.next) break;
    offset += limit;
  }

  return items;
}

async function fetchTopTracks(sp, timeRange, maxCandidates) {
  const items = [];
  let offset = 0;
  const limit = 50;

  while (items.length < maxCandidates) {
    const resp = await spRetry(() =>
      sp.getMyTopTracks({
        time_range: timeRange || "short_term",
        limit,
        offset,
      }),
    );

    const batch = resp.body?.items || [];
    for (const t of batch) {
      if (t) items.push(t);
      if (items.length >= maxCandidates) break;
    }

    if (batch.length < limit) break;
    offset += limit;
  }

  return items;
}

async function fetchSearchTracks(sp, query, market, maxCandidates) {
  const items = [];
  let offset = 0;
  const limit = 50;

  while (items.length < maxCandidates) {
    const resp = await spRetry(() =>
      sp.searchTracks(query, {
        market,
        limit,
        offset,
      }),
    );

    const batch = resp.body?.tracks?.items || [];
    for (const t of batch) {
      if (t) items.push(t);
      if (items.length >= maxCandidates) break;
    }

    if (batch.length < limit) break;
    offset += limit;
  }

  return items;
}

// -------- Last.fm discovery (new artists) --------

function lastfmKey() {
  return process.env.LASTFM_API_KEY
    ? String(process.env.LASTFM_API_KEY).trim()
    : "";
}

function lastfmUrl(params) {
  const usp = new URLSearchParams({
    format: "json",
    api_key: lastfmKey(),
    ...params,
  });
  return `https://ws.audioscrobbler.com/2.0/?${usp.toString()}`;
}

async function lastfmGetSimilarArtists(artistName, limit) {
  const url = lastfmUrl({
    method: "artist.getsimilar",
    artist: artistName,
    limit: String(limit || 30),
    autocorrect: "1",
  });

  const js = await httpJsonRetry(url);
  const items = js?.similarartists?.artist || [];
  return items.map((a) => a?.name).filter(Boolean);
}

async function lastfmGetTopTracks(artistName, limit) {
  const url = lastfmUrl({
    method: "artist.gettoptracks",
    artist: artistName,
    limit: String(limit || 5),
    autocorrect: "1",
  });

  const js = await httpJsonRetry(url);
  const items = js?.toptracks?.track || [];
  return items.map((t) => t?.name).filter(Boolean);
}

async function spotifySearchTrackId(sp, artistName, trackName, market) {
  // Use a strict-ish query to reduce noise
  const q = `artist:"${artistName}" track:"${trackName}"`;
  const resp = await spRetry(() =>
    sp.searchTracks(q, { market, limit: 5, offset: 0 }),
  );
  const items = resp.body?.tracks?.items || [];
  // pick first
  const t0 = items[0];
  return t0?.id || null;
}

async function discoverWithLastFm({ sp, market, excludedSet, recipe }) {
  const meta = {
    provider: "lastfm",
    used_provider: "lastfm",
    need: Number(recipe.track_count ?? 50),
    counts: { lastfm_selected: 0, fallback_selected: 0 },
    notes: [],
  };

  const d = getDiscovery(recipe);
  if (!d.enabled) {
    meta.used_provider = "sources";
    meta.provider = "sources";
    meta.notes.push("discovery_disabled");
    return { tracks: [], meta };
  }

  if (!lastfmKey()) {
    meta.used_provider = "sources";
    meta.provider = "sources";
    meta.notes.push("missing_lastfm_api_key");
    return { tracks: [], meta };
  }

  // 1) seed artists from Spotify top artists
  const top = await spRetry(() =>
    sp.getMyTopArtists({
      limit: Math.max(1, Math.min(50, d.seed_top_artists_limit)),
      time_range: d.seed_top_artists_time_range,
    }),
  );

  const seeds = (top.body?.items || []).map((a) => a?.name).filter(Boolean);
  if (!seeds.length) {
    meta.used_provider = "sources";
    meta.provider = "sources";
    meta.notes.push("no_top_artists");
    return { tracks: [], meta };
  }

  // 2) similar artists from Last.fm
  const similarAll = [];
  for (const s of seeds) {
    const sim = await lastfmGetSimilarArtists(s, d.similar_per_seed);
    similarAll.push(...sim);
  }

  // include seeds too (helps)
  const artistPool = uniq([...seeds, ...similarAll]).slice(
    0,
    Math.max(5, d.take_artists),
  );

  // 3) top tracks (Last.fm) -> search on Spotify -> build candidates
  const candidates = [];
  const seenTrackIds = new Set();

  for (const artistName of artistPool) {
    const topTracks = await lastfmGetTopTracks(
      artistName,
      Math.max(1, d.tracks_per_artist),
    );
    for (const tn of topTracks.slice(0, d.tracks_per_artist)) {
      const id = await spotifySearchTrackId(sp, artistName, tn, market);
      if (!id) continue;
      if (excludedSet && excludedSet.has(id)) continue;
      if (seenTrackIds.has(id)) continue;
      seenTrackIds.add(id);

      // minimal shape (we’ll enrich later via filters? here we skip audio features etc)
      candidates.push({ id, name: tn, artists: [{ name: artistName }] });
    }
  }

  // Turn into "track objects" that normalizeTrack can accept:
  // We need explicit + album.release_date + artists[]; but for discovery we might not have it.
  // We'll fetch full track objects in batches via Spotify "getTracks" to apply filters correctly.
  const ids = candidates.map((c) => c.id);
  if (!ids.length) {
    meta.notes.push("lastfm_no_matches");
    return { tracks: [], meta };
  }

  const fullTracks = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const resp = await spRetry(() => sp.getTracks(chunk, { market }));
    fullTracks.push(...(resp.body?.tracks || []).filter(Boolean));
  }

  meta.counts.lastfm_selected = fullTracks.length;
  return { tracks: fullTracks, meta };
}

// -------- sources fallback (playlists/liked/top/search) --------

async function poolFromSources({ sp, recipe, market, excludedSet }) {
  const sources = getRecipeSources(recipe);
  const filters = getRecipeFilters(recipe);
  const limits = getRecipeLimits(recipe);

  const trackCount = Number(recipe.track_count ?? 50);
  const maxCandidates = Math.max(
    50,
    Math.min(10000, sources.max_candidates || 1500),
  );

  const raw = [];

  // 1) playlists
  if (sources.playlists.length) {
    const per = Math.floor(
      maxCandidates / Math.max(1, sources.playlists.length),
    );
    for (const p of sources.playlists) {
      const pid = parsePlaylistId(p);
      if (!pid) continue;
      const got = await fetchAllPlaylistTrackItems(sp, pid, per);
      raw.push(...got);
    }
  }

  // 2) search queries
  if (sources.search.length) {
    const per = Math.floor(maxCandidates / Math.max(1, sources.search.length));
    for (const q of sources.search) {
      const got = await fetchSearchTracks(sp, String(q), market, per);
      raw.push(...got);
    }
  }

  // 3) liked
  if (sources.liked) {
    const got = await fetchLikedTracks(sp, Math.floor(maxCandidates / 2));
    raw.push(...got);
  }

  // 4) top tracks
  if (sources.top_tracks?.enabled) {
    const tr = sources.top_tracks?.time_range || "short_term";
    const got = await fetchTopTracks(sp, tr, Math.floor(maxCandidates / 2));
    raw.push(...got);
  }

  // fallback if nothing configured
  if (raw.length === 0) {
    const liked = await fetchLikedTracks(sp, Math.floor(maxCandidates / 2));
    const top = await fetchTopTracks(
      sp,
      "short_term",
      Math.floor(maxCandidates / 2),
    );
    raw.push(...liked, ...top);
  }

  let candidates = applyFiltersAndDedup(raw, {
    excludedSet: excludedSet || new Set(),
    filters,
  });
  shuffleInPlace(candidates);

  const selected = selectTracks(candidates, trackCount, limits.max_per_artist);
  return selected;
}

// -------- public API --------

async function generateTracksWithMeta({ sp, recipe, market, excludedSet }) {
  const need = Number(recipe.track_count ?? 50);

  const meta = {
    need,
    provider: "sources",
    used_provider: "sources",
    counts: { lastfm_selected: 0, fallback_selected: 0 },
    notes: [],
  };

  const filters = getRecipeFilters(recipe);
  const limits = getRecipeLimits(recipe);

  // 1) Try Last.fm discovery first if enabled
  let discovered = [];
  const disc = getDiscovery(recipe);

  if (disc.enabled) {
    const dres = await discoverWithLastFm({ sp, market, excludedSet, recipe });
    meta.provider = dres.meta.provider;
    meta.used_provider = dres.meta.used_provider;
    meta.notes.push(...(dres.meta.notes || []));
    discovered = dres.tracks || [];

    // Apply filters/dedup/excluded to discovery
    discovered = applyFiltersAndDedup(discovered, {
      excludedSet: excludedSet || new Set(),
      filters,
    });
    shuffleInPlace(discovered);

    // Apply per-artist limit selection from discovery first
    const picked = selectTracks(discovered, need, limits.max_per_artist);
    meta.counts.lastfm_selected = picked.length;

    if (picked.length >= need) {
      meta.used_provider = "lastfm";
      return { tracks: picked.slice(0, need), meta };
    }

    // Not enough -> fill from sources
    const remainingNeed = need - picked.length;
    meta.notes.push("fill_from_sources");
    const fallback = await poolFromSources({
      sp,
      recipe,
      market,
      excludedSet: new Set([
        ...(excludedSet || []),
        ...picked.map((t) => t.id),
      ]),
    });

    // Ensure we only add what we still need
    const add = fallback.slice(0, remainingNeed);
    meta.counts.fallback_selected = add.length;

    meta.used_provider = "mixed";
    return { tracks: [...picked, ...add].slice(0, need), meta };
  }

  // 2) Sources only
  const tracks = await poolFromSources({ sp, recipe, market, excludedSet });
  meta.used_provider = "sources";
  meta.counts.fallback_selected = tracks.length;
  return { tracks: tracks.slice(0, need), meta };
}

async function replacePlaylistItems({ sp, playlistId, trackUris }) {
  const pid = String(playlistId || "").trim();
  const uris = Array.isArray(trackUris) ? trackUris : [];

  const first = uris.slice(0, 100);
  await spRetry(() => sp.replaceTracksInPlaylist(pid, first));

  let offset = 100;
  while (offset < uris.length) {
    const chunk = uris.slice(offset, offset + 100);
    await spRetry(() => sp.addTracksToPlaylist(pid, chunk));
    offset += 100;
  }
}

module.exports = {
  generateTracksWithMeta,
  replacePlaylistItems,
};

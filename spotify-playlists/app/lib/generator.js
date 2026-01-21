// MVP generator: uses Spotify recommendations with seeds + audio feature targets,
// then filters with history + diversity constraints.

async function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function clamp01(x) {
  if (x == null) return null;
  const n = Number(x);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function numOrNull(x) {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isNaN(n) ? null : n;
}

function buildRecommendationsParams(recipe, market) {
  const seeds = {};
  if (
    Array.isArray(recipe.source?.seed_genres) &&
    recipe.source.seed_genres.length
  ) {
    seeds.seed_genres = recipe.source.seed_genres.slice(0, 5).join(",");
  }
  if (
    Array.isArray(recipe.source?.seed_tracks) &&
    recipe.source.seed_tracks.length
  ) {
    seeds.seed_tracks = recipe.source.seed_tracks.slice(0, 5).join(",");
  }
  if (
    Array.isArray(recipe.source?.seed_artists) &&
    recipe.source.seed_artists.length
  ) {
    seeds.seed_artists = recipe.source.seed_artists.slice(0, 5).join(",");
  }

  const f = recipe.filters || {};
  const params = {
    market,
    limit: 100,
    ...seeds,
  };

  // Tempo (BPM)
  const tempoMin = numOrNull(f.tempo_min);
  const tempoMax = numOrNull(f.tempo_max);
  if (tempoMin != null) params.min_tempo = tempoMin;
  if (tempoMax != null) params.max_tempo = tempoMax;

  // Year isn't supported directly in recommendations; we'll filter later by album release_date

  // Audio features supported as target/min/max (some do)
  const energyMin = numOrNull(f.energy_min);
  const energyMax = numOrNull(f.energy_max);
  const valMin = numOrNull(f.valence_min);
  const valMax = numOrNull(f.valence_max);
  const danceMin = numOrNull(f.danceability_min);
  const danceMax = numOrNull(f.danceability_max);

  if (energyMin != null) params.min_energy = clamp01(energyMin);
  if (energyMax != null) params.max_energy = clamp01(energyMax);
  if (valMin != null) params.min_valence = clamp01(valMin);
  if (valMax != null) params.max_valence = clamp01(valMax);
  if (danceMin != null) params.min_danceability = clamp01(danceMin);
  if (danceMax != null) params.max_danceability = clamp01(danceMax);

  return params;
}

function yearFromReleaseDate(releaseDate) {
  // releaseDate may be "YYYY", "YYYY-MM", "YYYY-MM-DD"
  if (!releaseDate) return null;
  const m = String(releaseDate).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function applyFiltersAndDiversity({ tracks, recipe, excludedSet }) {
  const out = [];
  const maxPerArtist = Number(recipe.diversity?.max_per_artist ?? 2);
  const maxPerAlbum = Number(recipe.diversity?.max_per_album ?? 2);
  const avoidSameArtistInRow = Boolean(
    recipe.diversity?.avoid_same_artist_in_row ?? true,
  );

  const yearMin =
    recipe.filters?.year_min != null ? Number(recipe.filters.year_min) : null;
  const yearMax =
    recipe.filters?.year_max != null ? Number(recipe.filters.year_max) : null;

  const explicitAllowed = recipe.filters?.explicit_allowed ?? true;

  const artistCount = new Map();
  const albumCount = new Map();

  let lastArtistId = null;

  for (const t of tracks) {
    if (!t || !t.id) continue;
    if (excludedSet.has(t.id)) continue;

    if (explicitAllowed === false && t.explicit === true) continue;

    const y = yearFromReleaseDate(t.album?.release_date);
    if (yearMin != null && y != null && y < yearMin) continue;
    if (yearMax != null && y != null && y > yearMax) continue;

    const artistId = t.artists?.[0]?.id || null;
    const albumId = t.album?.id || null;

    if (artistId) {
      const c = artistCount.get(artistId) || 0;
      if (c >= maxPerArtist) continue;
      if (avoidSameArtistInRow && lastArtistId && lastArtistId === artistId)
        continue;
    }

    if (albumId) {
      const c = albumCount.get(albumId) || 0;
      if (c >= maxPerAlbum) continue;
    }

    out.push(t);

    if (artistId) {
      artistCount.set(artistId, (artistCount.get(artistId) || 0) + 1);
      lastArtistId = artistId;
    }
    if (albumId) {
      albumCount.set(albumId, (albumCount.get(albumId) || 0) + 1);
    }
  }

  return out;
}

async function generateTracks({ sp, recipe, market, excludedSet }) {
  const wanted = Number(recipe.track_count ?? 50);
  const collected = [];
  const seen = new Set(); // avoid duplicates in run

  // Strategy: call recommendations multiple times (up to ~10) until we have enough.
  const paramsBase = buildRecommendationsParams(recipe, market);

  const attempts = Number(recipe.advanced?.recommendation_attempts ?? 10);

  for (let i = 0; i < attempts && collected.length < wanted; i++) {
    const params = { ...paramsBase };

    // If recipe has "discovery", we can vary popularity bounds etc. later (optional)
    const rec = await sp.getRecommendations(params);
    const tracks = rec.body?.tracks || [];

    // remove dupes and already-seen
    const unique = tracks.filter((t) => t?.id && !seen.has(t.id));
    for (const t of unique) seen.add(t.id);

    const filtered = applyFiltersAndDiversity({
      tracks: unique,
      recipe,
      excludedSet,
    });

    for (const t of filtered) {
      if (collected.length >= wanted) break;
      // no repeats within playlist
      if (collected.some((x) => x.id === t.id)) continue;
      collected.push(t);
    }
  }

  return collected.slice(0, wanted);
}

async function replacePlaylistItems({ sp, playlistId, trackUris }) {
  // Spotify: replace playlist items (max 100 per call). Use replace for first batch, then add.
  const batches = await chunk(trackUris, 100);
  if (batches.length === 0) {
    // empty playlist
    await sp.replaceTracksInPlaylist(playlistId, []);
    return;
  }
  await sp.replaceTracksInPlaylist(playlistId, batches[0]);
  for (let i = 1; i < batches.length; i++) {
    await sp.addTracksToPlaylist(playlistId, batches[i]);
  }
}

module.exports = {
  generateTracks,
  replacePlaylistItems,
};

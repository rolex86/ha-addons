export const CATALOGS = [
  // Movies
  {
    id: "movie_popular",
    type: "movie",
    name: "Prehraj.to (TMDB) • Filmy • Popular",
    extraSupported: ["skip"],
  },
  {
    id: "movie_trending",
    type: "movie",
    name: "Prehraj.to (TMDB) • Filmy • Trending",
    extraSupported: ["skip"],
  },
  {
    id: "movie_by_genre",
    type: "movie",
    name: "Prehraj.to (TMDB) • Filmy • Žánr",
    extraSupported: ["genre", "skip"],
  },
  {
    id: "movie_by_year",
    type: "movie",
    name: "Prehraj.to (TMDB) • Filmy • Rok",
    extraSupported: ["year", "skip"],
  },

  // Series
  {
    id: "series_popular",
    type: "series",
    name: "Prehraj.to (TMDB) • Seriály • Popular",
    extraSupported: ["skip"],
  },
  {
    id: "series_trending",
    type: "series",
    name: "Prehraj.to (TMDB) • Seriály • Trending",
    extraSupported: ["skip"],
  },
  {
    id: "series_by_genre",
    type: "series",
    name: "Prehraj.to (TMDB) • Seriály • Žánr",
    extraSupported: ["genre", "skip"],
  },
  {
    id: "series_by_year",
    type: "series",
    name: "Prehraj.to (TMDB) • Seriály • Rok",
    extraSupported: ["year", "skip"],
  },

  // Direct search on prehraj.to
  {
    id: "pt_search",
    type: "movie",
    name: "Prehraj.to • Hledání (přímé)",
    extraSupported: ["search", "skip"],
  },
];

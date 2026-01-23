@echo off
setlocal
cd /d "%~dp0"

REM Data složka je o level výš: spotify-playlists\data
set "DATA_DIR=%~dp0..\data"

REM Volitelně port (jinak default 7790)
set "PORT=7790"

REM --- API / Spotify tokeny (doplň svoje) ---
REM Ochrana endpointu /api/run (Bearer token), pokud chceš:
REM set "API_TOKEN=SEM_DEJ_SVOJ_API_TOKEN"

set "SPOTIFY_CLIENT_ID=eeb31d2e68fc481283e3ec7696562011"
set "SPOTIFY_CLIENT_SECRET=abe57d7cfe914c058c1d7653ee786a8c"
set "SPOTIFY_REDIRECT_URI=http://localhost:%PORT%/api/auth/callback"
set "SPOTIFY_MARKET=CZ"

REM --- Discovery API keys (pokud je projekt používá) ---
REM Last.fm
set "LASTFM_API_KEY=4b23ef4976e490b3ce862cb2d1899ec8"

REM TasteDive
set "TASTEDIVE_API_KEY=1067454-spotifyp-17532C3F"

REM TheAudioDB
set "AUDIODB_API_KEY=123"

echo [run-local] DATA_DIR=%DATA_DIR%
echo [run-local] PORT=%PORT%
echo [run-local] SPOTIFY_CLIENT_ID=%SPOTIFY_CLIENT_ID%
echo [run-local] LASTFM_API_KEY=%LASTFM_API_KEY%
echo [run-local] TASTEDIVE_API_KEY=%TASTEDIVE_API_KEY%
echo [run-local] AUDIODB_API_KEY=%AUDIODB_API_KEY%

node "%~dp0server.js"
pause

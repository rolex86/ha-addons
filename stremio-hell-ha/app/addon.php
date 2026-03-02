<?php
// addon.php
// Hellspy Stremio addon with full file logging + Wikidata title resolver
declare(strict_types=1);

// ---------- CONFIG ----------
const ADDON_ID = "org.stremio.hellspy";
const ADDON_VERSION = "0.1.10";
const ADDON_NAME = "Hellspy";
const ADDON_DESCRIPTION = "Hellspy.to addon for Stremio";

const CACHE_TTL = 3600; // seconds (default)
const CACHE_TTL_WIKIDATA = 604800; // 7 days
const CACHE_TTL_SEARCH = 3600; // 1 hour
const CACHE_TTL_STREAM = 900; // 15 minutes
const CACHE_TTL_STREAM_NEGATIVE = 300; // 5 minutes
const REQUEST_DELAY = 1.0; // legacy fallback seconds
const REQUEST_DELAY_HELLSPY_DEFAULT = 0.5; // step-down default, can be reduced to 0.25 after monitoring
const REQUEST_DELAY_WIKIDATA_DEFAULT = 1.0;
const REQUEST_DELAY_OTHER_DEFAULT = 0.25;
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 2.0;
const MAX_RETRY_BACKOFF = 8.0;
const REQUEST_TIMEOUT = 10;
const SEARCH_TIME_BUDGET_MS = 7000;
const MAX_SEARCH_QUERIES = 8;
const STREAM_REQUEST_CACHE_TTL = 120;
const STREAM_REQUEST_INFLIGHT_WAIT_MS = 8000;
const STREAM_REQUEST_INFLIGHT_POLL_MS = 100;
const STREAM_RESOLVE_CONCURRENCY = 2;
const STREAM_RESOLVE_CONCURRENCY_HARD_CAP = 2;
const LOG_LEVEL_DEFAULT = 'info';
const LOG_LEVEL_DEFAULT_PRODUCTION = 'warn';
const LOG_HTTP_RESPONSE_BODY = false;

$__addonUrl = getenv('ADDON_URL') ?: 'https://example.invalid';
$__addonContact = getenv('ADDON_CONTACT') ?: 'mailto:admin@example.invalid';
define('ADDON_URL', $__addonUrl);
define('ADDON_CONTACT', $__addonContact);

// Persist data in /data when available (Home Assistant add-on), otherwise next to addon.php
$__DATA_BASE = (is_dir('/data') && is_writable('/data')) ? '/data/stremio-hellspy' : __DIR__;
if (!is_dir($__DATA_BASE)) { @mkdir($__DATA_BASE, 0755, true); }

define('CACHE_DIR', $__DATA_BASE . '/cache_hellspy_php');
define('LOG_FILE',  $__DATA_BASE . '/addon.log');
define('RATE_LIMIT_FILE', $__DATA_BASE . '/ratelimit.lock');
define('RATE_LIMIT_DIR', $__DATA_BASE . '/ratelimit');
define('INFLIGHT_DIR', $__DATA_BASE . '/inflight');

// ensure cache dir
if (!is_dir(CACHE_DIR)) {
    mkdir(CACHE_DIR, 0755, true);
}
if (!is_dir(RATE_LIMIT_DIR)) {
    mkdir(RATE_LIMIT_DIR, 0755, true);
}
if (!is_dir(INFLIGHT_DIR)) {
    mkdir(INFLIGHT_DIR, 0755, true);
}

function env_float(string $name, float $default, float $min, float $max): float {
    $raw = getenv($name);
    if ($raw === false) return $default;
    $val = (float)$raw;
    if (!is_finite($val)) return $default;
    if ($val < $min) return $min;
    if ($val > $max) return $max;
    return $val;
}

function env_int(string $name, int $default, int $min, int $max): int {
    $raw = getenv($name);
    if ($raw === false) return $default;
    $val = (int)$raw;
    if ($val < $min) return $min;
    if ($val > $max) return $max;
    return $val;
}

function env_bool(string $name, bool $default): bool {
    $raw = getenv($name);
    if ($raw === false) return $default;
    $v = strtolower(trim((string)$raw));
    if (in_array($v, ['1', 'true', 'yes', 'on'], true)) return true;
    if (in_array($v, ['0', 'false', 'no', 'off'], true)) return false;
    return $default;
}

$__hasLegacyDelay = getenv('REQUEST_DELAY') !== false;
$__legacyDelay = env_float('REQUEST_DELAY', REQUEST_DELAY, 0.0, 10.0);
$__defaultHellspyDelay = $__hasLegacyDelay ? $__legacyDelay : REQUEST_DELAY_HELLSPY_DEFAULT;
$__defaultWikidataDelay = $__hasLegacyDelay ? $__legacyDelay : REQUEST_DELAY_WIKIDATA_DEFAULT;
$__defaultOtherDelay = $__hasLegacyDelay ? min($__legacyDelay, REQUEST_DELAY_OTHER_DEFAULT) : REQUEST_DELAY_OTHER_DEFAULT;

define(
    'REQUEST_DELAY_HELLSPY',
    env_float('REQUEST_DELAY_HELLSPY', env_float('HELLSPY_REQUEST_DELAY', $__defaultHellspyDelay, 0.0, 10.0), 0.0, 10.0)
);
define('REQUEST_DELAY_WIKIDATA', env_float('REQUEST_DELAY_WIKIDATA', $__defaultWikidataDelay, 0.0, 10.0));
define('REQUEST_DELAY_OTHER', env_float('REQUEST_DELAY_OTHER', $__defaultOtherDelay, 0.0, 10.0));
define('MAX_RETRIES_RUNTIME', env_int('MAX_RETRIES', MAX_RETRIES, 0, 8));
define('REQUEST_TIMEOUT_RUNTIME', env_int('REQUEST_TIMEOUT', REQUEST_TIMEOUT, 2, 60));
define('RETRY_DELAY_BASE_RUNTIME', env_float('RETRY_DELAY_BASE', RETRY_DELAY_BASE, 0.1, 30.0));
define('MAX_RETRY_BACKOFF_RUNTIME', env_float('MAX_RETRY_BACKOFF', MAX_RETRY_BACKOFF, 0.1, 60.0));
define('SEARCH_TIME_BUDGET_MS_RUNTIME', env_int('SEARCH_TIME_BUDGET_MS', SEARCH_TIME_BUDGET_MS, 500, 30000));
define('MAX_SEARCH_QUERIES_RUNTIME', env_int('MAX_SEARCH_QUERIES', MAX_SEARCH_QUERIES, 1, 20));
define('STREAM_REQUEST_CACHE_TTL_RUNTIME', env_int('STREAM_REQUEST_CACHE_TTL', STREAM_REQUEST_CACHE_TTL, 5, 900));
define('STREAM_REQUEST_INFLIGHT_WAIT_MS_RUNTIME', env_int('STREAM_REQUEST_INFLIGHT_WAIT_MS', STREAM_REQUEST_INFLIGHT_WAIT_MS, 200, 20000));
define('STREAM_REQUEST_INFLIGHT_POLL_MS_RUNTIME', env_int('STREAM_REQUEST_INFLIGHT_POLL_MS', STREAM_REQUEST_INFLIGHT_POLL_MS, 20, 1000));
define(
    'STREAM_RESOLVE_CONCURRENCY_RUNTIME',
    env_int('STREAM_RESOLVE_CONCURRENCY', STREAM_RESOLVE_CONCURRENCY, 1, STREAM_RESOLVE_CONCURRENCY_HARD_CAP)
);

$__appEnv = strtolower(trim((string)(getenv('APP_ENV') ?: getenv('ENV') ?: '')));
$__defaultLogLevel = $__appEnv === 'production' ? LOG_LEVEL_DEFAULT_PRODUCTION : LOG_LEVEL_DEFAULT;
$__rawLogLevel = strtolower(trim((string)(getenv('LOG_LEVEL') ?: $__defaultLogLevel)));
if (!in_array($__rawLogLevel, ['debug', 'info', 'warn', 'error'], true)) {
    $__rawLogLevel = $__defaultLogLevel;
}
define('LOG_LEVEL_RUNTIME', $__rawLogLevel);
define('LOG_HTTP_RESPONSE_BODY_RUNTIME', env_bool('LOG_HTTP_RESPONSE_BODY', LOG_HTTP_RESPONSE_BODY));

// ---------- Logging ----------
function log_level_priority(string $level): int {
    $lvl = strtoupper(trim($level));
    if ($lvl === 'DEBUG') return 10;
    if ($lvl === 'INFO') return 20;
    if ($lvl === 'WARN') return 30;
    return 40; // ERROR and fallback
}

function should_log(string $level): bool {
    return log_level_priority($level) >= log_level_priority(LOG_LEVEL_RUNTIME);
}

function log_msg(string $level, string $msg) {
    if (!should_log($level)) return;
    $entry = "[" . date('Y-m-d H:i:s') . "][$level] $msg\n";
    file_put_contents(LOG_FILE, $entry, FILE_APPEND | LOCK_EX);
}
function log_debug(string $msg) { log_msg('DEBUG', $msg); }
function log_info(string $msg) { log_msg('INFO', $msg); }
function log_warn(string $msg) { log_msg('WARN', $msg); }
function log_err(string $msg)  { log_msg('ERROR', $msg); }

// startup log
file_put_contents(LOG_FILE, "[".date('Y-m-d H:i:s')."][START] addon.php loaded\n", FILE_APPEND | LOCK_EX);

// ---------- Helpers ----------
function now_float(): float { return microtime(true); }

function cache_get(string $key) {
    $path = CACHE_DIR . '/' . md5($key) . '.json';
    if (!is_file($path)) return null;
    $fp = @fopen($path, 'rb');
    if (!$fp) return null;
    @flock($fp, LOCK_SH);
    $raw = stream_get_contents($fp);
    @flock($fp, LOCK_UN);
    fclose($fp);
    if ($raw === false || $raw === '') return null;
    $data = @json_decode($raw, true);
    if (!is_array($data) || !isset($data['timestamp'])) return null;
    $ttl = isset($data['ttl']) ? (int)$data['ttl'] : CACHE_TTL;
    if ((time() - (int)$data['timestamp']) < $ttl) {
        return $data['value'] ?? null;
    }
    @unlink($path);
    return null;
}
function cache_set(string $key, $value, ?int $ttl = null): void {
    $path = CACHE_DIR . '/' . md5($key) . '.json';
    $payload = ['timestamp'=>time(),'value'=>$value];
    if ($ttl !== null) $payload['ttl'] = $ttl;
    $json = json_encode($payload);
    if ($json === false) return;
    $tmp = $path . '.' . uniqid('tmp', true);
    if (@file_put_contents($tmp, $json, LOCK_EX) === false) return;
    if (!@rename($tmp, $path)) {
        @unlink($path);
        @rename($tmp, $path);
    }
}

function detect_resolution_label(string $text): ?string {
    if ($text === '') return null;
    $patterns = [
        '4320p' => '/\b(?:4320p?|8k)\b/i',
        '2160p' => '/\b(?:2160p?|4k|uhd)\b/i',
        '1440p' => '/\b(?:1440p?|2k|qhd)\b/i',
        '1080p' => '/\b(?:1080p?|full[\s._-]?hd|fhd)\b/i',
        '720p' => '/\b(?:720p?|hd)\b/i',
        '576p' => '/\b576p?\b/i',
        '480p' => '/\b(?:480p?|sd)\b/i',
        '360p' => '/\b360p?\b/i',
        '240p' => '/\b240p?\b/i'
    ];
    foreach ($patterns as $label => $pattern) {
        if (preg_match($pattern, $text)) return $label;
    }
    if (preg_match('/\b(\d{3,4})(?:p|i)\b/i', $text, $m)) {
        return $m[1] . 'p';
    }
    return null;
}

function detect_hdr_label(string $text): ?string {
    if ($text === '') return null;
    $hasDv = preg_match('/\b(?:dolby[\s._-]*vision|dovi|dv)\b/i', $text) === 1;
    $hasHdr10Plus = preg_match('/\b(?:hdr10\+|hdr10plus)\b/i', $text) === 1;
    $hasHdr10 = preg_match('/\bhdr10\b/i', $text) === 1;
    $hasHdr = preg_match('/\bhdr\b/i', $text) === 1;
    $hasHlg = preg_match('/\bhlg\b/i', $text) === 1;

    if ($hasDv && $hasHdr10Plus) return 'DV HDR10+';
    if ($hasDv && ($hasHdr10 || $hasHdr)) return 'DV HDR';
    if ($hasDv) return 'DV';
    if ($hasHdr10Plus) return 'HDR10+';
    if ($hasHdr10) return 'HDR10';
    if ($hasHdr) return 'HDR';
    if ($hasHlg) return 'HLG';
    return null;
}

function normalize_quality_fallback(?string $quality): ?string {
    if ($quality === null) return null;
    $quality = trim($quality);
    if ($quality === '') return null;

    $resolution = detect_resolution_label($quality);
    $hdr = detect_hdr_label($quality);
    if ($resolution !== null && $hdr !== null) return $resolution . ' ' . $hdr;
    if ($resolution !== null) return $resolution;
    if ($hdr !== null) return $hdr;

    if (preg_match('/^\d+$/', $quality)) return $quality . 'p';
    if (strcasecmp($quality, 'original') === 0) return 'Original';
    return strtoupper($quality);
}

function build_display_quality(string $releaseTitle, ?string $apiQuality): string {
    $releaseTitle = trim($releaseTitle);
    $apiQuality = trim((string)$apiQuality);

    $resolution = detect_resolution_label($releaseTitle);
    $hdr = detect_hdr_label($releaseTitle);

    if ($resolution === null && $apiQuality !== '') {
        $resolution = detect_resolution_label($apiQuality);
    }
    if ($hdr === null && $apiQuality !== '') {
        $hdr = detect_hdr_label($apiQuality);
    }

    $parts = [];
    if ($resolution !== null) $parts[] = $resolution;
    if ($hdr !== null) $parts[] = $hdr;
    if (!empty($parts)) return implode(' ', $parts);

    $fallback = normalize_quality_fallback($apiQuality);
    return $fallback ?? 'unknown';
}

// ---------- HTTP Requests ----------
function host_from_url(string $url): string {
    $host = parse_url($url, PHP_URL_HOST);
    if (!is_string($host) || $host === '') return 'unknown';
    return strtolower($host);
}

function request_delay_for_host(string $host): float {
    if ($host === 'api.hellspy.to') return REQUEST_DELAY_HELLSPY;
    if ($host === 'query.wikidata.org') return REQUEST_DELAY_WIKIDATA;
    return REQUEST_DELAY_OTHER;
}

function rate_limit_file_for_host(string $host): string {
    $safeHost = preg_replace('/[^a-z0-9._-]+/i', '_', $host);
    if (!is_string($safeHost) || $safeHost === '') {
        $safeHost = 'unknown';
    }
    return RATE_LIMIT_DIR . '/ratelimit_' . $safeHost . '.lock';
}

function enforce_rate_limit_for_host(string $host, float $delaySeconds): void {
    if ($delaySeconds <= 0.0) return;

    $fp = @fopen(rate_limit_file_for_host($host), 'c+');
    if (!$fp) return;
    if (!@flock($fp, LOCK_EX)) {
        fclose($fp);
        return;
    }
    $raw = stream_get_contents($fp);
    $last = 0.0;
    if ($raw !== false && trim($raw) !== '') {
        $last = (float)trim($raw);
    }
    $now = now_float();
    $elapsed = $now - $last;
    if ($elapsed < $delaySeconds) {
        usleep((int)(($delaySeconds - $elapsed) * 1e6));
        $now = now_float();
    }
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, (string)$now);
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
}

function retry_sleep_seconds(int $retry): float {
    $base = RETRY_DELAY_BASE_RUNTIME * pow(2, $retry);
    $capped = min($base, MAX_RETRY_BACKOFF_RUNTIME);
    $jitter = mt_rand(0, 250) / 1000.0;
    return $capped + $jitter;
}

function make_rate_limited_request(string $url, array $opts = [], int $retries = 0) {
    $headers = $opts['headers'] ?? [];
    $params = $opts['params'] ?? null;
    if ($params && is_array($params)) {
        $url .= (strpos($url,'?')===false?'?':'&') . http_build_query($params);
    }

    $host = host_from_url($url);
    $requestDelay = request_delay_for_host($host);
    enforce_rate_limit_for_host($host, $requestDelay);

    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => REQUEST_TIMEOUT_RUNTIME,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HTTPHEADER => $headers
    ]);
    $result = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    log_info("HTTP GET: $url");

    if ($result === false) {
        $err = $curlErr ?: 'Unknown cURL error';
        log_err("HTTP request error for $url: $err");
        if ($retries < MAX_RETRIES_RUNTIME) {
            usleep((int)(retry_sleep_seconds($retries) * 1e6));
            return make_rate_limited_request($url,$opts,$retries+1);
        }
        throw new RuntimeException("HTTP request failed: $err");
    }
    if ($httpCode===429 && $retries<MAX_RETRIES_RUNTIME) {
        usleep((int)(retry_sleep_seconds($retries) * 1e6));
        return make_rate_limited_request($url,$opts,$retries+1);
    }
    if ($httpCode>=200 && $httpCode<300) {
        $decoded = json_decode($result,true);
        if (LOG_HTTP_RESPONSE_BODY_RUNTIME) {
            log_debug("HTTP response (truncated): " . substr($result,0,500));
        }
        return $decoded ?? $result;
    }
    $msg = "HTTP $httpCode for $url"; log_err($msg);
    throw new RuntimeException($msg);
}

// ---------- Wikidata ----------

function get_title_from_wikidata(string $imdbId): ?array {
    $cacheKey = "wikidata:$imdbId";
    $cached = cache_get($cacheKey);
    if ($cached !== null) return $cached;

    try {
        log_info("Fetching titles for $imdbId from Wikidata");

        $query = "
          SELECT ?film ?filmLabel ?filmLabelCs ?filmLabelEn ?originalTitle ?publicationDate ?instanceLabel WHERE {
            ?film wdt:P345 \"$imdbId\".
            OPTIONAL { ?film rdfs:label ?filmLabelCs FILTER(LANG(?filmLabelCs) = \"cs\") }
            OPTIONAL { ?film rdfs:label ?filmLabelEn FILTER(LANG(?filmLabelEn) = \"en\") }
            OPTIONAL { ?film wdt:P1476 ?originalTitle. }
            OPTIONAL { ?film wdt:P577 ?publicationDate. }
            OPTIONAL { ?film wdt:P31 ?instance. }
            SERVICE wikibase:label { bd:serviceParam wikibase:language \"cs,en\". }
          }
          LIMIT 1
        ";

        $url = "https://query.wikidata.org/sparql";
        $headers = [
            'Accept: application/sparql-results+json',
            'User-Agent: Hellspy-Stremio-Addon/' . ADDON_VERSION . ' (' . ADDON_URL . '; ' . ADDON_CONTACT . ')'
        ];

        $resp = make_rate_limited_request($url, ['params'=>['query'=>$query], 'headers'=>$headers]);
        $res = $resp['results']['bindings'][0] ?? [];

        $czTitle = $res['filmLabelCs']['value'] ?? null;
        $enTitle = $res['filmLabelEn']['value'] ?? null;
        $fallbackLabel = $res['filmLabel']['value'] ?? null;
        if ($czTitle === null && $fallbackLabel !== null) $czTitle = $fallbackLabel;
        if ($enTitle === null && $fallbackLabel !== null) $enTitle = $fallbackLabel;

        $origTitle = $res['originalTitle']['value'] ?? null;
        $year = null;
        if (!empty($res['publicationDate']['value'])) $year = substr($res['publicationDate']['value'],0,4);

        $type = $res['instanceLabel']['value'] ?? null;

        // discard Wikidata IDs as titles
        if ($czTitle && preg_match('/^Q\d+$/',$czTitle)) $czTitle = null;
        if ($enTitle && preg_match('/^Q\d+$/',$enTitle)) $enTitle = null;

        $info = [
            'czTitle'=>$czTitle,
            'enTitle'=>$enTitle,
            'originalTitle'=>$origTitle,
            'year'=>$year,
            'type'=>$type
        ];
        cache_set($cacheKey,$info, CACHE_TTL_WIKIDATA);
        log_info("Wikidata resolved: EN=$enTitle, CZ=$czTitle, Year=$year, Type=$type");
        return $info;
    } catch (Throwable $e) {
        log_err("Wikidata error for $imdbId: ".$e->getMessage());
        return null;
    }
}

// ---------- Hellspy ----------
function search_hellspy(string $query) {
    $cacheKey = "search:$query"; $cached=cache_get($cacheKey);
    if($cached!==null) return $cached;
    try {
        log_info("Searching Hellspy for \"$query\"...");
        $resp = make_rate_limited_request('https://api.hellspy.to/gw/search',['params'=>['query'=>$query,'offset'=>0,'limit'=>64]]);
        if(!is_array($resp)) {
            log_warn("Unexpected search response for $query");
            cache_set($cacheKey,[], CACHE_TTL_SEARCH);
            return [];
        }
        $items=$resp['items']??[];
        $results=array_values(array_filter($items,fn($i)=>isset($i['objectType'])&&$i['objectType']==='GWSearchVideo'));
        cache_set($cacheKey,$results, CACHE_TTL_SEARCH);
        log_info("Found ".count($results)." items for \"$query\"");
        return $results;
    } catch(Throwable $e) {
        log_err("Search error: ".$e->getMessage());
        return [];
    }
}

function parse_streams_from_video_response(string $id, array $resp): array {
    $title = (string)($resp['title'] ?? '');
    $duration = (int)($resp['duration'] ?? 0);
    log_info("Video: \"$title\" duration $duration s");

    $conversions = $resp['conversions'] ?? [];
    if (empty($conversions) && !empty($resp['download'])) {
        return [['url' => $resp['download'], 'quality' => 'original', 'title' => $title]];
    }
    if (empty($conversions) && empty($resp['download'])) {
        return [];
    }

    $streams = [];
    foreach ($conversions as $q => $u) {
        $quality = is_numeric($q) ? ($q . 'p') : (string)$q;
        $streams[] = ['url' => $u, 'quality' => $quality, 'title' => $title];
    }
    return $streams;
}

function get_stream_url(string $id,string $fileHash) {
    $cacheKey="stream:$id:$fileHash"; $cached=cache_get($cacheKey);
    if($cached!==null) return $cached;
    try {
        log_info("Fetching stream for video $id ($fileHash)");
        $resp = make_rate_limited_request("https://api.hellspy.to/gw/video/$id/$fileHash");
        if(!is_array($resp)) {
            log_warn("Stream response not JSON for $id");
            cache_set($cacheKey, [], CACHE_TTL_STREAM_NEGATIVE);
            return [];
        }
        $streams = parse_streams_from_video_response($id, $resp);
        cache_set($cacheKey, $streams, empty($streams) ? CACHE_TTL_STREAM_NEGATIVE : CACHE_TTL_STREAM);
        log_info("Found ".count($streams)." qualities for $id");
        return $streams;
    } catch(Throwable $e){
        log_err("get_stream_url error: ".$e->getMessage());
        cache_set($cacheKey, [], CACHE_TTL_STREAM_NEGATIVE);
        return [];
    }
}

function get_stream_urls_batch(array $items, int $concurrency): array {
    $out = [];
    $pending = [];

    foreach ($items as $item) {
        $id = trim((string)($item['id'] ?? ''));
        $fileHash = trim((string)($item['fileHash'] ?? ''));
        if ($id === '' || $fileHash === '') continue;

        $pairKey = $id . ':' . $fileHash;
        if (isset($out[$pairKey]) || isset($pending[$pairKey])) continue;

        $cacheKey = "stream:$id:$fileHash";
        $cached = cache_get($cacheKey);
        if ($cached !== null) {
            $out[$pairKey] = is_array($cached) ? $cached : [];
            continue;
        }
        $pending[$pairKey] = ['id' => $id, 'fileHash' => $fileHash];
    }

    if (empty($pending)) return $out;

    $concurrency = max(1, min($concurrency, STREAM_RESOLVE_CONCURRENCY_HARD_CAP));
    if ($concurrency <= 1 || count($pending) === 1) {
        foreach ($pending as $pairKey => $meta) {
            $out[$pairKey] = get_stream_url($meta['id'], $meta['fileHash']);
        }
        return $out;
    }

    $queue = array_values($pending);
    $mh = curl_multi_init();
    $active = [];
    $failed = [];
    $nextIndex = 0;
    $running = 0;

    $addHandle = function (array $meta) use ($mh, &$active): void {
        $id = $meta['id'];
        $fileHash = $meta['fileHash'];
        $url = "https://api.hellspy.to/gw/video/$id/$fileHash";
        $host = host_from_url($url);
        enforce_rate_limit_for_host($host, request_delay_for_host($host));

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => REQUEST_TIMEOUT_RUNTIME,
            CURLOPT_FOLLOWLOCATION => true
        ]);
        curl_multi_add_handle($mh, $ch);
        $active[(int)$ch] = ['ch' => $ch, 'id' => $id, 'fileHash' => $fileHash, 'url' => $url];
    };

    while ($nextIndex < count($queue) && count($active) < $concurrency) {
        $addHandle($queue[$nextIndex]);
        $nextIndex++;
    }

    do {
        do {
            $status = curl_multi_exec($mh, $running);
        } while ($status === CURLM_CALL_MULTI_PERFORM);

        while ($info = curl_multi_info_read($mh)) {
            $ch = $info['handle'];
            $meta = $active[(int)$ch] ?? null;
            $content = curl_multi_getcontent($ch);
            $curlErrNo = curl_errno($ch);
            $curlErr = curl_error($ch);
            $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);

            if ($meta) {
                $id = $meta['id'];
                $fileHash = $meta['fileHash'];
                $pairKey = $id . ':' . $fileHash;
                $cacheKey = "stream:$id:$fileHash";

                if ($curlErrNo === 0 && $httpCode >= 200 && $httpCode < 300) {
                    $decoded = json_decode((string)$content, true);
                    if (is_array($decoded)) {
                        $streams = parse_streams_from_video_response($id, $decoded);
                        cache_set($cacheKey, $streams, empty($streams) ? CACHE_TTL_STREAM_NEGATIVE : CACHE_TTL_STREAM);
                        $out[$pairKey] = $streams;
                    } else {
                        $failed[$pairKey] = ['id' => $id, 'fileHash' => $fileHash, 'why' => 'non-json'];
                    }
                } else {
                    $failed[$pairKey] = ['id' => $id, 'fileHash' => $fileHash, 'why' => "http=$httpCode curl=$curlErrNo $curlErr"];
                }
            }

            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
            if ($meta) unset($active[(int)$ch]);

            if ($nextIndex < count($queue)) {
                $addHandle($queue[$nextIndex]);
                $nextIndex++;
            }
        }

        if ($running > 0) {
            curl_multi_select($mh, 1.0);
        }
    } while ($running > 0 || !empty($active));

    curl_multi_close($mh);

    foreach ($failed as $pairKey => $meta) {
        log_warn("Batch resolve fallback for {$meta['id']} ({$meta['why']})");
        $out[$pairKey] = get_stream_url($meta['id'], $meta['fileHash']);
    }

    foreach ($pending as $pairKey => $meta) {
        if (!isset($out[$pairKey])) {
            $out[$pairKey] = get_stream_url($meta['id'], $meta['fileHash']);
        }
    }

    return $out;
}

function build_stream_request_cache_key(array $body): string {
    $normalized = [
        'type' => (string)($body['type'] ?? ''),
        'id' => (string)($body['id'] ?? ''),
        'name' => (string)($body['name'] ?? ''),
        'year' => (string)($body['year'] ?? ''),
        'episode' => $body['episode'] ?? null
    ];
    $json = json_encode($normalized, JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        $json = serialize($normalized);
    }
    return md5((string)$json);
}

function wait_for_cached_value(string $cacheKey, int $waitMs, int $pollMs) {
    $deadline = now_float() + ($waitMs / 1000.0);
    while (now_float() < $deadline) {
        $cached = cache_get($cacheKey);
        if ($cached !== null) return $cached;
        usleep($pollMs * 1000);
    }
    return null;
}

function with_singleflight_cache(string $lockKey, string $cacheKey, int $cacheTtl, callable $producer) {
    $cached = cache_get($cacheKey);
    if ($cached !== null) return $cached;

    $lockPath = INFLIGHT_DIR . '/' . md5($lockKey) . '.lock';
    $fp = @fopen($lockPath, 'c+');
    if ($fp && @flock($fp, LOCK_EX | LOCK_NB)) {
        try {
            $cached = cache_get($cacheKey);
            if ($cached !== null) return $cached;
            $value = $producer();
            cache_set($cacheKey, $value, $cacheTtl);
            return $value;
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
    }
    if ($fp) fclose($fp);

    $waited = wait_for_cached_value($cacheKey, STREAM_REQUEST_INFLIGHT_WAIT_MS_RUNTIME, STREAM_REQUEST_INFLIGHT_POLL_MS_RUNTIME);
    if ($waited !== null) return $waited;

    $value = $producer();
    cache_set($cacheKey, $value, $cacheTtl);
    return $value;
}

// ---------- Main Stream Logic ----------
function handle_stream_request_impl(array $body): array {
    $type = $body['type'] ?? null;
    $id = $body['id'] ?? null;
    $name = $body['name'] ?? null;
    $episode = $body['episode'] ?? null;
    $year = $body['year'] ?? null;
    $wikidata = null;

    log_info("Stream request: type=$type id=$id name=$name episode=" . json_encode($episode));

    // Parse series episode notation "tt1234567:1:2" -> ['season'=>1,'number'=>2]
    $season = $episodeNumber = null;
    if ($id && preg_match('/^tt\d+:\d+:\d+$/', $id)) {
        [$id, $season, $episodeNumber] = explode(':', $id);
        $season = (int)$season;
        $episodeNumber = (int)$episodeNumber;
    }
    // resolve IMDB id -> title
    if ($id && preg_match('/^tt\d+$/', $id)) {
        $wikidata = get_title_from_wikidata($id);
        if ($wikidata) {
            $name = $wikidata['czTitle'] ?? $wikidata['enTitle'] ?? $wikidata['originalTitle'] ?? $name;
            $year = $wikidata['year'] ?? $year;
            if (!$type && isset($wikidata['type'])) {
                $type = stripos($wikidata['type'], 'series') !== false ? 'series' : 'movie';
            }
        }
    }

    if (empty($name)) {
        log_warn("No title name found for id $id");
        return ['streams' => []];
    }

    // Build search queries
    $searchQueries = [];
    $simplifiedName = $name;
    if (strpos($name, ':') !== false) {
        $simplifiedName = explode(':', $name)[0];
    }

    if ($type === 'series' && $season !== null && $episodeNumber !== null) {
        $seasonStr = str_pad((string)$season, 2, '0', STR_PAD_LEFT);
        $epStr = str_pad((string)$episodeNumber, 2, '0', STR_PAD_LEFT);

        $searchQueries = [
            "$name S{$seasonStr}E{$epStr}",
            "$name {$seasonStr}x{$epStr}",
            "$name - $epStr",
            "$simplifiedName S{$seasonStr}E{$epStr}",
            "$simplifiedName {$seasonStr}x{$epStr}",
            "$simplifiedName - $epStr"
        ];
    } else { // movies
        $searchQueries = [$name . ($year ? " $year" : ""), $simplifiedName . ($year ? " $year" : ""), $name, $simplifiedName];
    }

    // Remove duplicates
    $searchQueries = array_unique(array_filter($searchQueries));

    $searchStartedAt = now_float();
    $searchDeadline = $searchStartedAt + (SEARCH_TIME_BUDGET_MS_RUNTIME / 1000.0);
    $searchAttempts = 0;
    $searchedKeys = [];
    $searchStopped = false;

    $results = [];
    foreach ($searchQueries as $query) {
        $query = trim((string)$query);
        $queryKey = strtolower($query);
        if ($queryKey === '' || isset($searchedKeys[$queryKey])) continue;
        if ($searchAttempts >= MAX_SEARCH_QUERIES_RUNTIME) {
            log_warn("Search query cap reached (max=" . MAX_SEARCH_QUERIES_RUNTIME . ")");
            $searchStopped = true;
            break;
        }
        if (now_float() >= $searchDeadline) {
            log_warn("Search time budget reached (" . SEARCH_TIME_BUDGET_MS_RUNTIME . " ms)");
            $searchStopped = true;
            break;
        }
        $searchedKeys[$queryKey] = true;
        $searchAttempts++;

        $res = search_hellspy($query);
        if (!empty($res)) {
            $results = $res;
            break;
        }
    }

    // If still no results and type=series, try alternate title from Wikidata
    if (
        empty($results)
        && !$searchStopped
        && $type === 'series'
        && $season !== null
        && $episodeNumber !== null
        && $wikidata
        && !empty($wikidata['enTitle'])
        && $wikidata['enTitle'] !== $name
    ) {
        $altName = $wikidata['enTitle'];
        $altSimplified = explode(':', $altName)[0] ?? $altName;
        $seasonStr = str_pad((string)$season, 2, '0', STR_PAD_LEFT);
        $epStr = str_pad((string)$episodeNumber, 2, '0', STR_PAD_LEFT);

        $altQueries = [
            "$altName S{$seasonStr}E{$epStr}",
            "$altName {$seasonStr}x{$epStr}",
            "$altName - $epStr",
            "$altSimplified S{$seasonStr}E{$epStr}",
            "$altSimplified {$seasonStr}x{$epStr}",
            "$altSimplified - $epStr"
        ];

        foreach ($altQueries as $query) {
            $query = trim((string)$query);
            $queryKey = strtolower($query);
            if ($queryKey === '' || isset($searchedKeys[$queryKey])) continue;
            if ($searchAttempts >= MAX_SEARCH_QUERIES_RUNTIME) {
                log_warn("Search query cap reached (max=" . MAX_SEARCH_QUERIES_RUNTIME . ")");
                $searchStopped = true;
                break;
            }
            if (now_float() >= $searchDeadline) {
                log_warn("Search time budget reached (" . SEARCH_TIME_BUDGET_MS_RUNTIME . " ms)");
                $searchStopped = true;
                break;
            }
            $searchedKeys[$queryKey] = true;
            $searchAttempts++;

            $res = search_hellspy($query);
            if (!empty($res)) {
                $results = $res;
                break;
            }
        }
    }

    if (empty($results)) {
        log_info("No search results for $name");
        return ['streams' => []];
    }

    // Prepare stream URLs
    $streams = [];
    $sort_by_size_desc = function (array $items): array {
        usort($items, function ($a, $b) {
            $sizeA = (isset($a['size']) && is_numeric($a['size'])) ? (float)$a['size'] : -1.0;
            $sizeB = (isset($b['size']) && is_numeric($b['size'])) ? (float)$b['size'] : -1.0;
            return $sizeB <=> $sizeA;
        });
        return $items;
    };
    if ($type === 'series' && $season !== null && $episodeNumber !== null) {
        $seasonStr = str_pad((string)$season, 2, '0', STR_PAD_LEFT);
        $epStr = str_pad((string)$episodeNumber, 2, '0', STR_PAD_LEFT);
        $patterns = [
            '/S' . $seasonStr . 'E' . $epStr . '/i',
            '/' . $seasonStr . 'x' . $epStr . '/i'
        ];
        $preferred = array_values(array_filter($results, function ($item) use ($patterns) {
            $title = (string)($item['title'] ?? '');
            foreach ($patterns as $pattern) {
                if (preg_match($pattern, $title)) return true;
            }
            return false;
        }));
        if (!empty($preferred)) {
            $preferred = $sort_by_size_desc($preferred);
            $limited = array_slice($preferred, 0, 2);
        } else {
            $results = $sort_by_size_desc($results);
            $limited = array_slice($results, 0, 5);
        }
    } else {
        $results = $sort_by_size_desc($results);
        $limited = array_slice($results, 0, 5);
    }

    $resolveItems = [];
    foreach ($limited as $res) {
        if (empty($res['id']) || empty($res['fileHash'])) {
            log_warn("Skipping result missing id/fileHash");
            continue;
        }
        $resolveItems[] = ['id' => (string)$res['id'], 'fileHash' => (string)$res['fileHash']];
    }
    $resolvedMap = get_stream_urls_batch($resolveItems, STREAM_RESOLVE_CONCURRENCY_RUNTIME);

    foreach ($limited as $res) {
        if (empty($res['id']) || empty($res['fileHash'])) {
            continue;
        }
        $resolveKey = (string)$res['id'] . ':' . (string)$res['fileHash'];
        try {
            $sinfo = $resolvedMap[$resolveKey] ?? [];
            if (is_array($sinfo) && count($sinfo) > 0) {
                $sizeGB = isset($res['size']) ? round($res['size'] / 1024 / 1024 / 1024, 2) . ' GB' : 'Unknown size';
                foreach ($sinfo as $s) {
                    $releaseTitle = trim((string)($res['title'] ?? ($s['title'] ?? '')));
                    if ($releaseTitle === '') {
                        $releaseTitle = 'Hellspy stream';
                    }
                    $qualitySourceTitle = $releaseTitle;
                    $streamMetaTitle = trim((string)($s['title'] ?? ''));
                    if ($streamMetaTitle !== '') {
                        $qualitySourceTitle .= ' ' . $streamMetaTitle;
                    }
                    $displayQuality = build_display_quality($qualitySourceTitle, (string)($s['quality'] ?? ''));
                    $streamTitle = $releaseTitle . "\n" . "Kvalita: " . $displayQuality . "\n" . "Velikost: " . $sizeGB;
                    $streams[] = [
                        'url' => $s['url'],
                        'quality' => $displayQuality,
                        'title' => $streamTitle,
                        'name' => "Hellspy - " . $displayQuality
                    ];
                }
            }
        } catch (Throwable $e) {
            log_err("Processing result error: " . $e->getMessage());
        }
    }

    log_info("Returning " . count($streams) . " streams");
    return ['streams' => $streams];
}

function handle_stream_request(array $body): array {
    $requestHash = build_stream_request_cache_key($body);
    $cacheKey = 'streamreq:' . $requestHash;
    $lockKey = 'streamreq-lock:' . $requestHash;
    $result = with_singleflight_cache($lockKey, $cacheKey, STREAM_REQUEST_CACHE_TTL_RUNTIME, function () use ($body) {
        return handle_stream_request_impl($body);
    });
    if (!is_array($result) || !isset($result['streams']) || !is_array($result['streams'])) {
        return ['streams' => []];
    }
    return $result;
}

// ---------- HTTP Routing ----------
$method=$_SERVER['REQUEST_METHOD'];
$uri=parse_url($_SERVER['REQUEST_URI'],PHP_URL_PATH);

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// HEAD support for manifest
if ($method === 'HEAD' && $uri === '/manifest.json') {
    header('Content-Type: application/json; charset=utf-8');
    http_response_code(200);
    exit;
}

// HEAD support for stream route
if ($method === 'HEAD' && preg_match('~^/stream/(movie|series)/([^/]+)\.json$~',$uri)) {
    header('Content-Type: application/json; charset=utf-8');
    http_response_code(200);
    exit;
}

// manifest
if($method==='GET' && $uri==='/manifest.json'){
    $remote = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? 'unknown';
    log_info("Manifest request from $remote UA=\"$ua\"");
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode([
        'id'=>ADDON_ID,'version'=>ADDON_VERSION,'name'=>ADDON_NAME,'description'=>ADDON_DESCRIPTION,
        'resources'=>[
            [
                'name'=>'stream',
                'types'=>['movie','series'],
                'idPrefixes'=>['tt']
            ]
        ],
        'types'=>['movie','series'],
        'idPrefixes'=>['tt'],
        'catalogs'=>[]
    ],JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES);
    exit;
}

// Stremio GET stream route: /stream/movie/tt123.json
if($method==='GET' && preg_match('~^/stream/(movie|series)/([^/]+)\.json$~',$uri,$m)){
    $type=$m[1]; $id=urldecode($m[2]);
    log_info("Stremio GET stream: type=$type id=$id");
    $body=['type'=>$type,'id'=>$id,'name'=>$id];
    $result=handle_stream_request($body);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($result,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES);
    exit;
}

// curl/debug POST stream
if($method==='POST' && $uri==='/stream'){
    $raw=file_get_contents('php://input');
    log_info("Raw POST body: " . $raw);
    $body=json_decode($raw,true)??[];
    log_info("Decoded request: " . json_encode($body));
    try {
        $result=handle_stream_request($body);
        log_info("Stream result count: " . count($result['streams'] ?? []));
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($result,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES);
    } catch(Throwable $e) {
        log_err("Stream handler error: " . $e->getMessage());
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error'=>$e->getMessage()]);
    }
    exit;
}

// default 404
http_response_code(404);
header('Content-Type: application/json; charset=utf-8');
echo json_encode(['error'=>'Not found']);
exit;

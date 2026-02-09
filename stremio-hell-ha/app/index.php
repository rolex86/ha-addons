<?php
// index.php
//
// Forward all requests to addon.php
// and normalize REQUEST_URI so that
// /manifest.json and /stream work correctly.

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// if the request is "/" (root), force it to "/manifest.json"
// so you can test by just opening https://yourdomain.com/
if ($uri === '/' || $uri === '/index.php') {
    $uri = '/manifest.json';
}

$_SERVER['REQUEST_URI'] = $uri;

require __DIR__ . '/addon.php';

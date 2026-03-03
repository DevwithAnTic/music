<?php
declare(strict_types=1);

require_once __DIR__ . DIRECTORY_SEPARATOR . 'common.php';

handle_cors_and_preflight();
require_post_method();
require_auth_if_enabled();
enforce_rate_limit('search');
metrics_increment('search.request.total');

$data = read_json_body();

$query = $data['query'] ?? null;
$mode = $data['mode'] ?? 'search';

if (!is_string($query) || trim($query) === '') {
    send_json(400, ['error' => 'Missing required field: query', 'requestId' => request_id()]);
}

$mode = strtolower(trim((string)$mode));
if ($mode !== 'search' && $mode !== 'suggest') {
    send_json(400, ['error' => 'Invalid mode. Use search or suggest.', 'requestId' => request_id()]);
}

$query = trim($query);
$maxQueryLen = env_int('MAX_QUERY_LENGTH', 120);
$queryLength = function_exists('mb_strlen') ? mb_strlen($query) : strlen($query);
if ($queryLength > $maxQueryLen) {
    send_json(400, ['error' => 'Query is too long.', 'requestId' => request_id()]);
}

$searchCacheTtl = env_int($mode === 'suggest' ? 'SUGGEST_CACHE_TTL_SECONDS' : 'SEARCH_CACHE_TTL_SECONDS', $mode === 'suggest' ? 60 : 180);
$normalizedQuery = function_exists('mb_strtolower') ? mb_strtolower($query) : strtolower($query);
$cacheKey = hash('sha256', $mode . '|' . $normalizedQuery);
$cached = cache_get_json('search', $cacheKey, $searchCacheTtl);
if (is_array($cached)) {
    if ($mode === 'search' && is_array($cached['videos'] ?? null) && count($cached['videos']) === 0) {
        $cached = null;
    }
    if ($mode === 'suggest' && is_array($cached['suggestions'] ?? null) && count($cached['suggestions']) === 0) {
        $cached = null;
    }
}
if (is_array($cached)) {
    metrics_increment('search.cache.hit');
    metrics_increment('search.response.success');
    send_json(200, $cached + ['cached' => true]);
}

$scriptPath = __DIR__ . DIRECTORY_SEPARATOR . 'youtubeSearch.js';
if (!is_file($scriptPath)) {
    metrics_increment('search.response.error');
    log_event('error', 'Missing Node script for search.', ['script' => $scriptPath]);
    send_json(500, ['error' => 'Server misconfiguration.', 'requestId' => request_id()]);
}

$result = run_node_script($scriptPath, [$mode, $query], env_int('NODE_TIMEOUT_SECONDS', 20));
if (!$result['ok']) {
    metrics_increment('search.response.error');
    $logLevel = $result['timedOut'] ? 'warning' : 'error';
    log_event($logLevel, 'Search execution failed.', [
        'mode' => $mode,
        'exitCode' => $result['exitCode'],
        'timedOut' => $result['timedOut'],
        'stderr' => $result['stderr'],
    ]);
    if ($result['timedOut']) {
        metrics_increment('search.response.timeout');
        send_json(504, ['error' => 'Search timed out.', 'requestId' => request_id()]);
    }
    send_json(502, ['error' => 'Search provider failed.', 'requestId' => request_id()]);
}

$decoded = json_decode(trim((string)$result['stdout']), true);
if (!is_array($decoded)) {
    metrics_increment('search.response.error');
    log_event('error', 'Search returned invalid JSON.', ['stdout' => $result['stdout']]);
    send_json(502, ['error' => 'Invalid search response.', 'requestId' => request_id()]);
}

if (($mode === 'search' && is_array($decoded['videos'] ?? null) && count($decoded['videos']) > 0) ||
    ($mode === 'suggest' && is_array($decoded['suggestions'] ?? null) && count($decoded['suggestions']) > 0)) {
    cache_set_json('search', $cacheKey, $decoded, $searchCacheTtl);
    metrics_increment('search.cache.miss');
}
metrics_increment('search.response.success');
send_json(200, $decoded + ['cached' => false]);

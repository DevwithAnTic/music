<?php
declare(strict_types=1);

require_once __DIR__ . DIRECTORY_SEPARATOR . 'common.php';

handle_cors_and_preflight();
require_post_method();
require_auth_if_enabled();
enforce_rate_limit('audio');
metrics_increment('audio.request.total');

$data = read_json_body();

$videoUrl = $data['videoUrl'] ?? null;
$videoId = $data['videoId'] ?? null;

if ((!is_string($videoUrl) || trim($videoUrl) === '') && (!is_string($videoId) || trim($videoId) === '')) {
    send_json(400, ['error' => 'Missing required field: provide videoUrl or videoId', 'requestId' => request_id()]);
}

if ((!is_string($videoUrl) || trim($videoUrl) === '') && is_string($videoId) && trim($videoId) !== '') {
    $cleanVideoId = trim($videoId);
    if (!is_valid_video_id($cleanVideoId)) {
        send_json(400, ['error' => 'Invalid YouTube videoId.', 'requestId' => request_id()]);
    }
    $videoUrl = 'https://www.youtube.com/watch?v=' . $cleanVideoId;
}

$normalizedUrl = to_valid_youtube_watch_url((string)$videoUrl);
if ($normalizedUrl === null) {
    send_json(400, ['error' => 'videoUrl must be a valid YouTube watch URL.', 'requestId' => request_id()]);
}

$audioCacheTtl = env_int('AUDIO_CACHE_TTL_SECONDS', 900);
$videoIdForCache = extract_video_id_from_watch_url($normalizedUrl) ?? $normalizedUrl;
$cacheKey = hash('sha256', $videoIdForCache);
$cached = cache_get_json('audio', $cacheKey, $audioCacheTtl);
if (is_array($cached) && is_string($cached['audioUrl'] ?? null)) {
    metrics_increment('audio.cache.hit');
    metrics_increment('audio.response.success');
    send_json(200, ['audioUrl' => $cached['audioUrl'], 'cached' => true]);
}

$scriptPath = __DIR__ . DIRECTORY_SEPARATOR . 'getAudio.js';
if (!is_file($scriptPath)) {
    metrics_increment('audio.response.error');
    log_event('error', 'Missing Node script for audio extraction.', ['script' => $scriptPath]);
    send_json(500, ['error' => 'Server misconfiguration.', 'requestId' => request_id()]);
}

$result = run_node_script($scriptPath, [$normalizedUrl], env_int('NODE_TIMEOUT_SECONDS', 20));
if (!$result['ok']) {
    metrics_increment('audio.response.error');
    $logLevel = $result['timedOut'] ? 'warning' : 'error';
    log_event($logLevel, 'Audio extraction failed.', [
        'exitCode' => $result['exitCode'],
        'timedOut' => $result['timedOut'],
        'stderr' => $result['stderr'],
    ]);
    if ($result['timedOut']) {
        metrics_increment('audio.response.timeout');
        send_json(504, ['error' => 'Audio extraction timed out.', 'requestId' => request_id()]);
    }
    send_json(502, ['error' => 'Failed to extract audio stream.', 'requestId' => request_id()]);
}

$audioUrl = trim((string)$result['stdout']);
if ($audioUrl === '' || !filter_var($audioUrl, FILTER_VALIDATE_URL)) {
    metrics_increment('audio.response.error');
    log_event('error', 'Extractor returned invalid audio URL.', ['stdout' => $result['stdout']]);
    send_json(502, ['error' => 'Invalid extractor response.', 'requestId' => request_id()]);
}

cache_set_json('audio', $cacheKey, ['audioUrl' => $audioUrl], $audioCacheTtl);
metrics_increment('audio.cache.miss');
metrics_increment('audio.response.success');
send_json(200, ['audioUrl' => $audioUrl, 'cached' => false]);

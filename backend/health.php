<?php
declare(strict_types=1);

require_once __DIR__ . DIRECTORY_SEPARATOR . 'common.php';

handle_cors_and_preflight();

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    send_json(405, ['error' => 'Method not allowed. Use GET.', 'requestId' => request_id()]);
}

$nodeAvailable = trim((string)shell_exec((env_value('NODE_BINARY', 'node')) . ' --version 2>&1')) !== '';
$audioScript = is_file(__DIR__ . DIRECTORY_SEPARATOR . 'getAudio.js');
$searchScript = is_file(__DIR__ . DIRECTORY_SEPARATOR . 'youtubeSearch.js');
$redis = redis_client();
$redisAvailable = $redis instanceof Redis;
$storage = storage_backend_name();

$healthy = $nodeAvailable && $audioScript && $searchScript;
$status = $healthy ? 200 : 503;

send_json($status, [
    'ok' => $healthy,
    'requestId' => request_id(),
    'storage' => $storage,
    'authRequired' => env_bool('AUTH_REQUIRED', false),
    'checks' => [
        'node' => $nodeAvailable,
        'getAudioScript' => $audioScript,
        'youtubeSearchScript' => $searchScript,
        'redis' => $redisAvailable,
    ],
]);

<?php
declare(strict_types=1);

require_once __DIR__ . DIRECTORY_SEPARATOR . 'common.php';

handle_cors_and_preflight();

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    send_json(405, ['error' => 'Method not allowed. Use GET.', 'requestId' => request_id()]);
}

metrics_require_auth_if_enabled();

send_json(200, [
    'ok' => true,
    'requestId' => request_id(),
    'storage' => storage_backend_name(),
    'counters' => metrics_snapshot(),
]);

<?php
declare(strict_types=1);

const ENV_CACHE_KEY = '__MUSIC_BACKEND_ENV_LOADED__';
const REDIS_INIT_KEY = '__MUSIC_BACKEND_REDIS_INIT__';
const REDIS_CLIENT_KEY = '__MUSIC_BACKEND_REDIS_CLIENT__';

function load_local_env(): void
{
    if (!empty($GLOBALS[ENV_CACHE_KEY])) {
        return;
    }

    $envPath = __DIR__ . DIRECTORY_SEPARATOR . '.env';
    if (!is_file($envPath)) {
        $GLOBALS[ENV_CACHE_KEY] = true;
        return;
    }

    $lines = @file($envPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!is_array($lines)) {
        $GLOBALS[ENV_CACHE_KEY] = true;
        return;
    }

    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || str_starts_with($trimmed, '#')) {
            continue;
        }
        $pos = strpos($trimmed, '=');
        if ($pos === false) {
            continue;
        }
        $key = trim(substr($trimmed, 0, $pos));
        $value = trim(substr($trimmed, $pos + 1));
        if ($key === '') {
            continue;
        }
        if (
            (str_starts_with($value, '"') && str_ends_with($value, '"')) ||
            (str_starts_with($value, "'") && str_ends_with($value, "'"))
        ) {
            $value = substr($value, 1, -1);
        }
        putenv($key . '=' . $value);
        $_ENV[$key] = $value;
        $_SERVER[$key] = $value;
    }

    $GLOBALS[ENV_CACHE_KEY] = true;
}

function env_value(string $key, ?string $default = null): ?string
{
    load_local_env();
    $value = getenv($key);
    if ($value === false || $value === '') {
        return $default;
    }
    return $value;
}

function env_bool(string $key, bool $default): bool
{
    $raw = env_value($key);
    if ($raw === null) {
        return $default;
    }
    return in_array(strtolower(trim($raw)), ['1', 'true', 'yes', 'on'], true);
}

function env_int(string $key, int $default): int
{
    $raw = env_value($key);
    if ($raw === null) {
        return $default;
    }
    $value = filter_var($raw, FILTER_VALIDATE_INT);
    if ($value === false) {
        return $default;
    }
    return (int)$value;
}

function request_id(): string
{
    static $id = null;
    if ($id !== null) {
        return $id;
    }
    $id = bin2hex(random_bytes(8));
    return $id;
}

function send_json(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Request-Id: ' . request_id());
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function log_event(string $level, string $message, array $context = []): void
{
    $entry = [
        'ts' => gmdate('c'),
        'level' => $level,
        'message' => $message,
        'request_id' => request_id(),
        'context' => $context,
    ];
    error_log(json_encode($entry, JSON_UNESCAPED_SLASHES));
}

function storage_backend_name(): string
{
    return redis_client() ? 'redis' : 'file';
}

function redis_client(): ?Redis
{
    if (!class_exists('Redis')) {
        return null;
    }

    if (!env_bool('REDIS_ENABLED', false)) {
        return null;
    }

    if (!empty($GLOBALS[REDIS_INIT_KEY])) {
        $client = $GLOBALS[REDIS_CLIENT_KEY] ?? null;
        return ($client instanceof Redis) ? $client : null;
    }
    $GLOBALS[REDIS_INIT_KEY] = true;

    try {
        $redis = new Redis();
        $url = env_value('REDIS_URL', '');
        $host = env_value('REDIS_HOST', '127.0.0.1');
        $port = env_int('REDIS_PORT', 6379);
        $timeout = (float)(env_value('REDIS_TIMEOUT_SECONDS', '2.0') ?? '2.0');
        $db = env_int('REDIS_DB', 0);
        $password = env_value('REDIS_PASSWORD', '');

        if ($url !== '') {
            $parts = parse_url($url);
            if (is_array($parts)) {
                if (is_string($parts['host'] ?? null) && $parts['host'] !== '') {
                    $host = $parts['host'];
                }
                if (is_int($parts['port'] ?? null)) {
                    $port = $parts['port'];
                }
                if (is_string($parts['pass'] ?? null)) {
                    $password = $parts['pass'];
                }
                if (is_string($parts['path'] ?? null) && $parts['path'] !== '') {
                    $dbPath = ltrim($parts['path'], '/');
                    if ($dbPath !== '' && ctype_digit($dbPath)) {
                        $db = (int)$dbPath;
                    }
                }
            }
        }

        if (!$redis->connect($host, $port, $timeout)) {
            log_event('warning', 'Redis connect returned false.', ['host' => $host, 'port' => $port]);
            return null;
        }

        if ($password !== '' && !$redis->auth($password)) {
            log_event('warning', 'Redis auth failed.');
            return null;
        }

        if ($db > 0 && !$redis->select($db)) {
            log_event('warning', 'Redis DB select failed.', ['db' => $db]);
            return null;
        }

        $prefix = env_value('REDIS_KEY_PREFIX', 'music_backend:');
        if ($prefix !== '') {
            $redis->setOption(Redis::OPT_PREFIX, $prefix);
        }

        $pong = $redis->ping();
        if ($pong === false) {
            log_event('warning', 'Redis ping failed.');
            return null;
        }

        $GLOBALS[REDIS_CLIENT_KEY] = $redis;
        return $redis;
    } catch (Throwable $e) {
        log_event('warning', 'Redis unavailable, falling back to file storage.', ['error' => $e->getMessage()]);
        return null;
    }
}

function client_ip(): string
{
    $trustProxy = env_bool('TRUST_PROXY_HEADERS', false);
    if ($trustProxy) {
        $forwarded = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
        if (is_string($forwarded) && $forwarded !== '') {
            $parts = explode(',', $forwarded);
            $candidate = trim($parts[0]);
            if ($candidate !== '') {
                return $candidate;
            }
        }
    }
    $remote = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    return is_string($remote) ? $remote : 'unknown';
}

function is_origin_allowed(string $origin, array $allowedOrigins): bool
{
    if ($origin === '') {
        return false;
    }
    foreach ($allowedOrigins as $allowed) {
        if ($allowed === '*') {
            return true;
        }
        if ($origin === $allowed) {
            return true;
        }
        // Support patterns like https://*.vercel.app
        if (str_contains($allowed, '*')) {
            $pattern = '#^' . str_replace('\*', '[^.]+', preg_quote($allowed, '#')) . '$#i';
            if (preg_match($pattern, $origin) === 1) {
                return true;
            }
        }
    }
    return false;
}

function handle_cors_and_preflight(): void
{
    $allowedOrigins = array_values(array_filter(array_map('trim', explode(',', env_value('ALLOWED_ORIGINS', 'http://localhost:5173')))));
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $allowOriginHeader = '';

    if (is_origin_allowed((string)$origin, $allowedOrigins)) {
        $allowOriginHeader = $origin;
    } elseif (in_array('*', $allowedOrigins, true)) {
        $allowOriginHeader = '*';
    }

    if ($allowOriginHeader !== '') {
        header('Access-Control-Allow-Origin: ' . $allowOriginHeader);
        header('Vary: Origin');
    }
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Access-Control-Max-Age: 3600');

    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        send_json(204, ['ok' => true]);
    }
}

function require_post_method(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        send_json(405, ['error' => 'Method not allowed. Use POST.', 'requestId' => request_id()]);
    }
}

function require_auth_if_enabled(): void
{
    $required = env_bool('AUTH_REQUIRED', false);
    if (!$required) {
        return;
    }

    $token = env_value('API_TOKEN', '');
    if ($token === '') {
        log_event('error', 'AUTH_REQUIRED is enabled but API_TOKEN is missing.');
        send_json(500, ['error' => 'Server authentication is misconfigured.', 'requestId' => request_id()]);
    }

    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!is_string($header) || !str_starts_with($header, 'Bearer ')) {
        send_json(401, ['error' => 'Unauthorized.', 'requestId' => request_id()]);
    }

    $incoming = substr($header, 7);
    if (!hash_equals($token, $incoming)) {
        send_json(401, ['error' => 'Unauthorized.', 'requestId' => request_id()]);
    }
}

function enforce_rate_limit(string $scope): void
{
    $scopeKey = 'RATE_LIMIT_' . strtoupper($scope) . '_PER_MINUTE';
    $limit = env_int($scopeKey, env_int('RATE_LIMIT_PER_MINUTE', 0));
    if ($limit <= 0) {
        return;
    }

    $redis = redis_client();
    if ($redis instanceof Redis) {
        $ip = client_ip();
        $key = 'rl:' . $scope . ':' . $ip;
        try {
            $count = (int)$redis->incr($key);
            if ($count === 1) {
                $redis->expire($key, 60);
            }
            if ($count > $limit) {
                metrics_increment('rate_limit.' . $scope . '.blocked');
                header('Retry-After: 60');
                send_json(429, ['error' => 'Rate limit exceeded. Try again later.', 'requestId' => request_id()]);
            }
            return;
        } catch (Throwable $e) {
            log_event('warning', 'Redis rate limit failed, using file fallback.', ['error' => $e->getMessage()]);
        }
    }

    $now = time();
    $windowStart = $now - 60;
    $ip = client_ip();
    $key = $scope . '|' . $ip;
    $file = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'music_backend_rate_limit.json';

    $handle = @fopen($file, 'c+');
    if ($handle === false) {
        log_event('warning', 'Rate limit storage unavailable.', ['file' => $file]);
        return;
    }

    $state = [];
    try {
        flock($handle, LOCK_EX);
        $raw = stream_get_contents($handle);
        if (is_string($raw) && trim($raw) !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                $state = $decoded;
            }
        }

        $events = $state[$key] ?? [];
        if (!is_array($events)) {
            $events = [];
        }
        $events = array_values(array_filter($events, static fn($ts): bool => is_int($ts) && $ts >= $windowStart));
        if (count($events) >= $limit) {
            metrics_increment('rate_limit.' . $scope . '.blocked');
            header('Retry-After: 60');
            send_json(429, ['error' => 'Rate limit exceeded. Try again later.', 'requestId' => request_id()]);
        }

        $events[] = $now;
        $state[$key] = $events;

        // Opportunistic cleanup for stale entries.
        foreach ($state as $stateKey => $timestamps) {
            if (!is_array($timestamps)) {
                unset($state[$stateKey]);
                continue;
            }
            $filtered = array_values(array_filter($timestamps, static fn($ts): bool => is_int($ts) && $ts >= $windowStart));
            if (empty($filtered)) {
                unset($state[$stateKey]);
                continue;
            }
            $state[$stateKey] = $filtered;
        }

        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($state));
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function read_json_body(int $maxBytes = 16384): array
{
    $rawBody = file_get_contents('php://input');
    if (!is_string($rawBody)) {
        send_json(400, ['error' => 'Invalid request body.', 'requestId' => request_id()]);
    }
    if (strlen($rawBody) > $maxBytes) {
        send_json(413, ['error' => 'Request body too large.', 'requestId' => request_id()]);
    }

    $data = json_decode($rawBody, true);
    if (!is_array($data)) {
        send_json(400, ['error' => 'Invalid JSON body.', 'requestId' => request_id()]);
    }
    return $data;
}

function cache_file_path(string $namespace): string
{
    return sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'music_backend_cache_' . preg_replace('/[^A-Za-z0-9_-]/', '_', $namespace) . '.json';
}

function cache_get_json(string $namespace, string $key, int $ttlSeconds): ?array
{
    if ($ttlSeconds <= 0) {
        return null;
    }

    $redis = redis_client();
    if ($redis instanceof Redis) {
        try {
            $raw = $redis->get('cache:' . $namespace . ':' . $key);
            if (!is_string($raw) || $raw === '') {
                return null;
            }
            $decoded = json_decode($raw, true);
            return is_array($decoded) ? $decoded : null;
        } catch (Throwable $e) {
            log_event('warning', 'Redis cache read failed, using file fallback.', ['error' => $e->getMessage()]);
        }
    }

    $file = cache_file_path($namespace);
    $handle = @fopen($file, 'c+');
    if ($handle === false) {
        return null;
    }
    try {
        flock($handle, LOCK_SH);
        $raw = stream_get_contents($handle);
        if (!is_string($raw) || trim($raw) === '') {
            return null;
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded) || !isset($decoded[$key]) || !is_array($decoded[$key])) {
            return null;
        }
        $entry = $decoded[$key];
        $expiresAt = (int)($entry['expiresAt'] ?? 0);
        $value = $entry['value'] ?? null;
        if ($expiresAt < time() || !is_array($value)) {
            return null;
        }
        return $value;
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function cache_set_json(string $namespace, string $key, array $value, int $ttlSeconds): void
{
    if ($ttlSeconds <= 0) {
        return;
    }

    $redis = redis_client();
    if ($redis instanceof Redis) {
        try {
            $redis->setex('cache:' . $namespace . ':' . $key, $ttlSeconds, json_encode($value, JSON_UNESCAPED_SLASHES));
            return;
        } catch (Throwable $e) {
            log_event('warning', 'Redis cache write failed, using file fallback.', ['error' => $e->getMessage()]);
        }
    }

    $file = cache_file_path($namespace);
    $handle = @fopen($file, 'c+');
    if ($handle === false) {
        return;
    }
    try {
        flock($handle, LOCK_EX);
        $raw = stream_get_contents($handle);
        $decoded = [];
        if (is_string($raw) && trim($raw) !== '') {
            $parsed = json_decode($raw, true);
            if (is_array($parsed)) {
                $decoded = $parsed;
            }
        }
        $now = time();
        foreach ($decoded as $k => $entry) {
            $expiresAt = (int)($entry['expiresAt'] ?? 0);
            if ($expiresAt < $now) {
                unset($decoded[$k]);
            }
        }
        $decoded[$key] = [
            'expiresAt' => $now + $ttlSeconds,
            'value' => $value,
        ];
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($decoded));
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function metrics_increment(string $metric, int $value = 1): void
{
    if ($metric === '' || $value <= 0) {
        return;
    }

    $redis = redis_client();
    if ($redis instanceof Redis) {
        try {
            $key = 'metrics:counters';
            $redis->hIncrBy($key, $metric, $value);
            $ttl = env_int('METRICS_TTL_SECONDS', 86400);
            if ($ttl > 0) {
                $redis->expire($key, $ttl);
            }
            return;
        } catch (Throwable $e) {
            log_event('warning', 'Redis metrics write failed, using file fallback.', ['error' => $e->getMessage()]);
        }
    }

    $file = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'music_backend_metrics.json';
    $handle = @fopen($file, 'c+');
    if ($handle === false) {
        return;
    }
    try {
        flock($handle, LOCK_EX);
        $raw = stream_get_contents($handle);
        $state = [];
        if (is_string($raw) && trim($raw) !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                $state = $decoded;
            }
        }
        $state[$metric] = (int)($state[$metric] ?? 0) + $value;
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($state, JSON_UNESCAPED_SLASHES));
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function metrics_snapshot(): array
{
    $redis = redis_client();
    if ($redis instanceof Redis) {
        try {
            $rows = $redis->hGetAll('metrics:counters');
            if (is_array($rows)) {
                $out = [];
                foreach ($rows as $k => $v) {
                    $out[(string)$k] = (int)$v;
                }
                ksort($out);
                return $out;
            }
        } catch (Throwable $e) {
            log_event('warning', 'Redis metrics read failed, using file fallback.', ['error' => $e->getMessage()]);
        }
    }

    $file = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'music_backend_metrics.json';
    if (!is_file($file)) {
        return [];
    }
    $raw = @file_get_contents($file);
    if (!is_string($raw) || trim($raw) === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return [];
    }
    $out = [];
    foreach ($decoded as $k => $v) {
        $out[(string)$k] = (int)$v;
    }
    ksort($out);
    return $out;
}

function metrics_require_auth_if_enabled(): void
{
    if (!env_bool('METRICS_REQUIRE_AUTH', true)) {
        return;
    }
    require_auth_if_enabled();
}

function extract_video_id_from_watch_url(string $url): ?string
{
    $parts = parse_url($url);
    if (!is_array($parts)) {
        return null;
    }
    $host = strtolower($parts['host'] ?? '');
    $path = $parts['path'] ?? '';
    $query = $parts['query'] ?? '';

    if ($host === 'youtu.be') {
        $id = ltrim($path, '/');
        return is_valid_video_id($id) ? $id : null;
    }

    parse_str($query, $params);
    $id = is_string($params['v'] ?? null) ? $params['v'] : '';
    return is_valid_video_id($id) ? $id : null;
}

function is_valid_video_id(string $videoId): bool
{
    return preg_match('/^[A-Za-z0-9_-]{11}$/', $videoId) === 1;
}

function to_valid_youtube_watch_url(string $value): ?string
{
    $url = trim($value);
    if ($url === '' || !filter_var($url, FILTER_VALIDATE_URL)) {
        return null;
    }

    $parts = parse_url($url);
    if (!is_array($parts)) {
        return null;
    }

    $host = strtolower($parts['host'] ?? '');
    $path = $parts['path'] ?? '';
    $query = $parts['query'] ?? '';

    $isYoutubeHost = in_array($host, ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'], true);
    if (!$isYoutubeHost) {
        return null;
    }

    if ($host === 'youtu.be') {
        $videoId = ltrim($path, '/');
        if (!is_valid_video_id($videoId)) {
            return null;
        }
        return 'https://www.youtube.com/watch?v=' . $videoId;
    }

    parse_str($query, $queryParams);
    $videoId = is_string($queryParams['v'] ?? null) ? $queryParams['v'] : '';
    if (!is_valid_video_id($videoId)) {
        return null;
    }
    return 'https://www.youtube.com/watch?v=' . $videoId;
}

function run_node_script(string $scriptPath, array $args, int $timeoutSeconds = 20): array
{
    $nodeBinary = env_value('NODE_BINARY', 'node');
    $cmd = escapeshellcmd((string)$nodeBinary) . ' ' . escapeshellarg($scriptPath);
    foreach ($args as $arg) {
        $cmd .= ' ' . escapeshellarg($arg);
    }

    $descriptors = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];

    $process = proc_open($cmd, $descriptors, $pipes, __DIR__);
    if (!is_resource($process)) {
        return ['ok' => false, 'exitCode' => 1, 'stdout' => '', 'stderr' => 'Failed to start process', 'timedOut' => false];
    }

    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);

    $stdout = '';
    $stderr = '';
    $timedOut = false;
    $start = microtime(true);

    while (true) {
        $status = proc_get_status($process);
        $running = (bool)($status['running'] ?? false);

        $read = [];
        if (!feof($pipes[1])) {
            $read[] = $pipes[1];
        }
        if (!feof($pipes[2])) {
            $read[] = $pipes[2];
        }

        if (!empty($read)) {
            $write = null;
            $except = null;
            @stream_select($read, $write, $except, 0, 200000);
            foreach ($read as $stream) {
                $chunk = fread($stream, 8192);
                if ($chunk === false || $chunk === '') {
                    continue;
                }
                if ($stream === $pipes[1]) {
                    $stdout .= $chunk;
                } else {
                    $stderr .= $chunk;
                }
            }
        }

        if (!$running) {
            break;
        }

        if ((microtime(true) - $start) > $timeoutSeconds) {
            $timedOut = true;
            proc_terminate($process);
            usleep(200000);
            $status = proc_get_status($process);
            if (($status['running'] ?? false) === true) {
                proc_terminate($process, 9);
            }
            break;
        }

        usleep(50000);
    }

    $remainingStdout = stream_get_contents($pipes[1]);
    $remainingStderr = stream_get_contents($pipes[2]);
    if (is_string($remainingStdout)) {
        $stdout .= $remainingStdout;
    }
    if (is_string($remainingStderr)) {
        $stderr .= $remainingStderr;
    }

    fclose($pipes[1]);
    fclose($pipes[2]);
    $exitCode = proc_close($process);

    return [
        'ok' => !$timedOut && $exitCode === 0,
        'exitCode' => (int)$exitCode,
        'stdout' => trim($stdout),
        'stderr' => trim($stderr),
        'timedOut' => $timedOut,
    ];
}

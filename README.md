# StreamWave Local Run Guide (Windows + Linux)

This project has:
- `backend` (PHP endpoints that call Node scripts)
- `frontend` (Vite app)

## 1) Prerequisites

- Node.js 20+ and npm
- PHP 8+
- `cloudflared` installed and authenticated for your domain

Install deps once:

```bash
cd backend && npm install
cd ../frontend && npm install
```

## 2) Environment

Use your existing env files:
- `backend/.env`
- `frontend/.env`

Make sure frontend points to your API domain in `frontend/.env`:

```env
VITE_API_BASE_URL=https://api.411710.xyz
VITE_REQUIRE_AUTH=true
VITE_API_TOKEN=your_token_here
```

## 3) Start Project (Windows, background)

From repo root (`music`):

```powershell
# Backend (PHP) on 127.0.0.1:8000
Start-Process pwsh -ArgumentList '-NoExit','-Command','cd backend; php -S 127.0.0.1:8000' -WindowStyle Minimized

# Frontend (Vite) on 127.0.0.1:5173
Start-Process pwsh -ArgumentList '-NoExit','-Command','cd frontend; npm run dev -- --host 127.0.0.1 --port 5173' -WindowStyle Minimized

# Cloudflared for frontend domain
Start-Process pwsh -ArgumentList '-NoExit','-Command','cloudflared tunnel --url http://127.0.0.1:5173 --hostname music.411710.xyz' -WindowStyle Minimized

# Cloudflared for backend domain
Start-Process pwsh -ArgumentList '-NoExit','-Command','cloudflared tunnel --url http://127.0.0.1:8000 --hostname api.411710.xyz' -WindowStyle Minimized
```

## 4) Start Project (Linux, background)

From repo root (`music`):

```bash
# Backend
cd backend
nohup php -S 127.0.0.1:8000 > php-server.log 2>&1 &
cd ..

# Frontend
cd frontend
nohup npm run dev -- --host 127.0.0.1 --port 5173 > vite.log 2>&1 &
cd ..

# Cloudflared frontend tunnel
nohup cloudflared tunnel --url http://127.0.0.1:5173 --hostname music.411710.xyz > cloudflared-frontend.log 2>&1 &

# Cloudflared backend tunnel
nohup cloudflared tunnel --url http://127.0.0.1:8000 --hostname api.411710.xyz > cloudflared-backend.log 2>&1 &
```

## 5) Check Running Processes

Windows:

```powershell
Get-Process php,node,cloudflared -ErrorAction SilentlyContinue
```

Linux:

```bash
ps -ef | grep -E "php -S|vite|cloudflared" | grep -v grep
```

## 6) Stop Processes

Windows:

```powershell
Stop-Process -Name php,node,cloudflared -Force
```

Linux:

```bash
pkill -f "php -S 127.0.0.1:8000"
pkill -f "vite"
pkill -f "cloudflared tunnel --url http://127.0.0.1:5173"
pkill -f "cloudflared tunnel --url http://127.0.0.1:8000"
```

## 7) Quick Health Checks

```bash
curl http://127.0.0.1:8000/health.php
curl https://api.411710.xyz/health.php
```

## 8) Production Setup (Frontend on Vercel)

### Backend recommended auth strategy

For browser-hosted frontend, do not expose backend bearer secrets in the client.
Use origin-based auth on backend:

```env
AUTH_REQUIRED=true
AUTH_STRATEGY=origin
ALLOWED_ORIGINS=https://music.411710.xyz
```

`API_TOKEN` can still be kept for admin/non-browser callers, but frontend should not require it with `AUTH_STRATEGY=origin`.

### Backend production env baseline

Recommended minimum:

```env
TRUST_PROXY_HEADERS=true
RATE_LIMIT_PER_MINUTE=240
RATE_LIMIT_AUDIO_PER_MINUTE=180
RATE_LIMIT_SEARCH_PER_MINUTE=600
```

### Vercel frontend env vars

Set these in Vercel Project -> Settings -> Environment Variables:

```env
VITE_API_BASE_URL=https://api.411710.xyz
VITE_REQUIRE_AUTH=false
VITE_API_TOKEN=
```

### Deploy frontend to Vercel

From repo root:

```bash
vercel --prod
```

or connect the Git repo in Vercel and let it auto-deploy on push.

### Post-deploy checks

1. `https://music.411710.xyz` loads and search works.
2. Browser network calls to `https://api.411710.xyz` succeed with 200/204 CORS.
3. `https://api.411710.xyz/health.php` returns healthy response.

# Deploying The System

The server is a single Node process (`server/index.js`) that serves the static client from
`public/` and runs Socket.IO. It reads `PORT` from the environment, exposes `/healthz`, and
mirrors in-progress games to disk (`server/persistence.js`) so a restart doesn't wipe them.

**Requirements that matter for hosting**
- **WebSockets / sticky sessions.** Socket.IO holds long-lived connections. Use a single
  instance, or enable sticky sessions / session affinity if you scale out. Do **not** put it
  behind a proxy that buffers or kills idle connections.
- **Persistence needs a writable path.** By default the snapshot is written to
  `data/.rooms-state.json` (ephemeral on most platforms). For games that survive restarts,
  set `STATE_FILE` to a path on a **mounted volume** (see below).

## Playing on phones
Deploy once (Railway or Render below), then open the URL on any phone. The host taps
**Create Room**; everyone else scans the lobby QR code or opens the shared invite link
(`https://<your-app>/?room=CODE`), which fills in the room code. Seats survive screen locks and
app switches: in-game indefinitely, in the lobby for 90 seconds, because the session token is
kept in `localStorage`.

## Railway (simplest)
1. Push this repo to GitHub.
2. New Project → Deploy from repo. Railway detects the `Dockerfile` (or the Node buildpack via
   `Procfile`) and sets `PORT` automatically.
3. (Optional, for durable games) Add a Volume, mount it at `/data`, and set a variable
   `STATE_FILE=/data/rooms-state.json`.
4. HTTPS is automatic on the generated `*.up.railway.app` domain.

## Render
1. New → Web Service → connect the repo.
2. Environment: Docker (uses the `Dockerfile`). Health check path: `/healthz`.
3. (Optional) Add a Disk mounted at `/data` and set `STATE_FILE=/data/rooms-state.json`.
4. HTTPS and the `*.onrender.com` domain are automatic. Use a single instance (free tier is
   one) so sockets stay on one process.

## Fly.io
1. `fly launch --no-deploy` (accept/adjust the app name; `fly.toml` is already here).
2. `fly volumes create system_data --size 1` (matches the `[mounts]` block → durable games).
3. `fly deploy`.
`fly.toml` already sets `PORT=8080`, `STATE_FILE=/data/rooms-state.json`, `force_https`, and a
`/healthz` check.

## Local Docker
```
docker build -t the-system .
docker run -p 3000:3000 the-system
# durable local games:
docker run -p 3000:3000 -e STATE_FILE=/data/rooms-state.json -v system_data:/data the-system
```

## Environment variables
| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | Port the server listens on (platforms set this). |
| `STATE_FILE` | `data/.rooms-state.json` | Where the room snapshot is written. Point at a mounted volume for durability. |

## Note on the current persistence model
The snapshot is a single JSON file rewritten (debounced) on every state change and reloaded on
boot — right for the current scale (a handful of concurrent rooms). Restored players start
disconnected and rejoin automatically with the token their browser already holds
(`sessionStorage`). If you later run multiple instances or need higher durability, swap
`server/persistence.js` for a database or Redis without touching the engine.

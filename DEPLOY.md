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

## Fly.io (recommended: always on, no sleep)
**From the dashboard, no CLI needed:**
1. fly.io → **Launch an App** → connect GitHub → pick this repo.
2. Pick an app name (it becomes `https://<name>.fly.dev`) and keep the region (`sin`).
3. Launch. Fly reads `fly.toml`: one always-on 512 MB machine, a 1 GB volume at `/data`
   for durable games, and a `/healthz` check. Pushes to `main` redeploy automatically.

**Or from the CLI:** `fly launch --no-deploy`, then `fly deploy`. If a deploy reports the
volume is missing: `fly volumes create system_data --size 1 --region sin`.

Keep the app at **one machine**. Rooms live in that process's memory, and every player in a
room must reach the same process. One machine comfortably runs dozens of games at once; use
`test/parallel-games.js` (below) to check a deployment.

`fly.toml` raises Fly's connection limit from its default of 25 per machine to 1000. Each
player holds one WebSocket, so the default would cap you at about 8 three-player games.

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
| `ROOM_IDLE_MS` | `86400000` (24 h) | A room with nobody connected for this long is deleted. |

## Checking a deployment
Run full bot games in parallel against the live server, each in its own room:
```
SMOKE_URL=https://<your-app>.fly.dev GAMES=20 npm run test:parallel
```
It prints each game's result and fails if any game stalls or two games share a room.

## Note on the current persistence model
The snapshot is a single JSON file rewritten (debounced) on every state change and reloaded on
boot — right for the current scale (a handful of concurrent rooms). Restored players start
disconnected and rejoin automatically with the token their browser already holds
(`sessionStorage`). If you later run multiple instances or need higher durability, swap
`server/persistence.js` for a database or Redis without touching the engine.

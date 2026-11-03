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
5. Settings → Build & Deploy → **Auto-Deploy: After CI Checks Pass**, so a push to `main` only
   goes live once the Test workflow is green.

**Free-tier caveats.** A free Render service sleeps after ~15 minutes without traffic; the next
visitor waits about a minute while it wakes. It also has no disk, so every deploy, restart or
sleep wipes in-progress games. For playtesters, open the link a minute before a session, and
don't merge to `main` while a game is running.

## Fly.io (recommended: always on, no sleep)
Deploys go through GitHub Actions (`.github/workflows/deploy-fly.yml`): a push to `main`
deploys **only after the Test workflow passes** on that commit. Don't also turn on Fly's
dashboard GitHub auto-deploy: it deploys every push, tested or not.

**One-time setup (CLI):**
1. `fly launch --no-deploy` — pick an app name (it becomes `https://<name>.fly.dev`), keep the
   region (`sin`). Fly reads `fly.toml`: one always-on 1 GB machine, a 1 GB volume at `/data`
   for durable games, and a `/healthz` check.
2. `fly deploy` for the first deploy. If it reports the volume is missing:
   `fly volumes create system_data --size 1 --region sin`.
3. `fly machines list` must show **exactly one** machine. If there are two, run
   `fly scale count 1`.
4. `fly tokens create deploy` and save the output as a GitHub repository secret named
   `FLY_API_TOKEN` (repo → Settings → Secrets and variables → Actions). From then on every green
   push to `main` deploys itself.

A deploy restarts the server: players see a short reconnect and their game continues, because
the server saves every room on shutdown and reloads it on boot.

Keep the app at **one machine**. Rooms live in that process's memory, and every player in a
room must reach the same process. One machine comfortably runs dozens of games at once; use
`test/parallel-games.js` (below) to check a deployment.

`fly.toml` raises Fly's connection limit from its default of 25 per machine to 2500. Each
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
| `SAVE_MAX_WAIT_MS` | `2000` | Longest a change waits before it is written, however busy the server is. |
| `ROOM_CREATE_MAX` | `30` | Rooms one IP may create per 10 minutes (room for a classroom on shared Wi-Fi). |
| `JOIN_MISS_MAX` | `40` | Joins to non-existent room codes per IP per 10 minutes (stops code scanning). |
| `SOCKET_EVENT_MAX` | `120` | Events one connection may send per 2 seconds (flood guard). |
| `MAX_ROOMS` | `2000` | Rooms held in memory at once; new rooms are refused beyond this. |

## Checking a deployment
Run full bot games in parallel against the live server, each in its own room:
```
SMOKE_URL=https://<your-app>.fly.dev GAMES=20 npm run test:parallel
```
It prints each game's result and fails if any game stalls or two games share a room. The bots
play at machine speed, so set `SOCKET_EVENT_MAX=100000` on the deployment while load-testing.

## Note on the current persistence model
The snapshot is a single JSON file, written at most every 2 seconds while games are changing,
replaced atomically (temp file + rename, so a crash can't truncate it), flushed on shutdown, and
reloaded on boot. Only rooms that changed are re-serialized. An unreadable snapshot is moved
aside as `*.corrupt-<time>` rather than overwritten. This suits one server with up to a few
hundred concurrent rooms. Restored players start
disconnected and rejoin automatically with the token their browser already holds
(`sessionStorage`). If you later run multiple instances or need higher durability, swap
`server/persistence.js` for a database or Redis without touching the engine.

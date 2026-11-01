// Parallel games: run several full bot games at once against one server, each in its own
// room, to check that concurrent rooms don't interfere and the server keeps up.
//
//   node test/parallel-games.js                  # 10 games against a local server it spawns
//   GAMES=30 node test/parallel-games.js         # more games
//   SMOKE_URL=https://your-app.fly.dev node test/parallel-games.js   # against a deployed server
//
// Each game is test/socket-smoke.js (3 bots, a full game to GAME_OVER) in a child process.
const { spawn } = require('child_process');
const path = require('path');

const GAMES = Number(process.env.GAMES) || 10;
const PORT = 3124;
const remote = process.env.SMOKE_URL;
const URL = remote || `http://localhost:${PORT}`;
// A remote server adds network latency to every bot move, so allow more time per game.
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || (remote ? 300000 : 120000);

let serverProc = null;
if (!remote) {
  serverProc = spawn('node', [path.join(__dirname, '../server/index.js')], {
    env: { ...process.env, PORT: String(PORT), STATE_FILE: path.join(require('os').tmpdir(), `parallel-${PORT}.json`) },
    stdio: 'ignore',
  });
  process.on('exit', () => serverProc.kill());
}

function runGame(i) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(__dirname, 'socket-smoke.js')], {
      env: { ...process.env, SMOKE_URL: URL, SMOKE_TIMEOUT_MS: String(TIMEOUT_MS) },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const room = (out.match(/room created: (\w+)/) || [])[1] || '????';
      const result = (out.match(/GAME OVER[^\n]*/) || [])[0];
      if (code === 0) console.log(`  ✔ game ${i + 1} (room ${room}) finished in ${secs}s — ${result}`);
      else console.log(`  ✘ game ${i + 1} (room ${room}) failed after ${secs}s\n${out.trim().split('\n').slice(-8).join('\n')}`);
      resolve({ ok: code === 0, secs: Number(secs), room });
    });
  });
}

async function main() {
  console.log(`Running ${GAMES} games in parallel against ${URL} (${GAMES * 3} bot players)...`);
  if (!remote) await new Promise((r) => setTimeout(r, 1200)); // let server boot
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: GAMES }, (_, i) => runGame(i)));
  const ok = results.filter((r) => r.ok).length;
  const rooms = new Set(results.map((r) => r.room));
  const slowest = Math.max(...results.map((r) => r.secs));
  console.log(
    `${ok}/${GAMES} games finished; ${rooms.size} distinct rooms; slowest ${slowest}s; wall time ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  if (rooms.size !== GAMES) console.log('WARNING: two games shared a room code');
  process.exit(ok === GAMES && rooms.size === GAMES ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

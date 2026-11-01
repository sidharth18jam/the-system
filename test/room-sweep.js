// Room sweep: an in-game room nobody is connected to is deleted after ROOM_IDLE_MS,
// and a room with someone still connected is kept.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const { io } = require('socket.io-client');

const PORT = 3125;
const URL = `http://localhost:${PORT}`;
const serverProc = spawn('node', [path.join(__dirname, '../server/index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    ROOM_IDLE_MS: '1500',
    ROOM_SWEEP_MS: '300',
    STATE_FILE: path.join(os.tmpdir(), `room-sweep-${process.pid}.json`),
  },
  stdio: 'ignore',
});
process.on('exit', () => serverProc.kill());

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('  ✘', msg);
    process.exit(1);
  }
  passed++;
  console.log('  ✔', msg);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () =>
  new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
const emitAck = (sock, event, data) => new Promise((resolve) => sock.emit(event, data, resolve));

// Two players start a game; returns the room code and the sockets.
async function startedRoom() {
  const [a, b] = await Promise.all([connect(), connect()]);
  const created = await emitAck(a, 'createRoom', { name: 'A' });
  await emitAck(b, 'joinRoom', { code: created.code, name: 'B' });
  await wait(200);
  a.emit('startGame', { mode: 'standard' });
  await wait(300);
  return { code: created.code, a, b };
}

async function main() {
  console.log('Running room sweep tests...');
  await wait(1200); // let server boot

  const abandoned = await startedRoom();
  const kept = await startedRoom();
  abandoned.a.close();
  abandoned.b.close();
  kept.b.close(); // kept.a stays connected

  await wait(2500); // past ROOM_IDLE_MS plus a few sweeps

  const probe = await connect();
  const gone = await emitAck(probe, 'joinRoom', { code: abandoned.code, name: 'Late' });
  assert(!gone.ok && /not found/i.test(gone.error), 'room with nobody connected is swept');
  const still = await emitAck(probe, 'joinRoom', { code: kept.code, name: 'Late' });
  assert(still.ok || !/not found/i.test(still.error || ''), 'room with a connected player is kept');

  console.log(`All room sweep tests passed (${passed} assertions).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

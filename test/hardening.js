// Hardening: the server survives hostile input, enforces abuse limits, frees seats when a socket
// changes rooms, and never loses or corrupts the room snapshot (busy server, shutdown, bad file).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { io } = require('socket.io-client');

let passed = 0;
const procs = [];
function assert(cond, msg) {
  if (!cond) {
    console.error('  ✘', msg);
    for (const p of procs) p.kill('SIGKILL');
    process.exit(1);
  }
  passed++;
  console.log('  ✔', msg);
}
process.on('exit', () => procs.forEach((p) => p.kill('SIGKILL')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-'));
let nextPort = 3140;

function startServer(env = {}) {
  const port = nextPort++;
  const proc = spawn('node', [path.join(__dirname, '../server/index.js')], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  procs.push(proc);
  const url = `http://localhost:${port}`;
  const ready = (async () => {
    for (let i = 0; i < 50; i++) {
      if (await healthy(url)) return;
      await sleep(100);
    }
    throw new Error('server did not start:\n' + out);
  })();
  return { proc, url, ready, log: () => out };
}

function healthy(url) {
  return new Promise((resolve) => {
    http
      .get(`${url}/healthz`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      })
      .on('error', () => resolve(false));
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const s = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const call = (s, event, data) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 2000);
    s.emit(event, data, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });
const nextEvent = (s, event, pred = () => true, ms = 2000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => {
      s.off(event, h);
      resolve(null);
    }, ms);
    const h = (x) => {
      if (!pred(x)) return;
      clearTimeout(t);
      s.off(event, h);
      resolve(x);
    };
    s.on(event, h);
  });
const exited = (proc) => new Promise((r) => (proc.exitCode != null ? r(proc.exitCode) : proc.on('exit', r)));

const EVENTS = [
  'createRoom', 'joinRoom', 'startGame', 'pickStartingResource', 'answerPolicy', 'buyVoterCard',
  'endTurn', 'gerrymander', 'skipGerrymander', 'proposeTrade', 'buyConspiracy', 'playConspiracy',
  'respondReaction', 'benefactorGift', 'buyHeadline', 'oracleSacrifice', 'insurgentMove',
  'pickPatronTargets', 'maverickCopy', 'prospect', 'landGrab', 'placeBenched', 'snatch', 'payback',
  'toughLove', 'placeBid', 'passBid', 'placeAuctionWin', 'respondTrade', 'cancelTrade',
  'proposeCoalition', 'respondCoalition', 'cancelCoalition', 'withdrawCoalition', 'useHomeTurf',
  'submitSetupBid', 'placeRequirement', 'discardResources', 'resync', 'chatSend', 'playAgain',
];
const JUNK = [undefined, null, 42, 'x', [], {}, { name: 42 }, { name: {} }, { code: 5, token: [] },
  { name: 'A', code: { a: 1 } }, { text: { toString: null } }, { to: {}, text: 'hi' }, { mode: 7 },
  { discards: null }, { amount: 'lots' }, { moves: 'x' }];

async function main() {
  console.log('Running hardening tests...');

  // --- 1. Hostile payloads never crash the server ------------------------------------------
  {
    const srv = startServer({ STATE_FILE: path.join(tmpDir, 'junk.json'), SOCKET_EVENT_MAX: '100000' });
    await srv.ready;
    const s = await connect(srv.url);
    const errors = [];
    s.on('errorMsg', (m) => errors.push(m));
    const bad = await call(s, 'createRoom', { name: 42 });
    assert(bad && bad.ok === false, 'createRoom with a non-string name is refused, not a crash');
    // Hit every event with junk, outside a room, then inside a lobby, then inside a game.
    const fire = () => {
      for (const ev of EVENTS) {
        s.emit(ev);
        for (const j of JUNK) s.emit(ev, j);
        for (const j of JUNK) s.emit(ev, j, () => {});
      }
    };
    fire();
    await sleep(300);
    const made = await call(s, 'createRoom', { name: 'Host' });
    const b = await connect(srv.url);
    await call(b, 'joinRoom', { code: made.code, name: 'Guest' });
    fire();
    await sleep(300);
    s.emit('startGame', { mode: 'standard' });
    await sleep(200);
    fire();
    await sleep(500);
    assert(srv.proc.exitCode === null, 'server still running after ~2000 malformed events');
    assert(await healthy(srv.url), 'health check still answers after the junk');
    assert(!/uncaught exception/.test(srv.log()), 'no uncaught exceptions were logged');
    const c = await connect(srv.url);
    const fresh = await call(c, 'createRoom', { name: 'After' });
    assert(fresh && fresh.ok, 'a new player can still create a room afterwards');
    [s, b, c].forEach((x) => x.close());
    srv.proc.kill();
    await exited(srv.proc);
  }

  // --- 2. Abuse limits ----------------------------------------------------------------------
  {
    const srv = startServer({
      STATE_FILE: path.join(tmpDir, 'limits.json'),
      ROOM_CREATE_MAX: '3',
      JOIN_MISS_MAX: '3',
      SOCKET_EVENT_MAX: '20',
      MAX_ROOMS: '5',
    });
    await srv.ready;
    const s = await connect(srv.url);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await call(s, 'createRoom', { name: 'N' + i }));
    assert(results.slice(0, 3).every((r) => r.ok), 'first 3 rooms from one IP are allowed');
    assert(!results[3].ok && /Too many rooms/.test(results[3].error), '4th room in the window is refused');

    const misses = [];
    for (let i = 0; i < 4; i++) misses.push(await call(s, 'joinRoom', { code: 'ZZZ' + i, name: 'x' }));
    assert(misses.slice(0, 3).every((r) => r.error === 'Room not found'), 'unknown codes report not found');
    assert(/Too many attempts/.test(misses[3].error), 'code scanning is cut off after the limit');

    const flood = nextEvent(s, 'errorMsg', (m) => /slow down/.test(m));
    for (let i = 0; i < 60; i++) s.emit('resync');
    assert(await flood, 'a socket flooding events is told to slow down');
    await sleep(2100);
    const again = await call(s, 'joinRoom', { code: results[0].code, token: results[0].token });
    assert(again && again.ok, 'the flood guard lifts once the window passes');
    s.close();
    srv.proc.kill();
    await exited(srv.proc);
  }

  // --- 3. Moving to another room frees the old seat -------------------------------------------
  {
    const srv = startServer({ STATE_FILE: path.join(tmpDir, 'seats.json') });
    await srv.ready;
    const a = await connect(srv.url);
    const b = await connect(srv.url);
    const r1 = await call(a, 'createRoom', { name: 'Ann' });
    await call(b, 'joinRoom', { code: r1.code, name: 'Ben' });
    const update = nextEvent(b, 'lobbyState', (l) => l.players.some((p) => p.name === 'Ann' && !p.connected));
    const r2 = await call(a, 'createRoom', { name: 'Ann' });
    assert(r2.ok && r2.code !== r1.code, 'the same socket can open a second room');
    assert(await update, 'the first room sees that player go offline instead of a ghost seat');
    const leak = nextEvent(a, 'lobbyState', (l) => l.code === r1.code, 600);
    b.emit('chatSend', { text: 'still here?' });
    await call(b, 'joinRoom', { code: r1.code, name: 'Cy' }).catch(() => {});
    assert(!(await leak), "the old room's updates no longer reach the socket that left");
    a.close();
    b.close();
    srv.proc.kill();
    await exited(srv.proc);
  }

  // --- 4. Persistence: busy server still saves; shutdown flushes; bad file is set aside --------
  {
    const file = path.join(tmpDir, 'busy.json');
    const srv = startServer({ STATE_FILE: file });
    await srv.ready;
    const host = await connect(srv.url);
    const room = await call(host, 'createRoom', { name: 'P0' });
    const socks = [host];
    for (let i = 1; i < 5; i++) {
      const s = await connect(srv.url);
      await call(s, 'joinRoom', { code: room.code, name: 'P' + i });
      socks.push(s);
    }
    await sleep(1000); // let the joins settle into a save
    fs.rmSync(file, { force: true });
    // One chat line every 200ms across the table — never a 400ms quiet gap, which starved
    // the old debounce-only save forever.
    let n = 0;
    const started = Date.now();
    while (Date.now() - started < 3500) {
      socks[n % 5].emit('chatSend', { text: 'line ' + n });
      n++;
      await sleep(200);
    }
    assert(fs.existsSync(file), 'a continuously busy server still writes its snapshot (max-wait)');
    const mid = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(mid.rooms[0].chat.length > 5, 'the mid-activity snapshot includes recent chat');

    // A change made just before shutdown is flushed, not lost.
    socks[1].emit('chatSend', { text: 'last words' });
    await sleep(50);
    srv.proc.kill('SIGTERM');
    const code = await exited(srv.proc);
    assert(code === 0, 'SIGTERM exits cleanly');
    const final = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(final.rooms[0].chat.some((m) => m.text === 'last words'), 'the last change before SIGTERM was saved');
    assert(!fs.readdirSync(tmpDir).some((f) => f.endsWith('.tmp')), 'no temp files left behind');
    socks.forEach((s) => s.close());

    // Restart on the same file: the room and its chat come back.
    const srv2 = startServer({ STATE_FILE: file });
    await srv2.ready;
    const back = await connect(srv2.url);
    const history = nextEvent(back, 'chatHistory');
    const rejoin = await call(back, 'joinRoom', { code: room.code, token: room.token });
    assert(rejoin.ok, 'the host rejoins the restored room with their token');
    const h = await history;
    assert(h && h.some((m) => m.text === 'last words'), 'chat survives the restart');
    back.close();
    srv2.proc.kill('SIGINT');
    assert((await exited(srv2.proc)) === 0, 'SIGINT (Fly) also exits cleanly');

    // An unreadable snapshot is moved aside, not silently overwritten.
    const badFile = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(badFile, '{"rooms":[{"code":"AB');
    const srv3 = startServer({ STATE_FILE: badFile });
    await srv3.ready;
    assert(
      fs.readdirSync(tmpDir).some((f) => f.startsWith('bad.json.corrupt-')),
      'a corrupt snapshot is kept aside for inspection'
    );
    srv3.proc.kill();
    await exited(srv3.proc);
  }

  console.log(`All hardening tests passed (${passed} assertions).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

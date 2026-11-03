// Open tables + funnel counters, end to end over real sockets and HTTP:
// who gets listed (and who doesn't), who may toggle it, what each step of the funnel counts,
// that counts survive a restart without double-counting, and that STATS_KEY guards /stats.
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
    procs.forEach((p) => p.kill('SIGKILL'));
    process.exit(1);
  }
  passed++;
  console.log('  ✔', msg);
}
process.on('exit', () => procs.forEach((p) => p.kill('SIGKILL')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-tables-'));
let nextPort = 3160;

function get(url, headers = {}) {
  return new Promise((resolve) => {
    http
      .get(url, { headers }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', () => resolve({ status: 0, body: '' }));
  });
}
function startServer(env = {}) {
  const port = nextPort++;
  const proc = spawn('node', [path.join(__dirname, '../server/index.js')], {
    env: { ...process.env, PORT: String(port), SOCKET_EVENT_MAX: '100000', ...env },
    stdio: 'ignore',
  });
  procs.push(proc);
  const url = `http://localhost:${port}`;
  const ready = (async () => {
    for (let i = 0; i < 50; i++) {
      if ((await get(`${url}/healthz`)).status === 200) return;
      await sleep(100);
    }
    throw new Error('server did not start');
  })();
  return { proc, url, ready };
}
const exited = (proc) => new Promise((r) => (proc.exitCode != null ? r(proc.exitCode) : proc.on('exit', r)));
function connect(url) {
  return new Promise((resolve, reject) => {
    const s = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const call = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const tables = async (s) => (await call(s, 'listTables', {})).tables;
const nextError = (s) => new Promise((r) => s.once('errorMsg', r));
const statsOf = async (url, q = '') => JSON.parse((await get(`${url}/stats.json${q}`)).body);
const total = (r, key) => [...r.funnel, ...r.other].find((x) => x.key === key).count;
const BROWSER = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' };

async function main() {
  console.log('Running open tables + funnel tests...');
  const file = path.join(tmpDir, 'state.json');
  const srv = startServer({ STATE_FILE: file });
  await srv.ready;

  // --- page views: real browsers count, link-preview bots and assets don't
  await get(`${srv.url}/`, BROWSER);
  await get(`${srv.url}/`, BROWSER);
  await get(`${srv.url}/`, { 'user-agent': 'redditbot/1.0' });
  await get(`${srv.url}/style.css`, BROWSER);
  assert(total(await statsOf(srv.url), 'pageViews') === 2, 'page views count browser loads only (not bots or assets)');

  // --- listing rules
  const browser = await connect(srv.url);
  const host = await connect(srv.url);
  const made = await call(host, 'createRoom', { name: 'Hostess' });
  assert((await tables(browser)).length === 0, 'a new room is private by default');

  const guest = await connect(srv.url);
  await call(guest, 'joinRoom', { code: made.code, name: 'Typed', via: 'code' });
  const refused = nextError(guest);
  guest.emit('setOpen', { open: true });
  assert(/Only the host/.test(await refused), 'only the host can list the table');
  assert((await tables(browser)).length === 0, '…and a refused toggle changes nothing');

  host.emit('setOpen', { open: true });
  await sleep(100);
  let list = await tables(browser);
  assert(list.length === 1 && list[0].code === made.code, 'host can list the lobby as an open table');
  assert(list[0].host === 'Hostess' && list[0].players === 2 && list[0].max === 5, 'listing shows host name and seats');

  const lobbyOpen = new Promise((r) => guest.once('lobbyState', r));
  host.emit('setOpen', { open: false });
  assert((await lobbyOpen).open === false, 'lobby state tells every seat whether the table is open');
  assert((await tables(browser)).length === 0, 'host can unlist it again');
  host.emit('setOpen', { open: true });
  await sleep(100);

  // --- joining from the list, up to a full table
  const joiners = [];
  for (let i = 0; i < 3; i++) {
    const s = await connect(srv.url);
    const r = await call(s, 'joinRoom', { code: made.code, name: 'L' + i, via: 'list' });
    assert(r.ok, `stranger ${i + 1} joins from the list`);
    joiners.push(s);
  }
  assert((await tables(browser)).length === 0, 'a full table (5/5) drops off the list');
  const late = await call(browser, 'joinRoom', { code: made.code, name: 'Late', via: 'list' });
  assert(!late.ok && /full/.test(late.error), 'joining a table that just filled explains why');

  // --- create-as-open, invite joins, abandoned listings
  const solo = await connect(srv.url);
  const openRoom = await call(solo, 'createRoom', { name: 'Solo', open: true });
  assert((await tables(browser)).some((t) => t.code === openRoom.code), '"Start an open table" lists the room at once');
  const invited = await connect(srv.url);
  await call(invited, 'joinRoom', { code: openRoom.code, name: 'Friend', via: 'invite' });
  const ghost = await connect(srv.url);
  const ghostRoom = await call(ghost, 'createRoom', { name: 'Ghost', open: true });
  ghost.close();
  await sleep(200);
  assert(!(await tables(browser)).some((t) => t.code === ghostRoom.code), 'a table with nobody connected is not listed');

  // --- starting removes it from the list and counts the start
  const started = new Promise((r) => host.once('gameState', r));
  host.emit('startGame', { mode: 'standard' });
  await started;
  assert(!(await tables(browser)).some((t) => t.code === made.code), 'a started game is no longer listed');

  let r = await statsOf(srv.url);
  assert(total(r, 'roomsCreated') === 3, 'rooms created: 3');
  assert(total(r, 'tablesOpened') === 3, 'tables opened: 3 (toggling the same table twice counts once)');
  assert(total(r, 'joinsViaList') === 3 && total(r, 'joinsViaCode') === 1 && total(r, 'joinsViaInvite') === 1, 'joins are attributed to list / code / invite');
  assert(total(r, 'roomsWith2') === 2, 'rooms that reached a 2nd player: 2');
  assert(total(r, 'gamesStarted') === 1 && r.modes.standard === 1 && r.playerCounts['5'] === 1, 'game start counted with mode and player count');
  assert(r.funnel[1].fromPrevious === 150, 'funnel shows each step as a % of the previous one');
  assert(r.days.length === 1 && r.days[0].roomsCreated === 3, 'counts are also bucketed by day');
  assert(r.live['games in progress'] === 1 && r.live['open tables'] === 1, 'live numbers: games in progress and open tables');

  // --- a full bot game to GAME_OVER counts one finish
  await new Promise((resolve, reject) => {
    const smoke = spawn('node', [path.join(__dirname, 'socket-smoke.js')], {
      env: { ...process.env, SMOKE_URL: srv.url },
      stdio: 'ignore',
    });
    smoke.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('smoke game failed'))));
  });
  r = await statsOf(srv.url);
  assert(total(r, 'gamesFinished') === 1, 'a game reaching GAME_OVER counts as finished, once');
  const page = await get(`${srv.url}/stats`);
  assert(page.status === 200 && /Games finished/.test(page.body) && /<table>/.test(page.body), '/stats renders the funnel page');

  // --- counts survive a restart; a finished game rejoined after restart isn't counted again
  [browser, host, guest, solo, invited, ...joiners].forEach((s) => s.close());
  await sleep(100);
  srv.proc.kill('SIGTERM');
  await exited(srv.proc);
  const srv2 = startServer({ STATE_FILE: file });
  await srv2.ready;
  r = await statsOf(srv2.url);
  assert(total(r, 'roomsCreated') === 4 && total(r, 'gamesFinished') === 1, 'counters survive a restart');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const finished = state.rooms.find((x) => x.game && x.game.phase === 'GAME_OVER');
  const anyToken = finished && finished.players[0].token;
  const back = await connect(srv2.url);
  const rejoin = await call(back, 'joinRoom', { code: finished.code, token: anyToken });
  await sleep(100);
  assert(rejoin.ok && total(await statsOf(srv2.url), 'gamesFinished') === 1, 'rejoining a finished game after restart does not double-count');
  const reopened = state.rooms.find((x) => x.code === openRoom.code);
  assert(reopened && reopened.open === true, 'the open flag is saved with the room');
  back.close();
  srv2.proc.kill();
  await exited(srv2.proc);

  // --- STATS_KEY locks the page
  const srv3 = startServer({ STATE_FILE: path.join(tmpDir, 'keyed.json'), STATS_KEY: 's3cret' });
  await srv3.ready;
  assert((await get(`${srv3.url}/stats`)).status === 404, 'with STATS_KEY set, /stats without the key is a 404');
  assert((await get(`${srv3.url}/stats.json?key=wrong`)).status === 404, '…and with a wrong key');
  const ok = await get(`${srv3.url}/stats?key=s3cret`);
  assert(ok.status === 200 && /stats\.json\?key=s3cret/.test(ok.body), 'the right key opens it (and its JSON link keeps the key)');
  srv3.proc.kill();
  await exited(srv3.proc);

  console.log(`All open tables + funnel tests passed (${passed} assertions).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Chat test: the chat rules in isolation, then over real sockets — table talk reaches every
// seat, a private line reaches only its two ends, and history survives a rejoin and a restart.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { postMessage, chatHistory } = require('../server/chat');

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  passed++;
}
const throws = (fn, re, msg) => {
  try {
    fn();
  } catch (e) {
    return assert(re.test(e.message), `${msg} (got "${e.message}")`);
  }
  assert(false, msg + ' (did not throw)');
};

console.log('Running chat tests...');

// ---- rules ----
{
  const seat = (pid, name) => ({ token: 't' + pid, pid, name });
  const room = { players: new Map(['a', 'b', 'c'].map((id, i) => [`t${id}`, seat(id, ['Ann', 'Ben', 'Cy'][i])])) };
  const [A, B, C] = [...room.players.values()];
  let t = 0;
  const m1 = postMessage(room, A, null, '  hello table  ', (t += 2000));
  assert(m1.text === 'hello table' && m1.to === null && m1.fromName === 'Ann', 'table line stored trimmed');
  const m2 = postMessage(room, A, 'b', 'psst', (t += 2000));
  assert(m2.to === 'b' && m2.toName === 'Ben' && m2.id === m1.id + 1, 'private line addressed and sequenced');
  assert(chatHistory(room, 'a').length === 2, 'sender sees both');
  assert(chatHistory(room, 'b').length === 2, 'recipient sees both');
  assert(chatHistory(room, 'c').map((m) => m.id).join() === String(m1.id), 'third seat never sees the private line');
  throws(() => postMessage(room, A, null, '   ', t), /empty/, 'blank rejected');
  throws(() => postMessage(room, A, null, 'x'.repeat(301), t), /under 300/, 'overlong rejected');
  throws(() => postMessage(room, A, 'zz', 'hi', t), /not in this room/, 'unknown recipient rejected');
  throws(() => postMessage(room, A, 'a', 'hi', t), /yourself/, 'self-message rejected');
  for (let i = 0; i < 6; i++) postMessage(room, C, null, 'spam ' + i, t + 1);
  throws(() => postMessage(room, C, null, 'one more', t + 2), /Slow down/, 'flood is rate-limited');
  assert(postMessage(room, C, null, 'later', t + 6000).text === 'later', 'rate limit lifts after the window');
  for (let i = 0; i < 320; i++) postMessage(room, i % 2 ? A : B, null, 'n' + i, (t += 6000));
  assert(room.chat.length === 300, 'old lines roll off past the cap');
}

// ---- over sockets ----
const PORT = 3124;
const URL = `http://localhost:${PORT}`;
const STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-')), 'state.json');
let serverProc = null;
const boot = () => {
  serverProc = spawn('node', [path.join(__dirname, '../server/index.js')], {
    env: { ...process.env, PORT: String(PORT), STATE_FILE },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((r) => setTimeout(r, 900));
};
process.on('exit', () => serverProc && serverProc.kill());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () =>
  new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    s.inbox = [];
    s.history = null;
    s.on('chatMsg', (m) => s.inbox.push(m));
    s.on('chatHistory', (h) => (s.history = h));
    s.on('lobbyState', (l) => (s.pid = l.you));
    s.on('connect', () => resolve(s));
  });
const emitAck = (sock, ev, data) => new Promise((r) => sock.emit(ev, data, r));

async function sockets() {
  await boot();
  const [a, b, c] = await Promise.all([connect(), connect(), connect()]);
  const create = await emitAck(a, 'createRoom', { name: 'Ann' });
  const jb = await emitAck(b, 'joinRoom', { code: create.code, name: 'Ben' });
  await emitAck(c, 'joinRoom', { code: create.code, name: 'Cy' });
  await wait(200);
  assert(a.pid && b.pid && c.pid, 'lobby state tells each seat its id');
  assert(Array.isArray(c.history) && c.history.length === 0, 'joiner receives (empty) history');

  assert((await emitAck(a, 'chatSend', { to: null, text: 'Opening offer?' })).ok, 'table line accepted');
  assert((await emitAck(a, 'chatSend', { to: b.pid, text: 'Ben — side deal' })).ok, 'private line accepted');
  const bad = await emitAck(a, 'chatSend', { to: null, text: '' });
  assert(!bad.ok && /empty/.test(bad.error), 'server rejects an empty line with a reason');
  await wait(200);
  assert(a.inbox.length === 2 && b.inbox.length === 2, 'both ends get table + private lines');
  assert(c.inbox.length === 1 && c.inbox[0].to === null, 'outsider gets only the table line');

  // A late joiner reads the table's backlog but not anyone's private lines.
  const d = await connect();
  await emitAck(d, 'joinRoom', { code: create.code, name: 'Dee' });
  await wait(150);
  assert(d.history.length === 1 && d.history[0].to === null, 'a new seat sees table history only');
  d.disconnect();

  // Rejoin with the seat token: history comes back, private lines included.

  b.disconnect();
  const b2 = await connect();
  await emitAck(b2, 'joinRoom', { code: create.code, token: jb.token });
  await wait(150);
  assert(b2.history.map((m) => m.text).join('|') === 'Opening offer?|Ben — side deal', 'rejoin restores private history');
  b2.history = null;
  b2.emit('resync');
  await wait(150);
  assert(b2.history && b2.history.length === 2, 'resync re-sends chat history');

  // Restart the server: chat comes back from the snapshot.
  await wait(600); // past the save debounce
  serverProc.kill();
  await wait(300);
  await boot();
  const b3 = await connect();
  const back = await emitAck(b3, 'joinRoom', { code: create.code, token: jb.token });
  await wait(150);
  assert(back.ok && b3.history.length === 2, 'chat survives a server restart');
  for (const s of [a, b3]) s.disconnect();
}

sockets()
  .then(() => {
    console.log(`All chat tests passed (${passed} assertions).`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

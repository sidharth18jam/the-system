// The System — server entry: Express static hosting + Socket.IO rooms
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { SystemGame } = require('./game');
const { scheduleSave, flushSave, loadState } = require('./persistence');
const { postMessage, chatHistory, canSee } = require('./chat');
const limits = require('./limits');

const app = express();
app.disable('x-powered-by');
// Browser-side defence in depth. The CSP allows scripts only from this origin (no inline JS,
// no eval), so even if an escaping bug slips into the client, injected markup can't run code.
// Inline styles stay allowed: the client renders style="…" attributes. Fonts are Google Fonts.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' wss: ws:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});
app.use(express.static(path.join(__dirname, '../public')));
app.get('/healthz', (_req, res) => res.type('text').send('ok')); // platform health check
// Lobby invite QR: encodes the join link the client builds, so phones can scan to join.
app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.u || '');
  if (!/^https?:\/\//.test(text) || text.length > 300) return res.status(400).end();
  // Only encode links to this site, so the endpoint can't mint QR codes for phishing URLs
  // under our domain.
  let host;
  try {
    host = new URL(text).host;
  } catch {
    return res.status(400).end();
  }
  if (host !== req.get('host')) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1 });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
  } catch {
    res.status(500).end();
  }
});

const server = http.createServer(app);
// Tighter heartbeat than the 25s+20s default: a phone that sleeps or drops Wi-Fi is noticed
// (and reconnects, which re-pushes state) in ~20s instead of ~45s.
// Game messages are tiny; cap inbound payloads well below Socket.IO's 1 MB default.
const io = new Server(server, { pingInterval: 10000, pingTimeout: 10000, maxHttpBufferSize: 64 * 1024 });

const PORT = process.env.PORT || 3000;
const LOBBY_GRACE_MS = 90 * 1000; // how long a dropped lobby player keeps their seat
// A room with nobody connected for this long is abandoned: drop it so memory and the
// snapshot file don't grow forever. Long enough to pause a game overnight and come back.
const ROOM_IDLE_MS = Number(process.env.ROOM_IDLE_MS) || 24 * 60 * 60 * 1000;
const ROOM_SWEEP_MS = Number(process.env.ROOM_SWEEP_MS) || 5 * 60 * 1000;

// roomCode -> { code, hostToken, players: Map<token, {token,pid,name,socketId,connected}>, game|null }
// Restored from disk on boot so in-progress games survive a restart.
const restored = loadState();
const rooms = restored ? restored.rooms : new Map();
let pidCounter = restored ? restored.pidCounter : 0;
// Mark a room changed (or all rooms, with no argument) and schedule a snapshot write.
const persist = (room) => scheduleSave(rooms, () => pidCounter, room);

const roomCreateLimiter = limits.makeLimiter(limits.ROOM_CREATE_MAX, limits.ROOM_CREATE_WINDOW_MS);
const joinMissLimiter = limits.makeLimiter(limits.JOIN_MISS_MAX, limits.JOIN_MISS_WINDOW_MS);

function sweepIdleRooms(now = Date.now()) {
  let removed = 0;
  for (const room of rooms.values()) {
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (anyone) {
      room.idleSince = null;
      continue;
    }
    if (room.idleSince == null) room.idleSince = now;
    if (now - room.idleSince >= ROOM_IDLE_MS) {
      rooms.delete(room.code);
      removed++;
    }
  }
  if (removed) {
    console.log(`swept ${removed} idle room(s); ${rooms.size} left`);
    persist();
  }
  roomCreateLimiter.prune(now);
  joinMissLimiter.prune(now);
}
setInterval(sweepIdleRooms, ROOM_SWEEP_MS).unref();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// A token is the only proof of owning a seat, so it must be unguessable. Math.random's state
// can be recovered from enough observed outputs (room codes, shuffles), so use the CSPRNG.
function makeToken() {
  return crypto.randomBytes(16).toString('base64url');
}
function makePid() {
  return 'p' + ++pidCounter;
}

function lobbyState(room) {
  return {
    code: room.code,
    started: !!room.game,
    players: [...room.players.values()].map((p) => ({
      id: p.pid,
      name: p.name,
      connected: p.connected,
      isHost: p.token === room.hostToken,
    })),
  };
}

// Per-socket broadcast so each client learns its own identity without leaking tokens.
// In-game state is serialized per viewer so hidden info (conspiracy hands, peeks)
// only reaches its owner.
function sendState(room, p, lobby) {
  if (!p.connected) return;
  const s = io.sockets.sockets.get(p.socketId);
  if (!s) return;
  const base = room.game ? room.game.serialize(p.pid) : lobby || lobbyState(room);
  const payload = { ...base, you: p.pid, youAreHost: p.token === room.hostToken };
  s.emit(room.game ? 'gameState' : 'lobbyState', payload);
}

// Chat history goes to one seat on (re)join or resync; new lines go only to the seats that
// may read them (everyone for table talk, the two ends for a private line).
function sendChatHistory(room, p) {
  const s = p.connected && io.sockets.sockets.get(p.socketId);
  if (s) s.emit('chatHistory', chatHistory(room, p.pid));
}
function deliverChat(room, msg) {
  for (const p of room.players.values()) {
    if (!p.connected || !canSee(msg, p.pid)) continue;
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('chatMsg', msg);
  }
}

function broadcast(room) {
  const lobby = room.game ? null : lobbyState(room);
  for (const p of room.players.values()) sendState(room, p, lobby);
  if (room.game) armTimers(room);
  persist(room); // mirror the change to disk (batched)
}

// Interrupt phases (REACTION, AUCTION, AUCTION_PLACE) must not hang on an absent player.
// Arm a one-shot server timeout that auto-advances if the game is still waiting.
const REACTION_TIMEOUT_MS = 25000;
const AUCTION_TIMEOUT_MS = 30000;
function armTimers(room) {
  const g = room.game;
  let wantKey = null;
  let action = null;
  if (g.phase === 'REACTION' && g.pendingReaction) {
    wantKey = `reaction:${g.pendingReaction.victimId}:${g.conspiracyCounter}:${g.turnCounter}`;
    action = () => {
      g.respondReaction(g.pendingReaction.victimId, null);
      g.addLog('⏲ Reaction window timed out.');
    };
  } else if (g.phase === 'AUCTION' && g.auction) {
    // Auto-pass everyone still deciding except the high bidder, ending the auction.
    wantKey = `auction:${g.auction.card.id}:${g.auction.bid}:${g.auction.highBidder || 'none'}`;
    action = () => {
      const stragglers = g.players.filter(
        (p) => !g.auction.passed.has(p.id) && p.id !== g.auction.highBidder
      );
      g.addLog('⏲ Bidding time expired.');
      for (const p of stragglers) {
        if (g.phase !== 'AUCTION') break;
        g.passBid(p.id);
      }
    };
  } else if (g.phase === 'SETUP_BID') {
    // Auto-bid 0 for anyone dawdling so a vanished player can't stall the start (DD-26).
    wantKey = `setupbid:${Object.keys(g.setupBids).join(',')}`;
    action = () => {
      g.addLog('⏲ Bidding time expired.');
      for (const p of g.players) {
        if (g.phase !== 'SETUP_BID') break;
        if (g.setupBids[p.id] == null) g.submitSetupBid(p.id, 0);
      }
    };
  } else if (g.phase === 'SETUP_REQUIREMENTS') {
    // Auto-place the placer's first card on the first open zone (DD-26).
    wantKey = `setupreq:${g.zones.filter((z) => z.requirement).length}`;
    action = () => {
      const placer = g.players[g.reqPlacerIndex];
      const zone = g.zones.find((z) => !z.requirement);
      const card = g.reqHands[placer.id][0];
      if (zone && card) {
        g.addLog('⏲ Placement timed out — a requirement is auto-pinned.');
        g.placeRequirement(placer.id, card.id, zone.id);
      }
    };
  } else if (g.phase === 'AUCTION_PLACE' && g.auctionPlacement) {
    wantKey = `place:${g.auctionPlacement.card.id}:${g.turnCounter}`;
    action = () => {
      // Auto-seat into the winner's best available zone (most of their pegs, then room).
      const winnerId = g.auctionPlacement.winnerId;
      const best = g.zones
        .filter((z) => g.emptyNormalIndices(z).length > 0)
        .sort((a, b) => g.pegCount(b, winnerId) - g.pegCount(a, winnerId))[0];
      if (best) {
        g.addLog('⏲ Placement timed out — the bloc is auto-seated.');
        g.placeAuctionWin(winnerId, best.id, false);
      }
    };
  }
  if (wantKey === room.timerKey) return; // already armed for this exact wait
  clearTimeout(room.timer);
  room.timerKey = wantKey;
  room.timer = null;
  if (!wantKey) return;
  const timeoutMs = g.phase === 'REACTION' ? REACTION_TIMEOUT_MS : AUCTION_TIMEOUT_MS;
  room.timer = setTimeout(() => {
    if (room.timerKey !== wantKey || !room.game) return;
    try {
      action();
    } catch (e) {
      /* stale timer; ignore */
    }
    broadcast(room);
  }, timeoutMs);
}

// Payload fields come from untrusted clients: coerce to the expected shape, never assume it.
const str = (v) => (typeof v === 'string' ? v : '');

// A seat's socket went away (disconnect) or moved to another room. Mark the seat offline and,
// in the lobby, free it after a grace period if its owner doesn't come back.
function releaseSeat(room, token, socketId) {
  const p = room.players.get(token);
  // A newer socket (reopened tab, reconnect) already owns this seat — nothing to do.
  if (!p || p.socketId !== socketId) return;
  p.connected = false;
  broadcast(room);
  if (room.game) return;
  // In lobby: phones drop the socket on screen lock or app switch, so hold the seat
  // briefly and only remove the player if they haven't come back.
  setTimeout(() => {
    if (room.game || p.connected || room.players.get(token) !== p) return;
    room.players.delete(token);
    if (room.players.size === 0) {
      rooms.delete(room.code);
      persist();
      return;
    }
    if (token === room.hostToken) {
      room.hostToken = room.players.keys().next().value;
    }
    broadcast(room);
  }, LOBBY_GRACE_MS).unref();
}

// Cap open sockets per IP so one script can't use up Fly's connection limit and lock everyone
// else out. Generous, because a classroom or a mobile carrier's NAT puts many players on one IP.
const connsByIp = new Map();
io.use((socket, next) => {
  const ip = limits.clientIp(socket);
  const n = connsByIp.get(ip) || 0;
  if (n >= limits.MAX_CONNS_PER_IP) return next(new Error('Too many connections from your network'));
  connsByIp.set(ip, n + 1);
  socket.once('disconnect', () => {
    const left = (connsByIp.get(ip) || 1) - 1;
    if (left <= 0) connsByIp.delete(ip);
    else connsByIp.set(ip, left);
  });
  next();
});

io.on('connection', (socket) => {
  let myRoom = null;
  let myToken = null;
  const ip = limits.clientIp(socket);
  const eventLimiter = limits.makeLimiter(limits.SOCKET_EVENT_MAX, limits.SOCKET_EVENT_WINDOW_MS);
  let floodWarned = false;

  const fail = (msg) => socket.emit('errorMsg', msg);
  const myPlayer = () => (myRoom && myToken ? myRoom.players.get(myToken) : null);

  // Every handler goes through here: a malformed payload, a flood, or a bug in one handler
  // must answer that one client with an error — never throw and take the whole server down.
  const on = (event, handler) =>
    socket.on(event, (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      if (!eventLimiter.allow('e')) {
        if (!floodWarned) fail('Too many actions at once — slow down');
        floodWarned = true;
        return ack && ack({ ok: false, error: 'Too many requests' });
      }
      floodWarned = false;
      const payload = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {};
      try {
        handler(payload, ack);
      } catch (e) {
        console.error(`handler "${event}" failed:`, e && e.stack ? e.stack : e);
        if (ack) ack({ ok: false, error: 'Something went wrong' });
        else fail('Something went wrong');
      }
    });

  // Moving to another room (create or join) gives up the seat this socket held before,
  // so the old room doesn't keep a ghost "connected" player and stop receiving our state.
  const leaveCurrentSeat = (nextRoom, nextToken) => {
    if (!myRoom || (myRoom === nextRoom && myToken === nextToken)) return;
    const old = myRoom;
    if (old !== nextRoom) socket.leave(old.code);
    releaseSeat(old, myToken, socket.id);
  };

  on('createRoom', (payload, ack) => {
    const name = str(payload.name);
    if (!name.trim()) return ack && ack({ ok: false, error: 'Enter a name' });
    if (rooms.size >= limits.MAX_ROOMS) {
      return ack && ack({ ok: false, error: 'The server is full right now — try again later' });
    }
    if (!roomCreateLimiter.allow(ip)) {
      return ack && ack({ ok: false, error: 'Too many rooms created — try again in a few minutes' });
    }
    leaveCurrentSeat(null, null);
    const code = makeRoomCode();
    const token = makeToken();
    const room = {
      code,
      hostToken: token,
      players: new Map([
        [token, { token, pid: makePid(), name: name.trim().slice(0, 20), socketId: socket.id, connected: true }],
      ]),
      game: null,
      chat: [],
      chatSeq: 0,
    };
    rooms.set(code, room);
    myRoom = room;
    myToken = token;
    socket.join(code);
    ack && ack({ ok: true, code, token });
    broadcast(room);
  });

  on('joinRoom', (payload, ack) => {
    const code = str(payload.code);
    const name = str(payload.name);
    const token = str(payload.token);
    const room = rooms.get(code.toUpperCase().trim());
    if (!room) {
      if (!joinMissLimiter.allow(ip)) {
        return ack && ack({ ok: false, error: 'Too many attempts — try again in a few minutes' });
      }
      return ack && ack({ ok: false, error: 'Room not found' });
    }

    // Reconnect path
    if (token && room.players.has(token)) {
      leaveCurrentSeat(room, token);
      const p = room.players.get(token);
      p.socketId = socket.id;
      p.connected = true;
      myRoom = room;
      myToken = token;
      socket.join(room.code);
      ack && ack({ ok: true, code: room.code, token });
      broadcast(room);
      sendChatHistory(room, p);
      return;
    }

    if (room.game) return ack && ack({ ok: false, error: 'Game already in progress' });
    if (room.players.size >= 5) return ack && ack({ ok: false, error: 'Room is full (5 max)' });
    if (!name.trim()) return ack && ack({ ok: false, error: 'Enter a name' });
    const cleanName = name.trim().slice(0, 20);
    if ([...room.players.values()].some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) {
      return ack && ack({ ok: false, error: 'Name taken in this room' });
    }
    leaveCurrentSeat(room, null);
    const newToken = makeToken();
    room.players.set(newToken, {
      token: newToken,
      pid: makePid(),
      name: cleanName,
      socketId: socket.id,
      connected: true,
    });
    myRoom = room;
    myToken = newToken;
    socket.join(room.code);
    ack && ack({ ok: true, code: room.code, token: newToken });
    broadcast(room);
    sendChatHistory(room, room.players.get(newToken));
  });

  on('startGame', (payload) => {
    if (!myRoom || myToken !== myRoom.hostToken) return fail('Only the host can start');
    if (myRoom.game) return fail('Already started');
    if (myRoom.players.size < 2) return fail('Need at least 2 players');
    let mode = str(payload.mode) || 'standard';
    // Two players ALWAYS play 2 Player mode — the 9-zone game doesn't work head-to-head,
    // and the engine rejects twoPlayer with any other count (DD-26).
    if (myRoom.players.size === 2) mode = 'twoPlayer';
    const infos = [...myRoom.players.values()].map((p) => ({ id: p.pid, name: p.name }));
    try {
      myRoom.game = new SystemGame(infos, Math.random, mode);
    } catch (e) {
      return fail(e.message);
    }
    broadcast(myRoom);
  });

  const gameAction = (fn) => {
    if (!myRoom || !myRoom.game) return fail('No game in progress');
    const p = myPlayer();
    if (!p) return fail('Not in this room');
    try {
      fn(myRoom.game, p.pid);
    } catch (e) {
      // Rule violations are expected (a stale click, an illegal move); report them to the player.
      return fail(e instanceof Error ? e.message : 'That move is not allowed');
    }
    broadcast(myRoom);
  };

  on('pickStartingResource', ({ resource }) =>
    gameAction((g, pid) => g.pickStartingResource(pid, resource))
  );
  on('answerPolicy', ({ choice }) => gameAction((g, pid) => g.answerPolicy(pid, choice)));
  on('buyVoterCard', ({ hqIndex, zoneId, useVolatile, discounts, hold }) =>
    gameAction((g, pid) => g.buyVoterCard(pid, hqIndex, zoneId, !!useVolatile, discounts || null, !!hold))
  );
  on('endTurn', () => gameAction((g, pid) => g.endTurn(pid)));
  on('gerrymander', ({ fromZoneId, slotIndex, toZoneId, toVolatile }) =>
    gameAction((g, pid) => g.gerrymander(pid, fromZoneId, slotIndex, toZoneId, !!toVolatile))
  );
  on('skipGerrymander', () => gameAction((g, pid) => g.skipGerrymander(pid)));
  on('proposeTrade', ({ toId, give, want, giveCards, wantCards }) =>
    gameAction((g, pid) => g.proposeTrade(pid, toId, give, want, giveCards, wantCards))
  );
  on('buyConspiracy', ({ payment, discounts }) =>
    gameAction((g, pid) => g.buyConspiracy(pid, payment, discounts || null))
  );
  on('playConspiracy', ({ cardId, targetSpec }) =>
    gameAction((g, pid) => g.playConspiracy(pid, cardId, targetSpec))
  );
  on('respondReaction', ({ cardId }) =>
    gameAction((g, pid) => g.respondReaction(pid, cardId || null))
  );
  // Official-elite active powers (DD-22). Passive elites express automatically.
  on('benefactorGift', ({ toId, payment, hqIndex, zoneId }) =>
    gameAction((g, pid) => g.benefactorGift(pid, toId, payment, hqIndex, zoneId))
  );
  on('buyHeadline', ({ payment, targetPlayerId }) =>
    gameAction((g, pid) => g.buyHeadline(pid, payment, targetPlayerId))
  );
  on('oracleSacrifice', ({ zoneId, slotIndex, gains }) =>
    gameAction((g, pid) => g.oracleSacrifice(pid, zoneId, slotIndex, gains))
  );
  on('insurgentMove', ({ moves }) => gameAction((g, pid) => g.insurgentMove(pid, moves)));
  on('pickPatronTargets', ({ targets }) =>
    gameAction((g, pid) => g.pickPatronTargets(pid, targets))
  );
  on('maverickCopy', ({ eliteId, args }) =>
    gameAction((g, pid) => g.maverickCopy(pid, eliteId, args || {}))
  );
  // ideologue powers (L3/L5) (DD-21).
  on('prospect', ({ giveRes, getA, getB }) =>
    gameAction((g, pid) => g.prospect(pid, giveRes, getA, getB))
  );
  on('landGrab', ({ zoneId, slotIndex }) =>
    gameAction((g, pid) => g.landGrab(pid, zoneId, slotIndex))
  );
  on('placeBenched', ({ zoneId, n }) =>
    gameAction((g, pid) => g.placeBenched(pid, zoneId, n))
  );
  on('snatch', ({ fromId, res }) => gameAction((g, pid) => g.snatch(pid, fromId, res)));
  on('payback', ({ payRes, zoneId, slotIndex }) =>
    gameAction((g, pid) => g.payback(pid, payRes, zoneId, slotIndex))
  );
  on('toughLove', ({ zoneId, slotIndex1, slotIndex2, extraPayment, discounts }) =>
    gameAction((g, pid) =>
      g.toughLove(pid, zoneId, slotIndex1, slotIndex2, extraPayment, discounts || null)
    )
  );
  on('placeBid', ({ amount }) => gameAction((g, pid) => g.placeBid(pid, amount)));
  on('passBid', () => gameAction((g, pid) => g.passBid(pid)));
  on('placeAuctionWin', ({ zoneId, useVolatile }) =>
    gameAction((g, pid) => g.placeAuctionWin(pid, zoneId, !!useVolatile))
  );
  on('respondTrade', ({ offerId, accept }) =>
    gameAction((g, pid) => g.respondTrade(pid, offerId, !!accept))
  );
  on('cancelTrade', ({ offerId }) =>
    gameAction((g, pid) => g.cancelTrade(pid, offerId))
  );
  // Coalitions (DD-23): joint zone capture with a peg split.
  on('proposeCoalition', ({ toId, zoneId, split }) =>
    gameAction((g, pid) => g.proposeCoalition(pid, toId, zoneId, split))
  );
  on('respondCoalition', ({ offerId, accept }) =>
    gameAction((g, pid) => g.respondCoalition(pid, offerId, !!accept))
  );
  on('cancelCoalition', ({ offerId }) =>
    gameAction((g, pid) => g.cancelCoalition(pid, offerId))
  );
  on('withdrawCoalition', ({ zoneId }) =>
    gameAction((g, pid) => g.withdrawCoalition(pid, zoneId))
  );
  // Home turfs (DD-24): use a held zone's turf power.
  on('useHomeTurf', ({ zoneId, targetSpec }) =>
    gameAction((g, pid) => g.useHomeTurf(pid, zoneId, targetSpec || null))
  );
  // 2 Player setup (DD-26): secret first-move bid, then requirement placement.
  on('submitSetupBid', ({ amount }) =>
    gameAction((g, pid) => g.submitSetupBid(pid, amount))
  );
  on('placeRequirement', ({ cardId, zoneId }) =>
    gameAction((g, pid) => g.placeRequirement(pid, cardId, zoneId))
  );
  on('discardResources', ({ discards }) =>
    gameAction((g, pid) => g.discardResources(pid, discards))
  );

  // A client coming back to the foreground asks for the current state instead of trusting
  // that it saw every push while the tab was frozen. Answers only the asker.
  on('resync', () => {
    const p = myPlayer();
    if (p && p.socketId === socket.id) {
      sendState(myRoom, p);
      sendChatHistory(myRoom, p);
    }
  });

  // Chat (lobby and in-game): to = null for the whole table, or a player id for a private line.
  on('chatSend', (payload, ack) => {
    const reply = ack || (() => {});
    const p = myPlayer();
    if (!p) return reply({ ok: false, error: 'Not in a room' });
    try {
      const msg = postMessage(myRoom, p, payload.to != null ? payload.to : null, payload.text);
      deliverChat(myRoom, msg);
      persist(myRoom);
      reply({ ok: true, id: msg.id });
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
  });

  on('playAgain', () => {
    if (!myRoom || myToken !== myRoom.hostToken) return fail('Only the host can restart');
    if (!myRoom.game || myRoom.game.phase !== 'GAME_OVER') return fail('Game still running');
    myRoom.game = null;
    broadcast(myRoom);
  });

  socket.on('disconnect', () => {
    if (!myRoom || !myToken) return;
    try {
      releaseSeat(myRoom, myToken, socket.id);
    } catch (e) {
      console.error('disconnect cleanup failed:', e && e.stack ? e.stack : e);
    }
  });
});

server.on('error', (e) => {
  console.error('server error:', e.message);
  process.exit(1); // e.g. port in use — let the platform restart us
});
server.listen(PORT, () => {
  console.log(`The System running on http://localhost:${PORT}`);
  // For LAN play the host must open the network address, not localhost: the invite link and
  // QR code are built from whatever address the host's browser is on.
  const lan = Object.values(require('os').networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
  if (lan.length && !process.env.FLY_APP_NAME) console.log(`Same Wi-Fi? Open ${lan.join(' or ')} so invite links work on phones`);
});

// Platforms stop the process on every deploy (Fly sends SIGINT, Render/Docker SIGTERM).
// Write any pending snapshot first so in-progress games survive the restart. Sockets are
// not closed politely on purpose: an abrupt drop makes clients auto-reconnect to the new
// process, while a server-initiated disconnect would tell them not to.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received — saving rooms and exiting`);
    flushSave();
    process.exit(0);
  });
}

// Last line of defence: an unexpected error is logged and the snapshot saved, but the
// process keeps serving — one bad event must not end every game on the server.
process.on('uncaughtException', (e) => {
  console.error('uncaught exception:', e && e.stack ? e.stack : e);
  flushSave();
});
process.on('unhandledRejection', (e) => {
  console.error('unhandled rejection:', e && e.stack ? e.stack : e);
});

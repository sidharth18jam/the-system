// The System — server entry: Express static hosting + Socket.IO rooms
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { SystemGame } = require('./game');
const { scheduleSave, loadState } = require('./persistence');

const app = express();
app.use(express.static(path.join(__dirname, '../public')));
app.get('/healthz', (_req, res) => res.type('text').send('ok')); // platform health check
// Lobby invite QR: encodes the join link the client builds, so phones can scan to join.
app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.u || '');
  if (!/^https?:\/\//.test(text) || text.length > 300) return res.status(400).end();
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
const io = new Server(server, { pingInterval: 10000, pingTimeout: 10000 });

const PORT = process.env.PORT || 3000;
const LOBBY_GRACE_MS = 90 * 1000; // how long a dropped lobby player keeps their seat

// roomCode -> { code, hostToken, players: Map<token, {token,pid,name,socketId,connected}>, game|null }
// Restored from disk on boot so in-progress games survive a restart.
const restored = loadState();
const rooms = restored ? restored.rooms : new Map();
let pidCounter = restored ? restored.pidCounter : 0;
const persist = () => scheduleSave(rooms, () => pidCounter);

function makeRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeToken() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function makePid() {
  return 'p' + ++pidCounter;
}

function lobbyState(room) {
  return {
    code: room.code,
    started: !!room.game,
    players: [...room.players.values()].map((p) => ({
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

function broadcast(room) {
  const lobby = room.game ? null : lobbyState(room);
  for (const p of room.players.values()) sendState(room, p, lobby);
  if (room.game) armTimers(room);
  persist(); // mirror the change to disk (debounced)
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

io.on('connection', (socket) => {
  let myRoom = null;
  let myToken = null;

  const fail = (msg) => socket.emit('errorMsg', msg);
  const myPlayer = () => (myRoom && myToken ? myRoom.players.get(myToken) : null);

  socket.on('createRoom', ({ name }, ack) => {
    if (!name || !name.trim()) return ack && ack({ ok: false, error: 'Enter a name' });
    const code = makeRoomCode();
    const token = makeToken();
    const room = {
      code,
      hostToken: token,
      players: new Map([
        [token, { token, pid: makePid(), name: name.trim().slice(0, 20), socketId: socket.id, connected: true }],
      ]),
      game: null,
    };
    rooms.set(code, room);
    myRoom = room;
    myToken = token;
    socket.join(code);
    ack && ack({ ok: true, code, token });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name, token }, ack) => {
    const room = rooms.get((code || '').toUpperCase().trim());
    if (!room) return ack && ack({ ok: false, error: 'Room not found' });

    // Reconnect path
    if (token && room.players.has(token)) {
      const p = room.players.get(token);
      p.socketId = socket.id;
      p.connected = true;
      myRoom = room;
      myToken = token;
      socket.join(room.code);
      ack && ack({ ok: true, code: room.code, token });
      broadcast(room);
      return;
    }

    if (room.game) return ack && ack({ ok: false, error: 'Game already in progress' });
    if (room.players.size >= 5) return ack && ack({ ok: false, error: 'Room is full (5 max)' });
    if (!name || !name.trim()) return ack && ack({ ok: false, error: 'Enter a name' });
    const cleanName = name.trim().slice(0, 20);
    if ([...room.players.values()].some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) {
      return ack && ack({ ok: false, error: 'Name taken in this room' });
    }
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
  });

  socket.on('startGame', (payload) => {
    if (!myRoom || myToken !== myRoom.hostToken) return fail('Only the host can start');
    if (myRoom.game) return fail('Already started');
    if (myRoom.players.size < 2) return fail('Need at least 2 players');
    let mode = (payload && payload.mode) || 'standard';
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
      broadcast(myRoom);
    } catch (e) {
      fail(e.message);
    }
  };

  socket.on('pickStartingResource', ({ resource }) =>
    gameAction((g, pid) => g.pickStartingResource(pid, resource))
  );
  socket.on('answerPolicy', ({ choice }) => gameAction((g, pid) => g.answerPolicy(pid, choice)));
  socket.on('buyVoterCard', ({ hqIndex, zoneId, useVolatile, discounts, hold }) =>
    gameAction((g, pid) => g.buyVoterCard(pid, hqIndex, zoneId, !!useVolatile, discounts || null, !!hold))
  );
  socket.on('endTurn', () => gameAction((g, pid) => g.endTurn(pid)));
  socket.on('gerrymander', ({ fromZoneId, slotIndex, toZoneId, toVolatile }) =>
    gameAction((g, pid) => g.gerrymander(pid, fromZoneId, slotIndex, toZoneId, !!toVolatile))
  );
  socket.on('skipGerrymander', () => gameAction((g, pid) => g.skipGerrymander(pid)));
  socket.on('proposeTrade', ({ toId, give, want, giveCards, wantCards }) =>
    gameAction((g, pid) => g.proposeTrade(pid, toId, give, want, giveCards, wantCards))
  );
  socket.on('buyConspiracy', ({ payment, discounts }) =>
    gameAction((g, pid) => g.buyConspiracy(pid, payment, discounts || null))
  );
  socket.on('playConspiracy', ({ cardId, targetSpec }) =>
    gameAction((g, pid) => g.playConspiracy(pid, cardId, targetSpec))
  );
  socket.on('respondReaction', ({ cardId }) =>
    gameAction((g, pid) => g.respondReaction(pid, cardId || null))
  );
  // Official-elite active powers (DD-22). Passive elites express automatically.
  socket.on('benefactorGift', ({ toId, payment, hqIndex, zoneId }) =>
    gameAction((g, pid) => g.benefactorGift(pid, toId, payment, hqIndex, zoneId))
  );
  socket.on('buyHeadline', ({ payment, targetPlayerId }) =>
    gameAction((g, pid) => g.buyHeadline(pid, payment, targetPlayerId))
  );
  socket.on('oracleSacrifice', ({ zoneId, slotIndex, gains }) =>
    gameAction((g, pid) => g.oracleSacrifice(pid, zoneId, slotIndex, gains))
  );
  socket.on('insurgentMove', ({ moves }) => gameAction((g, pid) => g.insurgentMove(pid, moves)));
  socket.on('pickPatronTargets', ({ targets }) =>
    gameAction((g, pid) => g.pickPatronTargets(pid, targets))
  );
  socket.on('maverickCopy', ({ eliteId, args }) =>
    gameAction((g, pid) => g.maverickCopy(pid, eliteId, args || {}))
  );
  // ideologue powers (L3/L5) (DD-21).
  socket.on('prospect', ({ giveRes, getA, getB }) =>
    gameAction((g, pid) => g.prospect(pid, giveRes, getA, getB))
  );
  socket.on('landGrab', ({ zoneId, slotIndex }) =>
    gameAction((g, pid) => g.landGrab(pid, zoneId, slotIndex))
  );
  socket.on('placeBenched', ({ zoneId, n }) =>
    gameAction((g, pid) => g.placeBenched(pid, zoneId, n))
  );
  socket.on('snatch', ({ fromId, res }) => gameAction((g, pid) => g.snatch(pid, fromId, res)));
  socket.on('payback', ({ payRes, zoneId, slotIndex }) =>
    gameAction((g, pid) => g.payback(pid, payRes, zoneId, slotIndex))
  );
  socket.on('toughLove', ({ zoneId, slotIndex1, slotIndex2, extraPayment, discounts }) =>
    gameAction((g, pid) =>
      g.toughLove(pid, zoneId, slotIndex1, slotIndex2, extraPayment, discounts || null)
    )
  );
  socket.on('placeBid', ({ amount }) => gameAction((g, pid) => g.placeBid(pid, amount)));
  socket.on('passBid', () => gameAction((g, pid) => g.passBid(pid)));
  socket.on('placeAuctionWin', ({ zoneId, useVolatile }) =>
    gameAction((g, pid) => g.placeAuctionWin(pid, zoneId, !!useVolatile))
  );
  socket.on('respondTrade', ({ offerId, accept }) =>
    gameAction((g, pid) => g.respondTrade(pid, offerId, !!accept))
  );
  socket.on('cancelTrade', ({ offerId }) =>
    gameAction((g, pid) => g.cancelTrade(pid, offerId))
  );
  // Coalitions (DD-23): joint zone capture with a peg split.
  socket.on('proposeCoalition', ({ toId, zoneId, split }) =>
    gameAction((g, pid) => g.proposeCoalition(pid, toId, zoneId, split))
  );
  socket.on('respondCoalition', ({ offerId, accept }) =>
    gameAction((g, pid) => g.respondCoalition(pid, offerId, !!accept))
  );
  socket.on('cancelCoalition', ({ offerId }) =>
    gameAction((g, pid) => g.cancelCoalition(pid, offerId))
  );
  socket.on('withdrawCoalition', ({ zoneId }) =>
    gameAction((g, pid) => g.withdrawCoalition(pid, zoneId))
  );
  // Home turfs (DD-24): use a held zone's turf power.
  socket.on('useHomeTurf', ({ zoneId, targetSpec }) =>
    gameAction((g, pid) => g.useHomeTurf(pid, zoneId, targetSpec || null))
  );
  // 2 Player setup (DD-26): secret first-move bid, then requirement placement.
  socket.on('submitSetupBid', ({ amount }) =>
    gameAction((g, pid) => g.submitSetupBid(pid, amount))
  );
  socket.on('placeRequirement', ({ cardId, zoneId }) =>
    gameAction((g, pid) => g.placeRequirement(pid, cardId, zoneId))
  );
  socket.on('discardResources', ({ discards }) =>
    gameAction((g, pid) => g.discardResources(pid, discards))
  );

  // A client coming back to the foreground asks for the current state instead of trusting
  // that it saw every push while the tab was frozen. Answers only the asker.
  socket.on('resync', () => {
    const p = myPlayer();
    if (p && p.socketId === socket.id) sendState(myRoom, p);
  });

  socket.on('playAgain', () => {
    if (!myRoom || myToken !== myRoom.hostToken) return fail('Only the host can restart');
    if (!myRoom.game || myRoom.game.phase !== 'GAME_OVER') return fail('Game still running');
    myRoom.game = null;
    broadcast(myRoom);
  });

  socket.on('disconnect', () => {
    if (!myRoom || !myToken) return;
    const room = myRoom;
    const token = myToken;
    const p = room.players.get(token);
    // A newer socket (reopened tab, reconnect) already owns this seat — nothing to do.
    if (!p || p.socketId !== socket.id) return;
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
  });
});

server.listen(PORT, () => {
  console.log(`The System running on http://localhost:${PORT}`);
});

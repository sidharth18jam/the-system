// Socket smoke test: spawns the server, then 3 clients play a full game over real sockets.
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3123;
const URL = `http://localhost:${PORT}`;

const serverProc = spawn('node', [path.join(__dirname, '../server/index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'inherit',
});
process.on('exit', () => serverProc.kill());
const RES = ['funds', 'clout', 'media', 'trust'];

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}

function emitAck(sock, event, data) {
  return new Promise((resolve) => sock.emit(event, data, resolve));
}

// Build a payment map summing to `amount` from the largest piles, or null if short.
function greedyPay(res, amount) {
  const pay = { funds: 0, clout: 0, media: 0, trust: 0 };
  let left = amount;
  for (const r of RES.slice().sort((a, b) => res[b] - res[a])) {
    const take = Math.min(left, res[r]);
    pay[r] = take;
    left -= take;
    if (left === 0) break;
  }
  return left === 0 ? pay : null;
}

// Pick a legal target for a conspiracy from a client's view of state, or undefined.
function smokeTarget(s, card, pid) {
  switch (card.target) {
    case 'none':
      return null;
    case 'player':
    case 'playerRes': {
      const opp = s.players.filter((p) => p.id !== pid);
      const t = opp[Math.floor(Math.random() * opp.length)];
      return card.target === 'playerRes'
        ? { playerId: t.id, res: RES[Math.floor(Math.random() * 4)] }
        : { playerId: t.id };
    }
    case 'opponentPeg': {
      for (const z of s.zones) {
        for (let i = 0; i < z.slots.length; i++) {
          const o = z.slots[i];
          if (o && o !== pid && i !== z.volatileIndex && o !== z.majorityOwner) {
            return { zoneId: z.id, slotIndex: i };
          }
        }
      }
      return undefined;
    }
    case 'zone': {
      return { zoneId: s.zones[Math.floor(Math.random() * s.zones.length)].id };
    }
    case 'hqCard': {
      const idx = s.hq.findIndex(Boolean);
      return idx >= 0 ? { hqIndex: idx } : undefined;
    }
    default:
      return undefined;
  }
}

async function main() {
  await new Promise((r) => setTimeout(r, 1200)); // let server boot
  const [a, b, c] = await Promise.all([connect(), connect(), connect()]);
  const clients = [
    { sock: a, name: 'Alice' },
    { sock: b, name: 'Bob' },
    { sock: c, name: 'Cara' },
  ];

  const create = await emitAck(a, 'createRoom', { name: 'Alice' });
  if (!create.ok) throw new Error('createRoom failed');
  console.log('room created:', create.code);
  for (const cl of [clients[1], clients[2]]) {
    const j = await emitAck(cl.sock, 'joinRoom', { code: create.code, name: cl.name });
    if (!j.ok) throw new Error('join failed: ' + j.error);
  }

  let done = false;
  let turnCount = 0;

  for (const cl of clients) {
    cl.sock.on('errorMsg', (m) => {
      // Bots race; benign errors like "Not your turn" are expected. Log unexpected ones.
      if (
        !/Not your turn|Not in|Cannot afford|full|offer is gone|Trading is closed|Volatile|no longer holds|do not hold|owe an IOU|Bid must|auction|dropped out|high bidder|only|No auction|do not hold that card|only play conspiracies|reaction|protected|equitable|Offer something|Pay exactly|deck is empty|active player|exactly|gerrymander phase|untouchable|No room|No voter|Unknown|starting picks/i.test(
          m
        )
      )
        console.log(`[${cl.name}] error:`, m);
      // A rejected action produces no state broadcast, so the bot would wait forever.
      // Re-act off the last known state; randomness steers it down a different path.
      setTimeout(() => act(cl), 60);
    });
    cl.sock.on('gameState', (s) => {
      cl.state = s;
      cl.pid = s.you;
      act(cl);
    });
  }

  function act(cl) {
    const s = cl.state;
    if (!s || done) return;
    if (s.phase === 'GAME_OVER') {
      if (!done) {
        done = true;
        const winners = s.players.filter((p) => s.winnerIds.includes(p.id));
        console.log(
          `GAME OVER after ~${turnCount} actions. Winner: ${winners
            .map((w) => `${w.name} (${w.score})`)
            .join(', ')}`
        );
        console.log('last log lines:', s.log.slice(-3).join(' | '));
        process.exit(0);
      }
      return;
    }
    const meP = s.players.find((p) => p.id === cl.pid);
    if (s.phase === 'SETUP_PICK' && meP.startingPicksRemaining > 0) {
      cl.sock.emit('pickStartingResource', { resource: RES[Math.floor(Math.random() * 4)] });
      return;
    }
    // If a conspiracy is pending against me, respond (coin-flip cancel/pass).
    if (s.pendingReaction && s.pendingReaction.victimId === cl.pid) {
      const react = (s.yourConspiracies || []).find((c) => c.reaction);
      cl.sock.emit('respondReaction', { cardId: Math.random() < 0.5 && react ? react.id : null });
      return;
    }
    // Public auction: any player bids or passes.
    if (s.phase === 'AUCTION' && s.auction) {
      const a = s.auction;
      if (a.passed.includes(cl.pid) || a.highBidder === cl.pid) return; // waiting
      if (meP.iou && meP.iou.debt > 0) {
        cl.sock.emit('passBid');
      } else if (Math.random() < 0.4 && a.bid + 1 <= s.resourceCap) {
        cl.sock.emit('placeBid', { amount: a.bid + 1 });
      } else {
        cl.sock.emit('passBid');
      }
      return;
    }
    if (s.phase === 'AUCTION_PLACE') {
      if (s.auctionPlacement && s.auctionPlacement.winnerId === cl.pid) {
        const zone =
          s.zones.find((z) => z.slots.some((sl, i) => sl === null && i !== z.volatileIndex)) ||
          s.zones.find((z) => z.slots[z.volatileIndex] === null);
        if (zone) cl.sock.emit('placeAuctionWin', { zoneId: zone.id });
      }
      return;
    }
    // Respond to incoming trade offers (accept anything payable).
    const incoming = (s.tradeOffers || []).find((o) => o.to === cl.pid);
    if (incoming) {
      const payable = Object.entries(incoming.want).every(([r, n]) => meP.resources[r] >= n);
      cl.sock.emit('respondTrade', { offerId: incoming.id, accept: payable });
      if (!payable) return; // wait for next state
    }
    if (s.phase === 'REACTION') return; // someone else's reaction window; wait it out
    // Between turns: a non-active player may strike in the POLICY window (DD-21).
    if (s.phase === 'POLICY' && s.activePlayerId !== cl.pid && s.youMayPlayConspiracy) {
      const between = (s.yourConspiracies || []).filter((c) => !c.reaction);
      if (between.length && Math.random() < 0.12) {
        const card = between[Math.floor(Math.random() * between.length)];
        const spec = smokeTarget(s, card, cl.pid);
        if (spec !== undefined) {
          cl.sock.emit('playConspiracy', { cardId: card.id, targetSpec: spec });
          return;
        }
      }
    }
    if (s.activePlayerId !== cl.pid) return;
    turnCount++;
    if (s.phase === 'POLICY') {
      cl.triedTrade = false; // new turn, new chance to negotiate
      cl.sock.emit('answerPolicy', { choice: Math.random() < 0.5 ? 'a' : 'b' });
    } else if (s.phase === 'ACTION') {
      // If my own offer is still on the table, wait for the response.
      if ((s.tradeOffers || []).some((o) => o.from === cl.pid)) return;
      // Debt-locked: can't spend on anything, just end the turn.
      if (meP.iou && meP.iou.debt > 0) {
        cl.sock.emit('endTurn');
        return;
      }

      // Occasionally play a held conspiracy at a legal target (exercises the reaction path).
      const hand = (s.yourConspiracies || []).filter((c) => !c.reaction);
      if (hand.length && Math.random() < 0.4) {
        const card = hand[Math.floor(Math.random() * hand.length)];
        const spec = smokeTarget(s, card, cl.pid);
        if (spec !== undefined) {
          cl.sock.emit('playConspiracy', { cardId: card.id, targetSpec: spec });
          return;
        }
      }
      // Occasionally buy a conspiracy: pay the top card's price in any mix (DD-21).
      if (s.conspiracyDeckCount > 0 && s.conspiracyPrice != null && Math.random() < 0.25) {
        const payment = greedyPay(meP.resources, s.conspiracyPrice);
        if (payment) {
          cl.sock.emit('buyConspiracy', { payment });
          return;
        }
      }
      // buy first affordable card into first open zone, else trade once, else end turn
      const i = s.hq.findIndex(
        (card) => card && Object.entries(card.cost).every(([r, n]) => meP.resources[r] >= n)
      );
      const useVolatile = Math.random() < 0.25;
      const zone = s.zones.find(
        (z) =>
          z.slots.some((slot, idx) => slot === null && idx !== z.volatileIndex) ||
          (useVolatile && z.slots[z.volatileIndex] === null)
      );
      if (i >= 0 && zone) {
        cl.sock.emit('buyVoterCard', { hqIndex: i, zoneId: zone.id, useVolatile });
        return;
      }
      if (i < 0 && !cl.triedTrade) {
        // Nothing affordable: trade toward the HQ card with the smallest deficit.
        // Trades are equitable (DD-21): swap 1 surplus for 1 needed resource.
        cl.triedTrade = true;
        const deficit = (card) =>
          Object.entries(card.cost).reduce((d, [r, n]) => d + Math.max(0, n - meP.resources[r]), 0);
        const target = s.hq.filter(Boolean).sort((a, b) => deficit(a) - deficit(b))[0];
        if (target) {
          const needRes = RES.find((r) => (target.cost[r] || 0) > meP.resources[r]);
          const partner = s.players.find((p) => p.id !== cl.pid && p.resources[needRes] >= 1);
          const surplus = RES.filter((r) => r !== needRes && !(r in target.cost)).sort(
            (a, b) => meP.resources[b] - meP.resources[a]
          )[0];
          if (needRes && partner && surplus && meP.resources[surplus] >= 1) {
            cl.sock.emit('proposeTrade', {
              toId: partner.id,
              give: { [surplus]: 1 },
              want: { [needRes]: 1 },
            });
            return; // wait for accept/decline before ending the turn
          }
        }
      }
      cl.sock.emit('endTurn');
    } else if (s.phase === 'GERRYMANDER') {
      cl.sock.emit('skipGerrymander');
    } else if (s.phase === 'DISCARD') {
      // Discard from the largest pile: keeps currency diversity so the economy
      // can't collapse into a single resource nobody can spend.
      const d = { funds: 0, clout: 0, media: 0, trust: 0 };
      let left = s.discardRequired;
      const sorted = RES.slice().sort((a, b) => meP.resources[b] - meP.resources[a]);
      for (const r of sorted) {
        const take = Math.min(left, meP.resources[r]);
        d[r] = take;
        left -= take;
        if (left === 0) break;
      }
      cl.sock.emit('discardResources', { discards: d });
    }
  }

  a.emit('startGame');

  setTimeout(() => {
    console.error('TIMEOUT: game did not finish in 60s');
    const s = clients[0].state;
    if (s) {
      console.error(`phase=${s.phase} active=${s.activePlayerId} actions=~${turnCount}`);
      console.error('offers:', JSON.stringify(s.tradeOffers));
      console.error('hq:', JSON.stringify(s.hq.map((c) => c && c.cost)));
      for (const p of s.players) console.error(p.id, p.name, JSON.stringify(p.resources));
      console.error(
        'board:',
        s.zones.map((z) => `${z.id}:${z.slots.filter(Boolean).length}/${z.capacity}${z.majorityOwner ? '*' : ''}`).join(' ')
      );
      console.error('last log:', s.log.slice(-5).join(' | '));
    }
    process.exit(1);
  }, 60000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

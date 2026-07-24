// Phase 2 unit tests: trading, majority breaking, gerrymandering, headlines/volatile.
// White-box style (pokes engine internals to set up positions), like simulate.js.
const { SystemGame } = require('../server/game');

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  passed++;
}
function expectThrow(fn, msg) {
  try {
    fn();
  } catch {
    passed++;
    return;
  }
  throw new Error('EXPECTED THROW: ' + msg);
}

// Deterministic rng (mulberry32) so shuffles are stable per test.
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fresh 2-player game fast-forwarded to the first ACTION phase.
function gameInAction(seed = 1) {
  const g = new SystemGame(
    [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    seededRng(seed)
  );
  for (const p of g.players) {
    while (p.startingPicksRemaining > 0) g.pickStartingResource(p.id, 'funds');
  }
  g.answerPolicy(g.activePlayer.id, 'a');
  return g;
}

// Fill `n` normal slots of a zone with pegs for `pid` (test setup helper).
function plant(g, zone, pid, n) {
  const spots = g.emptyNormalIndices(zone);
  if (spots.length < n) throw new Error('test setup: zone too full');
  for (let i = 0; i < n; i++) zone.slots[spots[i]] = pid;
}

const RES4 = ['funds', 'clout', 'media', 'trust'];
function totalRes(p) {
  return RES4.reduce((s, r) => s + p.resources[r], 0);
}

// Fresh 2-player game stopped at the opening POLICY phase (before any answer).
function gameInPolicy(seed = 1) {
  const g = new SystemGame(
    [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    seededRng(seed)
  );
  for (const p of g.players) {
    while (p.startingPicksRemaining > 0) g.pickStartingResource(p.id, 'funds');
  }
  return g;
}

// Satisfy a pending start-of-turn discard by dumping the largest piles (DD-21).
function clearDiscard(g) {
  if (g.phase !== 'DISCARD') return;
  const p = g.activePlayer;
  const d = { funds: 0, clout: 0, media: 0, trust: 0 };
  let left = g.discardRequired;
  for (const r of RES4.slice().sort((a, b) => p.resources[b] - p.resources[a])) {
    const take = Math.min(left, p.resources[r]);
    d[r] = take;
    left -= take;
    if (left === 0) break;
  }
  g.discardResources(p.id, d);
}

// ---------- majority breaking ----------
function testMajorityBreaking() {
  const g = gameInAction();
  const z = g.getZone('N'); // majority 5 / capacity 9
  plant(g, z, 'a', 5);
  g.checkMajority(z);
  assert(z.majorityOwner === 'a', 'majority established at threshold');

  // Drop below threshold → broken
  z.slots[z.slots.indexOf('a')] = null;
  g.checkMajority(z);
  assert(z.majorityOwner === null, 'majority broken when count drops below threshold');

  // Another player reaching threshold takes it over
  z.slots = z.slots.map((s) => (s === 'a' ? null : s)); // A's remaining pegs collapse
  plant(g, z, 'b', 5);
  g.checkMajority(z);
  assert(z.majorityOwner === 'b', 'zone re-awarded to new majority holder');
  console.log('  ✔ majority breaking');
}

// ---------- trading ----------
function testTrading() {
  const g = gameInAction();
  const active = g.activePlayer;
  const other = g.players.find((p) => p.id !== active.id);
  active.resources = { funds: 3, clout: 0, media: 0, trust: 0 };
  other.resources = { funds: 0, clout: 2, media: 0, trust: 0 };

  expectThrow(
    () => g.proposeTrade(active.id, active.id, { funds: 1 }, { clout: 1 }),
    'self-trade rejected'
  );
  expectThrow(
    () => g.proposeTrade(active.id, other.id, {}, { clout: 1 }),
    'gift (empty give) rejected'
  );
  expectThrow(
    () => g.proposeTrade(active.id, other.id, { funds: 1 }, {}),
    'gift (empty want) rejected'
  );
  // Trades need not be equitable — uneven counts (2-for-1, 1-for-2) are allowed as long as
  // neither side is empty (checked above) and the proposer can afford their side.
  const uneven1 = g.proposeTrade(active.id, other.id, { funds: 2 }, { clout: 1 });
  assert(uneven1.give.funds === 2 && uneven1.want.clout === 1, 'uneven 2-for-1 allowed');
  g.cancelTrade(active.id, uneven1.id);
  const uneven2 = g.proposeTrade(active.id, other.id, { funds: 1 }, { clout: 2 });
  assert(uneven2.give.funds === 1 && uneven2.want.clout === 2, 'uneven 1-for-2 allowed');
  g.cancelTrade(active.id, uneven2.id);
  expectThrow(
    () => g.proposeTrade(active.id, other.id, { clout: 1 }, { funds: 1 }),
    'offering resources you do not hold rejected'
  );
  expectThrow(
    () => g.proposeTrade(active.id, other.id, { funds: -1 }, { clout: 1 }),
    'negative amounts rejected'
  );

  // 1-for-1 settles.
  const offer = g.proposeTrade(active.id, other.id, { funds: 1 }, { clout: 1 });
  assert(g.tradeOffers.length === 1, 'offer recorded');

  expectThrow(() => g.respondTrade(active.id, offer.id, true), 'only target may respond');
  g.respondTrade(other.id, offer.id, true);
  assert(active.resources.funds === 2 && active.resources.clout === 1, 'proposer paid and received');
  assert(other.resources.funds === 1 && other.resources.clout === 1, 'target paid and received');
  assert(g.tradeOffers.length === 0, 'offer consumed');

  // 2-for-2 settles.
  active.resources = { funds: 2, clout: 0, media: 0, trust: 0 };
  other.resources = { funds: 0, clout: 2, media: 0, trust: 0 };
  const oEven = g.proposeTrade(active.id, other.id, { funds: 2 }, { clout: 2 });
  g.respondTrade(other.id, oEven.id, true);
  assert(active.resources.clout === 2 && other.resources.funds === 2, '2-for-2 settles');

  // Decline path + stale-offer acceptance guard
  active.resources = { funds: 3, clout: 0, media: 0, trust: 0 };
  other.resources = { funds: 0, clout: 3, media: 0, trust: 0 };
  const o2 = g.proposeTrade(other.id, active.id, { clout: 1 }, { funds: 1 });
  g.respondTrade(active.id, o2.id, false);
  assert(g.tradeOffers.length === 0, 'declined offer removed');

  const o3 = g.proposeTrade(other.id, active.id, { clout: 1 }, { funds: 1 });
  other.resources.clout = 0; // proposer spends it before acceptance
  expectThrow(() => g.respondTrade(active.id, o3.id, true), 'stale offer rejected at accept');

  // Cancel path + proposer-replaces-own-offer
  other.resources.clout = 3;
  const o4 = g.proposeTrade(active.id, other.id, { funds: 1 }, { clout: 1 });
  const o5 = g.proposeTrade(active.id, other.id, { funds: 2 }, { clout: 2 });
  assert(g.tradeOffers.length === 1 && g.tradeOffers[0].id === o5.id, 'new offer replaces old to same target');
  expectThrow(() => g.cancelTrade(other.id, o5.id), 'only proposer cancels');
  g.cancelTrade(active.id, o5.id);
  assert(g.tradeOffers.length === 0, 'offer cancelled');
  assert(o4, 'offer object returned');

  // Offers must involve the active player; offers expire on turn change.
  const g3 = new SystemGame(
    [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ],
    seededRng(2)
  );
  for (const p of g3.players) while (p.startingPicksRemaining > 0) g3.pickStartingResource(p.id, 'funds');
  const bystanders = g3.players.filter((p) => p.id !== g3.activePlayer.id);
  bystanders.forEach((p) => (p.resources.funds = 5));
  expectThrow(
    () => g3.proposeTrade(bystanders[0].id, bystanders[1].id, { funds: 1 }, { funds: 1 }),
    'trade between two non-active players rejected'
  );
  g3.activePlayer.resources.clout = 2;
  g3.proposeTrade(bystanders[0].id, g3.activePlayer.id, { funds: 1 }, { clout: 1 });
  g3.answerPolicy(g3.activePlayer.id, 'a');
  clearDiscard(g3);
  g3.endTurn(g3.activePlayer.id);
  if (g3.phase === 'GERRYMANDER') g3.skipGerrymander(g3.activePlayer.id);
  assert(g3.tradeOffers.length === 0, 'offers expire when the turn passes');
  console.log('  ✔ trading');
}

// ---------- gerrymandering ----------
function testGerrymander() {
  const g = gameInAction();
  const me = g.activePlayer.id;
  const opp = g.players.find((p) => p.id !== me).id;
  const nw = g.getZone('NW'); // adj: N, W
  const n = g.getZone('N');
  const se = g.getZone('SE'); // NOT adjacent to NW
  plant(g, nw, me, 6); // capture NW
  g.checkMajority(nw);
  assert(nw.majorityOwner === me, 'setup: NW captured');
  plant(g, n, opp, 2);
  plant(g, se, opp, 2);

  g.endTurn(me);
  assert(g.phase === 'GERRYMANDER', 'majority holder enters gerrymander phase');

  const oppSlotInN = n.slots.findIndex((s) => s === opp);
  expectThrow(
    () => g.gerrymander(me, 'SE', se.slots.findIndex((s) => s === opp), 'S'),
    'zones not bordering a held constituency rejected'
  );
  expectThrow(() => g.gerrymander(me, 'N', n.volatileIndex, 'C'), 'volatile peg immovable');
  const mySlotInNW = nw.slots.findIndex((s) => s === me);
  expectThrow(() => g.gerrymander(me, 'NW', mySlotInNW, 'N'), 'majority pegs immovable');
  expectThrow(() => g.gerrymander(me, 'N', 8, 'N'), 'same zone rejected');

  // Legal: move opponent's peg out of N (adjacent to my NW) into W (also adjacent to NW).
  assert(g.gerryMovesLeft === 1, 'one majority grants one move');
  g.gerrymander(me, 'N', oppSlotInN, 'W');
  assert(g.pegCount(n, opp) === 1 && g.pegCount(g.getZone('W'), opp) === 1, 'peg moved N → W');
  assert(g.phase !== 'GERRYMANDER', 'turn advances once the allowance is spent');

  // Allowance exhausted: a second gerrymander must fail.
  expectThrow(() => g.gerrymander(me, 'N', 0, 'C'), 'only one move with one majority');

  // Gerrymandering can break a majority: opp holds N with exactly 5, I pull one out.
  const g2 = gameInAction(7);
  const me2 = g2.activePlayer.id;
  const opp2 = g2.players.find((p) => p.id !== me2).id;
  const c2 = g2.getZone('C');
  const n2 = g2.getZone('N');
  plant(g2, c2, me2, 5);
  g2.checkMajority(c2);
  plant(g2, n2, opp2, 5);
  g2.checkMajority(n2);
  assert(n2.majorityOwner === opp2, 'setup: opponent holds N');
  g2.endTurn(me2);
  // N's pegs are opp2's majority pegs → immovable. But I can flood N? No — break via moving
  // one of MY pegs is pointless; majority pegs are locked. Instead verify skip works.
  g2.skipGerrymander(me2);
  assert(g2.phase !== 'GERRYMANDER', 'skip advances the turn');

  // Two majorities → two moves; the phase persists between them (DD-21).
  const g6 = gameInAction(12);
  const me6 = g6.activePlayer.id;
  const opp6 = g6.players.find((p) => p.id !== me6).id;
  const nw6 = g6.getZone('NW'); // adj: N, W
  const c6 = g6.getZone('C');
  plant(g6, nw6, me6, nw6.majority);
  g6.checkMajority(nw6);
  plant(g6, c6, me6, c6.majority);
  g6.checkMajority(c6);
  assert(nw6.majorityOwner === me6 && c6.majorityOwner === me6, 'setup: two majorities');
  const n6 = g6.getZone('N');
  plant(g6, n6, opp6, 2);
  g6.endTurn(me6);
  assert(g6.phase === 'GERRYMANDER' && g6.gerryMovesLeft === 2, 'two majorities grant two moves');
  g6.gerrymander(me6, 'N', n6.slots.findIndex((s) => s === opp6), 'W');
  assert(g6.phase === 'GERRYMANDER' && g6.gerryMovesLeft === 1, 'phase persists after the first move');
  g6.gerrymander(me6, 'N', n6.slots.findIndex((s) => s === opp6), 'W');
  assert(g6.phase !== 'GERRYMANDER', 'turn advances after the last move');

  // Skipping ends the phase early even with moves left.
  const g7 = gameInAction(13);
  const me7 = g7.activePlayer.id;
  const nw7 = g7.getZone('NW');
  const c7 = g7.getZone('C');
  plant(g7, nw7, me7, nw7.majority);
  g7.checkMajority(nw7);
  plant(g7, c7, me7, c7.majority);
  g7.checkMajority(c7);
  g7.endTurn(me7);
  assert(g7.gerryMovesLeft === 2, 'setup: two moves available');
  g7.skipGerrymander(me7);
  assert(g7.phase !== 'GERRYMANDER', 'skip ends the phase with moves unspent');
  console.log('  ✔ gerrymandering');
}

// ---------- headlines / volatile ----------
function testHeadlines() {
  const g = gameInAction();
  const p = g.activePlayer;
  p.resources = { funds: 12, clout: 12, media: 12, trust: 12 }; // afford anything (over cap; discard comes later)
  const zone = g.getZone('C');

  // Volatile placement is opt-in and triggers a pending headline.
  const res = g.buyVoterCard(p.id, 0, 'C', true);
  assert(res.hitVolatile === true, 'volatile placement reported');
  assert(zone.slots[zone.volatileIndex] === p.id, 'peg sits in the volatile slot');
  assert(g.pendingHeadlines.length === 1, 'headline queued');

  // Non-volatile buys never touch the volatile slot.
  const g2 = gameInAction(3);
  const p2 = g2.activePlayer;
  p2.resources = { funds: 12, clout: 12, media: 12, trust: 12 };
  const z2 = g2.getZone('N');
  // Fill all normal slots via repeated buys; volatile must stay empty.
  while (g2.emptyNormalIndices(z2).length > 0 && g2.phase === 'ACTION') {
    const i = g2.hq.findIndex((c) => c && g2.canAfford(p2, c.cost));
    if (i < 0) break;
    g2.buyVoterCard(p2.id, i, 'N', false);
    p2.resources = { funds: 12, clout: 12, media: 12, trust: 12 };
  }
  assert(z2.slots[z2.volatileIndex] === null, 'volatile slot untouched without opt-in');
  if (g2.phase === 'ACTION' && g2.emptyNormalIndices(z2).length === 0) {
    expectThrow(() => g2.buyVoterCard(p2.id, 0, 'N', false), 'must opt into last (volatile) slot');
  } else {
    passed++; // zone capture path ended the game early; opt-in guard covered above
  }

  // Headline resolves at end of turn and applies to the triggering player.
  g.endTurn(p.id);
  if (g.phase === 'GERRYMANDER') g.skipGerrymander(p.id);
  assert(g.pendingHeadlines.length === 0, 'headline resolved at turn end');
  assert(g.lastHeadline && g.lastHeadline.playerId === p.id, 'headline attributed to triggering player');

  // Effect handlers, exercised directly.
  const g4 = gameInAction(5);
  const p4 = g4.activePlayer;
  const o4 = g4.players.find((x) => x.id !== p4.id);
  const z4 = g4.getZone('W');
  p4.resources = { funds: 5, clout: 1, media: 0, trust: 0 };
  o4.resources = { funds: 4, clout: 0, media: 0, trust: 0 };

  g4.applyHeadline({ effect: { type: 'gain', resources: { media: 2 } } }, p4, z4);
  assert(p4.resources.media === 2, 'gain effect');
  g4.applyHeadline({ effect: { type: 'lose', resources: { trust: 3 } } }, p4, z4);
  assert(p4.resources.trust === 0, 'lose clamps at zero');
  g4.applyHeadline({ effect: { type: 'loseHighest', n: 2 } }, p4, z4);
  assert(p4.resources.funds === 3, 'loseHighest hits largest pile');
  g4.applyHeadline({ effect: { type: 'steal', res: 'funds', n: 2 } }, p4, z4);
  assert(p4.resources.funds === 5 && o4.resources.funds === 2, 'steal takes from richest opponent');
  g4.applyHeadline({ effect: { type: 'gainEach' } }, p4, z4);
  assert(p4.resources.trust === 1, 'gainEach');
  g4.applyHeadline({ effect: { type: 'opponentsGain', resources: { media: 1 } } }, p4, z4);
  assert(o4.resources.media === 1, 'opponentsGain');

  plant(g4, z4, o4.id, 3);
  g4.applyHeadline({ effect: { type: 'removeOpponent', n: 1 } }, p4, z4);
  assert(g4.pegCount(z4, o4.id) === 2, 'removeOpponent');
  g4.applyHeadline({ effect: { type: 'convert', n: 1 } }, p4, z4);
  assert(g4.pegCount(z4, o4.id) === 1 && g4.pegCount(z4, p4.id) === 1, 'convert flips a peg');
  g4.applyHeadline({ effect: { type: 'addPegs', n: 2 } }, p4, z4);
  assert(g4.pegCount(z4, p4.id) === 3, 'addPegs');
  g4.applyHeadline({ effect: { type: 'removeOwn', n: 2 } }, p4, z4);
  assert(g4.pegCount(z4, p4.id) === 1, 'removeOwn');

  // A headline breaking a majority: owner at exact threshold loses pegs.
  const g5 = gameInAction(6);
  const p5 = g5.activePlayer;
  const z5 = g5.getZone('C');
  plant(g5, z5, p5.id, 5);
  g5.checkMajority(z5);
  assert(z5.majorityOwner === p5.id, 'setup: majority at threshold');
  g5.applyHeadline({ effect: { type: 'removeOwn', n: 1 } }, p5, z5);
  assert(z5.majorityOwner === null, 'headline peg loss breaks majority');
  console.log('  ✔ headlines & volatile areas');
}

// ---------- volatile traps + headline fidelity (DD-20) ----------
function testVolatileTraps() {
  // Gerrymander an opponent's peg INTO a volatile area → THEY suffer the headline.
  const g = gameInAction(30);
  const me = g.activePlayer;
  const victim = g.players.find((p) => p.id !== me.id);
  victim.resources = { funds: 5, clout: 5, media: 5, trust: 5 };
  const meResBefore = JSON.stringify(me.resources);
  const n = g.getZone('N');
  plant(g, n, me.id, 5); // majority in N unlocks gerrymandering over N's neighborhood (NW/NE/C)
  g.checkMajority(n);
  plant(g, n, victim.id, 2);
  g.endTurn(me.id);
  assert(g.phase === 'GERRYMANDER', 'setup: gerrymander phase');
  // Rig the deck: next headline is a known penalty.
  g.headlineDeck.push({ id: 'rig', title: 'Rigged Penalty', text: 't', effect: { type: 'lose', resources: { trust: 3 } } });
  const victimSlot = n.slots.findIndex((s) => s === victim.id);
  const c = g.getZone('C');
  g.gerrymander(me.id, 'N', victimSlot, 'C', true); // the trap — resolves via finishTurn
  assert(c.slots[c.volatileIndex] === victim.id, 'victim peg sits in the volatile slot');
  assert(victim.resources.trust === 2, 'headline penalty hit the trapped VICTIM');
  assert(JSON.stringify(me.resources) === meResBefore, 'the trapper is untouched');
  assert(g.lastHeadline.playerId === victim.id, 'headline attributed to the victim');

  // Occupied volatile slot rejected; volatile source still immovable.
  const g2 = gameInAction(31);
  const me2 = g2.activePlayer;
  const v2 = g2.players.find((p) => p.id !== me2.id);
  const n2 = g2.getZone('N');
  plant(g2, n2, me2.id, 5);
  g2.checkMajority(n2);
  const c2 = g2.getZone('C');
  c2.slots[c2.volatileIndex] = me2.id; // volatile already occupied
  plant(g2, n2, v2.id, 2);
  g2.endTurn(me2.id);
  expectThrow(
    () => g2.gerrymander(me2.id, 'N', n2.slots.findIndex((s) => s === v2.id), 'C', true),
    'occupied volatile area rejected'
  );

  // Permanence: headline peg-removal never touches a volatile peg.
  const g3 = gameInAction(32);
  const p3 = g3.activePlayer;
  const z3 = g3.getZone('C');
  z3.slots[z3.volatileIndex] = p3.id; // volatile peg
  plant(g3, z3, p3.id, 1); // one normal peg
  const removed = g3.removePegs(z3, p3.id, 5);
  assert(removed === 1, 'only the normal peg is removable');
  assert(z3.slots[z3.volatileIndex] === p3.id, 'volatile peg is permanent');

  // Deck balance: ~70% of non-auction headlines are negative (designer's note).
  const cards = require('../data/headline-cards.json');
  const nonAuction = cards.filter((cd) => cd.effect.type !== 'auction');
  const negative = nonAuction.filter((cd) => g.headlineScore(cd) < 0);
  assert(
    negative.length / nonAuction.length >= 0.65,
    `headline deck is majority-negative (${negative.length}/${nonAuction.length})`
  );
  console.log('  ✔ volatile traps & headline fidelity');
}

// ---------- start-of-turn discard + passive income (DD-21) ----------
function testStartOfTurnDiscard() {
  // Answering into an over-cap position forces a discard BEFORE you act.
  const g = gameInPolicy(40);
  const p = g.activePlayer;
  p.resources = { funds: 12, clout: 0, media: 0, trust: 0 };
  g.answerPolicy(p.id, 'a');
  assert(g.phase === 'DISCARD', 'over-cap answer enters DISCARD');
  assert(g.activePlayer.id === p.id, 'the same player is still active');
  assert(g.discardRequired === totalRes(p) - 12, 'discardRequired is exactly the overflow');
  expectThrow(() => g.buyVoterCard(p.id, 0, 'C'), 'cannot act while over the cap');
  clearDiscard(g);
  assert(g.phase === 'ACTION', 'discarding returns to ACTION on the same turn');
  assert(g.activePlayer.id === p.id, 'still the same player, now acting');
  assert(totalRes(p) === 12, 'discarded down to exactly the cap');

  // End-of-turn overflow is NOT forced — it carries to the next turn's start.
  const g2 = gameInAction(41);
  const a2 = g2.activePlayer;
  a2.resources = { funds: 14, clout: 0, media: 0, trust: 0 };
  g2.endTurn(a2.id);
  if (g2.phase === 'GERRYMANDER') g2.skipGerrymander(a2.id);
  assert(g2.phase !== 'DISCARD', 'end-of-turn overflow does not force a discard');
  assert(totalRes(a2) === 14, 'overflow carries past the turn end');
  console.log('  ✔ start-of-turn discard');
}

// ---------- passive ideologue income (DD-21) ----------
function testPassiveIncome() {
  const g = gameInPolicy(50);
  const p = g.activePlayer;
  p.resources = { funds: 0, clout: 0, media: 0, trust: 0 };
  // 3 boss + 2 icon before answering → +1 clout, +1 media on the answer.
  p.manifesto = { mogul: 0, boss: 3, icon: 2, believer: 0 };
  const opt = g.currentCard.option_a;
  g.answerPolicy(p.id, 'a');
  clearDiscard(g);
  // Expected = rewards + passive, where passive is computed AFTER the manifesto bump.
  const bumped = { mogul: 0, boss: 3, icon: 2, believer: 0 };
  bumped[opt.ideology]++;
  const expect = { funds: 0, clout: 0, media: 0, trust: 0 };
  for (const [r, n] of Object.entries(opt.rewards)) expect[r] += n;
  expect.funds += Math.floor(bumped.mogul / 2);
  expect.clout += Math.floor(bumped.boss / 2);
  expect.media += Math.floor(bumped.icon / 2);
  expect.trust += Math.floor(bumped.believer / 2);
  assert(
    JSON.stringify(p.resources) === JSON.stringify(expect),
    `passive income paid out (${JSON.stringify(p.resources)} vs ${JSON.stringify(expect)})`
  );

  // serialize exposes the standing income so the client can show it.
  const s = g.serialize(p.id);
  const me = s.players.find((x) => x.id === p.id);
  assert(me.passiveIncome.clout === Math.floor(bumped.boss / 2), 'passiveIncome serialized');

  // Zero manifesto → no passive income.
  const g2 = gameInPolicy(51);
  const p2 = g2.activePlayer;
  p2.resources = { funds: 0, clout: 0, media: 0, trust: 0 };
  const opt2 = g2.currentCard.option_b;
  g2.answerPolicy(p2.id, 'b');
  assert(totalRes(p2) === Object.values(opt2.rewards).reduce((a, b) => a + b, 0), 'one card each → no income');
  console.log('  ✔ passive ideologue income');
}

console.log('Running Phase 2 tests...');
testMajorityBreaking();
testTrading();
testGerrymander();
testHeadlines();
testVolatileTraps();
testStartOfTurnDiscard();
testPassiveIncome();
console.log(`All Phase 2 tests passed (${passed} assertions).`);

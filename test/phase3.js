// Phase 3 unit tests: conspiracies (buy/play/react, hidden hands, tradable) and,
// once built, IOU + auctions. White-box style like phase2.js.
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

function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gameInAction(seed = 1, n = 2) {
  const infos = Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(97 + i), name: 'P' + (i + 1) }));
  const g = new SystemGame(infos, seededRng(seed));
  for (const p of g.players) {
    while (p.startingPicksRemaining > 0) g.pickStartingResource(p.id, 'funds');
  }
  g.answerPolicy(g.activePlayer.id, 'a');
  return g;
}

function plant(g, zone, pid, n) {
  const spots = g.emptyNormalIndices(zone);
  for (let i = 0; i < n; i++) zone.slots[spots[i]] = pid;
}

// Same as gameInAction but stopped at the opening POLICY phase (before any answer).
function gameInPolicy(seed = 1, n = 2) {
  const infos = Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(97 + i), name: 'P' + (i + 1) }));
  const g = new SystemGame(infos, seededRng(seed));
  for (const p of g.players) {
    while (p.startingPicksRemaining > 0) g.pickStartingResource(p.id, 'funds');
  }
  return g;
}

// Satisfy a pending start-of-turn discard by dumping the largest piles (DD-21).
function clearDiscard(g) {
  if (g.phase !== 'DISCARD') return;
  const p = g.activePlayer;
  const res = ['funds', 'clout', 'media', 'trust'];
  const d = { funds: 0, clout: 0, media: 0, trust: 0 };
  let left = g.discardRequired;
  for (const r of res.slice().sort((a, b) => p.resources[b] - p.resources[a])) {
    const take = Math.min(left, p.resources[r]);
    d[r] = take;
    left -= take;
    if (left === 0) break;
  }
  g.discardResources(p.id, d);
}

// Give a player a specific conspiracy card by id (test setup).
function grant(g, player, cardId) {
  const card = JSON.parse(JSON.stringify(require('../data/conspiracy-cards.json').find((c) => c.id === cardId)));
  player.conspiracies.push(card);
  return card;
}

// ---------- buying (DD-21: price 4/5, any-mix payment, no hand cap) ----------
function testBuy() {
  const g = gameInAction();
  const p = g.activePlayer;
  const price = g.conspiracyDeck[g.conspiracyDeck.length - 1].price;
  assert(price === 4 || price === 5, 'top conspiracy carries a 4 or 5 price');
  assert(g.serialize(p.id).conspiracyPrice === price, 'price surfaced in serialize');

  p.resources = { funds: 0, clout: 0, media: 0, trust: 0 };
  expectThrow(() => g.buyConspiracy(p.id, { funds: price }), 'cannot pay what you do not hold');

  // The payment must sum to exactly the price.
  p.resources = { funds: 10, clout: 10, media: 10, trust: 10 };
  expectThrow(() => g.buyConspiracy(p.id, { funds: price - 1 }), 'under-payment rejected');
  expectThrow(() => g.buyConspiracy(p.id, { funds: price + 1 }), 'over-payment rejected');

  // A mixed payment summing exactly to the price works.
  const before = g.conspiracyDeck.length;
  g.buyConspiracy(p.id, { funds: price - 1, clout: 1 });
  assert(p.resources.funds === 10 - (price - 1) && p.resources.clout === 9, 'paid the exact mix');
  assert(p.conspiracies.length === 1, 'card in hand');
  assert(g.conspiracyDeck.length === before - 1, 'drawn from deck');

  // No hand cap any more: keep buying past the old limit of three.
  for (let i = 0; i < 3; i++) {
    p.resources = { funds: 10, clout: 10, media: 10, trust: 10 };
    g.buyConspiracy(p.id, { funds: g.conspiracyDeck[g.conspiracyDeck.length - 1].price });
  }
  assert(p.conspiracies.length === 4, 'hand grows past the old cap of 3');

  // Not the active player
  const other = g.players.find((x) => x.id !== p.id);
  other.resources = { funds: 10, clout: 0, media: 0, trust: 0 };
  expectThrow(() => g.buyConspiracy(other.id, { funds: 4 }), 'only active player buys');
  console.log('  ✔ conspiracy buying');
}

// ---------- hidden hands ----------
function testHiddenHands() {
  const g = gameInAction();
  const p = g.activePlayer;
  const other = g.players.find((x) => x.id !== p.id);
  grant(g, p, 'c_warchest');
  grant(g, other, 'c_kompromat');

  const asP = g.serialize(p.id);
  const asOther = g.serialize(other.id);
  assert(asP.yourConspiracies.length === 1 && asP.yourConspiracies[0].id === 'c_warchest', 'viewer sees own hand');
  // The other player's payload must not contain P's card ids anywhere.
  assert(!JSON.stringify(asOther).includes('c_warchest'), 'opponent hand not leaked to others');
  const pInOther = asOther.players.find((x) => x.id === p.id);
  assert(pInOther.conspiracyCount === 1 && pInOther.conspiracies === undefined, 'only counts are public');
  console.log('  ✔ hidden hands');
}

// ---------- self / deck effects ----------
function testSelfEffects() {
  const g = gameInAction(2);
  const p = g.activePlayer;
  grant(g, p, 'c_warchest');
  g.playConspiracy(p.id, 'c_warchest');
  assert(p.resources.funds >= 3, 'War Chest granted funds');
  assert(p.conspiracies.length === 0, 'played card left hand');

  grant(g, p, 'c_exitpoll');
  g.playConspiracy(p.id, 'c_exitpoll');
  const asP = g.serialize(p.id);
  assert(asP.yourPeek && asP.yourPeek.kind === 'voter', 'peek recorded for viewer');
  assert(!JSON.stringify(g.serialize(g.players.find((x) => x.id !== p.id).id)).includes(asP.yourPeek.card ? asP.yourPeek.card.id : '__none__') || asP.yourPeek.card === null, 'peek private');

  grant(g, p, 'c_rigrolls');
  const oldCard = g.hq[0];
  g.playConspiracy(p.id, 'c_rigrolls', { hqIndex: 0 });
  assert(g.hq[0] !== oldCard, 'HQ card cycled');

  // Double Agent draws its full 2 — there is no hand cap any more (DD-21).
  const g2 = gameInAction(3);
  const p2 = g2.activePlayer;
  grant(g2, p2, 'c_doubleagent');
  g2.playConspiracy(p2.id, 'c_doubleagent');
  assert(p2.conspiracies.length === 2, 'Double Agent draws its full 2');
  console.log('  ✔ self/deck effects');
}

// ---------- targeted effects ----------
function testTargeted() {
  const g = gameInAction(4);
  const p = g.activePlayer;
  const o = g.players.find((x) => x.id !== p.id);
  o.resources = { funds: 5, clout: 2, media: 0, trust: 0 };

  // steal (playerRes) needs a resource choice
  grant(g, p, 'c_kompromat');
  expectThrow(() => g.playConspiracy(p.id, 'c_kompromat', { playerId: o.id }), 'steal needs a resource');
  expectThrow(() => g.playConspiracy(p.id, 'c_kompromat', { playerId: p.id, res: 'funds' }), 'cannot target self');
  g.playConspiracy(p.id, 'c_kompromat', { playerId: o.id, res: 'funds' });
  assert(o.resources.funds === 3 && p.resources.funds >= 2, 'stole 2 funds');

  // burn (player) hits highest
  grant(g, p, 'c_slushraid');
  o.resources = { funds: 1, clout: 6, media: 0, trust: 0 };
  g.playConspiracy(p.id, 'c_slushraid', { playerId: o.id });
  assert(o.resources.clout === 3, 'burned 3 of highest (clout)');

  // removePeg — must be opponent, non-majority, non-volatile
  const z = g.getZone('C');
  plant(g, z, o.id, 3);
  const slot = z.slots.findIndex((s) => s === o.id);
  grant(g, p, 'c_boothcap');
  expectThrow(() => g.playConspiracy(p.id, 'c_boothcap', { zoneId: 'C', slotIndex: z.volatileIndex }), 'volatile protected');
  g.playConspiracy(p.id, 'c_boothcap', { zoneId: 'C', slotIndex: slot });
  assert(g.pegCount(z, o.id) === 2, 'removed one opponent peg');

  // convertPeg
  grant(g, p, 'c_defection');
  const slot2 = z.slots.findIndex((s) => s === o.id);
  g.playConspiracy(p.id, 'c_defection', { zoneId: 'C', slotIndex: slot2 });
  assert(g.pegCount(z, p.id) === 1 && g.pegCount(z, o.id) === 1, 'converted a peg');

  // blockZone prevents gerrymander of that zone
  const g2 = gameInAction(5);
  const me = g2.activePlayer;
  const nw = g2.getZone('NW');
  plant(g2, nw, me.id, 6);
  g2.checkMajority(nw);
  grant(g2, me, 'c_codefreeze');
  g2.playConspiracy(me.id, 'c_codefreeze', { zoneId: 'N' });
  assert(g2.isZoneBlocked('N'), 'zone N blocked');
  const opp = g2.players.find((x) => x.id !== me.id);
  const n = g2.getZone('N');
  plant(g2, n, opp.id, 2);
  g2.endTurn(me.id);
  const oppSlot = n.slots.findIndex((s) => s === opp.id);
  expectThrow(() => g2.gerrymander(me.id, 'N', oppSlot, 'C'), 'cannot gerrymander a blocked zone');
  console.log('  ✔ targeted effects');
}

// ---------- reactions ----------
function testReactions() {
  const g = gameInAction(6);
  const p = g.activePlayer;
  const o = g.players.find((x) => x.id !== p.id);
  o.resources = { funds: 5, clout: 0, media: 0, trust: 0 };
  grant(g, p, 'c_kompromat');
  grant(g, o, 'c_leak');

  // Playing an offensive card opens a reaction window (victim holds a reaction).
  const res = g.playConspiracy(p.id, 'c_kompromat', { playerId: o.id, res: 'funds' });
  assert(res.pendingReaction === true, 'reaction window opened');
  assert(g.phase === 'REACTION', 'phase is REACTION');
  assert(g.pendingReaction && g.pendingReaction.victimId === o.id, 'pendingReaction descriptor');

  // Only the victim may respond
  expectThrow(() => g.respondReaction(p.id, null), 'caster cannot respond');
  expectThrow(() => g.respondReaction(o.id, 'c_warchest'), 'must be a reaction card held');

  // Cancel: effect fizzles, both cards discarded, phase restored
  g.respondReaction(o.id, 'c_leak');
  assert(g.phase === 'ACTION', 'phase restored after reaction');
  assert(o.resources.funds === 5, 'steal cancelled — no funds lost');
  assert(p.conspiracies.length === 0 && o.conspiracies.length === 0, 'both cards discarded');

  // Pass path: victim declines to react → effect resolves
  const g2 = gameInAction(7);
  const p2 = g2.activePlayer;
  const o2 = g2.players.find((x) => x.id !== p2.id);
  o2.resources = { funds: 5, clout: 0, media: 0, trust: 0 };
  grant(g2, p2, 'c_kompromat');
  grant(g2, o2, 'c_leak');
  g2.playConspiracy(p2.id, 'c_kompromat', { playerId: o2.id, res: 'funds' });
  g2.respondReaction(o2.id, null);
  assert(g2.phase === 'ACTION' && o2.resources.funds === 3, 'pass → steal resolves');
  assert(o2.conspiracies.length === 1, 'reaction card retained on pass');

  // No reaction window if victim holds no reaction card
  const g3 = gameInAction(8);
  const p3 = g3.activePlayer;
  const o3 = g3.players.find((x) => x.id !== p3.id);
  o3.resources = { funds: 5, clout: 0, media: 0, trust: 0 };
  grant(g3, p3, 'c_kompromat');
  const r = g3.playConspiracy(p3.id, 'c_kompromat', { playerId: o3.id, res: 'funds' });
  assert(r.pendingReaction === false && g3.phase === 'ACTION', 'no window without a reaction card');

  // While a reaction is pending, other actions are blocked
  const g4 = gameInAction(9);
  const p4 = g4.activePlayer;
  const o4 = g4.players.find((x) => x.id !== p4.id);
  o4.resources.funds = 5;
  grant(g4, p4, 'c_kompromat');
  grant(g4, o4, 'c_counterintel');
  g4.playConspiracy(p4.id, 'c_kompromat', { playerId: o4.id, res: 'funds' });
  expectThrow(() => g4.endTurn(p4.id), 'cannot end turn mid-reaction');
  expectThrow(() => g4.buyVoterCard(p4.id, 0, 'C'), 'cannot buy mid-reaction');
  console.log('  ✔ reactions');
}

// ---------- tradable ----------
function testTradableCards() {
  const g = gameInAction(10);
  const active = g.activePlayer;
  const other = g.players.find((x) => x.id !== active.id);
  active.resources = { funds: 2, clout: 0, media: 0, trust: 0 };
  other.resources = { funds: 0, clout: 2, media: 0, trust: 0 };
  grant(g, active, 'c_warchest');

  // Card-for-resource: active gives a card, wants clout
  const offer = g.proposeTrade(active.id, other.id, {}, { clout: 1 }, ['c_warchest'], []);
  assert(offer.giveCards.length === 1, 'card recorded in offer');
  g.respondTrade(other.id, offer.id, true);
  assert(other.conspiracies.some((c) => c.id === 'c_warchest'), 'card moved to other');
  assert(active.conspiracies.length === 0 && active.resources.clout === 1, 'active got clout, lost card');

  // Empty-both-sides rejected
  expectThrow(() => g.proposeTrade(active.id, other.id, {}, {}, [], []), 'cannot gift nothing');

  // Trades need not be equitable: card + resource for clout, uneven counts are fine.
  const g2 = gameInAction(11);
  const a2 = g2.activePlayer;
  const b2 = g2.players.find((x) => x.id !== a2.id);
  a2.resources = { funds: 1, clout: 0, media: 0, trust: 0 };
  b2.resources = { funds: 0, clout: 2, media: 0, trust: 0 };
  grant(g2, a2, 'c_warchest');
  const o2 = g2.proposeTrade(a2.id, b2.id, { funds: 1 }, { clout: 2 }, ['c_warchest'], []);
  g2.respondTrade(b2.id, o2.id, true);
  assert(a2.resources.clout === 2 && b2.conspiracies.length === 1, 'card counts as one item');
  console.log('  ✔ tradable conspiracies');
}

// ---------- auctions + IOU ----------
function testAuctions() {
  // Full auction: 3 players, contested, winner pays in full and places.
  const g = gameInAction(20, 3);
  const [p1, p2, p3] = g.players;
  p1.resources = { funds: 4, clout: 0, media: 0, trust: 0 };
  p2.resources = { funds: 6, clout: 0, media: 0, trust: 0 };
  p3.resources = { funds: 2, clout: 0, media: 0, trust: 0 };
  g.startAuction({ card: { id: 'auc1', voters: 5, auctioned: true }, triggeredBy: p1.id });
  assert(g.phase === 'AUCTION', 'auction started');
  expectThrow(() => g.placeBid(p1.id, 0), 'bid must beat 0');
  g.placeBid(p1.id, 3);
  expectThrow(() => g.passBid(p1.id), 'high bidder cannot pass');
  g.placeBid(p2.id, 5);
  expectThrow(() => g.placeBid(p3.id, 13), 'bid capped at 12');
  g.passBid(p1.id);
  g.passBid(p3.id);
  // p2 wins for 5, pays fully, must place.
  assert(g.phase === 'AUCTION_PLACE', 'winner must place');
  assert(p2.resources.funds === 1 && !p2.iou, 'winner paid 5, no IOU');
  expectThrow(() => g.placeAuctionWin(p1.id, 'C'), 'only winner places');
  const before = g.pegCount(g.getZone('C'), p2.id);
  g.placeAuctionWin(p2.id, 'C');
  assert(g.pegCount(g.getZone('C'), p2.id) === before + 5, 'won voters seated');
  assert(g.phase === 'POLICY', 'turn resolves after auction');

  // Over-bid → IOU, then debt lockout, then auto-repay.
  const g2 = gameInAction(21, 2);
  const [a, b] = g2.players;
  a.resources = { funds: 2, clout: 0, media: 0, trust: 0 };
  b.resources = { funds: 0, clout: 0, media: 0, trust: 0 };
  g2.startAuction({ card: { id: 'auc2', voters: 3, auctioned: true }, triggeredBy: a.id });
  g2.placeBid(a.id, 5);
  g2.passBid(b.id);
  // a wins for 5, holds 2 → pays 2, owes 3.
  assert(a.iou && a.iou.debt === 3, 'IOU issued for shortfall');
  assert(g2.debtLocked(a), 'debtor is locked');
  // Place the won voters (placing is not a spend), then the turn tries to advance.
  g2.placeAuctionWin(a.id, 'C');
  // Debt lockout: a cannot spend on their next turn.
  // Advance to a's turn (it is now b's turn or a's? turn advanced from a).
  // Give a resources and confirm auto-repay via answerPolicy.
  while (g2.activePlayer.id !== a.id && g2.phase !== 'GAME_OVER') {
    // b plays a trivial turn
    if (g2.phase === 'POLICY') g2.answerPolicy(g2.activePlayer.id, 'a');
    if (g2.phase === 'ACTION') g2.endTurn(g2.activePlayer.id);
    if (g2.phase === 'GERRYMANDER') g2.skipGerrymander(g2.activePlayer.id);
    if (g2.phase === 'DISCARD') {
      const d = { funds: 0, clout: 0, media: 0, trust: 0 };
      d.funds = g2.discardRequired;
      g2.discardResources(g2.activePlayer.id, d);
    }
  }
  if (g2.phase !== 'GAME_OVER') {
    // a answers a policy → reward auto-repays the IOU.
    const debtBefore = a.iou ? a.iou.debt : 0;
    g2.answerPolicy(a.id, 'a');
    const debtAfter = a.iou ? a.iou.debt : 0;
    assert(debtAfter < debtBefore || debtAfter === 0, 'income auto-repays the IOU');
    // While still (or if) locked, cannot buy.
    if (g2.debtLocked(a)) {
      expectThrow(() => g2.buyConspiracy(a.id, { funds: 4 }), 'debtor cannot buy conspiracies');
    }
  }

  // No-bid auction dissolves and the turn still completes.
  const g3 = gameInAction(22, 2);
  g3.startAuction({ card: { id: 'auc3', voters: 4, auctioned: true }, triggeredBy: g3.players[0].id });
  g3.passBid(g3.players[0].id);
  g3.passBid(g3.players[1].id);
  assert(g3.auction === null && (g3.phase === 'POLICY' || g3.phase === 'DISCARD'), 'no-bid auction dissolves');

  // Integration: an auction queued during finishTurn runs, then the turn completes.
  const g4 = gameInAction(23, 2);
  const active = g4.activePlayer;
  g4.pendingAuctions.push({ card: { id: 'auc4', voters: 3, auctioned: true }, triggeredBy: active.id });
  g4.endTurn(active.id); // no majority → finishTurn → auction
  assert(g4.phase === 'AUCTION', 'finishTurn enters queued auction');
  // Everyone passes with no bid → the bloc dissolves and the turn continues.
  g4.players.forEach((p) => g4.passBid(p.id));
  assert(g4.phase !== 'AUCTION', 'auction resolves and turn continues');
  console.log('  ✔ auctions + IOU');
}

// ---------- between-turn conspiracies (DD-21) ----------
function testPolicyWindow() {
  const g = gameInPolicy(60);
  const active = g.activePlayer;
  const other = g.players.find((x) => x.id !== active.id);
  active.resources = { funds: 5, clout: 0, media: 0, trust: 0 };
  other.resources = { funds: 0, clout: 0, media: 0, trust: 0 };
  grant(g, other, 'c_kompromat');

  // A non-active player may strike in the POLICY window, targeting the active player.
  g.playConspiracy(other.id, 'c_kompromat', { playerId: active.id, res: 'funds' });
  assert(active.resources.funds === 3 && other.resources.funds === 2, 'steal resolved in the POLICY window');
  assert(g.phase === 'POLICY', 'phase unchanged — the answer is still owed');
  assert(g.activePlayer.id === active.id, 'active player unchanged');

  // Targets still validate for a non-active caster.
  grant(g, other, 'c_kompromat');
  expectThrow(
    () => g.playConspiracy(other.id, 'c_kompromat', { playerId: other.id, res: 'funds' }),
    'non-active caster cannot target themselves'
  );

  // The active player's own window is ACTION/GERRYMANDER, not POLICY.
  grant(g, active, 'c_warchest');
  expectThrow(() => g.playConspiracy(active.id, 'c_warchest'), 'active player cannot play during POLICY');
  g.answerPolicy(active.id, 'a');
  clearDiscard(g);
  g.playConspiracy(active.id, 'c_warchest'); // legal now
  assert(!active.conspiracies.some((c) => c.id === 'c_warchest'), 'active player plays in ACTION');

  // A non-active player may NOT play during someone else's ACTION.
  grant(g, other, 'c_warchest');
  expectThrow(() => g.playConspiracy(other.id, 'c_warchest'), 'non-active cannot play during ACTION');

  // The per-viewer permission flag mirrors the rule.
  assert(g.serialize(active.id).youMayPlayConspiracy === true, 'active viewer may play in ACTION');
  assert(g.serialize(other.id).youMayPlayConspiracy === false, 'non-active viewer may not play in ACTION');
  const gp = gameInPolicy(62);
  const bystander = gp.players.find((x) => x.id !== gp.activePlayer.id);
  assert(gp.serialize(bystander.id).youMayPlayConspiracy === true, 'non-active viewer may play in POLICY');
  assert(gp.serialize(gp.activePlayer.id).youMayPlayConspiracy === false, 'active viewer may not play in POLICY');

  // A POLICY-window play against a reaction-holding victim resumes into POLICY.
  const g2 = gameInPolicy(61);
  const a2 = g2.activePlayer;
  const o2 = g2.players.find((x) => x.id !== a2.id);
  a2.resources = { funds: 5, clout: 0, media: 0, trust: 0 };
  grant(g2, o2, 'c_kompromat');
  grant(g2, a2, 'c_leak');
  const r = g2.playConspiracy(o2.id, 'c_kompromat', { playerId: a2.id, res: 'funds' });
  assert(r.pendingReaction === true && g2.phase === 'REACTION', 'victim gets a reaction window');
  assert(g2.pendingReaction.victimId === a2.id, 'the active player is the victim');
  expectThrow(() => g2.respondReaction(o2.id, null), 'only the victim responds');
  g2.respondReaction(a2.id, 'c_leak');
  assert(g2.phase === 'POLICY', 'phase resumes to POLICY after the reaction');
  assert(a2.resources.funds === 5, 'cancelled — nothing stolen');
  console.log('  ✔ between-turn conspiracies');
}

console.log('Running Phase 3 tests...');
testBuy();
testHiddenHands();
testSelfEffects();
testTargeted();
testReactions();
testTradableCards();
testAuctions();
testPolicyWindow();
console.log(`All Phase 3 tests passed (${passed} assertions).`);

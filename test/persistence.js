// Persistence test: a game snapshotted mid-play restores to an identical, playable state.
const { SystemGame, RESOURCES } = require('../server/game');

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  passed++;
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

console.log('Running persistence tests...');

// Play a few turns, snapshot, restore, and confirm state + behaviour match.
const g = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seededRng(1));
for (const p of g.players) while (p.startingPicksRemaining > 0) g.pickStartingResource(p.id, 'funds');
for (let t = 0; t < 6 && g.phase !== 'GAME_OVER'; t++) {
  g.answerPolicy(g.activePlayer.id, t % 2 ? 'a' : 'b');
  const active = g.activePlayer;
  const i = g.hq.findIndex((c) => c && g.canAfford(active, c.cost));
  const zone = g.zones.find((z) => g.emptyNormalIndices(z).length > 0);
  if (i >= 0 && zone) g.buyVoterCard(active.id, i, zone.id);
  g.endTurn(active.id);
  if (g.phase === 'GERRYMANDER') g.skipGerrymander(active.id);
  if (g.phase === 'AUCTION') g.players.forEach((p) => { if (g.phase === 'AUCTION') g.passBid(p.id); });
  if (g.phase === 'DISCARD') {
    const d = { funds: 0, clout: 0, media: 0, trust: 0 };
    d.funds = Math.min(g.discardRequired, g.activePlayer.resources.funds);
    let left = g.discardRequired - d.funds;
    for (const r of RESOURCES) { if (left <= 0) break; const take = Math.min(left, g.activePlayer.resources[r]); d[r] = (d[r] || 0) + take; left -= take; }
    g.discardResources(g.activePlayer.id, d);
  }
}

// Give someone a conspiracy + an IOU so those fields are exercised by the round-trip.
g.players[0].conspiracies.push({ id: 'c_warchest', title: 'War Chest', target: 'none', effect: { type: 'gain', resources: { funds: 3 } } });
g.players[1].iou = { debt: 2 };

const before = JSON.stringify(g.serialize('a'));
const snap = g.snapshot();
const restored = SystemGame.restore(snap);
const after = JSON.stringify(restored.serialize('a'));
assert(before === after, 'restored serialize() matches the original exactly');
assert(restored instanceof SystemGame, 'restored object is a real SystemGame');
assert(typeof restored.answerPolicy === 'function', 'restored object has engine methods');
assert(restored.players[0].conspiracies.length === 1, 'hidden hand survives the round-trip');
assert(restored.players[1].iou.debt === 2, 'IOU survives the round-trip');

// The restored game must keep playing from where it left off.
const activeId = restored.activePlayer.id;
if (restored.phase === 'POLICY') {
  restored.answerPolicy(activeId, 'a');
  assert(restored.phase === 'ACTION', 'restored game continues into ACTION');
}

// Snapshot during an AUCTION (Set field) round-trips too.
const g2 = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(5));
for (const p of g2.players) while (p.startingPicksRemaining > 0) g2.pickStartingResource(p.id, 'funds');
g2.answerPolicy(g2.activePlayer.id, 'a');
g2.startAuction({ card: { id: 'aucP', voters: 5, auctioned: true }, triggeredBy: g2.players[0].id });
g2.placeBid(g2.players[0].id, 3);
const r2 = SystemGame.restore(g2.snapshot());
assert(r2.phase === 'AUCTION' && r2.auction.bid === 3, 'auction snapshot restores');
assert(r2.auction.passed instanceof Set, 'auction.passed rehydrates to a Set');
r2.passBid(r2.players[1].id); // resolves the auction on the restored game
assert(r2.phase === 'AUCTION_PLACE', 'restored auction resolves correctly');

console.log(`All persistence tests passed (${passed} assertions).`);

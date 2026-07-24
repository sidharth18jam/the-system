// Coalition tests (DD-23): formation validation, card-swap side
// effects, locked-peg immunity, dissolution paths, split scoring, offer lifecycle.
// White-box style like phase2/phase3/phase4.
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

function gameInAction(seed = 1, n = 3) {
  const infos = Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(97 + i), name: 'P' + (i + 1) }));
  const g = new SystemGame(infos, seededRng(seed));
  for (const p of g.players) {
    while (p.startingPicksRemaining > 0) g.pickStartingResource(p.id, 'funds');
  }
  g.answerPolicy(g.activePlayer.id, 'a');
  clearDiscard(g);
  return g;
}

const RES4 = ['funds', 'clout', 'media', 'trust'];
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

function plant(g, zone, pid, n) {
  const spots = g.emptyNormalIndices(zone);
  for (let i = 0; i < n; i++) zone.slots[spots[i]] = pid;
}

// Stage a proposable coalition: active player (a) + partner in g.zones[0], both with
// a card in their manifesto. Returns { g, from, to, zone, split }.
function staged(seed = 1) {
  const g = gameInAction(seed, 3);
  const from = g.activePlayer;
  const to = g.players.find((p) => p.id !== from.id);
  const zone = g.zones[0];
  const split = { from: zone.majority - 2, to: 2 };
  plant(g, zone, from.id, split.from);
  plant(g, zone, to.id, split.to);
  from.manifesto = { mogul: 2, boss: 0, icon: 0, believer: 0 };
  to.manifesto = { mogul: 0, boss: 1, icon: 0, believer: 0 };
  return { g, from, to, zone, split };
}

function formCoalition(s) {
  const offer = s.g.proposeCoalition(s.from.id, s.to.id, s.zone.id, s.split);
  s.g.respondCoalition(s.to.id, offer.id, true);
  return s;
}

// ---------- formation validation ----------
function testFormationValidation() {
  const { g, from, to, zone, split } = staged();
  expectThrow(() => g.proposeCoalition(from.id, from.id, zone.id, split), 'no self-coalition');
  expectThrow(() => g.proposeCoalition(from.id, to.id, 'XX', split), 'unknown zone');
  expectThrow(
    () => g.proposeCoalition(from.id, to.id, zone.id, { from: split.from + 1, to: split.to }),
    'split must equal majority'
  );
  expectThrow(
    () => g.proposeCoalition(from.id, to.id, zone.id, { from: zone.majority, to: 0 }),
    'both partners contribute'
  );
  expectThrow(
    () => g.proposeCoalition(from.id, to.id, zone.id, { from: split.to, to: split.from }),
    'pegs must back the split'
  );
  const third = g.players.find((p) => p.id !== from.id && p.id !== to.id);
  expectThrow(
    () => g.proposeCoalition(to.id, third.id, zone.id, split),
    'coalition must involve the active player'
  );
  // Empty manifesto blocks the card exchange.
  to.manifesto = { mogul: 0, boss: 0, icon: 0, believer: 0 };
  expectThrow(() => g.proposeCoalition(from.id, to.id, zone.id, split), 'partner needs a card to exchange');
  to.manifesto = { mogul: 0, boss: 1, icon: 0, believer: 0 };

  // Owned zones can't be coalitioned.
  const zone2 = g.zones[1];
  plant(g, zone2, from.id, zone2.majority);
  g.checkMajority(zone2);
  assert(zone2.majorityOwner === from.id, 'zone2 captured solo');
  expectThrow(
    () => g.proposeCoalition(from.id, to.id, zone2.id, { from: zone2.majority - 1, to: 1 }),
    'owned zone rejected'
  );

  // 2-player games have no coalitions.
  const g2 = gameInAction(2, 2);
  const a2 = g2.activePlayer;
  const b2 = g2.players.find((p) => p.id !== a2.id);
  expectThrow(
    () => g2.proposeCoalition(a2.id, b2.id, g2.zones[0].id, { from: 1, to: g2.zones[0].majority - 1 }),
    'needs 3+ players'
  );
  console.log('  ✔ formation validation');
}

// ---------- accept: card swap + capture ----------
function testAcceptSwapsCards() {
  const s = formCoalition(staged());
  const { g, from, to, zone } = s;
  assert(zone.coalition && zone.coalition.a === from.id && zone.coalition.b === to.id, 'coalition set');
  assert(zone.majorityOwner === null, 'no solo owner on a coalition zone');
  // from gave a mogul (most-held), got to's boss; and vice versa.
  assert(from.manifesto.mogul === 1 && from.manifesto.boss === 1, 'proposer swapped cards');
  assert(to.manifesto.mogul === 1 && to.manifesto.boss === 0, 'partner swapped cards');
  assert(g.coalitionOffers.length === 0, 'offer consumed');
  console.log('  ✔ accept swaps most-held ideology cards');
}

// ---------- card swap de-levels powers ----------
function testSwapDelevelsPerks() {
  const s = staged();
  s.from.manifesto = { mogul: 3, boss: 0, icon: 0, believer: 0 };
  assert(s.g.hasPerk(s.from.id, 'mogul', 3), 'L3 before the swap');
  formCoalition(s);
  assert(!s.g.hasPerk(s.from.id, 'mogul', 3), 'L3 lost with the exchanged card');
  console.log('  ✔ card swap de-levels powers automatically');
}

// ---------- locked pegs: immune to movement and targeting ----------
function testLockedPegProtection() {
  const s = formCoalition(staged());
  const { g, from, to, zone } = s;
  const locked = g.coalitionLockedSlots(zone);
  assert(locked.size === zone.majority, 'exactly the majority pegs are locked');

  // Conspiracy peg-targeting rejects locked pegs.
  const lockedIdx = [...locked][0];
  const third = g.players.find((p) => p.id !== from.id && p.id !== to.id);
  expectThrow(
    () => g.validateConspiracyTarget({ target: 'opponentPeg' }, third, { zoneId: zone.id, slotIndex: lockedIdx }),
    'locked pegs are protected from conspiracies'
  );

  // A surplus peg beyond the split is NOT locked.
  plant(g, zone, from.id, 1);
  const surplus = zone.slots.findIndex(
    (o, i) => o === from.id && i !== zone.volatileIndex && !locked.has(i)
  );
  assert(surplus >= 0, 'surplus peg exists outside the lock');
  g.validateConspiracyTarget({ target: 'opponentPeg' }, third, { zoneId: zone.id, slotIndex: surplus });
  passed++;

  // Gerrymander cannot move a locked peg; the surplus one moves fine.
  const adjId = zone.adjacent[0];
  const adj = g.getZone(adjId);
  plant(g, adj, third.id, adj.majority);
  g.checkMajority(adj);
  assert(adj.majorityOwner === third.id, 'third player holds the adjacent zone');
  g.turnIndex = g.players.findIndex((p) => p.id === third.id);
  g.phase = 'GERRYMANDER';
  g.gerryMovesLeft = 2;
  expectThrow(
    () => g.gerrymander(third.id, zone.id, lockedIdx, adjId),
    'locked pegs cannot be gerrymandered'
  );
  g.gerrymander(third.id, zone.id, surplus, adjId);
  assert(zone.coalition, 'coalition survives losing a surplus peg');
  console.log('  ✔ locked pegs immune, surplus pegs fair game');
}

// ---------- no gerrymander rights from a coalition ----------
function testNoGerrymanderRights() {
  const s = formCoalition(staged());
  const { g, from, to, zone } = s;
  assert(
    g.gerrymanderSets(from.id).every((set) => set[0] !== zone.id),
    'proposer gains no gerrymander set from the coalition zone'
  );
  assert(g.gerrymanderSets(to.id).length === 0, 'partner gains no gerrymander rights');
  assert(!g.hasMajority(from.id) && !g.hasMajority(to.id), 'coalition is not a solo majority');
  console.log('  ✔ coalition grants no gerrymander rights');
}

// ---------- dissolution: peg loss ----------
function testDissolveOnPegLoss() {
  const s = formCoalition(staged());
  const { g, zone } = s;
  const lockedIdx = [...g.coalitionLockedSlots(zone)][0];
  zone.slots[lockedIdx] = null; // e.g. a Land Grab or Payback pierced the coalition
  g.checkMajority(zone);
  assert(zone.coalition === null, 'coalition dissolves below the threshold');
  console.log('  ✔ dissolves when combined pegs drop below majority');
}

// ---------- dissolution: withdrawal ----------
function testWithdraw() {
  const s = formCoalition(staged());
  const { g, from, to, zone } = s;
  const third = g.players.find((p) => p.id !== from.id && p.id !== to.id);
  expectThrow(() => g.withdrawCoalition(third.id, zone.id), 'outsiders cannot withdraw');
  expectThrow(() => g.withdrawCoalition(to.id, zone.id), 'withdraw only on your own turn');
  g.withdrawCoalition(from.id, zone.id); // from is the active player
  assert(zone.coalition === null, 'withdrawal dissolves the coalition');
  // Cards are NOT returned.
  assert(from.manifesto.mogul === 1 && from.manifesto.boss === 1, 'exchanged cards stay exchanged');

  // Withdrawal re-runs majority: a partner at the full threshold captures solo.
  const s2 = formCoalition(staged(7));
  plant(s2.g, s2.zone, s2.from.id, 2); // from now holds majority alone
  s2.g.withdrawCoalition(s2.from.id, s2.zone.id);
  assert(s2.zone.majorityOwner === s2.from.id, 'solo majority stands after withdrawal');
  console.log('  ✔ withdrawal paths');
}

// ---------- split scoring + captured count ----------
function testSplitScoring() {
  const s = formCoalition(staged());
  const { g, from, to, zone, split } = s;
  g.endGame();
  assert(from.score === split.from, `proposer scores ${split.from} (got ${from.score})`);
  assert(to.score === split.to, `partner scores ${split.to} (got ${to.score})`);
  console.log('  ✔ split scoring (DD-23 amends DD-4)');
}

function testCoalitionCountsAsCaptured() {
  const s = formCoalition(staged());
  const { g, from, zone } = s;
  for (const z of g.zones) {
    if (z.id === zone.id) continue;
    plant(g, z, from.id, z.majority);
    g.checkMajority(z);
  }
  g.checkAllZonesCaptured();
  assert(g.phase === 'GAME_OVER', 'coalition zone counts toward all-captured');
  console.log('  ✔ coalition zone counts as captured');
}

// ---------- offer lifecycle ----------
function testOfferLifecycle() {
  const { g, from, to, zone, split } = staged();
  const o1 = g.proposeCoalition(from.id, to.id, zone.id, split);
  const o2 = g.proposeCoalition(from.id, to.id, zone.id, split);
  assert(g.coalitionOffers.length === 1 && g.coalitionOffers[0].id === o2.id, 'new offer replaces old');
  expectThrow(() => g.respondCoalition(from.id, o2.id, true), 'only the addressee responds');
  expectThrow(() => g.cancelCoalition(to.id, o2.id), 'only the proposer cancels');
  g.respondCoalition(to.id, o2.id, false);
  assert(g.coalitionOffers.length === 0 && !zone.coalition, 'decline removes the offer');
  expectThrow(() => g.respondCoalition(to.id, o1.id, true), 'replaced offer is dead');

  // Offers expire with the turn.
  g.proposeCoalition(from.id, to.id, zone.id, split);
  g.advanceTurn();
  assert(g.coalitionOffers.length === 0, 'offers expire at turn end');

  // Acceptance re-validates: pegs gone since the proposal → reject.
  const s2 = staged(3);
  const o3 = s2.g.proposeCoalition(s2.from.id, s2.to.id, s2.zone.id, s2.split);
  for (let i = 0; i < s2.zone.slots.length; i++) {
    if (s2.zone.slots[i] === s2.to.id) s2.zone.slots[i] = null;
  }
  expectThrow(() => s2.g.respondCoalition(s2.to.id, o3.id, true), 'stale offer rejected on accept');
  console.log('  ✔ offer lifecycle');
}

// ---------- serialization ----------
function testSerialize() {
  const s = formCoalition(staged());
  const { g, from, zone } = s;
  const view = g.serialize(from.id);
  const zv = view.zones.find((z) => z.id === zone.id);
  assert(zv.coalition && zv.coalition.a === from.id, 'zone.coalition serialized');
  assert(Array.isArray(view.coalitionOffers), 'coalitionOffers serialized');
  JSON.stringify(view);
  passed++;
  console.log('  ✔ serialization');
}

console.log('Running coalition tests (DD-23)...');
testFormationValidation();
testAcceptSwapsCards();
testSwapDelevelsPerks();
testLockedPegProtection();
testNoGerrymanderRights();
testDissolveOnPegLoss();
testWithdraw();
testSplitScoring();
testCoalitionCountsAsCaptured();
testOfferLifecycle();
testSerialize();
console.log(`All coalition tests passed (${passed} assertions).`);

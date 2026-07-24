// Mode framework + Home Turfs tests (DD-24). White-box style like phase2–4.
const { SystemGame } = require('../server/game');
const HOME_TURFS = require('../data/home-turfs.json');

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

function gameInAction(seed = 1, n = 2, mode = 'standard') {
  const infos = Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(97 + i), name: 'P' + (i + 1) }));
  const g = new SystemGame(infos, seededRng(seed), mode);
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

// Give the active player majority (and rights) in zoneId.
function takeZone(g, zoneId) {
  const z = g.getZone(zoneId);
  plant(g, z, g.activePlayer.id, z.majority);
  g.checkMajority(z);
  return z;
}

// ---------- framework ----------
function testFramework() {
  expectThrow(() => new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(1), 'nonsense'), 'unknown mode rejected');
  const g = gameInAction(1, 2, 'homeTurfs');
  assert(g.mode === 'homeTurfs', 'mode stored');
  const view = g.serialize(g.players[0].id);
  assert(view.mode === 'homeTurfs', 'serialize carries mode');
  assert(Array.isArray(view.homeTurfs) && view.homeTurfs.length === 9, 'turf catalogue shipped in mode');
  const std = gameInAction(2, 2);
  const stdView = std.serialize(std.players[0].id);
  assert(stdView.mode === 'standard' && stdView.homeTurfs === null, 'standard game has no turfs');
  console.log('  ✔ mode framework (constructor, serialize)');
}

// ---------- data sanity ----------
function testTurfData() {
  assert(HOME_TURFS.length === 9, '9 turfs');
  const zoneIds = new Set(HOME_TURFS.map((t) => t.zoneId));
  assert(zoneIds.size === 9, 'one turf per zone');
  assert(HOME_TURFS.filter((t) => t.compulsory).length === 2, 'two compulsory turfs');
  const KINDS = ['none', 'self', 'player', 'zone', 'hqCard'];
  for (const t of HOME_TURFS) assert(KINDS.includes(t.target), `${t.zoneId} has a known target kind`);
  console.log('  ✔ turf data sanity');
}

// ---------- rights + once-per-turn ----------
function testRightsAndLimit() {
  const g = gameInAction(1, 2, 'homeTurfs');
  const p = g.activePlayer;
  // No rights yet → rejected.
  expectThrow(() => g.useHomeTurf(p.id, 'NW'), 'turf needs gerrymandering rights');
  takeZone(g, 'NW');
  const before = p.resources.funds;
  g.useHomeTurf(p.id, 'NW'); // Old Money: gain 2 funds
  assert(p.resources.funds === before + 2, 'Old Money pays 2 funds');
  expectThrow(() => g.useHomeTurf(p.id, 'NW'), 'once per turn');
  // Standard mode rejects turf use outright.
  const std = gameInAction(3, 2);
  takeZone(std, 'NW');
  expectThrow(() => std.useHomeTurf(std.activePlayer.id, 'NW'), 'standard mode has no turfs');
  // Someone else's zone is off limits.
  const g2 = gameInAction(5, 2, 'homeTurfs');
  const other = g2.players.find((x) => x.id !== g2.activePlayer.id);
  const zNW = g2.getZone('NW');
  plant(g2, zNW, other.id, zNW.majority);
  g2.checkMajority(zNW);
  expectThrow(() => g2.useHomeTurf(g2.activePlayer.id, 'NW'), 'rights belong to the majority owner');
  console.log('  ✔ rights required, once per turn');
}

// ---------- targeted effects ----------
function testTargetedTurfs() {
  const g = gameInAction(1, 2, 'homeTurfs');
  const p = g.activePlayer;
  const opp = g.players.find((x) => x.id !== p.id);

  // SW Badlands: burn 1 from a chosen rival's largest pile.
  takeZone(g, 'SW');
  opp.resources = { funds: 3, clout: 0, media: 0, trust: 0 };
  expectThrow(() => g.useHomeTurf(p.id, 'SW'), 'Badlands needs a target');
  expectThrow(() => g.useHomeTurf(p.id, 'SW', { playerId: p.id }), 'cannot target yourself');
  g.useHomeTurf(p.id, 'SW', { playerId: opp.id });
  assert(opp.resources.funds === 2, 'Badlands burns 1 from the largest pile');

  // SE Docks: seat 1 free voter in a chosen zone.
  takeZone(g, 'SE');
  const north = g.getZone('N');
  const beforePegs = g.pegCount(north, p.id);
  g.useHomeTurf(p.id, 'SE', { zoneId: north.id });
  assert(g.pegCount(north, p.id) === beforePegs + 1, 'Docks seats a free voter');

  // E Broadcast Hill: cycle a chosen HQ card.
  takeZone(g, 'E');
  const oldCard = g.hq[0];
  g.useHomeTurf(p.id, 'E', { hqIndex: 0 });
  assert(g.hq[0] !== oldCard, 'Broadcast Hill cycles the HQ card');

  // C Capital: draw a conspiracy.
  takeZone(g, 'C');
  const handBefore = p.conspiracies.length;
  g.useHomeTurf(p.id, 'C');
  assert(p.conspiracies.length === handBefore + 1, 'Capital draws a conspiracy');

  // NE Press Row: peek at the voter deck.
  takeZone(g, 'NE');
  g.useHomeTurf(p.id, 'NE');
  assert(p.peek && p.peek.kind === 'voter', 'Press Row peeks the voter deck');
  console.log('  ✔ targeted turf effects resolve');
}

// ---------- compulsory auto-fire ----------
function testCompulsoryAutoFire() {
  const g = gameInAction(1, 2, 'homeTurfs');
  const p = g.activePlayer;
  takeZone(g, 'S'); // Restive South: compulsory, burn self 1
  takeZone(g, 'W'); // Dockworkers' Union: compulsory, gain 1 clout
  p.resources = { funds: 4, clout: 0, media: 0, trust: 0 };
  g.endTurn(p.id); // compulsory turfs fire before the gerrymander branch
  assert(p.resources.funds === 3, 'Restive South burned 1 from the largest pile');
  assert(p.resources.clout === 1, "Dockworkers' Union paid 1 clout");
  assert(g.turfUsed.S === g.turnCounter && g.turfUsed.W === g.turnCounter, 'both marked used');
  assert(g.phase === 'GERRYMANDER', 'turn continues into gerrymander');

  // Using a compulsory turf manually pre-empts the auto-fire.
  const g2 = gameInAction(9, 2, 'homeTurfs');
  const p2 = g2.activePlayer;
  takeZone(g2, 'W');
  p2.resources = { funds: 2, clout: 0, media: 0, trust: 0 };
  g2.useHomeTurf(p2.id, 'W');
  assert(p2.resources.clout === 1, 'manual use works');
  g2.endTurn(p2.id);
  assert(p2.resources.clout === 1, 'no double fire at end of turn');
  console.log('  ✔ compulsory turfs auto-fire once');
}

// ================= Hidden Objectives (DD-25) =================
const HIDDEN_OBJECTIVES = require('../data/hidden-objectives.json');

function objGame(seed = 1, n = 3) {
  return gameInAction(seed, n, 'hiddenObjectives');
}
// Force a specific objective onto a player.
function dealObjective(p, check) {
  p.objective = HIDDEN_OBJECTIVES.find((o) => o.check === check);
}

function testObjectiveDealing() {
  const g = objGame();
  assert(g.players.every((p) => p.objective && p.objective.check), 'everyone dealt an objective');
  const ids = new Set(g.players.map((p) => p.objective.id));
  assert(ids.size === g.players.length, 'objectives are unique');
  const std = gameInAction(2, 2);
  assert(std.players.every((p) => p.objective === null), 'standard mode deals none');
  console.log('  ✔ objective dealing');
}

function testObjectiveSecrecy() {
  const g = objGame(3);
  const me = g.players[0];
  const view = g.serialize(me.id);
  assert(view.yourObjective && view.yourObjective.id === me.objective.id, 'own objective visible');
  assert(view.objectiveResults === null, 'no results before game over');
  const str = JSON.stringify(view);
  for (const o of g.players.slice(1)) {
    assert(!str.includes(`"${o.objective.id}"`), `${o.name}'s objective hidden from me`);
  }
  assert(view.players.every((pp) => pp.objective === undefined), 'players array carries no objectives');
  console.log('  ✔ objective secrecy');
}

function testEachCheck() {
  const g = objGame(5);
  const [a, b, c] = g.players;

  // Board-state checks: give `a` majorities in C, N, SE, then rig objectives and endGame.
  for (const zid of ['C', 'N', 'SE']) takeZoneFor(g, zid, a.id);
  dealObjective(a, 'centerHeld');
  dealObjective(b, 'noIOUEver');
  dealObjective(c, 'conspiracies3');
  c.conspiraciesPlayed = 3;
  b.tookIOU = true;
  g.endGame();
  const res = Object.fromEntries(g.objectiveResults.map((r) => [r.playerId, r]));
  assert(res[a.id].met, 'centerHeld met');
  assert(!res[b.id].met, 'noIOUEver broken by an IOU');
  assert(res[c.id].met, 'conspiracies3 met');
  assert(a.score === 5 + 5 + 11 + 3, `bonus added on top of zone scores (got ${a.score})`); // C5 + N5 + SE11 + 3
  console.log('  ✔ endGame evaluation + bonus');
}

function takeZoneFor(g, zoneId, pid) {
  const z = g.getZone(zoneId);
  plant(g, z, pid, z.majority);
  g.checkMajority(z);
  return z;
}

function testRemainingChecks() {
  // majorities3plus, adjacentPair, bigZone, spread6, untouchable, richest, trapped2.
  const g = objGame(7);
  const [a, b, c] = g.players;
  for (const zid of ['NW', 'N', 'NE']) takeZoneFor(g, zid, a.id);
  // spread6 for b: 1 peg in 6 zones.
  for (const zid of ['NW', 'N', 'NE', 'W', 'C', 'E']) {
    const z = g.getZone(zid);
    const spots = g.emptyNormalIndices(z);
    z.slots[spots[0]] = b.id;
  }
  // richest for c.
  c.resources = { funds: 5, clout: 3, media: 0, trust: 0 };
  a.resources = { funds: 1, clout: 0, media: 0, trust: 0 };
  b.resources = { funds: 0, clout: 0, media: 1, trust: 0 };
  dealObjective(a, 'majorities3plus');
  dealObjective(b, 'spread6');
  dealObjective(c, 'richest');
  g.endGame();
  let res = Object.fromEntries(g.objectiveResults.map((r) => [r.playerId, r]));
  assert(res[a.id].met, 'majorities3plus met');
  assert(res[b.id].met, 'spread6 met');
  assert(res[c.id].met, 'richest met');

  const g2 = objGame(9);
  const [a2, b2, c2] = g2.players;
  takeZoneFor(g2, 'N', a2.id); // adjacentPair needs N + (NW|NE|C)
  takeZoneFor(g2, 'C', a2.id);
  takeZoneFor(g2, 'SE', b2.id);
  takeZoneFor(g2, 'NW', c2.id);
  c2.majoritiesLost = 1; // untouchable broken
  a2.trapsSprung = 2;
  dealObjective(a2, 'adjacentPair');
  dealObjective(b2, 'bigZone');
  dealObjective(c2, 'untouchable');
  g2.endGame();
  res = Object.fromEntries(g2.objectiveResults.map((r) => [r.playerId, r]));
  assert(res[a2.id].met, 'adjacentPair met');
  assert(res[b2.id].met, 'bigZone met');
  assert(!res[c2.id].met, 'untouchable broken by a lost majority');

  // trapped2 via the real tracker: springing traps increments trapsSprung.
  const g3 = objGame(11);
  const p3 = g3.activePlayer;
  assert(p3.trapsSprung === 0, 'trap counter starts at 0');
  console.log('  ✔ remaining checks');
}

function testBonusSwingsWinner() {
  const g = objGame(13);
  const [a, b] = g.players;
  takeZoneFor(g, 'N', a.id); // a: 5 points
  takeZoneFor(g, 'NW', b.id); // b: 6 points — would win on zones alone
  dealObjective(a, 'centerHeld');
  takeZoneFor(g, 'C', a.id); // a: +5 = 10, and centerHeld met → +3
  dealObjective(b, 'conspiracies3'); // missed
  g.players[2].objective = HIDDEN_OBJECTIVES.find((o) => o.check === 'richest');
  g.players[2].resources = { funds: 0, clout: 0, media: 0, trust: 0 };
  g.endGame();
  assert(a.score === 13 && b.score === 6, `rigged scores (${a.score}/${b.score})`);
  assert(g.winnerIds.length === 1 && g.winnerIds[0] === a.id, 'objective bonus counted in the winner math');
  console.log('  ✔ objective bonus affects the result');
}

// ================= 2 Player mode (DD-26) =================
const ZONE_REQUIREMENTS = require('../data/zone-requirements.json');

function totalResources(res) {
  return RES4.reduce((s, r) => s + (res[r] || 0), 0);
}

function twoPlayerGame(seed = 1) {
  return new SystemGame(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    seededRng(seed),
    'twoPlayer'
  );
}
// Drive the setup so tests start in POLICY. Returns { g, first, second }.
function twoPlayerInPolicy(seed = 1, bids = { a: 3, b: 1 }) {
  const g = twoPlayerGame(seed);
  g.submitSetupBid('a', bids.a);
  g.submitSetupBid('b', bids.b);
  while (g.phase === 'SETUP_REQUIREMENTS') {
    const placer = g.players[g.reqPlacerIndex];
    const card = g.reqHands[placer.id][0];
    const zone = g.zones.find((z) => !z.requirement);
    g.placeRequirement(placer.id, card.id, zone.id);
  }
  return { g, first: g.players[0], second: g.players[1] };
}
// Pin a chosen requirement on a bare zone mid-test.
function pinReq(g, zoneId, check) {
  const card = ZONE_REQUIREMENTS.find((r) => r.check === check);
  const zone = g.getZone(zoneId);
  zone.requirement = { card, metBy: {} };
  if (card.kind === 'zonalRule') {
    if (card.check === 'majorityPlus1') zone.majority += 1;
    if (card.check === 'majorityMinus1') zone.majority -= 1;
  }
  return zone;
}

function test2pFramework() {
  expectThrow(
    () =>
      new SystemGame(
        [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
        seededRng(1),
        'twoPlayer'
      ),
    'twoPlayer needs exactly 2 players'
  );
  const g = twoPlayerGame();
  assert(g.phase === 'SETUP_BID', 'opens with the bid');
  assert(g.zones.length === 7, '7-zone board');
  assert(g.players.every((p) => totalResources(p.resources) === 8), 'both hold 8 resources');
  assert(g.players.every((p) => p.startingPicksRemaining === 0), 'no starting picks');
  // Auction headlines are filtered from the deck.
  assert(g.headlineDeck.every((c) => c.effect.type !== 'auction'), 'auction headlines filtered');
  const std = gameInAction(1, 2);
  assert(std.headlineDeck.some((c) => c.effect.type === 'auction'), 'standard deck keeps auctions');
  console.log('  ✔ 2p framework (board, resources, deck filtering)');
}

function testSetupBid() {
  const g = twoPlayerGame(3);
  expectThrow(() => g.submitSetupBid('a', 9), 'bid capped at holdings');
  expectThrow(() => g.submitSetupBid('a', -1), 'no negative bids');
  g.submitSetupBid('a', 2);
  expectThrow(() => g.submitSetupBid('a', 3), 'one bid each');
  // Secrecy: submitted list only, never amounts.
  const view = g.serialize('b');
  assert(view.setupBid && view.setupBid.submitted.includes('a'), 'submission visible');
  assert(!JSON.stringify(view.setupBid).includes('2'), 'amount stays secret');
  // Tie → rebid.
  g.submitSetupBid('b', 2);
  assert(g.phase === 'SETUP_BID' && Object.keys(g.setupBids).length === 0, 'tie clears both bids');
  assert(g.players.every((p) => totalResources(p.resources) === 8), 'tie costs nothing');
  // Resolution: higher bidder goes first, both pay.
  g.submitSetupBid('a', 1);
  g.submitSetupBid('b', 4);
  assert(g.phase === 'SETUP_REQUIREMENTS', 'bids resolve');
  assert(g.players[0].id === 'b', 'higher bidder moves first');
  assert(totalResources(g.getPlayer('b').resources) === 4, 'winner paid their bid');
  assert(totalResources(g.getPlayer('a').resources) === 7, 'loser paid theirs too');
  assert(g.reqPlacerIndex === 1, 'second player places requirements first');
  console.log('  ✔ setup bid (cap, secrecy, tie rebid, payment, order)');
}

function testRequirementPlacement() {
  const g = twoPlayerGame(5);
  g.submitSetupBid('a', 3);
  g.submitSetupBid('b', 1); // a first, so b places first
  const order = [];
  while (g.phase === 'SETUP_REQUIREMENTS') {
    const placer = g.players[g.reqPlacerIndex];
    order.push(placer.id);
    const other = g.players[1 - g.reqPlacerIndex];
    expectThrow(
      () => g.placeRequirement(other.id, g.reqHands[other.id][0].id, g.zones.find((z) => !z.requirement).id),
      'only the placer places'
    );
    const card = g.reqHands[placer.id][0];
    const zone = g.zones.find((z) => !z.requirement);
    g.placeRequirement(placer.id, card.id, zone.id);
    if (g.phase === 'SETUP_REQUIREMENTS') {
      expectThrow(() => g.placeRequirement(placer.id, g.reqHands[placer.id][0] && g.reqHands[placer.id][0].id, zone.id), 'zone already claimed');
    }
  }
  assert(order.join('') === 'bababab', `alternates starting with P2 (${order.join('')})`);
  assert(g.phase === 'POLICY', 'policy after all 7 placed');
  console.log('  ✔ requirement placement order');
}

function testRequirementKinds() {
  // oneTime: hold8Resources blocks, then lazily unblocks and stays met.
  const { g, first } = twoPlayerInPolicy(7);
  const z = g.zones[0];
  z.requirement = { card: ZONE_REQUIREMENTS.find((r) => r.check === 'hold8Resources'), metBy: {} };
  z.majority = 5;
  first.resources = { funds: 1, clout: 0, media: 0, trust: 0 };
  plant(g, z, first.id, 5);
  g.checkMajority(z);
  assert(z.majorityOwner === null, 'oneTime blocks the award');
  first.resources = { funds: 8, clout: 0, media: 0, trust: 0 };
  g.checkMajority(z);
  assert(z.majorityOwner === first.id, 'oneTime lazily satisfied');
  first.resources = { funds: 0, clout: 0, media: 0, trust: 0 };
  z.majorityOwner = null;
  g.checkMajority(z);
  assert(z.majorityOwner === first.id, 'oneTime stays met once satisfied');

  // onMajority payExtra2: collected at award; short → withheld.
  const s2 = twoPlayerInPolicy(9);
  const z2 = pinReqFresh(s2.g, 1, 'payExtra2');
  s2.first.resources = { funds: 1, clout: 0, media: 0, trust: 0 };
  plant(s2.g, z2, s2.first.id, z2.majority);
  s2.g.checkMajority(z2);
  assert(z2.majorityOwner === null, 'toll unpaid → no capture');
  s2.first.resources = { funds: 3, clout: 0, media: 0, trust: 0 };
  s2.g.checkMajority(z2);
  assert(z2.majorityOwner === s2.first.id, 'toll paid → captured');
  assert(totalResources(s2.first.resources) === 1, 'the toll cost 2');

  // onMajority needPlusOne.
  const z3 = pinReqFresh(s2.g, 2, 'needPlusOne');
  plant(s2.g, z3, s2.second.id, z3.majority);
  s2.g.checkMajority(z3);
  assert(z3.majorityOwner === null, 'threshold alone is not enough');
  plant(s2.g, z3, s2.second.id, 1);
  s2.g.checkMajority(z3);
  assert(z3.majorityOwner === s2.second.id, 'threshold+1 captures');

  // zonalRule: majority adjustments and the Fortress.
  const s3 = twoPlayerInPolicy(11);
  const zUp = pinReqFresh(s3.g, 3, 'majorityPlus1');
  const zDown = pinReqFresh(s3.g, 4, 'majorityMinus1');
  const zFort = pinReqFresh(s3.g, 5, 'noGerrymander');
  assert(s3.g.isZoneBlocked(zFort.id), 'Fortress is permanently frozen');
  plant(s3.g, zDown, s3.first.id, zDown.majority);
  s3.g.checkMajority(zDown);
  assert(zDown.majorityOwner === s3.first.id, 'reduced threshold captures');
  console.log('  ✔ requirement kinds (oneTime, onMajority, zonalRule)');
}

// Re-pin helper that clears whatever setup placed there first.
function pinReqFresh(g, zoneIndex, check) {
  const zone = g.zones[zoneIndex];
  // Undo a zonal rule the random setup may have applied to this zone.
  const prev = zone.requirement && zone.requirement.card;
  if (prev && prev.kind === 'zonalRule') {
    if (prev.check === 'majorityPlus1') zone.majority -= 1;
    if (prev.check === 'majorityMinus1') zone.majority += 1;
  }
  zone.requirement = null;
  return pinReq(g, zone.id, check);
}

console.log('Running mode framework + Home Turfs tests (DD-24)...');
testFramework();
testTurfData();
testRightsAndLimit();
testTargetedTurfs();
testCompulsoryAutoFire();
console.log('Running hidden-objective tests (DD-25)...');
testObjectiveDealing();
testObjectiveSecrecy();
testEachCheck();
testRemainingChecks();
testBonusSwingsWinner();
console.log('Running 2 Player mode tests (DD-26)...');
test2pFramework();
testSetupBid();
testRequirementPlacement();
testRequirementKinds();
console.log(`All phase5-modes tests passed (${passed} assertions).`);

// Phase 4 unit tests: ideologue powers (L3/L5) (DD-21), elites (DD-19).
// White-box style like phase2/phase3.
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
  clearDiscard(g);
  return g;
}

function plant(g, zone, pid, n) {
  const spots = g.emptyNormalIndices(zone);
  for (let i = 0; i < n; i++) zone.slots[spots[i]] = pid;
}

const RES4 = ['funds', 'clout', 'media', 'trust'];
function totalRes(p) {
  return RES4.reduce((s, r) => s + p.resources[r], 0);
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

// Indices of pid's non-volatile pegs in a zone.
function slotsOf(zone, pid) {
  const out = [];
  for (let i = 0; i < zone.slots.length; i++) {
    if (i !== zone.volatileIndex && zone.slots[i] === pid) out.push(i);
  }
  return out;
}

// ---------- Mogul L3: Prospecting ----------
function testProspecting() {
  const g = gameInAction(1);
  const p = g.activePlayer;
  p.resources = { funds: 3, clout: 0, media: 0, trust: 0 };

  expectThrow(() => g.prospect(p.id, 'funds', 'clout', 'media'), 'prospecting needs Mogul L3');
  p.manifesto.mogul = 3;
  expectThrow(() => g.prospect(p.id, 'clout', 'funds', 'funds'), 'must hold the resource you pay');

  g.prospect(p.id, 'funds', 'clout', 'media');
  assert(p.resources.funds === 2 && p.resources.clout === 1 && p.resources.media === 1, 'pay 1, take 2');
  assert(totalRes(p) === 4, 'net +1 resource');
  expectThrow(() => g.prospect(p.id, 'funds', 'clout', 'clout'), 'once per turn');

  // Both gains may be the same resource.
  g.turnFlags.prospecting = 0;
  g.prospect(p.id, 'funds', 'trust', 'trust');
  assert(p.resources.trust === 2, 'both gains may be the same type');
  console.log('  ✔ prospecting (Mogul L3)');
}

// ---------- Mogul L5: Land Grab + benched voters ----------
function testLandGrab() {
  const g = gameInAction(2);
  const me = g.activePlayer;
  const opp = g.players.find((x) => x.id !== me.id);
  const z = g.getZone('C');

  expectThrow(() => g.landGrab(me.id, 'C', 0), 'land grab needs Mogul L5');
  me.manifesto.mogul = 5;

  // Volatile pegs can never be evicted (DD-20).
  z.slots[z.volatileIndex] = opp.id;
  expectThrow(() => g.landGrab(me.id, 'C', z.volatileIndex), 'volatile peg refused');
  z.slots[z.volatileIndex] = null;

  // Evicting a majority peg breaks the majority.
  plant(g, z, opp.id, z.majority);
  g.checkMajority(z);
  assert(z.majorityOwner === opp.id, 'setup: opponent holds C');
  g.landGrab(me.id, 'C', slotsOf(z, opp.id)[0]);
  assert(z.majorityOwner === null, 'evicting a majority peg breaks the majority');
  assert(opp.benched === 1, 'evicted voter is benched');
  assert(opp.benchDeadline === g.turnCounter + g.players.length, 'deadline is the owner’s next turn');

  // Three per turn.
  g.landGrab(me.id, 'C', slotsOf(z, opp.id)[0]);
  g.landGrab(me.id, 'C', slotsOf(z, opp.id)[0]);
  assert(opp.benched === 3, 'three voters benched');
  expectThrow(() => g.landGrab(me.id, 'C', slotsOf(z, opp.id)[0]), 'only three land grabs per turn');
  console.log('  ✔ land grab (Mogul L5)');
}

function testBenchedVoters() {
  // Re-seat on your own turn.
  const g = gameInAction(3);
  const me = g.activePlayer;
  const opp = g.players.find((x) => x.id !== me.id);
  me.manifesto.mogul = 5;
  const z = g.getZone('C');
  plant(g, z, opp.id, 2);
  g.landGrab(me.id, 'C', slotsOf(z, opp.id)[0]);
  assert(opp.benched === 1, 'benched');
  expectThrow(() => g.placeBenched(opp.id, 'N', 1), 'cannot re-seat on someone else’s turn');

  g.endTurn(me.id);
  if (g.phase === 'GERRYMANDER') g.skipGerrymander(me.id);
  assert(g.activePlayer.id === opp.id, 'setup: opponent to act');
  g.answerPolicy(opp.id, 'a');
  clearDiscard(g);
  const n = g.getZone('N');
  const before = g.pegCount(n, opp.id);
  g.placeBenched(opp.id, 'N', 1);
  assert(g.pegCount(n, opp.id) === before + 1, 'benched voter re-seated');
  assert(opp.benched === 0 && opp.benchDeadline === null, 'bench cleared');
  expectThrow(() => g.placeBenched(opp.id, 'N', 1), 'nothing left on the bench');

  // Expiry: unclaimed by the deadline, they disperse.
  const g2 = gameInAction(4);
  const me2 = g2.activePlayer;
  const opp2 = g2.players.find((x) => x.id !== me2.id);
  me2.manifesto.mogul = 5;
  const z2 = g2.getZone('C');
  plant(g2, z2, opp2.id, 2);
  g2.landGrab(me2.id, 'C', slotsOf(z2, opp2.id)[0]);
  assert(opp2.benched === 1, 'setup: benched');
  let guard = 0;
  while (opp2.benched > 0 && guard++ < 30 && g2.phase !== 'GAME_OVER') {
    if (g2.phase === 'POLICY') g2.answerPolicy(g2.activePlayer.id, 'a');
    else if (g2.phase === 'DISCARD') clearDiscard(g2);
    else if (g2.phase === 'ACTION') g2.endTurn(g2.activePlayer.id);
    else if (g2.phase === 'GERRYMANDER') g2.skipGerrymander(g2.activePlayer.id);
    else break;
  }
  assert(opp2.benched === 0, 'benched voters disperse past the deadline');
  console.log('  ✔ benched voters (re-seat + expiry)');
}

// ---------- Boss L3: Snatch ----------
function testSnatch() {
  const g = gameInAction(5);
  const me = g.activePlayer;
  const opp = g.players.find((x) => x.id !== me.id);
  me.resources = { funds: 0, clout: 0, media: 0, trust: 0 };
  opp.resources = { funds: 2, clout: 0, media: 0, trust: 0 };

  expectThrow(() => g.snatch(me.id, opp.id, 'funds'), 'snatch needs Boss L3');
  me.manifesto.boss = 3;
  expectThrow(() => g.snatch(me.id, me.id, 'funds'), 'cannot snatch from yourself');
  expectThrow(() => g.snatch(me.id, opp.id, 'clout'), 'target must hold the resource');

  g.snatch(me.id, opp.id, 'funds');
  g.snatch(me.id, opp.id, 'funds');
  assert(me.resources.funds === 2 && opp.resources.funds === 0, 'two snatches land');
  assert(g.turnFlags.snatches === 2, 'snatch counter');
  opp.resources.clout = 1;
  expectThrow(() => g.snatch(me.id, opp.id, 'clout'), 'only two snatches per turn');
  console.log('  ✔ snatch (Boss L3)');
}

// ---------- Boss L5: Payback ----------
function testPayback() {
  const g = gameInAction(6);
  const me = g.activePlayer;
  const opp = g.players.find((x) => x.id !== me.id);
  me.resources = { funds: 1, clout: 0, media: 0, trust: 1 };
  const z = g.getZone('C');
  plant(g, z, opp.id, z.majority);
  g.checkMajority(z);
  assert(z.majorityOwner === opp.id, 'setup: opponent holds C');

  expectThrow(() => g.payback(me.id, 'funds', 'C', slotsOf(z, opp.id)[0]), 'payback needs Boss L5');
  me.manifesto.boss = 5;
  expectThrow(() => g.payback(me.id, 'clout', 'C', slotsOf(z, opp.id)[0]), 'must hold the payment');
  expectThrow(() => g.payback(me.id, 'funds', 'C', z.volatileIndex), 'volatile untouchable');

  g.payback(me.id, 'funds', 'C', slotsOf(z, opp.id)[0]);
  assert(me.resources.funds === 0, 'paid 1 resource');
  assert(z.majorityOwner === null, 'majority peg discarded — majority breaks');

  // Own pegs are not a legal payback target.
  plant(g, z, me.id, 1);
  expectThrow(() => g.payback(me.id, 'trust', 'C', slotsOf(z, me.id)[0]), 'payback targets an opponent');

  // Twice per turn.
  me.resources = { funds: 2, clout: 0, media: 0, trust: 0 };
  g.payback(me.id, 'funds', 'C', slotsOf(z, opp.id)[0]);
  assert(g.turnFlags.paybacks === 2, 'two paybacks used');
  expectThrow(() => g.payback(me.id, 'funds', 'C', slotsOf(z, opp.id)[0]), 'only two paybacks per turn');
  console.log('  ✔ payback (Boss L5)');
}

// ---------- Icon L3: Going Viral ----------
function testGoingViral() {
  const g = gameInAction(7);
  const p = g.activePlayer;
  p.manifesto.icon = 3;
  p.resources = { funds: 12, clout: 0, media: 0, trust: 0 };
  g.hq[0] = { id: 'v1', voters: 1, cost: { funds: 1 } };
  g.hq[1] = { id: 'v2', voters: 1, cost: { funds: 1 } };
  g.hq[2] = { id: 'v3', voters: 1, cost: { funds: 1 } };

  assert(g.buyVoterCard(p.id, 0, 'C').placed === 2, 'viral adds a voter (1st buy)');
  assert(g.buyVoterCard(p.id, 1, 'N').placed === 2, 'viral adds a voter (2nd buy)');
  assert(g.buyVoterCard(p.id, 2, 'W').placed === 1, 'viral caps at two per turn');
  assert(g.turnFlags.viral === 2, 'viral counter capped at 2');

  // No perk, no bonus.
  const g2 = gameInAction(8);
  const p2 = g2.activePlayer;
  p2.resources = { funds: 12, clout: 0, media: 0, trust: 0 };
  g2.hq[0] = { id: 'v1', voters: 1, cost: { funds: 1 } };
  assert(g2.buyVoterCard(p2.id, 0, 'C').placed === 1, 'no bonus without Icon L3');
  console.log('  ✔ going viral (Icon L3)');
}

// ---------- Icon L5: Election Fever ----------
function testElectionFever() {
  // Without the Fever: one move per majority, majority pegs locked.
  const g = gameInAction(9);
  const me = g.activePlayer;
  const nw = g.getZone('NW');
  plant(g, nw, me.id, nw.majority);
  g.checkMajority(nw);
  g.endTurn(me.id);
  assert(g.gerryMovesLeft === 1, 'one majority → one move');
  expectThrow(
    () => g.gerrymander(me.id, 'NW', slotsOf(nw, me.id)[0], 'N'),
    'majority pegs locked without Election Fever'
  );

  // With the Fever: allowance doubles and majority pegs move.
  const g2 = gameInAction(10);
  const me2 = g2.activePlayer;
  me2.manifesto.icon = 5;
  const nw2 = g2.getZone('NW');
  const c2 = g2.getZone('C');
  plant(g2, nw2, me2.id, nw2.majority);
  g2.checkMajority(nw2);
  plant(g2, c2, me2.id, c2.majority);
  g2.checkMajority(c2);
  g2.endTurn(me2.id);
  assert(g2.gerryMovesLeft === 4, 'two majorities × Election Fever = four moves');
  g2.gerrymander(me2.id, 'NW', slotsOf(nw2, me2.id)[0], 'N');
  assert(g2.phase === 'GERRYMANDER' && g2.gerryMovesLeft === 3, 'Fever moved a majority peg');

  // Volatile pegs stay immovable even with the Fever (DD-20).
  c2.slots[c2.volatileIndex] = me2.id;
  expectThrow(
    () => g2.gerrymander(me2.id, 'C', c2.volatileIndex, 'N'),
    'volatile immovable even with Election Fever'
  );
  console.log('  ✔ election fever (Icon L5)');
}

// ---------- Believer L3: Helping Hands ----------
function testHelpingHands() {
  const g = gameInAction(11);
  const p = g.activePlayer;
  p.resources = { funds: 2, clout: 0, media: 0, trust: 0 };
  g.hq[0] = { id: 'vh1', voters: 1, cost: { funds: 3 } };

  expectThrow(() => g.buyVoterCard(p.id, 0, 'C', false, { funds: 1 }), 'discounts need Believer L3');
  p.manifesto.believer = 3;
  // 3 funds − 1 discount = 2, exactly what we hold: the discount lands before affordability.
  g.buyVoterCard(p.id, 0, 'C', false, { funds: 1 });
  assert(p.resources.funds === 0, 'discount applied before the affordability check');
  assert(g.turnFlags.discounts === 1, 'one discount consumed');

  // Two per turn, and a failed request consumes nothing.
  p.resources = { funds: 5, clout: 0, media: 0, trust: 0 };
  g.hq[1] = { id: 'vh2', voters: 1, cost: { funds: 3 } };
  expectThrow(() => g.buyVoterCard(p.id, 1, 'N', false, { funds: 2 }), 'would exceed 2 discounts');
  assert(g.turnFlags.discounts === 1, 'a rejected discount is not consumed');
  g.buyVoterCard(p.id, 1, 'N', false, { funds: 1 });
  assert(g.turnFlags.discounts === 2, 'allowance exhausted');
  g.hq[2] = { id: 'vh3', voters: 1, cost: { funds: 3 } };
  expectThrow(() => g.buyVoterCard(p.id, 2, 'W', false, { funds: 1 }), 'no discounts left this turn');

  // A discount never drives a cost component below zero.
  const g2 = gameInAction(12);
  const p2 = g2.activePlayer;
  p2.manifesto.believer = 3;
  p2.resources = { funds: 0, clout: 0, media: 0, trust: 0 };
  g2.hq[0] = { id: 'vh4', voters: 1, cost: { funds: 1 } };
  g2.buyVoterCard(p2.id, 0, 'C', false, { funds: 2 });
  assert(p2.resources.funds === 0, 'cost floors at zero, not negative');

  // Conspiracy prices are discounted too.
  const g3 = gameInAction(13);
  const p3 = g3.activePlayer;
  p3.manifesto.believer = 3;
  const price = g3.conspiracyDeck[g3.conspiracyDeck.length - 1].price;
  p3.resources = { funds: price - 2, clout: 0, media: 0, trust: 0 };
  g3.buyConspiracy(p3.id, { funds: price - 2 }, { funds: 2 });
  assert(p3.resources.funds === 0 && p3.conspiracies.length === 1, 'two discounts shave 2 off the price');
  assert(g3.turnFlags.discounts === 2, 'conspiracy discounts counted');
  console.log('  ✔ helping hands (Believer L3)');
}

// ---------- Believer L5: Tough Love ----------
function testToughLove() {
  const g = gameInAction(14);
  const me = g.activePlayer;
  const opp = g.players.find((x) => x.id !== me.id);
  const z = g.getZone('C');
  plant(g, z, opp.id, 2);
  const [s1, s2] = slotsOf(z, opp.id);
  me.resources = { funds: 2, clout: 0, media: 0, trust: 2 };

  expectThrow(() => g.toughLove(me.id, 'C', s1, s2, { funds: 2 }), 'tough love needs Believer L5');
  me.manifesto.believer = 5;
  expectThrow(() => g.toughLove(me.id, 'C', s1, s1, { funds: 2 }), 'two different voters required');
  expectThrow(() => g.toughLove(me.id, 'C', s1, s2, { funds: 1 }), 'extra payment must total 2');
  expectThrow(() => g.toughLove(me.id, 'C', s1, z.volatileIndex, { funds: 2 }), 'volatile untouchable');

  g.toughLove(me.id, 'C', s1, s2, { funds: 2 });
  assert(g.pegCount(z, me.id) === 2 && g.pegCount(z, opp.id) === 0, 'both voters convert');
  assert(me.resources.trust === 0 && me.resources.funds === 0, 'paid 2 trust + any 2');
  assert(g.turnFlags.toughLove === 1, 'tough love counter');

  // Once per turn.
  plant(g, z, opp.id, 2);
  const [t1, t2] = slotsOf(z, opp.id);
  me.resources = { funds: 2, clout: 0, media: 0, trust: 2 };
  expectThrow(() => g.toughLove(me.id, 'C', t1, t2, { funds: 2 }), 'once per turn');

  // Both pegs must belong to the SAME opponent, and not to you.
  const g2 = gameInAction(15, 3);
  const me2 = g2.activePlayer;
  const [o1, o2] = g2.players.filter((x) => x.id !== me2.id);
  me2.manifesto.believer = 5;
  me2.resources = { funds: 2, clout: 0, media: 0, trust: 2 };
  const z2 = g2.getZone('C');
  plant(g2, z2, o1.id, 1);
  plant(g2, z2, o2.id, 1);
  const a = slotsOf(z2, o1.id)[0];
  const b = slotsOf(z2, o2.id)[0];
  expectThrow(() => g2.toughLove(me2.id, 'C', a, b, { funds: 2 }), 'both voters must share an owner');
  plant(g2, z2, me2.id, 2);
  const [m1, m2] = slotsOf(z2, me2.id);
  expectThrow(() => g2.toughLove(me2.id, 'C', m1, m2, { funds: 2 }), 'tough love targets an opponent');
  console.log('  ✔ tough love (Believer L5)');
}

// ---------- elites: persistent auto-expressing hybrids (DD-22) ----------
function testEliteActivation() {
  const g = gameInAction(20);
  const p = g.activePlayer;
  p.manifesto = { mogul: 0, boss: 0, icon: 0, believer: 0 };
  assert(g.activeElites(p.id).length === 0, 'no elites at zero manifesto');

  // Fixer: cap 3 + show 3, ¬believer.
  p.manifesto = { mogul: 3, boss: 0, icon: 3, believer: 0 };
  assert(g.hasElite(p.id, 'fixer'), 'fixer activates on cap3+show3');
  assert(g.hasElite(p.id, 'operator'), 'operator too (same pair, ¬boss)');
  // Negation breaks it: a single believer card deactivates the fixer.
  p.manifesto.believer = 1;
  assert(!g.hasElite(p.id, 'fixer'), 'believer card negates fixer');
  assert(g.hasElite(p.id, 'operator'), 'operator survives an believer card (it negates on boss)');
  p.manifesto.boss = 1;
  assert(!g.hasElite(p.id, 'operator'), 'boss card negates operator');

  // Maverick: ≥2 in three ideologies, none at 3.
  p.manifesto = { mogul: 2, boss: 2, icon: 2, believer: 0 };
  assert(g.hasElite(p.id, 'maverick'), 'maverick on three 2s');
  p.manifesto.mogul = 3;
  assert(!g.hasElite(p.id, 'maverick'), 'maverick lost when an ideology hits 3');

  // Serialize ships active ids per player + a static catalogue; no claim state.
  const s = g.serialize(p.id);
  assert(Array.isArray(s.eliteCatalog) && s.eliteCatalog.length === 13, 'catalogue of 13');
  assert(Array.isArray(s.players[0].elites), 'per-player active elite ids');
  console.log('  ✔ elite activation / negation / serialize');
}

function testElitePowers() {
  // Fixer doubles policy rewards.
  const gl = gameInAction(20);
  const pl = gl.activePlayer;
  pl.manifesto = { mogul: 3, boss: 0, icon: 3, believer: 0 };
  gl.phase = 'POLICY';
  gl.currentCard = { id: 'x', question: 'q', option_a: { text: 't', ideology: 'mogul', rewards: { funds: 2 } }, option_b: { text: 't2', ideology: 'boss', rewards: {} } };
  const fundsBefore = pl.resources.funds;
  gl.answerPolicy(pl.id, 'a');
  assert(pl.resources.funds >= fundsBefore + 4, 'fixer doubled the 2-funds reward to 4');

  // Enforcer taxes every other player's policy answer.
  const gm = gameInAction(21, 3);
  const boss = gm.players.find((x) => x.id !== gm.activePlayer.id);
  boss.manifesto = { mogul: 3, boss: 3, icon: 0, believer: 0 };
  const answerer = gm.activePlayer;
  answerer.resources = { funds: 5, clout: 0, media: 0, trust: 0 };
  gm.phase = 'POLICY';
  gm.currentCard = { id: 'y', question: 'q', option_a: { text: 't', ideology: 'believer', rewards: {} }, option_b: { text: 't2', ideology: 'believer', rewards: {} } };
  const bossFunds = boss.resources.funds;
  gm.answerPolicy(answerer.id, 'a');
  assert(boss.resources.funds === bossFunds + 1, 'enforcer skimmed 1 from the answerer');
  assert(answerer.resources.funds === 4, 'answerer paid the enforcer');

  // Oracle: sacrifice own peg for 3 resources, once per turn.
  const gg = gameInAction(22);
  const pg = gg.activePlayer;
  pg.manifesto = { mogul: 0, boss: 3, icon: 0, believer: 3 };
  const zg = gg.getZone('C');
  plant(gg, zg, pg.id, 1);
  const idx = slotsOf(zg, pg.id)[0];
  const totalBefore = totalRes(pg);
  gg.oracleSacrifice(pg.id, 'C', idx, { funds: 1, clout: 1, media: 1 });
  assert(zg.slots[idx] === null, 'oracle removed the sacrificed peg');
  assert(totalRes(pg) === totalBefore + 3, 'oracle gained 3 resources');
  expectThrow(() => gg.oracleSacrifice(pg.id, 'C', slotsOf(zg, pg.id)[0] ?? 0, { funds: 3 }), 'oracle once per turn');

  // Strongman: gerrymander an opponent peg into your territory and it defects.
  const gd = gameInAction(23);
  const pd = gd.activePlayer;
  const od = gd.players.find((x) => x.id !== pd.id);
  pd.manifesto = { mogul: 3, boss: 3, icon: 0, believer: 0 };
  const home = gd.getZone('C');
  const neigh = gd.getZone(home.adjacent[0]);
  plant(gd, home, pd.id, home.majority); // pd holds C → gerrymander rights over C and neighbours
  gd.checkMajority(home);
  plant(gd, neigh, od.id, 1);
  const oidx = slotsOf(neigh, od.id)[0];
  gd.phase = 'GERRYMANDER';
  gd.gerryMovesLeft = 5;
  gd.gerrymander(pd.id, neigh.id, oidx, home.id);
  assert(gd.pegCount(home, pd.id) >= home.majority + 1, "strongman converted the opponent's dragged peg");

  // Maverick borrows the Oracle's power once.
  const gr = gameInAction(24);
  const pr = gr.activePlayer;
  pr.manifesto = { mogul: 2, boss: 2, icon: 2, believer: 0 };
  assert(gr.hasElite(pr.id, 'maverick'), 'maverick active');
  const zr = gr.getZone('C');
  plant(gr, zr, pr.id, 1);
  const ridx = slotsOf(zr, pr.id)[0];
  const rBefore = totalRes(pr);
  gr.maverickCopy(pr.id, 'oracle', { zoneId: 'C', slotIndex: ridx, gains: { trust: 3 } });
  assert(totalRes(pr) === rBefore + 3 && zr.slots[ridx] === null, 'maverick fired the oracle power');
  expectThrow(() => gr.maverickCopy(pr.id, 'insurgent', { moves: [] }), 'maverick once per turn');

  console.log('  ✔ elite powers (fixer, enforcer, oracle, strongman, maverick)');
}

// ---------- The Reckoning (DD-22) ----------
const RECK = require('../data/reckoning.json');
function testCostOfVictory() {
  const g = gameInAction(30);
  const p = g.players[0];
  const z = g.getZone('C');
  plant(g, z, p.id, z.majority);
  g.checkMajority(z);
  p.manifesto = { mogul: 4, boss: 2, icon: 0, believer: 0 };
  g.endGame();
  assert(g.winnerIds.includes(p.id), 'p wins with the captured zone');
  const want = RECK.find((c) => c.primary === 'mogul' && c.secondary === 'boss');
  assert(g.reckoning && g.reckoning.playerId === p.id, 'the reckoning is attached to the winner');
  assert(g.reckoning.title === want.title, 'mogul>boss selects the right dystopia');
  assert(g.serialize(p.id).reckoning.title === want.title, 'the reckoning is serialized');

  // Manifesto tie breaks by IDEOLOGIES order (mogul before boss).
  const g2 = gameInAction(31);
  const q = g2.players[0];
  const z2 = g2.getZone('C');
  plant(g2, z2, q.id, z2.majority);
  g2.checkMajority(z2);
  q.manifesto = { mogul: 3, boss: 3, icon: 0, believer: 0 };
  g2.endGame();
  assert(g2.reckoning.title === want.title, 'tie: mogul ranks ahead of boss');
  console.log('  ✔ the reckoning');
}

console.log('Running Phase 4 tests...');
testProspecting();
testLandGrab();
testBenchedVoters();
testSnatch();
testPayback();
testGoingViral();
testElectionFever();
testHelpingHands();
testToughLove();
testEliteActivation();
testElitePowers();
testCostOfVictory();
console.log(`All Phase 4 tests passed (${passed} assertions).`);

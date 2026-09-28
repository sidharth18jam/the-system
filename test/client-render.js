// Headless smoke test for the browser client: stubs just enough DOM + socket to load
// public/client.js and drive its render() pipeline with real serialized engine states.
// Catches runtime errors (bad property access, missing branches) that node --check can't.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { SystemGame } = require('../server/game');

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Minimal element stub. Records what render() writes; enough for the code paths to run.
function makeEl(id) {
  const el = {
    id,
    _html: '',
    _text: '',
    disabled: false,
    checked: false,
    value: '',
    dataset: {},
    style: {},
    classList: {
      _s: new Set(),
      toggle(c, on) { if (on === undefined ? this._s.has(c) : !on) this._s.delete(c); else this._s.add(c); },
      add(c) { this._s.add(c); },
      remove(...cs) { cs.forEach((c) => this._s.delete(c)); },
      contains(c) { return this._s.has(c); },
    },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); this._html = escapeHtml(v); },
    get textContent() { return this._text; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    getAttribute() { return null; },
    addEventListener() {},
    appendChild() {},
    onclick: null,
    onchange: null,
  };
  return el;
}

const els = {};
const document = {
  getElementById(id) {
    if (!els[id]) els[id] = makeEl(id);
    return els[id];
  },
  querySelectorAll() { return []; },
  createElement() { return makeEl('_tmp'); },
  addEventListener() {},
};

// Socket stub: captures registered handlers; emit is a no-op we can inspect.
const handlers = {};
const emitted = [];
const socket = {
  on(ev, fn) { handlers[ev] = fn; },
  emit(ev, data) { emitted.push({ ev, data }); },
};
const io = () => socket;

const sandbox = {
  io,
  document,
  socket,
  window: {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  URLSearchParams,
  location: { search: '', origin: 'http://localhost:3000', pathname: '/' },
  navigator: {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
};
sandbox.globalThis = sandbox;

// help.js loads first in index.html and defines the HELP global client.js reads.
const help = fs.readFileSync(path.join(__dirname, '../public/help.js'), 'utf8');
const code = fs.readFileSync(path.join(__dirname, '../public/client.js'), 'utf8');
vm.runInNewContext(`${help}\n;globalThis.HELP = HELP;\n${code}`, sandbox);

// render() isolates panels so one bug can't freeze the rest in production; the harness
// still has to fail loudly on any panel that threw.
const rawGameState = handlers.gameState;
handlers.gameState = (s) => {
  rawGameState(s);
  const failed = sandbox.takeRenderFailures();
  if (failed.length) throw failed[0].error;
};

// Drive real states through the gameState handler for a variety of phases.
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const g = new SystemGame([{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }], seededRng(1));
const feed = (viewerId) => {
  const payload = { ...g.serialize(viewerId), you: viewerId, youAreHost: viewerId === 'a' };
  handlers.gameState(payload);
};

let checks = 0;
function ok(label) { checks++; console.log('  ✔ ' + label); }

// SETUP_PICK
feed('a'); feed('b'); ok('renders SETUP_PICK');
for (const p of g.players) while (p.startingPicksRemaining > 0) g.pickStartingResource(p.id, 'funds');
// POLICY — a first-timer's own question and a bystander's view each get their coach tip.
const coachTitle = () => (els.coach.classList.contains('hidden') ? null : els['coach-title'].textContent);
const firstBystander = g.players.find((p) => p.id !== g.activePlayer.id).id;
feed(g.activePlayer.id);
if (coachTitle() !== 'Your first question') throw new Error(`policy coach tip missing: ${coachTitle()}`);
feed(firstBystander);
if (coachTitle() !== 'Not your turn — still your game') throw new Error(`watch coach tip missing: ${coachTitle()}`);
feed(g.activePlayer.id);
if (coachTitle() !== null) throw new Error('policy coach tip repeated after its moment passed');
ok('renders POLICY (active + spectator) with first-time coach tips');
g.answerPolicy(g.activePlayer.id, 'a');
// ACTION with a conspiracy in hand + peek + IOU-less
const active = g.activePlayer;
active.resources = { funds: 12, clout: 6, media: 6, trust: 6 };
active.conspiracies.push(JSON.parse(JSON.stringify(require('../data/conspiracy-cards.json')[0])));
active.peek = { kind: 'voter', card: g.voterDeck[g.voterDeck.length - 1] };
feed(active.id); ok('renders ACTION with conspiracy hand + peek');
// Opponent view (hidden hand)
const opp = g.players.find((p) => p.id !== active.id).id;
feed(opp); ok('renders ACTION from opponent view');
// REACTION: stage a pending reaction targeting opp
const victim = g.getPlayer(opp);
victim.conspiracies.push(JSON.parse(JSON.stringify(require('../data/conspiracy-cards.json').find((c) => c.reaction))));
active.resources.clout = 5;
g.playConspiracy(active.id, active.conspiracies.find((c) => c.target === 'playerRes').id, { playerId: opp, res: 'clout' });
feed(opp); ok('renders REACTION modal for victim');
feed(active.id); ok('renders REACTION wait for caster');
g.respondReaction(opp, null);
// GERRYMANDER
const g2 = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(3));
for (const p of g2.players) while (p.startingPicksRemaining > 0) g2.pickStartingResource(p.id, 'funds');
g2.answerPolicy(g2.activePlayer.id, 'a');
const z = g2.getZone('N');
const spots = g2.emptyNormalIndices(z);
for (let i = 0; i < 5; i++) z.slots[spots[i]] = g2.activePlayer.id;
g2.checkMajority(z);
g2.endTurn(g2.activePlayer.id);
const h2 = (vid) => handlers.gameState({ ...g2.serialize(vid), you: vid });
h2(g2.activePlayer.id); ok('renders GERRYMANDER');
// AUCTION + AUCTION_PLACE + IOU badge
const g3 = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seededRng(9));
for (const p of g3.players) while (p.startingPicksRemaining > 0) g3.pickStartingResource(p.id, 'funds');
g3.answerPolicy(g3.activePlayer.id, 'a');
g3.players[1].resources = { funds: 6, clout: 0, media: 0, trust: 0 };
g3.startAuction({ card: { id: 'aucX', voters: 5, auctioned: true }, triggeredBy: g3.players[0].id });
const h3 = (vid) => handlers.gameState({ ...g3.serialize(vid), you: vid });
h3(g3.players[1].id); ok('renders AUCTION (bidder view)');
h3(g3.players[0].id); ok('renders AUCTION (trigger view)');
g3.placeBid(g3.players[1].id, 5);
g3.passBid(g3.players[0].id);
g3.passBid(g3.players[2].id);
h3(g3.players[1].id); ok('renders AUCTION_PLACE (winner)');
h3(g3.players[0].id); ok('renders AUCTION_PLACE (spectator)');

// IOU badge: force a debt and render
const g4 = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(11));
for (const p of g4.players) while (p.startingPicksRemaining > 0) g4.pickStartingResource(p.id, 'funds');
g4.answerPolicy(g4.activePlayer.id, 'a');
g4.players[0].iou = { debt: 4 };
handlers.gameState({ ...g4.serialize('a'), you: 'a' }); ok('renders IOU badge');

// Perks: a player with every track unlocked renders tracks, peek, bank trade, strike.
const g5 = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(13));
for (const p of g5.players) while (p.startingPicksRemaining > 0) g5.pickStartingResource(p.id, 'funds');
g5.answerPolicy(g5.activePlayer.id, 'a');
const perked = g5.activePlayer;
perked.manifesto = { mogul: 5, boss: 5, icon: 5, believer: 5 };
perked.resources = { funds: 6, clout: 3, media: 3, trust: 3 };
const zz = g5.getZone('NW');
const sp = g5.emptyNormalIndices(zz);
for (let i = 0; i < 6; i++) zz.slots[sp[i]] = perked.id;
g5.checkMajority(zz);
const other5 = g5.players.find((p) => p.id !== perked.id);
const zn = g5.getZone('N');
zn.slots[g5.emptyNormalIndices(zn)[0]] = other5.id;
handlers.gameState({ ...g5.serialize(perked.id), you: perked.id }); ok('renders full ideologue-powers bar (ACTION)');
// Benched voters (Land Grab) surface a re-seat banner.
perked.benched = 2;
perked.benchDeadline = g5.turnCounter + g5.players.length;
handlers.gameState({ ...g5.serialize(perked.id), you: perked.id }); ok('renders benched-voter banner');
perked.benched = 0;
g5.endTurn(perked.id);
handlers.gameState({ ...g5.serialize(perked.id), you: perked.id }); ok('renders GERRYMANDER with land grab + payback (moves left)');

// Start-of-turn DISCARD: answering over the cap blocks acting until you dump the excess.
const gD = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(19));
for (const p of gD.players) while (p.startingPicksRemaining > 0) gD.pickStartingResource(p.id, 'funds');
gD.activePlayer.resources = { funds: 12, clout: 0, media: 0, trust: 0 };
gD.answerPolicy(gD.activePlayer.id, 'a');
handlers.gameState({ ...gD.serialize(gD.activePlayer.id), you: gD.activePlayer.id });
ok('renders start-of-turn DISCARD modal');

// POLICY window: a bystander may play a conspiracy between turns (DD-21).
const gW = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(23));
for (const p of gW.players) while (p.startingPicksRemaining > 0) gW.pickStartingResource(p.id, 'funds');
const bystander = gW.players.find((p) => p.id !== gW.activePlayer.id);
bystander.conspiracies.push(
  JSON.parse(JSON.stringify(require('../data/conspiracy-cards.json').find((c) => c.id === 'c_kompromat')))
);
handlers.gameState({ ...gW.serialize(bystander.id), you: bystander.id });
ok('renders playable conspiracy for a bystander during POLICY');

// Elites: near-miss hybrid view, then an active auto-expressed elite (DD-22).
const g6 = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(17));
for (const p of g6.players) while (p.startingPicksRemaining > 0) g6.pickStartingResource(p.id, 'funds');
g6.answerPolicy(g6.activePlayer.id, 'a');
const e6 = g6.activePlayer;
e6.manifesto = { mogul: 3, boss: 0, icon: 2, believer: 0 };
handlers.gameState({ ...g6.serialize(e6.id), you: e6.id }); ok('renders elite display (near-miss hybrid)');
e6.manifesto = { mogul: 3, boss: 0, icon: 3, believer: 0 };
handlers.gameState({ ...g6.serialize(e6.id), you: e6.id }); ok('renders active elite (holder)');
handlers.gameState({ ...g6.serialize(g6.players.find((p) => p.id !== e6.id).id), you: g6.players.find((p) => p.id !== e6.id).id });
ok('renders active elite (opponent view)');

// Coalition (DD-23): offer pending, then the dual-color capture tag + withdraw button.
const g7 = new SystemGame(
  [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
  seededRng(29)
);
for (const p of g7.players) while (p.startingPicksRemaining > 0) g7.pickStartingResource(p.id, 'funds');
g7.answerPolicy(g7.activePlayer.id, 'a');
const cFrom = g7.activePlayer;
const cTo = g7.players.find((p) => p.id !== cFrom.id);
const cz = g7.getZone('N');
const czSpots = g7.emptyNormalIndices(cz);
for (let i = 0; i < cz.majority - 2; i++) cz.slots[czSpots[i]] = cFrom.id;
for (let i = cz.majority - 2; i < cz.majority; i++) cz.slots[czSpots[i]] = cTo.id;
cFrom.manifesto.mogul = 1;
cTo.manifesto.boss = 1;
const cOffer = g7.proposeCoalition(cFrom.id, cTo.id, cz.id, { from: cz.majority - 2, to: 2 });
handlers.gameState({ ...g7.serialize(cTo.id), you: cTo.id }); ok('renders coalition offer (addressee)');
handlers.gameState({ ...g7.serialize(cFrom.id), you: cFrom.id }); ok('renders coalition offer (proposer)');
g7.respondCoalition(cTo.id, cOffer.id, true);
handlers.gameState({ ...g7.serialize(cFrom.id), you: cFrom.id }); ok('renders coalition tag (partner, can withdraw)');
handlers.gameState({ ...g7.serialize(g7.players.find((p) => p.id !== cFrom.id && p.id !== cTo.id).id), you: 'x' });
ok('renders coalition tag (outsider)');

// Home Turfs mode (DD-24): mode badge + turf chip with a usable power.
const g8 = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(31), 'homeTurfs');
for (const p of g8.players) while (p.startingPicksRemaining > 0) g8.pickStartingResource(p.id, 'funds');
g8.answerPolicy(g8.activePlayer.id, 'a');
const t8 = g8.activePlayer;
const tz = g8.getZone('NW');
const tSpots = g8.emptyNormalIndices(tz);
for (let i = 0; i < tz.majority; i++) tz.slots[tSpots[i]] = t8.id;
g8.checkMajority(tz);
handlers.gameState({ ...g8.serialize(t8.id), you: t8.id }); ok('renders homeTurfs (usable turf chip + badge)');
g8.useHomeTurf(t8.id, 'NW');
handlers.gameState({ ...g8.serialize(t8.id), you: t8.id }); ok('renders homeTurfs (used turf)');
handlers.gameState({
  ...g8.serialize(g8.players.find((p) => p.id !== t8.id).id),
  you: g8.players.find((p) => p.id !== t8.id).id,
});
ok('renders homeTurfs (opponent view)');

// Hidden Objectives mode (DD-25): own card mid-game, reveal at game over.
const g9 = new SystemGame(
  [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
  seededRng(37),
  'hiddenObjectives'
);
for (const p of g9.players) while (p.startingPicksRemaining > 0) g9.pickStartingResource(p.id, 'funds');
g9.answerPolicy(g9.activePlayer.id, 'a');
handlers.gameState({ ...g9.serialize('a'), you: 'a' }); ok('renders hidden objective card (own)');
g9.endGame();
handlers.gameState({ ...g9.serialize('a'), you: 'a' }); ok('renders objective reveal at GAME_OVER');

// 2 Player mode (DD-26): 7-zone board, bid modal, requirement placement + chips.
const gT = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(41), 'twoPlayer');
handlers.gameState({ ...gT.serialize('a'), you: 'a' }); ok('renders 2p SETUP_BID (open)');
gT.submitSetupBid('a', 3);
handlers.gameState({ ...gT.serialize('a'), you: 'a' }); ok('renders 2p SETUP_BID (waiting)');
gT.submitSetupBid('b', 1);
handlers.gameState({ ...gT.serialize(gT.players[1].id), you: gT.players[1].id });
ok('renders 2p SETUP_REQUIREMENTS (placer with hand)');
handlers.gameState({ ...gT.serialize(gT.players[0].id), you: gT.players[0].id });
ok('renders 2p SETUP_REQUIREMENTS (waiting side)');
while (gT.phase === 'SETUP_REQUIREMENTS') {
  const placer = gT.players[gT.reqPlacerIndex];
  gT.placeRequirement(placer.id, gT.reqHands[placer.id][0].id, gT.zones.find((z) => !z.requirement).id);
}
handlers.gameState({ ...gT.serialize(gT.players[0].id), you: gT.players[0].id });
ok('renders 2p POLICY with requirement chips on the 7-zone board');

// GAME_OVER
g2.endGame();
h2(g2.activePlayer.id); ok('renders GAME_OVER');

// ⓘ explanations: every info key the UI references must resolve to a real sheet.
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const keys = new Set();
for (const m of html.matchAll(/data-info="([^"]+)"/g)) keys.add(m[1]);
for (const m of code.matchAll(/infoBtn\('([a-z]+)'/g)) keys.add(m[1]);
const gH = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seededRng(5), 'homeTurfs');
const sH = { ...gH.serialize('a'), you: 'a' };
handlers.gameState(sH);
for (const e of sH.eliteCatalog) keys.add('elite:' + e.id);
for (const t of sH.homeTurfs) keys.add('turf:' + t.zoneId);
for (const k of keys) {
  const t = sandbox.helpTopic(k);
  if (!t || !t.title || !t.body) throw new Error(`ⓘ topic "${k}" has no explanation`);
  for (const see of t.see || []) if (!sandbox.HELP[see]) throw new Error(`ⓘ "${k}" links to missing "${see}"`);
  sandbox.openInfo(k);
  if (els['info-title'].textContent !== t.title) throw new Error(`ⓘ "${k}" did not open`);
}
console.log(`  ✔ ${keys.size} ⓘ topics resolve and open (every elite and home turf included)`);

// Notifications: consecutive states for one seat are diffed into attention events.
{
  const gN = new SystemGame(
    [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Cy' }],
    seededRng(43)
  );
  const view = (vid) => ({ ...gN.serialize(vid), you: vid });
  const texts = (prev, next) => sandbox.detectEvents(prev, next).map((e) => e.text);
  const expect = (cond, label) => {
    if (!cond) throw new Error('notify: ' + label);
    ok('notify: ' + label);
  };
  for (const p of gN.players) while (p.startingPicksRemaining > 0) gN.pickStartingResource(p.id, 'funds');
  const first = gN.activePlayer;
  const other = gN.players.find((p) => p.id !== first.id);
  const third = gN.players.find((p) => p.id !== first.id && p.id !== other.id);

  let before = view(other.id);
  gN.answerPolicy(first.id, 'a');
  if (gN.phase === 'DISCARD') gN.discardResources(first.id, { funds: gN.discardRequired });
  first.resources = { funds: 3, clout: 3, media: 3, trust: 3 };
  other.resources = { funds: 3, clout: 3, media: 3, trust: 3 };
  gN.proposeTrade(first.id, other.id, { funds: 1 }, { clout: 1 }, [], []);
  let after = view(other.id);
  expect(texts(before, after).some((t) => t.includes(`${first.name} offers you a trade`)), 'trade offer pings its addressee');
  expect(!texts(view(third.id), view(third.id)).length, 'no change, no events');
  expect(
    !sandbox.detectEvents(before, after).some((e) => e.text.includes('proposed a trade')),
    'offer is not repeated from the log'
  );

  before = view(first.id);
  const deciderBefore = view(other.id);
  gN.respondTrade(other.id, gN.tradeOffers[0].id, false);
  after = view(first.id);
  expect(texts(before, after).some((t) => t.includes('declined')), 'declined trade reaches the proposer via the log');
  expect(!texts(deciderBefore, view(other.id)).length, 'decliner is not told about their own action');

  before = view(other.id);
  gN.endTurn(first.id);
  if (gN.phase === 'GERRYMANDER') gN.skipGerrymander(first.id);
  after = view(gN.activePlayer.id);
  const nextUp = gN.activePlayer.id;
  expect(
    texts({ ...before, you: nextUp, activePlayerId: first.id }, after).includes('🗳 Your turn.'),
    'turn change pings the new active player'
  );
  expect(after.logSeq > before.logSeq, 'server exposes a growing logSeq');
}

console.log(`Client render harness: ${checks} states rendered without error.`);

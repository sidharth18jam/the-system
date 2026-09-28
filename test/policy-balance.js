// Policy-question balance: every resource is handed out equally, and answer
// position (A/B) never reveals which ideology an answer belongs to.
const { SystemGame } = require('../server/game');
const CARDS = require('../data/ideology-cards.json');

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  passed++;
}

const IDEO_RES = { mogul: 'funds', boss: 'clout', icon: 'media', believer: 'trust' };
const RES = Object.values(IDEO_RES);

// Every answer: +2 of its ideology's resource, +1 of one other.
const totals = Object.fromEntries(RES.map((r) => [r, 0]));
const bonus = Object.fromEntries(Object.keys(IDEO_RES).map((i) => [i, {}]));
for (const c of CARDS) {
  for (const o of [c.option_a, c.option_b]) {
    const home = IDEO_RES[o.ideology];
    const keys = Object.keys(o.rewards);
    assert(keys.length === 2 && o.rewards[home] === 2, `${c.id}: +2 ${home} and one bonus`);
    const other = keys.find((k) => k !== home);
    assert(o.rewards[other] === 1, `${c.id}: bonus is +1`);
    bonus[o.ideology][other] = (bonus[o.ideology][other] || 0) + 1;
    for (const k of keys) totals[k] += o.rewards[k];
  }
}
const expected = totals.funds;
for (const r of RES) assert(totals[r] === expected, `${r} total ${totals[r]} === ${expected}`);
for (const [ideo, m] of Object.entries(bonus)) {
  const counts = Object.values(m);
  assert(counts.length === 3 && Math.max(...counts) === Math.min(...counts), `${ideo} bonus split even: ${JSON.stringify(m)}`);
}
console.log(`  ✔ policy rewards: each resource totals ${expected}; bonuses split evenly`);

// Draw order: over many draws, each ideology lands on both A and B, and the answer
// the player picks still pays out that answer's own rewards.
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const g = new SystemGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seededRng(7));
const seen = {};
for (let i = 0; i < 400; i++) {
  const c = g.drawIdeologyCard();
  for (const [pos, o] of [['a', c.option_a], ['b', c.option_b]]) {
    seen[o.ideology] = seen[o.ideology] || new Set();
    seen[o.ideology].add(pos);
  }
  g.ideologyDiscard.push(c);
}
for (const ideo of Object.keys(IDEO_RES)) assert(seen[ideo] && seen[ideo].size === 2, `${ideo} appears as both A and B`);

for (const p of g.players) while (p.startingPicksRemaining > 0) g.pickStartingResource(p.id, 'funds');
const card = g.currentCard;
const before = { ...g.activePlayer.resources };
const manifestoBefore = { ...g.activePlayer.manifesto };
g.answerPolicy(g.activePlayer.id, 'b');
const after = g.activePlayer;
assert(after.manifesto[card.option_b.ideology] === manifestoBefore[card.option_b.ideology] + 1, 'B credits B’s ideology');
for (const [r, n] of Object.entries(card.option_b.rewards)) assert(after.resources[r] >= before[r] + n, `B pays ${n} ${r}`);
console.log('  ✔ A/B order is shuffled per draw and answers still pay their own rewards');

console.log(`All policy-balance tests passed (${passed} assertions).`);

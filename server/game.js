// The System — core game engine (Phase 2: trading, gerrymandering, headlines, majority breaking)
// Authoritative, framework-free, fully testable without sockets.

const fs = require('fs');
const path = require('path');

const ZONES = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/zones.json'), 'utf8'));
const IDEOLOGY_CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/ideology-cards.json'), 'utf8'));
const VOTER_CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/voter-cards.json'), 'utf8'));
const HEADLINE_CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/headline-cards.json'), 'utf8'));
const CONSPIRACY_CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/conspiracy-cards.json'), 'utf8'));
const ELITE_CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/elite-cards.json'), 'utf8'));
const RECKONING = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/reckoning.json'), 'utf8'));
const HOME_TURFS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/home-turfs.json'), 'utf8'));
const HIDDEN_OBJECTIVES = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/hidden-objectives.json'), 'utf8'));
const ZONES_2P = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/zones-2p.json'), 'utf8'));
const ZONE_REQUIREMENTS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/zone-requirements.json'), 'utf8'));

// Host-selectable play modes (DD-24). Further modes are added per part.
const MODES = ['standard', 'homeTurfs', 'hiddenObjectives', 'twoPlayer'];

// Zone-requirement checks for 2 Player mode (DD-26).
// oneTime: once a player satisfies it, it stays met for them (lazy, each checkMajority).
const ONETIME_CHECKS = {
  played2Conspiracies: (g, p) => (p.conspiraciesPlayed || 0) >= 2,
  hold8Resources: (g, p) => totalResources(p.resources) >= 8,
  ideology3: (g, p) => IDEOLOGIES.some((i) => p.manifesto[i] >= 3),
  sprungTrap: (g, p) => (p.trapsSprung || 0) >= 1,
  spread4: (g, p) => g.zones.filter((z) => g.pegCount(z, p.id) > 0).length >= 4,
  media4: (g, p) => p.resources.media >= 4,
  heldMajority: (g, p) => g.zones.some((z) => z.majorityOwner === p.id),
};
// onMajority: must hold at the moment the majority would be awarded — every time.
// payExtra2 has a side effect (the toll is collected) so it only runs at award time.
const ONMAJORITY_CHECKS = {
  payExtra2: (g, p) => {
    if (totalResources(p.resources) < 2) return false;
    let owed = 2;
    for (const r of RESOURCES.slice().sort((a, b) => p.resources[b] - p.resources[a])) {
      const pay = Math.min(owed, p.resources[r]);
      p.resources[r] -= pay;
      owed -= pay;
      if (!owed) break;
    }
    g.addLog(`💰 ${p.name} pays the toll of 2 to capture the zone.`);
    return true;
  },
  needPlusOne: (g, p, zone) => g.pegCount(zone, p.id) >= zone.majority + 1,
  holdTrust2: (g, p) => p.resources.trust >= 2,
  noDebt: (g, p) => !g.debtLocked(p),
};

// Endgame checks for hidden objectives (DD-25). Each takes (game, player) → bool.
const OBJECTIVE_CHECKS = {
  majorities3plus: (g, p) => g.zones.filter((z) => z.majorityOwner === p.id).length >= 3,
  adjacentPair: (g, p) =>
    g.zones.some(
      (z) => z.majorityOwner === p.id && z.adjacent.some((a) => g.getZone(a).majorityOwner === p.id)
    ),
  centerHeld: (g, p) => g.getZone('C').majorityOwner === p.id,
  richest: (g, p) =>
    g.players.every(
      (o) => o.id === p.id || totalResources(o.resources) < totalResources(p.resources)
    ),
  noIOUEver: (g, p) => !p.tookIOU,
  conspiracies3: (g, p) => (p.conspiraciesPlayed || 0) >= 3,
  trapped2: (g, p) => (p.trapsSprung || 0) >= 2,
  bigZone: (g, p) => g.getZone('SE').majorityOwner === p.id,
  spread6: (g, p) => g.zones.filter((z) => g.pegCount(z, p.id) > 0).length >= 6,
  untouchable: (g, p) =>
    (p.majoritiesLost || 0) === 0 && g.zones.some((z) => z.majorityOwner === p.id),
};

const RESOURCES = ['funds', 'clout', 'media', 'trust'];
// Display names for log lines. The `media` storage key predates the rename to Buzz; it
// stays put because "media" also appears as ordinary prose throughout the card decks.
const RES_LABEL = { funds: 'funds', clout: 'clout', media: 'buzz', trust: 'trust' };
const IDEOLOGIES = ['mogul', 'boss', 'icon', 'believer'];
// Each ideology's home resource — drives passive ideologue income (DD-21).
const IDEO_RES = { mogul: 'funds', boss: 'clout', icon: 'media', believer: 'trust' };
const COLORS = ['green', 'red', 'blue', 'yellow', 'purple'];
const RESOURCE_CAP = 12; // flat personal cap; discard down to it at the START of your turn (DD-21)
const HQ_SIZE = 3;
// Trading is open while the active player still has agency in their turn (DD-11).
const TRADE_PHASES = ['POLICY', 'ACTION', 'GERRYMANDER'];
// Conspiracies play on your own turn while you still have agency (DD-15).
const CONSPIRACY_PHASES = ['ACTION', 'GERRYMANDER'];

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function totalResources(res) {
  return RESOURCES.reduce((s, r) => s + (res[r] || 0), 0);
}

// Per-turn allowances for the ideologue powers (DD-21).
function freshTurnFlags() {
  return {
    prospecting: 0, landGrabs: 0, snatches: 0, paybacks: 0, viral: 0, discounts: 0, toughLove: 0,
    // Official-elite per-turn allowances (DD-22).
    benefactor: 0, agitator: 0, spinner: 0, oracle: 0, insurgent: 0, maverick: 0,
  };
}

// Validate a {funds, clout, media, trust} map of non-negative integers.
function cleanResourceMap(m) {
  if (!m || typeof m !== 'object') throw new Error('Invalid resource map');
  const out = { funds: 0, clout: 0, media: 0, trust: 0 };
  for (const [r, n] of Object.entries(m)) {
    if (!RESOURCES.includes(r)) throw new Error('Unknown resource: ' + r);
    if (!Number.isInteger(n) || n < 0) throw new Error('Invalid resource amount');
    out[r] = n;
  }
  return out;
}

class SystemGame {
  constructor(playerInfos, rng = Math.random, mode = 'standard') {
    if (playerInfos.length < 2 || playerInfos.length > 5) {
      throw new Error('The System supports 2-5 players');
    }
    if (!MODES.includes(mode)) throw new Error('Unknown mode: ' + mode);
    if (mode === 'twoPlayer' && playerInfos.length !== 2) {
      throw new Error('2 Player mode needs exactly 2 players');
    }
    this.mode = mode;
    this.turfUsed = {}; // zoneId -> turnCounter of last use (homeTurfs mode, DD-24)
    this.rng = rng;
    this.log = [];

    // Randomized turn order; index in array IS turn order (DD-8).
    const order = shuffle(playerInfos, rng);
    this.players = order.map((p, i) => ({
      id: p.id,
      name: p.name,
      color: COLORS[i],
      resources: { funds: 0, clout: 0, media: 0, trust: 0 },
      manifesto: { mogul: 0, boss: 0, icon: 0, believer: 0 },
      startingPicksRemaining: i + 1, // P1 gets 1, P2 gets 2, ...
      conspiracies: [], // hidden hand of conspiracy card objects (no hand cap, DD-21)
      peek: null, // private info revealed by Exit Poll Leak; cleared at turn end
      iou: null, // { debt } when the player owes the bank from an over-bid auction (DD-16)
      benched: 0, // voters evicted by a Land Grab / held by a Operator (DD-21, DD-22)
      benchDeadline: null, // turnCounter by which benched voters must be re-seated
      backerTargets: [], // the ≤2 rivals a Backer collects from (DD-22)
      // Always-on trackers feeding hidden-objective checks (DD-25); cheap, JSON-safe.
      tookIOU: false,
      conspiraciesPlayed: 0,
      trapsSprung: 0,
      majoritiesLost: 0,
      objective: null, // dealt below in hiddenObjectives mode; viewer-gated in serialize
      score: 0,
    }));
    if (mode === 'hiddenObjectives') {
      const objDeck = shuffle(HIDDEN_OBJECTIVES, rng);
      this.players.forEach((p, i) => (p.objective = objDeck[i]));
    }
    this.objectiveResults = null; // filled at endGame in hiddenObjectives mode (DD-25)
    this.turnFlags = freshTurnFlags(); // per-turn ideologue-power allowances (DD-21)

    // slots[i] = playerId | null. slots[volatileIndex] is the Volatile Area.
    // 2 Player mode plays its own 7-zone board (DD-26).
    this.zones = (mode === 'twoPlayer' ? ZONES_2P : ZONES).map((z) => ({
      id: z.id,
      name: z.name,
      capacity: z.capacity,
      majority: z.majority,
      volatileIndex: z.volatile,
      adjacent: z.adjacent,
      slots: Array(z.capacity).fill(null),
      majorityOwner: null,
      coalition: null, // { a, b, split: {a, b} } — joint capture (DD-23)
      requirement: null, // { card, metBy: {} } — 2 Player zone requirement (DD-26)
    }));

    this.ideologyDeck = shuffle(IDEOLOGY_CARDS, rng);
    this.ideologyDiscard = [];
    this.voterDeck = shuffle(VOTER_CARDS, rng);
    this.voterDiscard = [];
    // Cards flagged "twoPlayer": false (the auction headlines) sit out head-to-head games.
    this.headlineDeck = shuffle(
      mode === 'twoPlayer' ? HEADLINE_CARDS.filter((c) => c.twoPlayer !== false) : HEADLINE_CARDS,
      rng
    );
    this.headlineDiscard = [];
    this.conspiracyDeck = shuffle(CONSPIRACY_CARDS, rng);
    this.conspiracyDiscard = [];
    this.hq = [];
    for (let i = 0; i < HQ_SIZE; i++) this.hq.push(this.drawVoterCard());

    // SETUP_PICK -> POLICY -> ACTION -> (GERRYMANDER) -> (DISCARD) -> ... -> GAME_OVER
    // Headlines resolve between GERRYMANDER and DISCARD, inside finishTurn().
    // 2 Player mode instead opens SETUP_BID -> SETUP_REQUIREMENTS -> POLICY (DD-26).
    this.phase = 'SETUP_PICK';
    this.setupBids = null;
    this.reqHands = null;
    this.reqPlacerIndex = null;
    if (mode === 'twoPlayer') {
      this.phase = 'SETUP_BID';
      // Both start with 8 resources (2 of each) and bid secretly for first turn;
      // the classic asymmetric starting picks are replaced entirely.
      for (const p of this.players) {
        p.resources = { funds: 2, clout: 2, media: 2, trust: 2 };
        p.startingPicksRemaining = 0;
      }
      this.setupBids = {}; // pid -> amount; amounts stay secret until both are in
      const reqDeck = shuffle(ZONE_REQUIREMENTS, rng);
      this.reqHands = {
        [this.players[0].id]: reqDeck.slice(0, 7),
        [this.players[1].id]: reqDeck.slice(7, 14),
      };
    }
    this.turnIndex = 0;
    this.currentCard = null;
    // Volatile-area hits this turn: { zoneId, victimId }. The headline applies to the
    // owner of the peg in the volatile slot — who may be a trapped opponent (DD-20).
    this.pendingHeadlines = [];
    this.lastHeadline = null; // { key, title, text, playerId, zoneId, summary }
    this.headlineCounter = 0;
    this.pendingAuctions = []; // auction prize cards queued by 'auction' headlines this turn
    this.auction = null; // active auction: { card, bid, highBidder, passed, triggeredBy }
    this.auctionCounter = 0;
    this.tradeOffers = []; // { id, from, to, give, want, giveCards, wantCards }
    this.tradeCounter = 0;
    this.coalitionOffers = []; // { id, from, to, zoneId, split: {from, to} } (DD-23)
    this.coalitionCounter = 0;
    this.turnCounter = 0; // total turns elapsed; used for timed effects (zone blocks)
    this.gerryBlocks = {}; // zoneId -> turnCounter at which the block lifts
    this.gerryMovesLeft = 0; // allowance, locked when GERRYMANDER is entered (DD-21)
    this.reactionContext = null; // { conspiracy, byId, victimId, targetSpec, resumePhase }
    this.pendingReaction = null; // public descriptor of the reaction window
    this.lastConspiracy = null; // { key, title, byId, summary }
    this.conspiracyCounter = 0;
    this.lastConspiracyTurn = 0; // turnCounter of the last conspiracy played (Informant, DD-22)
    this.reckoning = null; // { playerId, title, text } — set at endGame (DD-22)
    this.finalTurnsRemaining = null; // set when board fills
    this.winnerIds = null;
    this.addLog(
      mode === 'twoPlayer'
        ? 'Head to head. Both campaigns hold 8 resources — bid secretly for the first move.'
        : `Game started. Turn order drawn by lot: ${this.players
            .map((p) => p.name)
            .join(' → ')}. Later positions get more starting resources.`
    );
  }

  // ---------- helpers ----------

  addLog(msg) {
    // Monotonic count of every line ever logged, so clients can tell exactly which lines
    // in the trimmed window are new since their last state (notifications, highlights).
    this.logSeq = (this.logSeq || 0) + 1;
    this.log.push(msg);
    if (this.log.length > 100) this.log.shift();
  }

  get activePlayer() {
    return this.players[this.turnIndex];
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  drawVoterCard() {
    if (this.voterDeck.length === 0) {
      this.voterDeck = shuffle(this.voterDiscard, this.rng);
      this.voterDiscard = [];
    }
    return this.voterDeck.pop() || null;
  }

  drawIdeologyCard() {
    if (this.ideologyDeck.length === 0) {
      this.ideologyDeck = shuffle(this.ideologyDiscard, this.rng);
      this.ideologyDiscard = [];
    }
    const card = this.ideologyDeck.pop();
    // Coin-flip which answer shows as A, so position never gives away the ideology.
    if (card && this.rng() < 0.5) return { ...card, option_a: card.option_b, option_b: card.option_a };
    return card;
  }

  drawHeadlineCard() {
    if (this.headlineDeck.length === 0) {
      this.headlineDeck = shuffle(this.headlineDiscard, this.rng);
      this.headlineDiscard = [];
    }
    return this.headlineDeck.pop();
  }

  drawConspiracyCard() {
    if (this.conspiracyDeck.length === 0) {
      this.conspiracyDeck = shuffle(this.conspiracyDiscard, this.rng);
      this.conspiracyDiscard = [];
    }
    return this.conspiracyDeck.pop() || null;
  }

  getZone(zoneId) {
    return this.zones.find((z) => z.id === zoneId);
  }

  debtLocked(player) {
    return !!(player && player.iou && player.iou.debt > 0);
  }

  // ---------- manifesto perks: ideologue powers (L3/L5) (DD-21) ----------

  perkLevel(playerId, ideology) {
    const p = this.getPlayer(playerId);
    return p ? p.manifesto[ideology] : 0;
  }

  hasPerk(playerId, ideology, level) {
    return this.perkLevel(playerId, ideology) >= level;
  }

  // What this player's machine pays out each time they answer a policy (DD-21).
  passiveIncomeFor(player) {
    const out = { funds: 0, clout: 0, media: 0, trust: 0 };
    for (const ideo of IDEOLOGIES) out[IDEO_RES[ideo]] += Math.floor(player.manifesto[ideo] / 2);
    return out;
  }

  // Helping Hands (Believer L3): returns { cost, used } with up to (2 - already used)
  // single-resource discounts applied, min 0 per component. Pure — the caller commits
  // turnFlags.discounts only once the purchase actually goes through (DD-21).
  discountedCost(player, cost, discounts) {
    if (!discounts) return { cost: { ...cost }, used: 0 };
    if (!this.hasPerk(player.id, 'believer', 3)) throw new Error('Discounts require Believer level 3');
    const d = cleanResourceMap(discounts);
    const total = totalResources(d);
    if (total === 0) return { cost: { ...cost }, used: 0 };
    if (this.turnFlags.discounts + total > 2) throw new Error('Only 2 Helping Hands discounts per turn');
    const out = { ...cost };
    for (const [r, n] of Object.entries(d)) out[r] = Math.max(0, (out[r] || 0) - n);
    return { cost: out, used: total };
  }

  pegCount(zone, playerId) {
    return zone.slots.filter((id) => id === playerId).length;
  }

  emptySlots(zone) {
    return zone.slots.filter((s) => s === null).length;
  }

  emptyNormalIndices(zone) {
    const out = [];
    for (let i = 0; i < zone.slots.length; i++) {
      if (zone.slots[i] === null && i !== zone.volatileIndex) out.push(i);
    }
    return out;
  }

  // ---------- setup phase ----------

  pickStartingResource(playerId, resource) {
    if (this.phase !== 'SETUP_PICK') throw new Error('Not in setup phase');
    if (!RESOURCES.includes(resource)) throw new Error('Unknown resource');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('Unknown player');
    if (p.startingPicksRemaining <= 0) throw new Error('No starting picks left');
    p.resources[resource]++;
    p.startingPicksRemaining--;
    if (this.players.every((pl) => pl.startingPicksRemaining === 0)) {
      this.addLog('Starting resources chosen. The campaign begins.');
      this.beginPolicyPhase();
    }
  }

  // ---------- 2 Player setup: secret bid, then requirement placement (DD-26) ----------

  submitSetupBid(playerId, amount) {
    if (this.phase !== 'SETUP_BID') throw new Error('Not in the bidding step');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('Unknown player');
    if (this.setupBids[playerId] != null) throw new Error('Your bid is already in');
    if (!Number.isInteger(amount) || amount < 0 || amount > totalResources(p.resources)) {
      throw new Error('Bid between 0 and what you hold');
    }
    this.setupBids[playerId] = amount;
    this.addLog(`${p.name}'s bid is in.`);
    if (Object.keys(this.setupBids).length < 2) return;

    const [a, b] = this.players;
    const bidA = this.setupBids[a.id];
    const bidB = this.setupBids[b.id];
    if (bidA === bidB) {
      this.setupBids = {};
      this.addLog(`Both bid ${bidA} — tie. Bid again.`);
      return;
    }
    // Both bids are paid to the reserve; the higher bidder moves first.
    for (const pl of this.players) {
      let owed = this.setupBids[pl.id];
      for (const r of RESOURCES.slice().sort((x, y) => pl.resources[y] - pl.resources[x])) {
        const pay = Math.min(owed, pl.resources[r]);
        pl.resources[r] -= pay;
        owed -= pay;
        if (!owed) break;
      }
    }
    if (bidB > bidA) this.players.reverse();
    this.turnIndex = 0;
    this.addLog(
      `Bids revealed: ${a.name} ${bidA}, ${b.name} ${bidB}. ${this.players[0].name} takes the first move.`
    );
    // Requirement placement: the second player places first, alternating.
    this.phase = 'SETUP_REQUIREMENTS';
    this.reqPlacerIndex = 1;
    this.addLog(`${this.players[1].name} places the first zone requirement.`);
  }

  placeRequirement(playerId, cardId, zoneId) {
    if (this.phase !== 'SETUP_REQUIREMENTS') throw new Error('Not in requirement placement');
    const placer = this.players[this.reqPlacerIndex];
    if (playerId !== placer.id) throw new Error('Not your placement');
    const hand = this.reqHands[playerId];
    const card = hand.find((c) => c.id === cardId);
    if (!card) throw new Error('You do not hold that requirement card');
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error('Unknown zone');
    if (zone.requirement) throw new Error(`${zone.name} already has a requirement`);
    this.reqHands[playerId] = hand.filter((c) => c.id !== cardId);
    zone.requirement = { card, metBy: {} };
    // Zonal rules reshape the zone permanently the moment they land (DD-26).
    if (card.kind === 'zonalRule') {
      if (card.check === 'majorityPlus1') zone.majority += 1;
      if (card.check === 'majorityMinus1') zone.majority -= 1;
      // noGerrymander is consulted in isZoneBlocked.
    }
    this.addLog(`📜 ${placer.name} pins "${card.title}" on ${zone.name}.`);
    if (this.zones.every((z) => z.requirement)) {
      this.addLog('All seven constituencies have their terms. The campaign begins.');
      this.beginPolicyPhase();
      return;
    }
    this.reqPlacerIndex = 1 - this.reqPlacerIndex;
  }

  // Does `player` clear this zone's requirement for a majority award (DD-26)?
  requirementSatisfied(zone, player) {
    const req = zone.requirement;
    if (!req) return true;
    const card = req.card;
    if (card.kind === 'oneTime') {
      if (req.metBy[player.id]) return true;
      if (ONETIME_CHECKS[card.check](this, player)) {
        req.metBy[player.id] = true;
        this.addLog(`📜 ${player.name} has satisfied "${card.title}" in ${zone.name}.`);
        return true;
      }
      return false;
    }
    if (card.kind === 'onMajority') return ONMAJORITY_CHECKS[card.check](this, player, zone);
    return true; // zonalRule: enforced structurally, never blocks the award itself
  }

  // ---------- policy phase ----------

  beginPolicyPhase() {
    this.phase = 'POLICY';
    this.turnFlags = freshTurnFlags();
    this.currentCard = this.drawIdeologyCard();
    this.addLog(`${this.activePlayer.name}'s turn — policy question drawn: "${this.currentCard.question}"`);
  }

  // Card as clients may see it: rewards hidden until answered.
  publicCurrentCard() {
    if (!this.currentCard) return null;
    const c = this.currentCard;
    return {
      id: c.id,
      question: c.question,
      option_a: { text: c.option_a.text },
      option_b: { text: c.option_b.text },
    };
  }

  answerPolicy(playerId, choice) {
    if (this.phase !== 'POLICY') throw new Error('Not in policy phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    if (choice !== 'a' && choice !== 'b') throw new Error('Choice must be a or b');
    const opt = choice === 'a' ? this.currentCard.option_a : this.currentCard.option_b;
    const p = this.activePlayer;
    // Fixer (elite): policy rewards pay out double (DD-22).
    const mult = this.hasElite(p.id, 'fixer') ? 2 : 1;
    for (const [res, n] of Object.entries(opt.rewards)) p.resources[res] += n * mult;
    p.manifesto[opt.ideology]++;
    this.addLog(
      `${p.name} chose "${opt.text}" (+${Object.entries(opt.rewards)
        .map(([r, n]) => `${n * mult} ${RES_LABEL[r]}`)
        .join(', ')}${mult > 1 ? ' — Fixer double' : ''}, ${opt.ideology} card).`
    );
    // Enforcer (elite): every governing player skims 1 of the answerer's largest pile (DD-22).
    for (const m of this.players) {
      if (m.id === p.id || !this.hasElite(m.id, 'enforcer')) continue;
      const top = RESOURCES.slice().sort((a, b) => p.resources[b] - p.resources[a])[0];
      if (p.resources[top] > 0) {
        p.resources[top] -= 1;
        m.resources[top] += 1;
        this.addLog(`💰 ${p.name} pays 1 ${top} to ${m.name}'s machine (Enforcer).`);
      }
    }
    // Passive ideologue income: +1 home resource per 2 cards in each ideology (DD-21).
    const passive = [];
    for (const ideo of IDEOLOGIES) {
      const n = Math.floor(p.manifesto[ideo] / 2);
      if (n > 0) {
        p.resources[IDEO_RES[ideo]] += n;
        passive.push(`${n} ${IDEO_RES[ideo]}`);
      }
    }
    if (passive.length) {
      this.addLog(`${p.name}'s machine delivers: +${passive.join(', +')} (passive ideologue income).`);
    }
    this.ideologyDiscard.push(this.currentCard);
    this.lastAnsweredCard = {
      question: this.currentCard.question,
      chosen: opt,
      choice,
      options: { a: this.currentCard.option_a.text, b: this.currentCard.option_b.text },
    };
    this.currentCard = null;
    this.settleDebt(p); // new resources pay the bank first (DD-16)
    // Over the cap? Discard down to it at the START of your turn, before acting (DD-21).
    const over = totalResources(p.resources) - RESOURCE_CAP;
    if (over > 0) {
      this.phase = 'DISCARD';
      this.discardRequired = over;
      this.addLog(`${p.name} is over the cap and must discard ${over} before acting.`);
    } else {
      this.phase = 'ACTION';
    }
  }

  // ---------- action phase ----------

  canAfford(player, cost) {
    return Object.entries(cost).every(([r, n]) => player.resources[r] >= n);
  }

  buyVoterCard(playerId, hqIndex, zoneId, useVolatile = false, discounts = null, hold = false) {
    if (this.phase !== 'ACTION') throw new Error('Not in action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const card = this.hq[hqIndex];
    if (!card) throw new Error('No card at that HQ slot');
    const p = this.activePlayer;
    if (this.debtLocked(p)) throw new Error('You owe an IOU — pay it off before spending');
    if (hold && !this.hasElite(p.id, 'operator')) throw new Error('Only the Operator may hold voters in reserve');
    const { cost, used: discUsed } = this.discountedCost(p, card.cost, discounts); // Helping Hands (DD-21)
    if (!this.canAfford(p, cost)) throw new Error('Cannot afford this voter card');
    const zone = hold ? null : this.getZone(zoneId);
    if (!hold && !zone) throw new Error('Unknown zone');

    const normal = hold ? [] : this.emptyNormalIndices(zone);
    const volatileFree = hold ? false : zone.slots[zone.volatileIndex] === null;
    const capacity = normal.length + (useVolatile && volatileFree ? 1 : 0);
    if (!hold && capacity <= 0) {
      throw new Error(
        volatileFree
          ? 'Only the Volatile Area remains — you must opt into it'
          : 'That constituency is full'
      );
    }

    // Pay
    for (const [r, n] of Object.entries(cost)) p.resources[r] -= n;
    this.turnFlags.discounts += discUsed; // commit Helping Hands allowance now the buy is real

    // Going Viral — Icon L3: +1 voter on a buy, up to twice per turn (DD-21).
    let voters = card.voters;
    if (this.hasPerk(p.id, 'icon', 3) && this.turnFlags.viral < 2) {
      voters += 1;
      this.turnFlags.viral++;
      this.addLog(`${p.name}'s campaign goes viral — one extra voter turns out.`);
    }

    // Operator (elite): bank the whole bloc on the mat instead of seating it (DD-22).
    if (hold) {
      p.benched = (p.benched || 0) + voters;
      p.benchDeadline = this.turnCounter + this.players.length; // held indefinitely while Operator active
      this.voterDiscard.push(card);
      this.hq[hqIndex] = this.drawVoterCard();
      this.addLog(`🗄 ${p.name} holds ${voters} voter${voters === 1 ? '' : 's'} in reserve (Operator).`);
      this.backerPayout(p, card);
      return { placed: 0, discarded: 0, hitVolatile: false, held: voters };
    }

    // Place: all voters from one card go to ONE zone (DD-3); excess beyond capacity discarded.
    let placed = Math.min(voters, capacity);
    let remaining = placed;
    let hitVolatile = false;
    if (useVolatile && volatileFree && remaining > 0) {
      zone.slots[zone.volatileIndex] = p.id;
      remaining--;
      hitVolatile = true;
      this.pendingHeadlines.push({ zoneId: zone.id, victimId: p.id });
    }
    for (let i = 0; i < remaining; i++) zone.slots[normal[i]] = p.id;
    const discarded = voters - placed;

    this.voterDiscard.push(card);
    this.hq[hqIndex] = this.drawVoterCard();

    this.addLog(
      `${p.name} influenced ${placed} voter${placed > 1 ? 's' : ''} in ${zone.name}` +
        (hitVolatile ? ' — one entered the Volatile Area! A Headline will drop at turn end' : '') +
        (discarded > 0 ? ` (${discarded} lost — no room)` : '') +
        '.'
    );

    this.backerPayout(p, card);
    this.checkMajority(zone);
    this.checkBoardFull();
    this.checkAllZonesCaptured();
    return { placed, discarded, hitVolatile };
  }

  // Backer (elite): when a rival they backed influences a 3-voter card, the Backer banks
  // one voter of their own (DD-22). `buyer` made the purchase of `card`.
  backerPayout(buyer, card) {
    if (card.voters < 3) return;
    for (const q of this.players) {
      if (q.id === buyer.id) continue;
      if (!this.hasElite(q.id, 'backer')) continue;
      if (!(q.backerTargets || []).includes(buyer.id)) continue;
      q.benched = (q.benched || 0) + 1;
      q.benchDeadline = this.turnCounter + this.players.length;
      this.addLog(`🎩 ${q.name} collects a voter as ${buyer.name} campaigns (Backer).`);
    }
  }

  // Majorities can be established, broken (flip-back), and re-established (DD-9 lifted).
  checkMajority(zone) {
    // A coalition holds the zone jointly; it dissolves if the combined pegs slip below
    // the threshold, and no solo majority can be awarded while it stands (DD-23).
    if (zone.coalition) {
      const { a, b } = zone.coalition;
      if (this.pegCount(zone, a) + this.pegCount(zone, b) < zone.majority) {
        this.addLog(
          `💔 The ${this.getPlayer(a).name}–${this.getPlayer(b).name} coalition in ${zone.name} collapses — not enough voters.`
        );
        zone.coalition = null;
      } else {
        return;
      }
    }
    const prev = zone.majorityOwner;
    if (prev && this.pegCount(zone, prev) < zone.majority) {
      zone.majorityOwner = null;
      this.getPlayer(prev).majoritiesLost++; // feeds the Untouchable objective (DD-25)
      this.addLog(`💥 ${this.getPlayer(prev).name}'s majority in ${zone.name} is broken!`);
    }
    if (!zone.majorityOwner) {
      for (const p of this.players) {
        if (this.pegCount(zone, p.id) >= zone.majority) {
          // 2 Player zone requirements gate the award (DD-26).
          if (!this.requirementSatisfied(zone, p)) {
            const req = zone.requirement;
            const key = `${p.id}:${this.turnCounter}`;
            if (req.lastBlockLog !== key) {
              req.lastBlockLog = key;
              this.addLog(
                `📜 ${p.name} has the numbers in ${zone.name} but not the terms — "${req.card.title}" withholds the majority.`
              );
            }
            continue;
          }
          zone.majorityOwner = p.id;
          if (p.id !== prev) this.addLog(`🏛 ${p.name} captured ${zone.name}!`);
          return;
        }
      }
    }
  }

  checkAllZonesCaptured() {
    if (this.phase === 'GAME_OVER') return;
    if (this.zones.every((z) => z.majorityOwner || z.coalition)) {
      this.addLog('All nine constituencies captured — the election is called.');
      this.endGame();
    }
  }

  checkBoardFull() {
    if (this.finalTurnsRemaining !== null || this.phase === 'GAME_OVER') return;
    if (this.zones.every((z) => this.emptySlots(z) === 0)) {
      this.finalTurnsRemaining = this.players.length;
      this.addLog('The board is full! Every player gets one final turn.');
    }
  }

  // ---------- trading (DD-5) ----------

  tradingOpen() {
    return TRADE_PHASES.includes(this.phase);
  }

  // Validate a list of conspiracy card ids the player must currently hold; returns the cards.
  cleanCardList(player, cardIds) {
    if (cardIds == null) return [];
    if (!Array.isArray(cardIds)) throw new Error('Invalid card list');
    const cards = [];
    for (const id of cardIds) {
      const card = this.findConspiracy(player, id);
      if (!card) throw new Error('You do not hold one of those cards');
      if (cards.includes(card)) throw new Error('Duplicate card in offer');
      cards.push(card);
    }
    return cards;
  }

  proposeTrade(playerId, toId, give, want, giveCards = [], wantCards = []) {
    if (!this.tradingOpen()) throw new Error('Trading is closed right now');
    const from = this.getPlayer(playerId);
    const to = this.getPlayer(toId);
    if (!from || !to) throw new Error('Unknown player');
    if (from.id === to.id) throw new Error('Cannot trade with yourself');
    // Trades happen on the active player's turn: they are always one side of the deal.
    if (from.id !== this.activePlayer.id && to.id !== this.activePlayer.id) {
      throw new Error('Trades must involve the active player');
    }
    const g = cleanResourceMap(give);
    const w = cleanResourceMap(want);
    const gc = this.cleanCardList(from, giveCards).map((c) => c.id);
    const wc = this.cleanCardList(to, wantCards).map((c) => c.id);
    // Trades need not be equitable (e.g. 1:3), but neither side may be empty — no giveaways.
    const giveTotal = totalResources(g) + gc.length;
    const wantTotal = totalResources(w) + wc.length;
    if (giveTotal < 1) throw new Error('Offer something');
    if (wantTotal < 1) throw new Error('Ask for something in return');
    if (!this.canAfford(from, g)) throw new Error('You do not hold what you are offering');

    // One open offer per proposer→target pair; a new one replaces it.
    this.tradeOffers = this.tradeOffers.filter((o) => !(o.from === from.id && o.to === to.id));
    const offer = { id: 't' + ++this.tradeCounter, from: from.id, to: to.id, give: g, want: w, giveCards: gc, wantCards: wc };
    this.tradeOffers.push(offer);
    this.addLog(`${from.name} proposed a trade to ${to.name}.`);
    return offer;
  }

  respondTrade(playerId, offerId, accept) {
    const offer = this.tradeOffers.find((o) => o.id === offerId);
    if (!offer) throw new Error('That offer is gone');
    if (offer.to !== playerId) throw new Error('This offer is not addressed to you');
    this.tradeOffers = this.tradeOffers.filter((o) => o.id !== offerId);
    const from = this.getPlayer(offer.from);
    const to = this.getPlayer(offer.to);
    if (!accept) {
      this.addLog(`${to.name} declined ${from.name}'s trade.`);
      return;
    }
    if (!this.tradingOpen()) throw new Error('Trading is closed right now');
    if (from.id !== this.activePlayer.id && to.id !== this.activePlayer.id) {
      throw new Error('Trades must involve the active player');
    }
    if (!this.canAfford(from, offer.give)) throw new Error(`${from.name} no longer holds their side`);
    if (!this.canAfford(to, offer.want)) throw new Error('You do not hold what they asked for');
    const giveCards = this.cleanCardList(from, offer.giveCards);
    const wantCards = this.cleanCardList(to, offer.wantCards);
    for (const [r, n] of Object.entries(offer.give)) {
      from.resources[r] -= n;
      to.resources[r] += n;
    }
    for (const [r, n] of Object.entries(offer.want)) {
      to.resources[r] -= n;
      from.resources[r] += n;
    }
    from.conspiracies = from.conspiracies.filter((c) => !giveCards.includes(c));
    to.conspiracies = to.conspiracies.filter((c) => !wantCards.includes(c));
    from.conspiracies.push(...wantCards);
    to.conspiracies.push(...giveCards);
    this.settleDebt(from); // received resources pay any IOU first (DD-16)
    this.settleDebt(to);
    const fmt = (m, cards) =>
      [
        ...Object.entries(m).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${RES_LABEL[r]}`),
        ...cards.map((c) => c.title),
      ].join(' + ') || 'nothing';
    this.addLog(
      `🤝 Trade locked: ${from.name} gave ${fmt(offer.give, giveCards)} to ${to.name} for ${fmt(offer.want, wantCards)}.`
    );
  }

  cancelTrade(playerId, offerId) {
    const offer = this.tradeOffers.find((o) => o.id === offerId);
    if (!offer) throw new Error('That offer is gone');
    if (offer.from !== playerId) throw new Error('Only the proposer can cancel');
    this.tradeOffers = this.tradeOffers.filter((o) => o.id !== offerId);
    this.addLog(`${this.getPlayer(playerId).name} withdrew a trade offer.`);
  }

  // ---------- coalitions (DD-23) ----------

  // A player's most-held ideology; ties break by IDEOLOGIES order. Null if manifesto empty.
  mostHeldIdeology(player) {
    const best = IDEOLOGIES.slice().sort(
      (a, b) => player.manifesto[b] - player.manifesto[a] || IDEOLOGIES.indexOf(a) - IDEOLOGIES.indexOf(b)
    )[0];
    return player.manifesto[best] > 0 ? best : null;
  }

  // The coalition-locked slot indices of a zone: the first split.a of a's pegs and the
  // first split.b of b's — exactly the pegs forming the joint majority. Immune to being
  // moved or targeted, like solo majority pegs (DD-23).
  coalitionLockedSlots(zone) {
    if (!zone.coalition) return new Set();
    const { a, b, split } = zone.coalition;
    const locked = new Set();
    const want = { [a]: split.a, [b]: split.b };
    for (let i = 0; i < zone.slots.length; i++) {
      const owner = zone.slots[i];
      if (owner != null && want[owner] > 0) {
        locked.add(i);
        want[owner]--;
      }
    }
    return locked;
  }

  validateCoalitionOffer(from, to, zone, split) {
    if (this.players.length < 3) throw new Error('Coalitions need at least 3 players in the game');
    if (!from || !to) throw new Error('Unknown player');
    if (from.id === to.id) throw new Error('Ally with an opponent, not yourself');
    if (!zone) throw new Error('Unknown zone');
    if (zone.majorityOwner) throw new Error(`${zone.name} is already captured`);
    if (zone.coalition) throw new Error(`${zone.name} already has a coalition`);
    if (!split || !Number.isInteger(split.from) || !Number.isInteger(split.to)) {
      throw new Error('Invalid peg split');
    }
    if (split.from < 1 || split.to < 1) throw new Error('Both partners must contribute voters');
    if (split.from + split.to !== zone.majority) {
      throw new Error(`The split must add up to ${zone.majority} voters`);
    }
    if (this.pegCount(zone, from.id) < split.from) {
      throw new Error(`${from.name} does not have ${split.from} voters in ${zone.name}`);
    }
    if (this.pegCount(zone, to.id) < split.to) {
      throw new Error(`${to.name} does not have ${split.to} voters in ${zone.name}`);
    }
    // Forming a coalition costs each partner one card of their most-held ideology.
    if (!this.mostHeldIdeology(from)) throw new Error(`${from.name} has no ideology card to exchange`);
    if (!this.mostHeldIdeology(to)) throw new Error(`${to.name} has no ideology card to exchange`);
  }

  proposeCoalition(playerId, toId, zoneId, split) {
    if (!this.tradingOpen()) throw new Error('Coalitions form while trading is open');
    const from = this.getPlayer(playerId);
    const to = this.getPlayer(toId);
    // Like trades, deals happen on the active player's turn (DD-11).
    if (from && to && from.id !== this.activePlayer.id && to.id !== this.activePlayer.id) {
      throw new Error('Coalitions must involve the active player');
    }
    const zone = this.getZone(zoneId);
    this.validateCoalitionOffer(from, to, zone, split);
    // One open coalition offer per proposer→target pair; a new one replaces it.
    this.coalitionOffers = this.coalitionOffers.filter((o) => !(o.from === from.id && o.to === to.id));
    const offer = {
      id: 'c' + ++this.coalitionCounter,
      from: from.id,
      to: to.id,
      zoneId: zone.id,
      split: { from: split.from, to: split.to },
    };
    this.coalitionOffers.push(offer);
    this.addLog(`${from.name} proposed a coalition with ${to.name} in ${zone.name}.`);
    return offer;
  }

  respondCoalition(playerId, offerId, accept) {
    const offer = this.coalitionOffers.find((o) => o.id === offerId);
    if (!offer) throw new Error('That offer is gone');
    if (offer.to !== playerId) throw new Error('This offer is not addressed to you');
    this.coalitionOffers = this.coalitionOffers.filter((o) => o.id !== offerId);
    const from = this.getPlayer(offer.from);
    const to = this.getPlayer(offer.to);
    if (!accept) {
      this.addLog(`${to.name} declined ${from.name}'s coalition.`);
      return;
    }
    if (!this.tradingOpen()) throw new Error('Coalitions form while trading is open');
    if (from.id !== this.activePlayer.id && to.id !== this.activePlayer.id) {
      throw new Error('Coalitions must involve the active player');
    }
    const zone = this.getZone(offer.zoneId);
    this.validateCoalitionOffer(from, to, zone, offer.split);
    // Each partner hands the other one card of their most-held ideology. The cards are
    // NOT returned if the coalition later breaks — powers de-level automatically (DD-23).
    const fromIdeo = this.mostHeldIdeology(from);
    const toIdeo = this.mostHeldIdeology(to);
    from.manifesto[fromIdeo]--;
    to.manifesto[fromIdeo]++;
    to.manifesto[toIdeo]--;
    from.manifesto[toIdeo]++;
    zone.coalition = { a: from.id, b: to.id, split: { a: offer.split.from, b: offer.split.to } };
    this.addLog(
      `🤝🏛 ${from.name} and ${to.name} form a coalition and capture ${zone.name} ` +
        `(${offer.split.from}/${offer.split.to} split; exchanged a ${fromIdeo} card for a ${toIdeo} card).`
    );
    this.checkAllZonesCaptured();
  }

  cancelCoalition(playerId, offerId) {
    const offer = this.coalitionOffers.find((o) => o.id === offerId);
    if (!offer) throw new Error('That offer is gone');
    if (offer.from !== playerId) throw new Error('Only the proposer can cancel');
    this.coalitionOffers = this.coalitionOffers.filter((o) => o.id !== offerId);
    this.addLog(`${this.getPlayer(playerId).name} withdrew a coalition offer.`);
  }

  // Either partner may walk out on their own turn, at no cost. Exchanged cards stay
  // exchanged (DD-23).
  withdrawCoalition(playerId, zoneId) {
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error('Unknown zone');
    if (!zone.coalition) throw new Error('No coalition in that constituency');
    const { a, b } = zone.coalition;
    if (playerId !== a && playerId !== b) throw new Error('You are not in that coalition');
    if (playerId !== this.activePlayer.id) throw new Error('Withdraw on your own turn');
    if (!['POLICY', 'ACTION', 'GERRYMANDER'].includes(this.phase)) {
      throw new Error('Withdraw during your policy, action or gerrymander phase');
    }
    const partner = this.getPlayer(playerId === a ? b : a);
    zone.coalition = null;
    this.addLog(
      `💔 ${this.getPlayer(playerId).name} walks out of the coalition with ${partner.name} in ${zone.name}.`
    );
    this.checkMajority(zone); // a solo majority may now stand
    this.checkAllZonesCaptured();
  }

  // ---------- conspiracies (DD-14, DD-15) ----------

  conspiraciesOpen() {
    return CONSPIRACY_PHASES.includes(this.phase);
  }

  findConspiracy(player, cardId) {
    return player.conspiracies.find((c) => c.id === cardId);
  }

  // Price is the TOP deck card's own price (4 or 5), payable in any resource mix (DD-21).
  buyConspiracy(playerId, payment, discounts = null) {
    if (this.phase !== 'ACTION') throw new Error('Not in action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (this.debtLocked(p)) throw new Error('You owe an IOU — pay it before spending');
    if (this.conspiracyDeck.length === 0) throw new Error('The conspiracy deck is empty');
    let required = this.conspiracyDeck[this.conspiracyDeck.length - 1].price;
    // Agitator (elite): conspiracies cost 2 less, up to twice per turn (DD-22).
    const agit = this.hasElite(p.id, 'agitator') && this.turnFlags.agitator < 2;
    if (agit) required = Math.max(0, required - 2);
    // Helping Hands (Believer L3): each discount shaves 1 off the price this turn.
    let discUsed = 0;
    if (discounts) {
      if (!this.hasPerk(p.id, 'believer', 3)) throw new Error('Discounts require Believer level 3');
      discUsed = totalResources(cleanResourceMap(discounts));
      if (this.turnFlags.discounts + discUsed > 2) throw new Error('Only 2 Helping Hands discounts per turn');
      required = Math.max(0, required - discUsed);
    }
    const pay = cleanResourceMap(payment);
    if (totalResources(pay) !== required) throw new Error(`Pay exactly ${required} in any mix`);
    if (!this.canAfford(p, pay)) throw new Error('You do not hold that payment');
    const card = this.drawConspiracyCard();
    for (const [r, n] of Object.entries(pay)) p.resources[r] -= n;
    this.turnFlags.discounts += discUsed;
    if (agit) this.turnFlags.agitator++;
    p.conspiracies.push(card);
    this.addLog(`${p.name} bought a conspiracy card (paid ${totalResources(pay)} across resources).`);
    return { card };
  }

  // The opponent a play victimises (and who may react to it), or null.
  conspiracyVictim(card, targetSpec) {
    switch (card.target) {
      case 'player':
      case 'playerRes':
        return targetSpec && targetSpec.playerId ? this.getPlayer(targetSpec.playerId) : null;
      case 'opponentPeg': {
        if (!targetSpec) return null;
        const zone = this.getZone(targetSpec.zoneId);
        if (!zone) return null;
        const owner = zone.slots[targetSpec.slotIndex];
        return owner ? this.getPlayer(owner) : null;
      }
      case 'zone': {
        if (!targetSpec) return null;
        const zone = this.getZone(targetSpec.zoneId);
        return zone && zone.majorityOwner ? this.getPlayer(zone.majorityOwner) : null;
      }
      default:
        return null;
    }
  }

  // Validate targetSpec before committing; throws on illegal targets.
  validateConspiracyTarget(card, caster, targetSpec) {
    switch (card.target) {
      case 'none':
        return;
      case 'player':
      case 'playerRes': {
        const t = targetSpec && this.getPlayer(targetSpec.playerId);
        if (!t) throw new Error('Pick a target player');
        if (t.id === caster.id) throw new Error('You cannot target yourself');
        if (card.target === 'playerRes') {
          if (!RESOURCES.includes(targetSpec.res)) throw new Error('Pick a resource to take');
        }
        return;
      }
      case 'opponentPeg': {
        if (!targetSpec) throw new Error('Pick a voter to target');
        const zone = this.getZone(targetSpec.zoneId);
        if (!zone) throw new Error('Unknown zone');
        const owner = zone.slots[targetSpec.slotIndex];
        if (owner == null) throw new Error('No voter in that spot');
        if (owner === caster.id) throw new Error('That is your own voter');
        if (targetSpec.slotIndex === zone.volatileIndex) throw new Error('Volatile voters are protected');
        if (owner === zone.majorityOwner) throw new Error('Majority voters are protected');
        if (this.coalitionLockedSlots(zone).has(targetSpec.slotIndex)) {
          throw new Error('Coalition voters are protected');
        }
        return;
      }
      case 'zone': {
        const zone = targetSpec && this.getZone(targetSpec.zoneId);
        if (!zone) throw new Error('Pick a constituency');
        return;
      }
      case 'hqCard': {
        if (!targetSpec || !this.hq[targetSpec.hqIndex]) throw new Error('Pick an HQ card');
        return;
      }
      default:
        throw new Error('Unknown conspiracy target');
    }
  }

  // Conspiracies play on your own action/gerrymander phase, OR — for non-active players —
  // in the POLICY window before the active player answers ("between turns", DD-21).
  playConspiracy(playerId, cardId, targetSpec = null) {
    const isActive = playerId === this.activePlayer.id;
    if (isActive && !['ACTION', 'GERRYMANDER'].includes(this.phase))
      throw new Error('Play conspiracies during your action or gerrymander phase');
    if (!isActive && this.phase !== 'POLICY')
      throw new Error('Others may only play conspiracies before the active player answers');
    const caster = this.getPlayer(playerId);
    if (!caster) throw new Error('Unknown player');
    const card = this.findConspiracy(caster, cardId);
    if (!card) throw new Error('You do not hold that card');
    if (card.reaction) throw new Error('Reaction cards can only be played in response to a conspiracy');
    this.validateConspiracyTarget(card, caster, targetSpec);

    // Offer a reaction window if the victim can defend themselves.
    const victim = card.cancellable ? this.conspiracyVictim(card, targetSpec) : null;
    if (victim && victim.conspiracies.some((c) => c.reaction)) {
      caster.conspiracies = caster.conspiracies.filter((c) => c.id !== cardId);
      this.reactionContext = {
        conspiracy: card,
        byId: caster.id,
        victimId: victim.id,
        targetSpec,
        resumePhase: this.phase,
      };
      this.pendingReaction = {
        conspiracyTitle: card.title,
        conspiracyEffect: card.effect, // lets the victim's client explain what's coming
        conspiracyTarget: card.target,
        byId: caster.id,
        byName: caster.name,
        victimId: victim.id,
        victimName: victim.name,
      };
      this.phase = 'REACTION';
      this.addLog(`${caster.name} played ${card.title} on ${victim.name} — awaiting their response…`);
      return { pendingReaction: true };
    }

    this.commitConspiracy(card, caster, targetSpec);
    return { pendingReaction: false };
  }

  respondReaction(playerId, cardId) {
    if (this.phase !== 'REACTION' || !this.reactionContext) throw new Error('No reaction pending');
    const ctx = this.reactionContext;
    if (playerId !== ctx.victimId) throw new Error('This reaction is not yours to make');
    const victim = this.getPlayer(ctx.victimId);
    const caster = this.getPlayer(ctx.byId);
    this.phase = ctx.resumePhase;
    this.reactionContext = null;
    this.pendingReaction = null;

    if (cardId) {
      const react = this.findConspiracy(victim, cardId);
      if (!react || !react.reaction) {
        // Restore the window rather than silently swallowing a bad response.
        this.phase = 'REACTION';
        this.reactionContext = ctx;
        this.pendingReaction = {
          conspiracyTitle: ctx.conspiracy.title,
          conspiracyEffect: ctx.conspiracy.effect,
          conspiracyTarget: ctx.conspiracy.target,
          byId: caster.id,
          byName: caster.name,
          victimId: victim.id,
          victimName: victim.name,
        };
        throw new Error('That is not a reaction card');
      }
      victim.conspiracies = victim.conspiracies.filter((c) => c.id !== cardId);
      this.conspiracyDiscard.push(react, ctx.conspiracy);
      this.recordConspiracy(caster, `${ctx.conspiracy.title} was cancelled by ${victim.name}'s ${react.title}!`);
      this.addLog(`🛡 ${victim.name} played ${react.title} — ${ctx.conspiracy.title} is cancelled.`);
      return;
    }

    // Passed: the conspiracy resolves.
    this.addLog(`${victim.name} let it happen.`);
    this.commitConspiracy(ctx.conspiracy, caster, ctx.targetSpec);
  }

  // Apply an already-validated conspiracy and clean up.
  commitConspiracy(card, caster, targetSpec) {
    caster.conspiracies = caster.conspiracies.filter((c) => c.id !== card.id);
    caster.conspiraciesPlayed++; // feeds the Deep State objective (DD-25)
    const summary = this.applyConspiracy(card, caster, targetSpec);
    this.conspiracyDiscard.push(card);
    this.recordConspiracy(caster, summary);
    this.addLog(`🎭 ${caster.name} played ${card.title} — ${summary}`);
    this.lastConspiracyTurn = this.turnCounter; // resets the Informant's "dry round" clock (DD-22)
    this.informantStrike(caster.id);
    this.checkAllZonesCaptured();
  }

  // Informant (elite): when a rival plays a conspiracy, each active Informant
  // removes one of the caster's exposed (non-majority, non-volatile) voters (DD-22).
  informantStrike(casterId) {
    for (const w of this.players) {
      if (w.id === casterId || !this.hasElite(w.id, 'informant')) continue;
      let best = null;
      let bestN = 0;
      for (const z of this.zones) {
        if (z.majorityOwner === casterId) continue; // majority pegs are protected
        let n = 0;
        let idx = -1;
        for (let i = 0; i < z.slots.length; i++) {
          if (i === z.volatileIndex) continue;
          if (z.slots[i] === casterId) {
            n++;
            if (idx < 0) idx = i;
          }
        }
        if (n > bestN) {
          bestN = n;
          best = { z, idx };
        }
      }
      if (best) {
        best.z.slots[best.idx] = null;
        this.checkMajority(best.z);
        this.addLog(`🚨 ${w.name} exposes ${this.getPlayer(casterId).name} — a voter in ${best.z.name} is removed (Informant).`);
      }
    }
  }

  recordConspiracy(caster, summary) {
    this.lastConspiracy = {
      key: ++this.conspiracyCounter,
      title: null,
      byId: caster.id,
      summary,
    };
  }

  applyConspiracy(card, p, targetSpec) {
    return this.applyEffect(card.effect, p, targetSpec);
  }

  // Shared typed-effect resolver used by conspiracies, elite plays and home turfs (DD-24).
  applyEffect(e, p, targetSpec) {
    switch (e.type) {
      case 'steal': {
        const t = this.getPlayer(targetSpec.playerId);
        const res = targetSpec.res;
        const taken = Math.min(t.resources[res], e.n);
        t.resources[res] -= taken;
        p.resources[res] += taken;
        return `${p.name} took ${taken} ${res} from ${t.name}.`;
      }
      case 'burn': {
        const t = this.getPlayer(targetSpec.playerId);
        const top = RESOURCES.slice().sort((a, b) => t.resources[b] - t.resources[a])[0];
        const lost = Math.min(t.resources[top], e.n);
        t.resources[top] -= lost;
        return `${t.name} lost ${lost} ${top}.`;
      }
      case 'gain': {
        for (const [r, n] of Object.entries(e.resources)) p.resources[r] += n;
        return `${p.name} gained ${Object.entries(e.resources).map(([r, n]) => `${n} ${RES_LABEL[r]}`).join(', ')}.`;
      }
      case 'gainEach': {
        for (const r of RESOURCES) p.resources[r] += 1;
        return `${p.name} gained 1 of every resource.`;
      }
      case 'removePeg': {
        const zone = this.getZone(targetSpec.zoneId);
        const owner = zone.slots[targetSpec.slotIndex];
        zone.slots[targetSpec.slotIndex] = null;
        this.checkMajority(zone);
        return `removed one of ${this.getPlayer(owner).name}'s voters from ${zone.name}.`;
      }
      case 'convertPeg': {
        const zone = this.getZone(targetSpec.zoneId);
        const owner = zone.slots[targetSpec.slotIndex];
        zone.slots[targetSpec.slotIndex] = p.id;
        this.checkMajority(zone);
        return `turned one of ${this.getPlayer(owner).name}'s voters in ${zone.name} to ${p.name}.`;
      }
      case 'blockZone': {
        const zone = this.getZone(targetSpec.zoneId);
        this.gerryBlocks[zone.id] = this.turnCounter + this.players.length;
        return `${zone.name} is frozen against gerrymandering for a round.`;
      }
      case 'peekVoter': {
        const top = this.voterDeck[this.voterDeck.length - 1] || null;
        p.peek = top ? { kind: 'voter', card: top } : { kind: 'voter', card: null };
        return `${p.name} peeked at the next voter card.`;
      }
      case 'cycleHq': {
        const old = this.hq[targetSpec.hqIndex];
        if (old) this.voterDiscard.push(old);
        this.hq[targetSpec.hqIndex] = this.drawVoterCard();
        return `${p.name} cycled an HQ card.`;
      }
      case 'drawConspiracy': {
        let drawn = 0;
        for (let i = 0; i < e.n; i++) {
          const c = this.drawConspiracyCard();
          if (!c) break;
          p.conspiracies.push(c);
          drawn++;
        }
        return `${p.name} drew ${drawn} conspiracy card${drawn === 1 ? '' : 's'}.`;
      }
      case 'addPegs': {
        // Zone-targeted free placement (used by elites; DD-19).
        const zone = this.getZone(targetSpec.zoneId);
        const spots = this.emptyNormalIndices(zone);
        const placed = Math.min(e.n, spots.length);
        for (let i = 0; i < placed; i++) zone.slots[spots[i]] = p.id;
        this.checkMajority(zone);
        this.checkBoardFull();
        return placed > 0
          ? `${p.name} seats ${placed} free voter${placed === 1 ? '' : 's'} in ${zone.name}.`
          : `${zone.name} has no room — nothing happens.`;
      }
      default:
        return 'nothing happened.';
    }
  }

  // ---------- home turfs (mode `homeTurfs`, DD-24) ----------

  turfForZone(zoneId) {
    return HOME_TURFS.find((t) => t.zoneId === zoneId);
  }

  // Use a held zone's turf power: requires Gerrymandering Rights there (majority owner),
  // once per turn, during your own ACTION or GERRYMANDER phase.
  useHomeTurf(playerId, zoneId, targetSpec = null) {
    if (this.mode !== 'homeTurfs') throw new Error('Home turfs are not in play');
    if (!['ACTION', 'GERRYMANDER'].includes(this.phase)) {
      throw new Error('Use turf powers during your action or gerrymander phase');
    }
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error('Unknown zone');
    const turf = this.turfForZone(zoneId);
    if (!turf) throw new Error('That constituency has no turf power');
    if (zone.majorityOwner !== playerId) {
      throw new Error('Turf powers need Gerrymandering Rights in the zone');
    }
    if (this.turfUsed[zoneId] === this.turnCounter) {
      throw new Error('That turf power was already used this turn');
    }
    const p = this.activePlayer;
    if (turf.target === 'self') targetSpec = { playerId: p.id };
    else this.validateConspiracyTarget({ target: turf.target }, p, targetSpec);
    const summary = this.applyEffect(turf.effect, p, targetSpec);
    this.turfUsed[zoneId] = this.turnCounter;
    this.addLog(`🏘 ${p.name} works ${turf.title} (${zone.name}) — ${summary}`);
    this.checkAllZonesCaptured();
  }

  // Compulsory turfs fire on their own at the end of the holder's turn if unused (DD-24).
  fireCompulsoryTurfs(playerId) {
    if (this.mode !== 'homeTurfs') return;
    for (const zone of this.zones) {
      if (zone.majorityOwner !== playerId) continue;
      const turf = this.turfForZone(zone.id);
      if (!turf || !turf.compulsory) continue;
      if (this.turfUsed[zone.id] === this.turnCounter) continue;
      const p = this.getPlayer(playerId);
      const spec = turf.target === 'self' ? { playerId } : null;
      const summary = this.applyEffect(turf.effect, p, spec);
      this.turfUsed[zone.id] = this.turnCounter;
      this.addLog(`🏘 ${turf.title} (${zone.name}) stirs on its own — ${summary}`);
    }
  }

  // ---------- gerrymandering (DD-9 unlock) ----------

  isZoneBlocked(zoneId) {
    const zone = this.getZone(zoneId);
    // The Fortress zonal rule freezes its zone permanently (DD-26).
    if (zone && zone.requirement && zone.requirement.card.check === 'noGerrymander') return true;
    const until = this.gerryBlocks[zoneId];
    return until != null && this.turnCounter < until;
  }

  // Zones a player may gerrymander between: for each majority zone Z, the set {Z} ∪ adj(Z).
  gerrymanderSets(playerId) {
    return this.zones
      .filter((z) => z.majorityOwner === playerId)
      .map((z) => [z.id, ...z.adjacent]);
  }

  hasMajority(playerId) {
    return this.zones.some((z) => z.majorityOwner === playerId);
  }

  endTurn(playerId) {
    if (this.phase !== 'ACTION') throw new Error('Not in action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    this.fireCompulsoryTurfs(playerId); // unused compulsory turfs go off by themselves (DD-24)
    if (this.phase === 'GAME_OVER') return;
    if (this.hasMajority(playerId)) {
      this.phase = 'GERRYMANDER';
      const majorities = this.zones.filter((z) => z.majorityOwner === playerId).length;
      // One move per majority held; Election Fever (Icon L5) doubles it (DD-21).
      // Allowance is LOCKED at entry — mid-phase majority changes do not recount.
      this.gerryMovesLeft = majorities * (this.hasPerk(playerId, 'icon', 5) ? 2 : 1);
      this.addLog(
        `${this.activePlayer.name} holds a majority — gerrymandering unlocked — ${this.gerryMovesLeft} move(s).`
      );
      return;
    }
    this.finishTurn();
  }

  // toVolatile: drop the peg into the destination's Volatile Area — the trap play (DD-20).
  // The trapped peg's owner suffers a headline at the end of this turn.
  gerrymander(playerId, fromZoneId, slotIndex, toZoneId, toVolatile = false) {
    if (this.phase !== 'GERRYMANDER') throw new Error('Not in gerrymander phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const from = this.getZone(fromZoneId);
    const to = this.getZone(toZoneId);
    if (!from || !to) throw new Error('Unknown zone');
    if (from.id === to.id) throw new Error('Pick two different zones');
    const legal = this.gerrymanderSets(playerId).some(
      (set) => set.includes(from.id) && set.includes(to.id)
    );
    if (!legal) throw new Error('Both zones must border a constituency you hold');
    if (this.isZoneBlocked(from.id)) throw new Error(`${from.name} is frozen against gerrymandering`);
    if (this.isZoneBlocked(to.id)) throw new Error(`${to.name} is frozen against gerrymandering`);
    const pegOwner = from.slots[slotIndex];
    if (pegOwner == null) throw new Error('No voter in that spot');
    if (slotIndex === from.volatileIndex) throw new Error('Volatile Area voters cannot be moved');
    // Election Fever (Icon L5) lets the mover shift majority pegs too (DD-21).
    if (pegOwner === from.majorityOwner && !this.hasPerk(playerId, 'icon', 5)) {
      throw new Error('Majority voters cannot be moved');
    }
    // Coalition majority pegs are immune to movement — even Election Fever (DD-23).
    if (this.coalitionLockedSlots(from).has(slotIndex)) {
      throw new Error('Coalition voters cannot be moved');
    }

    if (toVolatile) {
      if (to.slots[to.volatileIndex] !== null) throw new Error('That Volatile Area is occupied');
      from.slots[slotIndex] = null;
      to.slots[to.volatileIndex] = pegOwner;
      if (pegOwner !== playerId) this.activePlayer.trapsSprung++; // Trapper objective (DD-25)
      this.pendingHeadlines.push({ zoneId: to.id, victimId: pegOwner });
      this.addLog(
        `🗺⚡ ${this.activePlayer.name} gerrymandered one of ${this.getPlayer(pegOwner).name}'s voters into ${to.name}'s Volatile Area — a Headline awaits them!`
      );
    } else {
      const dest = this.emptyNormalIndices(to);
      if (dest.length === 0) throw new Error('No room in the destination constituency');
      from.slots[slotIndex] = null;
      // Strongman (elite): an opponent's peg dragged into your rightful territory defects (DD-22).
      const strongmanSeizes = pegOwner !== playerId && this.hasElite(playerId, 'strongman');
      to.slots[dest[0]] = strongmanSeizes ? playerId : pegOwner;
      this.addLog(
        strongmanSeizes
          ? `🗺👑 ${this.activePlayer.name} drags one of ${this.getPlayer(pegOwner).name}'s voters into ${to.name} — and it defects (Strongman).`
          : `🗺 ${this.activePlayer.name} gerrymandered one of ${this.getPlayer(pegOwner).name}'s voters from ${from.name} to ${to.name}.`
      );
    }
    this.checkMajority(from);
    this.checkMajority(to);
    this.checkAllZonesCaptured();
    if (this.phase === 'GAME_OVER') return;
    this.gerryMovesLeft--;
    if (this.gerryMovesLeft > 0) return; // more moves allowed this turn (DD-21)
    this.finishTurn();
  }

  skipGerrymander(playerId) {
    if (this.phase !== 'GERRYMANDER') throw new Error('Not in gerrymander phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    this.finishTurn();
  }

  // ---------- elite cards: persistent auto-expressing hybrids (DD-22, supersedes DD-19) ----------

  eliteById(eliteId) {
    return ELITE_CARDS.find((e) => e.id === eliteId);
  }

  // The elite ids a player currently satisfies. A hybrid needs 3 cards in each of its two
  // ideologies AND zero in its negation; the Maverick needs ≥2 in three ideologies with
  // none at 3. Elites express passively and can activate/deactivate as manifestos change.
  activeElites(playerId) {
    const p = this.getPlayer(playerId);
    if (!p) return [];
    return ELITE_CARDS.filter((e) => {
      if (e.special === 'maverick') {
        return (
          IDEOLOGIES.filter((i) => p.manifesto[i] >= 2).length >= 3 &&
          IDEOLOGIES.every((i) => p.manifesto[i] < 3)
        );
      }
      const reqOk = Object.entries(e.requires).every(([ideo, lvl]) => p.manifesto[ideo] >= lvl);
      return reqOk && p.manifesto[e.negation] === 0;
    }).map((e) => e.id);
  }

  hasElite(playerId, eliteId) {
    return this.activeElites(playerId).includes(eliteId);
  }

  // Benefactor (elite, 1×/turn): gift 2 resources to a rival, then influence one HQ
  // card for free. `bypass` lets the Maverick copy it without the ownership/limit checks.
  benefactorGift(playerId, toId, payment, hqIndex, zoneId, bypass = false) {
    if (this.phase !== 'ACTION') throw new Error('Benefactor acts in your action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (!bypass) {
      if (!this.hasElite(p.id, 'benefactor')) throw new Error('You are not the Benefactor');
      if (this.turnFlags.benefactor >= 1) throw new Error('Benefactor acts once per turn');
    }
    const to = this.getPlayer(toId);
    if (!to || to.id === p.id) throw new Error('Gift a rival, not yourself');
    const pay = cleanResourceMap(payment);
    if (totalResources(pay) !== 2) throw new Error('Gift exactly 2 resources');
    if (!this.canAfford(p, pay)) throw new Error('You do not hold that gift');
    const card = this.hq[hqIndex];
    if (!card) throw new Error('No card at that HQ slot');
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error('Unknown zone');
    if (this.emptyNormalIndices(zone).length === 0) throw new Error('That constituency is full');
    for (const [r, n] of Object.entries(pay)) {
      p.resources[r] -= n;
      to.resources[r] += n;
    }
    this.settleDebt(to);
    const seated = this.seatVoters(p, zone, card.voters, false);
    this.voterDiscard.push(card);
    this.hq[hqIndex] = this.drawVoterCard();
    if (!bypass) this.turnFlags.benefactor++;
    this.addLog(`🎗 ${p.name} gifts 2 to ${to.name} and seats ${seated.placed} free voter${seated.placed === 1 ? '' : 's'} in ${zone.name} (Benefactor).`);
    this.checkMajority(zone);
    this.checkBoardFull();
    this.checkAllZonesCaptured();
  }

  // Spinner (elite, 1×/turn): pay any 3, draw a Headline and aim it at a rival's
  // strongest zone.
  buyHeadline(playerId, payment, targetPlayerId, bypass = false) {
    if (this.phase !== 'ACTION') throw new Error('Spinner acts in your action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (!bypass) {
      if (!this.hasElite(p.id, 'spinner')) throw new Error('You are not the Spinner');
      if (this.turnFlags.spinner >= 1) throw new Error('Spinner acts once per turn');
    }
    const target = this.getPlayer(targetPlayerId);
    if (!target || target.id === p.id) throw new Error('Aim the Headline at a rival');
    const pay = cleanResourceMap(payment);
    if (totalResources(pay) !== 3) throw new Error('Pay exactly 3 to plant a Headline');
    if (!this.canAfford(p, pay)) throw new Error('You do not hold that payment');
    if (this.headlineDeck.length === 0 && this.headlineDiscard.length === 0) throw new Error('No Headlines left to plant');
    for (const [r, n] of Object.entries(pay)) p.resources[r] -= n;
    // Aim at the target's strongest zone (most of their pegs); fall back to the first zone.
    let zone = this.zones[0];
    let best = -1;
    for (const z of this.zones) {
      const n = this.pegCount(z, target.id);
      if (n > best) {
        best = n;
        zone = z;
      }
    }
    const card = this.drawHeadlineCard();
    const summary = this.applyHeadline(card, target, zone);
    this.headlineDiscard.push(card);
    this.lastHeadline = {
      key: ++this.headlineCounter,
      title: card.title,
      text: card.text,
      playerId: target.id,
      zoneId: zone.id,
      summary,
    };
    if (!bypass) this.turnFlags.spinner++;
    this.addLog(`🗞 ${p.name} plants "${card.title}" on ${target.name} in ${zone.name} — ${summary} (Spinner).`);
    this.checkAllZonesCaptured();
  }

  // Oracle (elite, 1×/turn): sacrifice one of your own non-volatile voters for any 3 resources.
  oracleSacrifice(playerId, zoneId, slotIndex, gains, bypass = false) {
    if (this.phase !== 'ACTION') throw new Error('Oracle acts in your action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (!bypass) {
      if (!this.hasElite(p.id, 'oracle')) throw new Error('You are not the Oracle');
      if (this.turnFlags.oracle >= 1) throw new Error('Oracle acts once per turn');
    }
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error('Unknown zone');
    if (slotIndex === zone.volatileIndex) throw new Error('Volatile voters cannot be sacrificed');
    if (zone.slots[slotIndex] !== p.id) throw new Error('Sacrifice one of your own voters');
    const g = cleanResourceMap(gains);
    if (totalResources(g) !== 3) throw new Error('Claim exactly 3 resources');
    zone.slots[slotIndex] = null;
    for (const [r, n] of Object.entries(g)) p.resources[r] += n;
    if (!bypass) this.turnFlags.oracle++;
    this.settleDebt(p);
    this.addLog(`🙏 ${p.name} sacrifices a voter in ${zone.name} for 3 resources (Oracle).`);
    this.checkMajority(zone);
  }

  // Insurgent (elite, 1×/turn): shift up to 4 of your own non-majority voters, each to an
  // adjacent zone — on top of any gerrymander allowance.
  insurgentMove(playerId, moves, bypass = false) {
    if (this.phase !== 'ACTION' && this.phase !== 'GERRYMANDER') {
      throw new Error('Insurgent acts in your action or gerrymander phase');
    }
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (!bypass) {
      if (!this.hasElite(p.id, 'insurgent')) throw new Error('You are not the Insurgent');
      if (this.turnFlags.insurgent >= 1) throw new Error('Insurgent acts once per turn');
    }
    if (!Array.isArray(moves) || moves.length < 1 || moves.length > 4) {
      throw new Error('Move between 1 and 4 voters');
    }
    for (const mv of moves) {
      const from = this.getZone(mv.fromZoneId);
      const to = this.getZone(mv.toZoneId);
      if (!from || !to) throw new Error('Unknown zone in a move');
      if (from.id === to.id) throw new Error('Each move needs two different zones');
      if (!from.adjacent.includes(to.id)) throw new Error(`${to.name} does not border ${from.name}`);
      if (mv.slotIndex === from.volatileIndex) throw new Error('Volatile voters cannot be moved');
      const owner = from.slots[mv.slotIndex];
      if (owner !== p.id) throw new Error('Move only your own voters');
      if (owner === from.majorityOwner) throw new Error('Majority voters cannot be moved');
      if (this.coalitionLockedSlots(from).has(mv.slotIndex)) {
        throw new Error('Coalition voters cannot be moved');
      }
      const dest = this.emptyNormalIndices(to);
      if (dest.length === 0) throw new Error(`No room in ${to.name}`);
      from.slots[mv.slotIndex] = null;
      to.slots[dest[0]] = p.id;
      this.checkMajority(from);
      this.checkMajority(to);
    }
    if (!bypass) this.turnFlags.insurgent++;
    this.addLog(`🥷 ${p.name} redeploys ${moves.length} voter${moves.length === 1 ? '' : 's'} across borders (Insurgent).`);
    this.checkAllZonesCaptured();
  }

  // Backer (elite): choose the ≤2 rivals you collect from (re-pickable while active).
  pickPatronTargets(playerId, targets) {
    if (this.phase !== 'ACTION') throw new Error('Choose Backer targets in your action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (!this.hasElite(p.id, 'backer')) throw new Error('You are not the Backer');
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 2) {
      throw new Error('Back one or two rivals');
    }
    const clean = [];
    for (const id of targets) {
      const t = this.getPlayer(id);
      if (!t || t.id === p.id) throw new Error('Back rivals, not yourself');
      if (clean.includes(id)) throw new Error('Pick two different rivals');
      clean.push(id);
    }
    p.backerTargets = clean;
    this.addLog(`🎩 ${p.name} backs ${clean.map((id) => this.getPlayer(id).name).join(' and ')} (Backer).`);
  }

  // Maverick (elite, 1×/turn): borrow another elite's active power for a single use.
  maverickCopy(playerId, eliteId, args = {}) {
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (!this.hasElite(p.id, 'maverick')) throw new Error('You are not the Maverick');
    if (this.turnFlags.maverick >= 1) throw new Error('Maverick borrows one power per turn');
    switch (eliteId) {
      case 'benefactor':
        this.benefactorGift(playerId, args.toId, args.payment, args.hqIndex, args.zoneId, true);
        break;
      case 'spinner':
        this.buyHeadline(playerId, args.payment, args.targetPlayerId, true);
        break;
      case 'oracle':
        this.oracleSacrifice(playerId, args.zoneId, args.slotIndex, args.gains, true);
        break;
      case 'insurgent':
        this.insurgentMove(playerId, args.moves, true);
        break;
      default:
        throw new Error('That elite has no active power to borrow');
    }
    this.turnFlags.maverick++;
    this.addLog(`🃏 ${p.name} borrows the ${this.eliteById(eliteId).title}'s power (Maverick).`);
  }

  // ---------- active ideologue powers (L3/L5, DD-21) ----------

  // Prospecting — Mogul L3: once per turn, pay 1 resource and take any 2.
  prospect(playerId, giveRes, getA, getB) {
    if (this.phase !== 'ACTION') throw new Error('Prospect in your action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (this.debtLocked(p)) throw new Error('You owe an IOU — pay it off before spending');
    if (!this.hasPerk(p.id, 'mogul', 3)) throw new Error('Requires Mogul level 3');
    if (this.turnFlags.prospecting >= 1) throw new Error('You already prospected this turn');
    for (const r of [giveRes, getA, getB]) {
      if (!RESOURCES.includes(r)) throw new Error('Unknown resource');
    }
    if (p.resources[giveRes] < 1) throw new Error(`Need 1 ${giveRes}`);
    p.resources[giveRes] -= 1;
    p.resources[getA] += 1;
    p.resources[getB] += 1;
    this.turnFlags.prospecting++;
    this.settleDebt(p);
    this.addLog(`⛏ ${p.name} prospects: 1 ${giveRes} becomes 1 ${getA} + 1 ${getB}.`);
  }

  // Land Grab — Mogul L5: up to 3×/turn, evict ANY non-volatile voter (majority or
  // your own included). The evicted voter is benched; its owner may re-seat it by their
  // next turn, after which it disperses.
  landGrab(playerId, zoneId, slotIndex) {
    if (this.phase !== 'ACTION' && this.phase !== 'GERRYMANDER') {
      throw new Error('Land grab during your action or gerrymander phase');
    }
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (!this.hasPerk(p.id, 'mogul', 5)) throw new Error('Requires Mogul level 5');
    if (this.turnFlags.landGrabs >= 3) throw new Error('Only 3 land grabs per turn');
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error('Unknown zone');
    if (slotIndex === zone.volatileIndex) throw new Error('Volatile voters are untouchable');
    const owner = zone.slots[slotIndex];
    if (owner == null) throw new Error('No voter in that spot');
    zone.slots[slotIndex] = null;
    const ow = this.getPlayer(owner);
    ow.benched = (ow.benched || 0) + 1;
    ow.benchDeadline = this.turnCounter + this.players.length; // their next turn
    this.turnFlags.landGrabs++;
    this.addLog(`🏗 ${p.name} seizes ground in ${zone.name} — one of ${ow.name}'s voters is benched.`);
    this.checkMajority(zone);
  }

  // Re-seat voters benched by a Land Grab, into normal slots on your own turn.
  placeBenched(playerId, zoneId, n) {
    if (this.phase !== 'ACTION') throw new Error('Place benched voters in your action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (!p.benched) throw new Error('You have no benched voters');
    if (!Number.isInteger(n) || n < 1) throw new Error('Place at least one voter');
    if (n > p.benched) throw new Error(`You only have ${p.benched} benched voters`);
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error('Unknown zone');
    const place = Math.min(n, this.emptyNormalIndices(zone).length);
    if (place === 0) throw new Error('No room in that constituency');
    this.seatVoters(p, zone, place, false);
    p.benched -= place;
    if (p.benched <= 0) {
      p.benched = 0;
      p.benchDeadline = null;
    }
    this.addLog(`${p.name} re-seats ${place} benched voter${place === 1 ? '' : 's'} in ${zone.name}.`);
    this.checkMajority(zone);
    this.checkBoardFull();
    this.checkAllZonesCaptured();
  }

  // Snatch — Boss L3: up to twice per turn, take 1 resource from an opponent.
  snatch(playerId, fromId, res) {
    if (this.phase !== 'ACTION') throw new Error('Snatch in your action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (!this.hasPerk(p.id, 'boss', 3)) throw new Error('Requires Boss level 3');
    if (this.turnFlags.snatches >= 2) throw new Error('Only 2 snatches per turn');
    if (!RESOURCES.includes(res)) throw new Error('Unknown resource');
    const t = this.getPlayer(fromId);
    if (!t) throw new Error('Unknown player');
    if (t.id === p.id) throw new Error('Snatch from an opponent, not yourself');
    if (t.resources[res] < 1) throw new Error(`${t.name} has no ${res}`);
    t.resources[res] -= 1;
    p.resources[res] += 1;
    this.turnFlags.snatches++;
    this.settleDebt(p);
    this.addLog(`✊ ${p.name} snatches 1 ${res} from ${t.name}.`);
  }

  // Payback — Boss L5: up to twice per turn, pay 1 resource to discard an opponent's
  // non-volatile voter (majority pegs included).
  payback(playerId, payRes, zoneId, slotIndex) {
    if (this.phase !== 'ACTION' && this.phase !== 'GERRYMANDER') {
      throw new Error('Payback during your action or gerrymander phase');
    }
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (this.debtLocked(p)) throw new Error('You owe an IOU — pay it off before spending');
    if (!this.hasPerk(p.id, 'boss', 5)) throw new Error('Requires Boss level 5');
    if (this.turnFlags.paybacks >= 2) throw new Error('Only 2 paybacks per turn');
    if (!RESOURCES.includes(payRes)) throw new Error('Unknown resource');
    if (p.resources[payRes] < 1) throw new Error(`Need 1 ${payRes}`);
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error('Unknown zone');
    if (slotIndex === zone.volatileIndex) throw new Error('Volatile voters are untouchable');
    const owner = zone.slots[slotIndex];
    if (owner == null) throw new Error('No voter in that spot');
    if (owner === p.id) throw new Error('Payback targets an opponent');
    p.resources[payRes] -= 1;
    zone.slots[slotIndex] = null;
    this.turnFlags.paybacks++;
    this.addLog(
      `💢 ${p.name} pays back ${this.getPlayer(owner).name} — a voter in ${zone.name} is discarded.`
    );
    this.checkMajority(zone);
  }

  // Tough Love — Believer L5: once per turn, pay 2 trust + any 2 to convert two of one
  // opponent's non-volatile voters in a single zone (majority pegs included).
  toughLove(playerId, zoneId, slotIndex1, slotIndex2, extraPayment, discounts = null) {
    if (this.phase !== 'ACTION') throw new Error('Tough love in your action phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    if (this.debtLocked(p)) throw new Error('You owe an IOU — pay it off before spending');
    if (!this.hasPerk(p.id, 'believer', 5)) throw new Error('Requires Believer level 5');
    if (this.turnFlags.toughLove >= 1) throw new Error('Tough love is once per turn');
    if (slotIndex1 === slotIndex2) throw new Error('Pick two different voters');
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error('Unknown zone');
    if (slotIndex1 === zone.volatileIndex || slotIndex2 === zone.volatileIndex) {
      throw new Error('Volatile voters are untouchable');
    }
    const o1 = zone.slots[slotIndex1];
    const o2 = zone.slots[slotIndex2];
    if (o1 == null || o2 == null) throw new Error('Both spots must hold a voter');
    if (o1 !== o2) throw new Error('Both voters must belong to the same opponent');
    if (o1 === p.id) throw new Error('Tough love targets an opponent');
    const extra = cleanResourceMap(extraPayment);
    if (totalResources(extra) !== 2) throw new Error('Pay 2 more of any resources');
    const base = { ...extra };
    base.trust = (base.trust || 0) + 2;
    const { cost, used: discUsed } = this.discountedCost(p, base, discounts);
    if (!this.canAfford(p, cost)) throw new Error('Cannot afford tough love (2 trust + any 2)');
    for (const [r, n] of Object.entries(cost)) p.resources[r] -= n;
    this.turnFlags.discounts += discUsed;
    zone.slots[slotIndex1] = p.id;
    zone.slots[slotIndex2] = p.id;
    this.turnFlags.toughLove++;
    this.addLog(
      `💛 ${p.name} wins over two of ${this.getPlayer(o1).name}'s voters in ${zone.name}.`
    );
    this.checkMajority(zone);
    this.checkAllZonesCaptured();
  }

  // ---------- headline resolution ----------

  // Heuristic used to audit the headline deck's reward/penalty balance.
  headlineScore(card) {
    const t = card.effect.type;
    if (['gain', 'gainEach', 'steal', 'addPegs', 'convert', 'removeOpponent'].includes(t)) return 1;
    if (t === 'auction' || t === 'peekVoter') return 0;
    return -1; // lose, loseHighest, removeOwn, opponentsGain
  }

  // Headlines are read at the end of the active player's turn but apply to the player
  // whose peg sits in the volatile slot — possibly a trapped opponent (DD-20).
  resolveHeadlines() {
    while (this.pendingHeadlines.length > 0) {
      const { zoneId, victimId } = this.pendingHeadlines.shift();
      const zone = this.getZone(zoneId);
      const victim = this.getPlayer(victimId);
      const card = this.drawHeadlineCard();
      const summary = this.applyHeadline(card, victim, zone);
      this.headlineDiscard.push(card);
      this.lastHeadline = {
        key: ++this.headlineCounter,
        title: card.title,
        text: card.text,
        playerId: victim.id,
        zoneId: zone.id,
        summary,
      };
      this.addLog(`📰 HEADLINE (${zone.name}): "${card.title}" — ${summary}`);
      if (this.phase === 'GAME_OVER') return;
    }
  }

  applyHeadline(card, p, zone) {
    const e = card.effect;
    const clampLose = (res, n) => {
      const lost = Math.min(p.resources[res], n);
      p.resources[res] -= lost;
      return lost;
    };
    switch (e.type) {
      case 'gain': {
        for (const [r, n] of Object.entries(e.resources)) p.resources[r] += n;
        return `${p.name} gains ${Object.entries(e.resources).map(([r, n]) => `${n} ${RES_LABEL[r]}`).join(', ')}.`;
      }
      case 'lose': {
        const lost = Object.entries(e.resources).map(([r, n]) => `${clampLose(r, n)} ${RES_LABEL[r]}`);
        return `${p.name} loses ${lost.join(', ')}.`;
      }
      case 'gainEach': {
        for (const r of RESOURCES) p.resources[r]++;
        return `${p.name} gains 1 of every resource.`;
      }
      case 'loseHighest': {
        const top = RESOURCES.slice().sort((a, b) => p.resources[b] - p.resources[a])[0];
        const lost = clampLose(top, e.n);
        return `${p.name} loses ${lost} ${top}.`;
      }
      case 'opponentsGain': {
        for (const o of this.players) {
          if (o.id === p.id) continue;
          for (const [r, n] of Object.entries(e.resources)) o.resources[r] += n;
        }
        return `every opponent gains ${Object.entries(e.resources).map(([r, n]) => `${n} ${RES_LABEL[r]}`).join(', ')}.`;
      }
      case 'steal': {
        const richest = this.players
          .filter((o) => o.id !== p.id)
          .sort((a, b) => b.resources[e.res] - a.resources[e.res])[0];
        const taken = Math.min(richest.resources[e.res], e.n);
        richest.resources[e.res] -= taken;
        p.resources[e.res] += taken;
        return `${p.name} takes ${taken} ${e.res} from ${richest.name}.`;
      }
      case 'removeOwn': {
        const removed = this.removePegs(zone, p.id, e.n);
        this.checkMajority(zone);
        return `${p.name} loses ${removed} voter${removed === 1 ? '' : 's'} in ${zone.name}.`;
      }
      case 'removeOpponent': {
        const target = this.biggestOpponentInZone(zone, p.id);
        if (!target) return `no opposing voters in ${zone.name} — nothing happens.`;
        const removed = this.removePegs(zone, target.id, e.n);
        this.checkMajority(zone);
        return `${target.name} loses ${removed} voter${removed === 1 ? '' : 's'} in ${zone.name}.`;
      }
      case 'convert': {
        const target = this.biggestOpponentInZone(zone, p.id);
        if (!target) return `no opposing voters in ${zone.name} — nothing happens.`;
        let converted = 0;
        for (let i = 0; i < zone.slots.length && converted < e.n; i++) {
          if (zone.slots[i] === target.id && i !== zone.volatileIndex) {
            zone.slots[i] = p.id;
            converted++;
          }
        }
        this.checkMajority(zone);
        return `${converted} of ${target.name}'s voters in ${zone.name} defect to ${p.name}.`;
      }
      case 'addPegs': {
        const spots = this.emptyNormalIndices(zone);
        const placed = Math.min(e.n, spots.length);
        for (let i = 0; i < placed; i++) zone.slots[spots[i]] = p.id;
        this.checkMajority(zone);
        this.checkBoardFull();
        return placed > 0
          ? `${p.name} places ${placed} free voter${placed === 1 ? '' : 's'} in ${zone.name}.`
          : `${zone.name} has no room — nothing happens.`;
      }
      case 'auction': {
        // Queue a public auction; it runs after all headlines resolve (DD-17).
        const card = { id: 'auction_' + ++this.auctionCounter, voters: e.voters, auctioned: true };
        this.pendingAuctions.push({ card, triggeredBy: p.id });
        return `a bloc of ${e.voters} voters goes up for public auction!`;
      }
      default:
        return 'nothing happens.';
    }
  }

  // Remove up to n pegs of ownerId from zone. Volatile pegs are permanent (DD-20):
  // they can never be removed, converted, or moved by anything.
  removePegs(zone, ownerId, n) {
    let removed = 0;
    for (let i = 0; i < zone.slots.length && removed < n; i++) {
      if (i === zone.volatileIndex) continue;
      if (zone.slots[i] === ownerId) {
        zone.slots[i] = null;
        removed++;
      }
    }
    return removed;
  }

  biggestOpponentInZone(zone, playerId) {
    const opponents = this.players
      .filter((o) => o.id !== playerId)
      .map((o) => ({ o, n: this.pegCount(zone, o.id) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
    return opponents.length ? opponents[0].o : null;
  }

  // ---------- IOU + auctions (DD-16, DD-17) ----------

  // Divert a debtor's held resources to pay down their bank debt (auto-repay).
  settleDebt(player) {
    if (!player.iou || player.iou.debt <= 0) return;
    let owed = player.iou.debt;
    const order = RESOURCES.slice().sort((a, b) => player.resources[b] - player.resources[a]);
    for (const r of order) {
      const pay = Math.min(owed, player.resources[r]);
      player.resources[r] -= pay;
      owed -= pay;
      if (owed === 0) break;
    }
    player.iou.debt = owed;
    if (owed === 0) {
      player.iou = null;
      this.addLog(`💸 ${player.name} paid off their IOU.`);
    }
  }

  startAuction({ card, triggeredBy }) {
    this.auction = {
      card,
      bid: 0,
      highBidder: null,
      passed: new Set(),
      triggeredBy,
    };
    // Debt-locked players can't bid, so they're out from the start.
    for (const p of this.players) if (this.debtLocked(p)) this.auction.passed.add(p.id);
    this.phase = 'AUCTION';
    this.addLog(`🔨 Auction: a bloc of ${card.voters} voters is up for bid (up to the cap of ${RESOURCE_CAP}).`);
    this.maybeResolveAuction();
  }

  activeBidders() {
    return this.players.filter((p) => !this.auction.passed.has(p.id));
  }

  placeBid(playerId, amount) {
    if (this.phase !== 'AUCTION') throw new Error('No auction running');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('Unknown player');
    if (this.debtLocked(p)) throw new Error('You owe an IOU and cannot bid');
    if (this.auction.passed.has(playerId)) throw new Error('You already dropped out of this auction');
    if (!Number.isInteger(amount)) throw new Error('Bid must be a whole number');
    if (amount <= this.auction.bid) throw new Error(`Bid must beat ${this.auction.bid}`);
    if (amount > RESOURCE_CAP) throw new Error(`Bids are capped at ${RESOURCE_CAP}`);
    this.auction.bid = amount;
    this.auction.highBidder = playerId;
    this.addLog(`${p.name} bids ${amount}.`);
    // A new high bid revives everyone who hadn't dropped; only explicit passes remove you.
    this.maybeResolveAuction();
  }

  passBid(playerId) {
    if (this.phase !== 'AUCTION') throw new Error('No auction running');
    const p = this.getPlayer(playerId);
    if (!p) throw new Error('Unknown player');
    if (playerId === this.auction.highBidder) throw new Error('You are the high bidder');
    if (!this.auction.passed.has(playerId)) {
      this.auction.passed.add(playerId);
      this.addLog(`${p.name} drops out of the auction.`);
    }
    this.maybeResolveAuction();
  }

  // Sell once the high bidder is unopposed; dissolve only if everyone passes.
  maybeResolveAuction() {
    const inRace = this.activeBidders();
    if (this.auction.highBidder) {
      // Someone leading: keep going while another active bidder could still raise.
      const others = inRace.filter((p) => p.id !== this.auction.highBidder);
      if (others.length > 0) return;
    } else {
      // No bid yet: keep going while anyone is still in to open one.
      if (inRace.length > 0) return;
    }

    const winnerId = this.auction.highBidder;
    const { card, bid } = this.auction;
    if (!winnerId) {
      this.addLog('🔨 No bids — the bloc dissolves.');
      this.auction = null;
      this.afterAuction();
      return;
    }
    const winner = this.getPlayer(winnerId);
    // Pay from holdings; shortfall becomes an IOU to the bank (DD-16).
    let owed = bid;
    const order = RESOURCES.slice().sort((a, b) => winner.resources[b] - winner.resources[a]);
    for (const r of order) {
      const pay = Math.min(owed, winner.resources[r]);
      winner.resources[r] -= pay;
      owed -= pay;
      if (owed === 0) break;
    }
    if (owed > 0) {
      winner.iou = { debt: owed };
      winner.tookIOU = true; // breaks the Clean Hands objective for good (DD-25)
      this.addLog(`${winner.name} wins for ${bid} but is short — takes an IOU for ${owed}.`);
    } else {
      this.addLog(`🔨 Sold! ${winner.name} wins the bloc for ${bid}.`);
    }
    // The winner now places the won voters (DD-17): a dedicated placement step.
    this.auction = null;
    if (this.zones.some((z) => this.emptyNormalIndices(z).length > 0 || z.slots[z.volatileIndex] === null)) {
      this.auctionPlacement = { winnerId, card };
      this.phase = 'AUCTION_PLACE';
    } else {
      this.addLog(`${winner.name} has nowhere to seat the bloc — the voters disperse.`);
      this.afterAuction();
    }
  }

  placeAuctionWin(playerId, zoneId, useVolatile = false) {
    if (this.phase !== 'AUCTION_PLACE') throw new Error('No auction placement pending');
    if (playerId !== this.auctionPlacement.winnerId) throw new Error('Only the auction winner places');
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error('Unknown zone');
    const card = this.auctionPlacement.card;
    const placed = this.seatVoters(this.getPlayer(playerId), zone, card.voters, useVolatile);
    this.auctionPlacement = null;
    this.addLog(
      `${this.getPlayer(playerId).name} seats ${placed.placed} won voter${placed.placed === 1 ? '' : 's'} in ${zone.name}` +
        (placed.hitVolatile ? ' — including the Volatile Area!' : '') +
        (placed.discarded > 0 ? ` (${placed.discarded} lost — no room)` : '') +
        '.'
    );
    this.checkMajority(zone);
    this.checkBoardFull();
    this.checkAllZonesCaptured();
    if (this.phase === 'GAME_OVER') return;
    this.afterAuction();
  }

  // Shared voter-seating used by buyVoterCard and auction placement (DD-3/DD-10).
  seatVoters(player, zone, voters, useVolatile) {
    const normal = this.emptyNormalIndices(zone);
    const volatileFree = zone.slots[zone.volatileIndex] === null;
    const capacity = normal.length + (useVolatile && volatileFree ? 1 : 0);
    const placed = Math.min(voters, capacity);
    let remaining = placed;
    let hitVolatile = false;
    if (useVolatile && volatileFree && remaining > 0) {
      zone.slots[zone.volatileIndex] = player.id;
      remaining--;
      hitVolatile = true;
      this.pendingHeadlines.push({ zoneId: zone.id, victimId: player.id });
    }
    for (let i = 0; i < remaining; i++) zone.slots[normal[i]] = player.id;
    return { placed, discarded: voters - placed, hitVolatile };
  }

  // Continue turn resolution after an auction: next queued auction, or cleanup.
  afterAuction() {
    if (this.phase === 'GAME_OVER') return;
    this.continueAfterHeadlines();
  }

  // ---------- turn end / cleanup ----------

  // GERRYMANDER (or ACTION with no majority) → headlines → auctions → cap check → next.
  finishTurn() {
    this.resolveHeadlines();
    if (this.phase === 'GAME_OVER') return;
    this.continueAfterHeadlines();
  }

  continueAfterHeadlines() {
    if (this.phase === 'GAME_OVER') return;
    if (this.pendingAuctions.length > 0) {
      this.startAuction(this.pendingAuctions.shift());
      return;
    }
    this.doCleanup();
  }

  doCleanup() {
    const p = this.activePlayer;
    this.settleDebt(p); // any resources the turn produced pay the bank first
    this.advanceTurn(); // over-cap discard now happens at the START of a turn (DD-21)
  }

  discardResources(playerId, discards) {
    if (this.phase !== 'DISCARD') throw new Error('Not in discard phase');
    if (playerId !== this.activePlayer.id) throw new Error('Not your turn');
    const p = this.activePlayer;
    const count = totalResources(discards);
    if (count !== this.discardRequired) {
      throw new Error(`Must discard exactly ${this.discardRequired} resources`);
    }
    for (const [r, n] of Object.entries(discards)) {
      if (!RESOURCES.includes(r) || (n || 0) < 0) throw new Error('Invalid discard');
      if (p.resources[r] < n) throw new Error(`Not enough ${r} to discard`);
    }
    for (const [r, n] of Object.entries(discards)) p.resources[r] -= n;
    this.discardRequired = 0;
    this.addLog(`${p.name} discarded down to the cap.`);
    this.phase = 'ACTION'; // discard is at the start of the turn — now act (DD-21)
  }

  advanceTurn() {
    this.tradeOffers = []; // open offers expire with the turn
    this.coalitionOffers = [];
    this.activePlayer.peek = null; // private peek is only good for the current turn
    this.turnCounter++;
    // Benched voters not re-seated by their owner's next turn disperse (DD-21). The
    // Operator holds their reserve indefinitely — only losing the elite starts the clock (DD-22).
    for (const p of this.players) {
      if (this.hasElite(p.id, 'operator')) continue;
      if (p.benched > 0 && p.benchDeadline != null && this.turnCounter > p.benchDeadline) {
        this.addLog(`${p.name}'s ${p.benched} benched voter(s) disperse.`);
        p.benched = 0;
        p.benchDeadline = null;
      }
    }
    // Informant (elite): a full round with no conspiracy played banks 2 reserve voters (DD-22).
    const dry = this.turnCounter - this.lastConspiracyTurn;
    if (dry > 0 && dry % this.players.length === 0) {
      for (const p of this.players) {
        if (!this.hasElite(p.id, 'informant')) continue;
        p.benched = (p.benched || 0) + 2;
        p.benchDeadline = this.turnCounter + this.players.length;
        this.addLog(`🕊 A clean round rewards ${p.name} with 2 reserve voters (Informant).`);
      }
    }
    if (this.finalTurnsRemaining !== null) {
      this.finalTurnsRemaining--;
      if (this.finalTurnsRemaining <= 0) {
        this.endGame();
        return;
      }
    }
    this.turnIndex = (this.turnIndex + 1) % this.players.length;
    this.beginPolicyPhase();
  }

  // ---------- scoring ----------

  endGame() {
    this.phase = 'GAME_OVER';
    this.currentCard = null;
    this.tradeOffers = [];
    this.coalitionOffers = [];
    this.pendingHeadlines = [];
    this.pendingAuctions = [];
    this.auction = null;
    this.auctionPlacement = null;
    this.reactionContext = null;
    this.pendingReaction = null;
    for (const p of this.players) p.score = 0;
    for (const z of this.zones) {
      if (z.majorityOwner) {
        // Only pegs contributing to the majority count — exactly the threshold (DD-4).
        this.getPlayer(z.majorityOwner).score += z.majority;
      } else if (z.coalition) {
        // Coalition zones split the threshold by contribution (DD-23 amends DD-4).
        this.getPlayer(z.coalition.a).score += z.coalition.split.a;
        this.getPlayer(z.coalition.b).score += z.coalition.split.b;
      }
    }
    // Hidden objectives cash in before the winner is computed (DD-25).
    if (this.mode === 'hiddenObjectives') {
      this.objectiveResults = this.players.map((p) => {
        const met = !!(p.objective && OBJECTIVE_CHECKS[p.objective.check](this, p));
        if (met) p.score += p.objective.bonus;
        return {
          playerId: p.id,
          title: p.objective.title,
          text: p.objective.text,
          met,
          bonus: p.objective.bonus,
        };
      });
      for (const r of this.objectiveResults) {
        this.addLog(
          `🎯 ${this.getPlayer(r.playerId).name}'s secret objective "${r.title}" — ${
            r.met ? `MET (+${r.bonus})` : 'missed'
          }.`
        );
      }
    }
    const best = Math.max(...this.players.map((p) => p.score));
    let leaders = this.players.filter((p) => p.score === best);
    if (leaders.length > 1) {
      // Tiebreak: most total pegs on the board.
      const pegTotals = (pl) =>
        this.zones.reduce((s, z) => s + this.pegCount(z, pl.id), 0);
      const bestPegs = Math.max(...leaders.map(pegTotals));
      leaders = leaders.filter((p) => pegTotals(p) === bestPegs);
    }
    this.winnerIds = leaders.map((p) => p.id);
    this.addLog(
      `Election over. Winner${leaders.length > 1 ? 's' : ''}: ${leaders
        .map((p) => p.name)
        .join(', ')} with ${best} majority voters.`
    );
    // The Reckoning: the first winner's dominant ideology pair names the dystopia they
    // usher in (DD-22). Ties in manifesto counts break by IDEOLOGIES order.
    if (leaders.length > 0) {
      const w = leaders[0];
      const ranked = IDEOLOGIES.slice().sort(
        (a, b) => w.manifesto[b] - w.manifesto[a] || IDEOLOGIES.indexOf(a) - IDEOLOGIES.indexOf(b)
      );
      const [primary, secondary] = ranked;
      const card = RECKONING.find((c) => c.primary === primary && c.secondary === secondary);
      if (card) {
        this.reckoning = { playerId: w.id, title: card.title, text: card.text };
        this.addLog(`📕 The Reckoning: ${w.name} brings about "${card.title}".`);
      }
    }
  }

  // ---------- serialization ----------

  // viewerId restricts hidden information (conspiracy hands, private peeks) to its owner.
  serialize(viewerId = null) {
    const viewer = viewerId ? this.getPlayer(viewerId) : null;
    return {
      phase: this.phase,
      mode: this.mode,
      // Turf catalogue + per-turn usage; null outside homeTurfs mode (DD-24).
      homeTurfs: this.mode === 'homeTurfs' ? HOME_TURFS : null,
      turfUsed: this.mode === 'homeTurfs' ? this.turfUsed : null,
      turnCounter: this.turnCounter,
      turnIndex: this.turnIndex,
      activePlayerId: ['SETUP_PICK', 'SETUP_BID', 'SETUP_REQUIREMENTS'].includes(this.phase)
        ? null
        : this.activePlayer.id,
      // 2 Player setup (DD-26): who has bid — never the amounts; whose placement it is.
      setupBid:
        this.phase === 'SETUP_BID'
          ? { submitted: Object.keys(this.setupBids) }
          : null,
      reqPlacerId:
        this.phase === 'SETUP_REQUIREMENTS' ? this.players[this.reqPlacerIndex].id : null,
      yourRequirementHand:
        viewer && this.reqHands && this.phase === 'SETUP_REQUIREMENTS'
          ? this.reqHands[viewer.id]
          : null,
      discardRequired: this.phase === 'DISCARD' ? this.discardRequired : 0,
      finalTurnsRemaining: this.finalTurnsRemaining,
      currentCard: this.publicCurrentCard(),
      lastAnsweredCard: this.lastAnsweredCard || null,
      lastHeadline: this.lastHeadline,
      lastConspiracy: this.lastConspiracy,
      pendingHeadlineCount: this.pendingHeadlines.length,
      pendingReaction: this.pendingReaction,
      auction: this.auction
        ? {
            card: this.auction.card,
            bid: this.auction.bid,
            highBidder: this.auction.highBidder,
            passed: [...this.auction.passed],
            triggeredBy: this.auction.triggeredBy,
          }
        : null,
      auctionPlacement: this.auctionPlacement
        ? { winnerId: this.auctionPlacement.winnerId, card: this.auctionPlacement.card }
        : null,
      tradeOffers: this.tradeOffers,
      coalitionOffers: this.coalitionOffers,
      tradingOpen: this.tradingOpen(),
      conspiraciesOpen: this.conspiraciesOpen(),
      // May THIS viewer play a conspiracy right now? The active player acts in their
      // action/gerrymander phase; everyone else only in the POLICY window (DD-21).
      youMayPlayConspiracy: viewer
        ? viewer.id === this.activePlayer.id
          ? ['ACTION', 'GERRYMANDER'].includes(this.phase)
          : this.phase === 'POLICY'
        : false,
      conspiracyDeckCount: this.conspiracyDeck.length,
      conspiracyPrice: this.conspiracyDeck.length
        ? this.conspiracyDeck[this.conspiracyDeck.length - 1].price
        : null,
      // Only the viewer's own hand and peek are shipped; others see counts only.
      yourConspiracies: viewer ? viewer.conspiracies : [],
      yourPeek: viewer ? viewer.peek : null,
      // Hidden objective: only its owner sees it before GAME_OVER (DD-25).
      yourObjective: viewer ? viewer.objective : null,
      objectiveResults: this.phase === 'GAME_OVER' ? this.objectiveResults : null,
      gerryMovesLeft: this.phase === 'GERRYMANDER' ? this.gerryMovesLeft : 0,
      turnFlags: this.turnFlags,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        resources: p.resources,
        resourceTotal: totalResources(p.resources),
        manifesto: p.manifesto,
        passiveIncome: this.passiveIncomeFor(p),
        startingPicksRemaining: p.startingPicksRemaining,
        conspiracyCount: p.conspiracies.length,
        iou: p.iou ? { debt: p.iou.debt } : null,
        cap: RESOURCE_CAP,
        benched: p.benched || 0,
        elites: this.activeElites(p.id), // ids currently expressing (DD-22)
        backerTargets: p.backerTargets || [],
        score: p.score,
      })),
      // Static catalogue of every elite hybrid and its requirements (DD-22).
      eliteCatalog: ELITE_CARDS,
      // Organizer (elite): an active Organizer sees every rival's conspiracy hand (DD-22).
      spyHands:
        viewer && this.hasElite(viewer.id, 'organizer')
          ? this.players
              .filter((o) => o.id !== viewer.id)
              .map((o) => ({ id: o.id, name: o.name, conspiracies: o.conspiracies }))
          : null,
      reckoning: this.reckoning,
      zones: this.zones.map((z) => ({
        id: z.id,
        name: z.name,
        capacity: z.capacity,
        majority: z.majority,
        volatileIndex: z.volatileIndex,
        adjacent: z.adjacent,
        slots: z.slots,
        majorityOwner: z.majorityOwner,
        coalition: z.coalition,
        requirement: z.requirement
          ? { card: z.requirement.card, metBy: z.requirement.metBy }
          : null,
        blocked: this.isZoneBlocked(z.id),
      })),
      hq: this.hq,
      voterDeckCount: this.voterDeck.length,
      winnerIds: this.winnerIds,
      log: this.log.slice(-30),
      logSeq: this.logSeq || 0,
      resourceCap: RESOURCE_CAP,
    };
  }

  // ---------- persistence (Phase 5, item 11: survive server restarts) ----------

  // A complete, JSON-safe capture of internal state (unlike serialize(), which is lossy).
  snapshot() {
    const snap = {};
    for (const k of Object.keys(this)) {
      if (k === 'rng') continue; // functions aren't serializable; restore uses Math.random
      snap[k] = this[k];
    }
    if (this.auction) snap.auction = { ...this.auction, passed: [...this.auction.passed] };
    return JSON.parse(JSON.stringify(snap));
  }

  // Rebuild a live game from a snapshot() without re-running the constructor.
  static restore(snap) {
    const g = Object.create(SystemGame.prototype);
    Object.assign(g, snap);
    g.rng = Math.random;
    if (g.auction && Array.isArray(g.auction.passed)) g.auction.passed = new Set(g.auction.passed);
    return g;
  }
}

module.exports = { SystemGame, RESOURCES, IDEOLOGIES, COLORS };

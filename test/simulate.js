// Bot simulation: plays full random games through the engine and checks invariants.
// Bots exercise the Phase 2 systems: trading, volatile placement, gerrymandering.
const { SystemGame, RESOURCES } = require('../server/game');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

function totalRes(p) {
  return RESOURCES.reduce((s, r) => s + p.resources[r], 0);
}

function playGame(numPlayers, seedLabel, mode = 'standard') {
  const infos = Array.from({ length: numPlayers }, (_, i) => ({
    id: `bot${i}`,
    name: `Bot ${i + 1}`,
  }));
  const g = new SystemGame(infos, Math.random, mode);

  // --- setup ---
  if (mode === 'twoPlayer') {
    // Secret bid (ties re-bid), then alternating requirement placement (DD-26).
    assert(g.phase === 'SETUP_BID', 'head-to-head starts with the bid');
    let guard = 0;
    while (g.phase === 'SETUP_BID' && guard++ < 30) {
      for (const p of g.players) {
        if (g.phase === 'SETUP_BID' && g.setupBids[p.id] == null) {
          g.submitSetupBid(p.id, Math.floor(Math.random() * 9));
        }
      }
    }
    assert(g.phase === 'SETUP_REQUIREMENTS', 'bid resolves into requirement placement');
    while (g.phase === 'SETUP_REQUIREMENTS') {
      const placer = g.players[g.reqPlacerIndex];
      const hand = g.reqHands[placer.id];
      const card = hand[Math.floor(Math.random() * hand.length)];
      const zone = g.zones.find((z) => !z.requirement);
      g.placeRequirement(placer.id, card.id, zone.id);
    }
    assert(g.phase === 'POLICY', 'setup done after 7 requirements');
    assert(g.zones.every((z) => z.requirement), 'every zone carries a requirement');
  } else {
    assert(g.phase === 'SETUP_PICK', 'starts in setup');
    for (const p of g.players) {
      while (p.startingPicksRemaining > 0) {
        g.pickStartingResource(p.id, RESOURCES[Math.floor(Math.random() * 4)]);
      }
    }
    assert(g.phase === 'POLICY', 'moves to policy after setup');
    // Verify asymmetric distribution: player i has i+1 resources
    g.players.forEach((p, i) => assert(totalRes(p) === i + 1, `P${i + 1} starts with ${i + 1}`));
  }

  // --- main loop ---
  let turns = 0;
  let trades = 0;
  let headlines = 0;
  let gerrymanders = 0;
  let conspiracies = 0;
  let elites = 0;
  let coalitions = 0;
  let turfs = 0;

  // Any bot that is the victim of a pending conspiracy responds (coin-flip cancel/pass).
  function resolveReactions() {
    let guard = 0;
    while (g.phase === 'REACTION' && guard++ < 10) {
      const v = g.getPlayer(g.pendingReaction.victimId);
      const react = v.conspiracies.find((c) => c.reaction);
      g.respondReaction(v.id, Math.random() < 0.5 && react ? react.id : null);
    }
  }

  // Drive any headline-triggered auction to completion (bots bid or pass, winner places).
  function resolveAuctions() {
    let guard = 0;
    while ((g.phase === 'AUCTION' || g.phase === 'AUCTION_PLACE') && guard++ < 60) {
      if (g.phase === 'AUCTION') {
        const a = g.auction;
        const bidder = g.players.find(
          (p) => !a.passed.has(p.id) && p.id !== a.highBidder && !g.debtLocked(p)
        );
        if (!bidder) {
          for (const p of g.players) {
            if (!a.passed.has(p.id) && p.id !== a.highBidder) g.passBid(p.id);
          }
          continue;
        }
        if (Math.random() < 0.45 && a.bid + 1 <= 12) g.placeBid(bidder.id, a.bid + 1);
        else g.passBid(bidder.id);
      } else {
        const w = g.auctionPlacement.winnerId;
        const zone =
          g.zones.find((z) => g.emptyNormalIndices(z).length > 0) ||
          g.zones.find((z) => z.slots[z.volatileIndex] === null);
        if (zone) g.placeAuctionWin(w, zone.id, false);
        else break;
      }
    }
  }

  // Pick a legal target for a held conspiracy, or null if none exists → returns spec|undefined.
  function pickTarget(card, caster) {
    switch (card.target) {
      case 'none':
        return null;
      case 'player':
      case 'playerRes': {
        const opp = g.players.filter((p) => p.id !== caster.id);
        const t = opp[Math.floor(Math.random() * opp.length)];
        return card.target === 'playerRes'
          ? { playerId: t.id, res: RESOURCES[Math.floor(Math.random() * 4)] }
          : { playerId: t.id };
      }
      case 'opponentPeg': {
        for (const z of g.zones) {
          for (let s = 0; s < z.slots.length; s++) {
            const o = z.slots[s];
            if (
              o &&
              o !== caster.id &&
              s !== z.volatileIndex &&
              o !== z.majorityOwner &&
              !g.coalitionLockedSlots(z).has(s)
            ) {
              return { zoneId: z.id, slotIndex: s };
            }
          }
        }
        return undefined;
      }
      case 'zone': {
        return { zoneId: g.zones[Math.floor(Math.random() * g.zones.length)].id };
      }
      case 'hqCard': {
        const idx = g.hq.findIndex(Boolean);
        return idx >= 0 ? { hqIndex: idx } : undefined;
      }
      default:
        return undefined;
    }
  }

  // Build a payment map summing to `amount` from the largest piles, or null if short.
  function greedyFrom(res, amount) {
    const pay = { funds: 0, clout: 0, media: 0, trust: 0 };
    let left = amount;
    const sorted = RESOURCES.slice().sort((a, b) => res[b] - res[a]);
    for (const r of sorted) {
      const take = Math.min(left, res[r]);
      pay[r] = take;
      left -= take;
      if (left === 0) break;
    }
    return left === 0 ? pay : null;
  }

  // First non-volatile peg belonging to someone other than pid.
  function findOpponentPeg(pid) {
    for (const z of g.zones) {
      for (let s = 0; s < z.slots.length; s++) {
        if (s === z.volatileIndex) continue;
        if (z.slots[s] && z.slots[s] !== pid) return { zoneId: z.id, slotIndex: s };
      }
    }
    return null;
  }

  // First non-volatile peg of any owner (Land Grab may evict anyone, even yourself).
  function findAnyPeg() {
    for (const z of g.zones) {
      for (let s = 0; s < z.slots.length; s++) {
        if (s === z.volatileIndex) continue;
        if (z.slots[s]) return { zoneId: z.id, slotIndex: s };
      }
    }
    return null;
  }

  // Two non-volatile pegs of the SAME opponent inside one zone (Tough Love target).
  function findOpponentPair(pid) {
    for (const z of g.zones) {
      const byOwner = {};
      for (let s = 0; s < z.slots.length; s++) {
        if (s === z.volatileIndex) continue;
        const o = z.slots[s];
        if (!o || o === pid) continue;
        (byOwner[o] = byOwner[o] || []).push(s);
        if (byOwner[o].length === 2) return { zoneId: z.id, a: byOwner[o][0], b: byOwner[o][1] };
      }
    }
    return null;
  }

  const MAX_TURNS = 2000;
  while (g.phase !== 'GAME_OVER' && turns < MAX_TURNS) {
    turns++;
    const active = g.activePlayer;

    // Policy
    assert(g.phase === 'POLICY', 'turn begins with policy');
    const pub = g.publicCurrentCard();
    assert(pub && !JSON.stringify(pub).includes('rewards'), 'rewards hidden from public card');
    g.answerPolicy(active.id, Math.random() < 0.5 ? 'a' : 'b');

    // Over-cap discard now happens at the START of the turn, before acting (DD-21).
    if (g.phase === 'DISCARD') {
      g.discardResources(active.id, greedyFrom(active.resources, g.discardRequired));
    }
    assert(
      totalRes(active) <= 12,
      `${active.name} is at/under the cap after the start-of-turn discard (${totalRes(active)})`
    );

    // Trading: if the active bot can't afford anything on the HQ, try an equitable 1-for-1
    // swap of its richest resource for one it lacks, with a random opponent (DD-21).
    const affordsAny = () => g.hq.some((c) => c && g.canAfford(active, c.cost));
    if (!affordsAny() && Math.random() < 0.8) {
      const partner = g.players[Math.floor(Math.random() * g.players.length)];
      if (partner.id !== active.id) {
        const rich = RESOURCES.slice().sort((a, b) => active.resources[b] - active.resources[a])[0];
        const need = RESOURCES.slice().sort((a, b) => partner.resources[b] - partner.resources[a])[0];
        if (active.resources[rich] >= 1 && partner.resources[need] >= 1 && rich !== need) {
          const offer = g.proposeTrade(active.id, partner.id, { [rich]: 1 }, { [need]: 1 });
          // Partner bot accepts anything it can pay for.
          g.respondTrade(partner.id, offer.id, true);
          trades++;
        }
      }
    }

    // Home turfs (DD-24): work every held zone's power most turns, targets picked greedily.
    if (g.mode === 'homeTurfs' && g.phase === 'ACTION' && Math.random() < 0.7) {
      for (const z of g.zones) {
        if (g.phase !== 'ACTION') break;
        if (z.majorityOwner !== active.id) continue;
        if (g.turfUsed[z.id] === g.turnCounter) continue;
        const turf = g.turfForZone(z.id);
        let spec = null;
        if (turf.target === 'player') {
          const opp = g.players.find((p) => p.id !== active.id);
          spec = { playerId: opp.id };
        } else if (turf.target === 'zone') {
          const dest = g.zones.find((zz) => g.emptyNormalIndices(zz).length > 0);
          if (!dest) continue;
          spec = { zoneId: dest.id };
        } else if (turf.target === 'hqCard') {
          const idx = g.hq.findIndex(Boolean);
          if (idx < 0) continue;
          spec = { hqIndex: idx };
        }
        g.useHomeTurf(active.id, z.id, spec);
        turfs++;
      }
    }
    if (g.phase === 'GAME_OVER') break; // a turf's free peg can complete the map

    // Coalitions (DD-23): ally when the active bot and a partner jointly reach an
    // unowned zone's threshold; the partner accepts most of the time.
    if (g.players.length >= 3 && g.phase === 'ACTION' && Math.random() < 0.2) {
      coalitionHunt: for (const z of g.zones) {
        if (z.majorityOwner || z.coalition) continue;
        const mine = g.pegCount(z, active.id);
        if (mine < 1 || mine >= z.majority) continue;
        for (const partner of g.players) {
          if (partner.id === active.id) continue;
          const split = { from: mine, to: z.majority - mine };
          if (g.pegCount(z, partner.id) < split.to) continue;
          if (!g.mostHeldIdeology(active) || !g.mostHeldIdeology(partner)) continue;
          const offer = g.proposeCoalition(active.id, partner.id, z.id, split);
          g.respondCoalition(partner.id, offer.id, Math.random() < 0.7);
          if (z.coalition) coalitions++;
          break coalitionHunt;
        }
      }
    }
    if (g.phase === 'GAME_OVER') break; // a coalition can complete the map
    // Rarely walk out of a coalition on your own turn.
    if (g.phase === 'ACTION' && Math.random() < 0.03) {
      const z = g.zones.find(
        (z) => z.coalition && (z.coalition.a === active.id || z.coalition.b === active.id)
      );
      if (z) g.withdrawCoalition(active.id, z.id);
    }
    if (g.phase === 'GAME_OVER') break; // withdrawal can hand someone the final majority

    // Re-seat any voters an opponent's Land Grab benched, before they disperse (DD-21).
    while (g.phase === 'ACTION' && active.benched > 0) {
      const zone = g.zones.find((z) => g.emptyNormalIndices(z).length > 0);
      if (!zone) break;
      const room = g.emptyNormalIndices(zone).length;
      g.placeBenched(active.id, zone.id, Math.min(active.benched, room));
    }
    if (g.phase === 'GAME_OVER') break;

    // ideologue powers (L3/L5) (DD-21).
    if (g.phase === 'ACTION' && !g.debtLocked(active)) {
      // Prospecting — Mogul L3, once per turn: pay 1, take any 2.
      if (!affordsAny() && g.hasPerk(active.id, 'mogul', 3) && g.turnFlags.prospecting < 1) {
        const rich = RESOURCES.slice().sort((a, b) => active.resources[b] - active.resources[a])[0];
        const need = RESOURCES.slice().sort((a, b) => active.resources[a] - active.resources[b])[0];
        if (active.resources[rich] >= 1) g.prospect(active.id, rich, need, need);
      }
      // Snatch — Boss L3, up to twice per turn.
      while (g.hasPerk(active.id, 'boss', 3) && g.turnFlags.snatches < 2 && Math.random() < 0.35) {
        const victim = g.players.find((o) => o.id !== active.id && totalRes(o) > 0);
        if (!victim) break;
        g.snatch(active.id, victim.id, RESOURCES.find((r) => victim.resources[r] > 0));
      }
      // Payback — Boss L5, up to twice per turn: pay 1, discard an opponent's peg.
      while (g.hasPerk(active.id, 'boss', 5) && g.turnFlags.paybacks < 2 && Math.random() < 0.35) {
        const payRes = RESOURCES.find((r) => active.resources[r] >= 1);
        const hit = findOpponentPeg(active.id);
        if (!payRes || !hit) break;
        g.payback(active.id, payRes, hit.zoneId, hit.slotIndex);
      }
      // Land Grab — Mogul L5, up to three per turn: evict any non-volatile peg.
      while (g.hasPerk(active.id, 'mogul', 5) && g.turnFlags.landGrabs < 3 && Math.random() < 0.35) {
        const hit = findAnyPeg();
        if (!hit) break;
        g.landGrab(active.id, hit.zoneId, hit.slotIndex);
      }
      // Tough Love — Believer L5, once per turn: 2 trust + any 2 converts two pegs.
      if (
        g.hasPerk(active.id, 'believer', 5) &&
        g.turnFlags.toughLove < 1 &&
        active.resources.trust >= 2 &&
        Math.random() < 0.35
      ) {
        const pair = findOpponentPair(active.id);
        const extra = pair && greedyFrom({ ...active.resources, trust: active.resources.trust - 2 }, 2);
        if (pair && extra) g.toughLove(active.id, pair.zoneId, pair.a, pair.b, extra);
      }
    }
    if (g.phase === 'GAME_OVER') break;

    // Elites express automatically (fixer/enforcer/backer/informant/strongman fire in
    // the normal flow); here we exercise the invocable active powers (DD-22).
    if (g.phase === 'ACTION') {
      const mine = g.activeElites(active.id);
      const RES = ['funds', 'clout', 'media', 'trust'];
      const opp = g.players.find((x) => x.id !== active.id);
      const ownPeg = () => {
        for (const z of g.zones) {
          for (let i = 0; i < z.slots.length; i++) {
            if (i !== z.volatileIndex && z.slots[i] === active.id && z.majorityOwner !== active.id) {
              return { zoneId: z.id, slotIndex: i, zone: z };
            }
          }
        }
        return null;
      };
      const payN = (n) => {
        const out = { funds: 0, clout: 0, media: 0, trust: 0 };
        let need = n;
        for (const r of RES) {
          const t = Math.min(need, active.resources[r]);
          out[r] = t;
          need -= t;
          if (!need) break;
        }
        return need === 0 ? out : null;
      };
      try {
        if (mine.includes('backer') && active.backerTargets.length === 0 && opp) {
          g.pickPatronTargets(active.id, [opp.id]);
        }
        if (mine.includes('oracle') && Math.random() < 0.3) {
          const pg = ownPeg();
          if (pg) { g.oracleSacrifice(active.id, pg.zoneId, pg.slotIndex, { funds: 3 }); elites++; }
        } else if (mine.includes('insurgent') && Math.random() < 0.3) {
          const pg = ownPeg();
          const adj = pg && pg.zone.adjacent.find((a) => g.emptyNormalIndices(g.getZone(a)).length > 0);
          if (adj) { g.insurgentMove(active.id, [{ fromZoneId: pg.zoneId, slotIndex: pg.slotIndex, toZoneId: adj }]); elites++; }
        } else if (mine.includes('benefactor') && Math.random() < 0.3 && opp) {
          const pay = payN(2);
          const hqi = g.hq.findIndex(Boolean);
          const zone = g.zones.find((z) => g.emptyNormalIndices(z).length > 0);
          if (pay && hqi >= 0 && zone) { g.benefactorGift(active.id, opp.id, pay, hqi, zone.id); elites++; }
        } else if (mine.includes('spinner') && Math.random() < 0.3 && opp) {
          const pay = payN(3);
          if (pay) { g.buyHeadline(active.id, pay, opp.id); elites++; }
        } else if (mine.includes('maverick') && Math.random() < 0.3) {
          const pg = ownPeg();
          if (pg) { g.maverickCopy(active.id, 'oracle', { zoneId: pg.zoneId, slotIndex: pg.slotIndex, gains: { clout: 3 } }); elites++; }
        }
      } catch {
        /* legality mismatch this turn — skip */
      }
      if (g.phase === 'GAME_OVER') break;
    }

    // Conspiracies: occasionally buy one, paying the top card's price in any mix (DD-21).
    if (
      g.phase === 'ACTION' &&
      !g.debtLocked(active) &&
      Math.random() < 0.3 &&
      g.conspiracyDeck.length > 0
    ) {
      // Agitator (elite) shaves 2 off the price, up to twice per turn (DD-22).
      let price = g.conspiracyDeck[g.conspiracyDeck.length - 1].price;
      if (g.activeElites(active.id).includes('agitator') && (g.turnFlags.agitator || 0) < 2) {
        price = Math.max(0, price - 2);
      }
      const pay = greedyFrom(active.resources, price);
      if (pay) g.buyConspiracy(active.id, pay);
    }

    // Occasionally play a held (non-reaction) conspiracy at a legal target.
    if (g.phase === 'ACTION' && Math.random() < 0.5) {
      const playable = active.conspiracies.filter((c) => !c.reaction);
      if (playable.length) {
        const card = playable[Math.floor(Math.random() * playable.length)];
        const spec = pickTarget(card, active);
        if (spec !== undefined) {
          g.playConspiracy(active.id, card.id, spec);
          conspiracies++;
          resolveReactions();
        }
      }
    }
    if (g.phase === 'GAME_OVER') break;

    // Action: greedily buy affordable cards, place in random zone with space
    let bought = true;
    while (bought && g.phase === 'ACTION' && !g.debtLocked(active)) {
      bought = false;
      for (let i = 0; i < g.hq.length; i++) {
        const card = g.hq[i];
        if (!card || !g.canAfford(active, card.cost)) continue;
        const useVolatile = Math.random() < 0.25;
        const open = g.zones.filter(
          (z) =>
            g.emptyNormalIndices(z).length > 0 ||
            (useVolatile && z.slots[z.volatileIndex] === null)
        );
        if (open.length === 0) break;
        const zone = open[Math.floor(Math.random() * Math.min(3, open.length))];
        const res = g.buyVoterCard(active.id, i, zone.id, useVolatile);
        if (res.hitVolatile) headlines++;
        bought = true;
        break;
      }
    }
    if (g.phase === 'GAME_OVER') break;

    g.endTurn(active.id);

    // Gerrymander: one move per majority held (doubled by Election Fever). Keep moving
    // while the allowance lasts, then skip out (DD-21).
    while (g.phase === 'GERRYMANDER' && g.gerryMovesLeft > 0 && Math.random() < 0.7) {
      let moved = false;
      outer: for (const set of g.gerrymanderSets(active.id)) {
        for (const fromId of set) {
          if (g.isZoneBlocked(fromId)) continue;
          const from = g.getZone(fromId);
          for (let s = 0; s < from.slots.length; s++) {
            if (from.slots[s] === null || s === from.volatileIndex) continue;
            // Majority pegs move only for Election Fever (Icon L5).
            if (from.slots[s] === from.majorityOwner && !g.hasPerk(active.id, 'icon', 5)) continue;
            // Coalition-locked pegs never move (DD-23).
            if (g.coalitionLockedSlots(from).has(s)) continue;
            // Sometimes spring the trap: drop an opponent's peg into a volatile area.
            const trapId =
              from.slots[s] !== active.id && Math.random() < 0.3
                ? set.find((id) => {
                    if (id === fromId || g.isZoneBlocked(id)) return false;
                    const z = g.getZone(id);
                    return z.slots[z.volatileIndex] === null;
                  })
                : null;
            if (trapId) {
              g.gerrymander(active.id, fromId, s, trapId, true);
              gerrymanders++;
              headlines++;
              moved = true;
              break outer;
            }
            const toId = set.find(
              (id) =>
                id !== fromId &&
                !g.isZoneBlocked(id) &&
                g.emptyNormalIndices(g.getZone(id)).length > 0
            );
            if (!toId) continue;
            g.gerrymander(active.id, fromId, s, toId);
            gerrymanders++;
            moved = true;
            break outer;
          }
        }
      }
      if (!moved) break;
    }
    if (g.phase === 'GERRYMANDER') g.skipGerrymander(active.id);

    // Headline-triggered auctions resolve here, before cap cleanup.
    resolveAuctions();
    if (g.phase === 'GAME_OVER') break;

    // --- invariants after every turn ---
    // Over-cap is no longer forced at turn end: a player may finish above the cap and
    // carries the overflow into their next turn's start-of-turn discard (DD-21).
    for (const p of g.players) {
      for (const r of RESOURCES) assert(p.resources[r] >= 0, 'no negative resources');
      assert((p.benched || 0) >= 0, `${p.name} benched count never goes negative`);
    }
    for (const z of g.zones) {
      assert(z.slots.length === z.capacity, `${z.id} slot array intact`);
      if (z.majorityOwner) {
        const cnt = z.slots.filter((id) => id === z.majorityOwner).length;
        assert(cnt >= z.majority, `${z.id} majority owner actually holds majority`);
      }
      if (z.coalition) {
        assert(!z.majorityOwner, `${z.id} coalition zone has no solo owner`);
        const combined =
          g.pegCount(z, z.coalition.a) + g.pegCount(z, z.coalition.b);
        assert(combined >= z.majority, `${z.id} coalition actually holds the threshold`);
      }
    }
    // Hidden-hand safety: no other player's payload should carry a hand array.
    const view = g.serialize(g.players[0].id);
    assert(view.players.every((pp) => pp.conspiracies === undefined), 'no hands leak in serialize');
    // Hidden-objective secrecy: rivals' objectives never appear in my payload mid-game (DD-25).
    if (mode === 'hiddenObjectives' && g.phase !== 'GAME_OVER') {
      const str = JSON.stringify(view);
      for (const o of g.players.slice(1)) {
        assert(!str.includes(`"${o.objective.id}"`), `${o.name}'s objective stays hidden`);
      }
    }
  }

  assert(g.phase === 'GAME_OVER', `game ends within ${MAX_TURNS} turns (took ${turns})`);
  assert(g.winnerIds && g.winnerIds.length >= 1, 'has winner(s)');

  // Scoring: majorities score the threshold; coalition zones score the split (DD-23);
  // met hidden objectives add their bonus (DD-25).
  for (const p of g.players) {
    let expected = g.zones.reduce((s, z) => {
      if (z.majorityOwner === p.id) return s + z.majority;
      if (z.coalition && z.coalition.a === p.id) return s + z.coalition.split.a;
      if (z.coalition && z.coalition.b === p.id) return s + z.coalition.split.b;
      return s;
    }, 0);
    const objResult = (g.objectiveResults || []).find((r) => r.playerId === p.id);
    if (objResult && objResult.met) expected += objResult.bonus;
    assert(p.score === expected, `${p.name} score matches majorities + splits + objective`);
  }
  // Hidden objectives never leak into another player's payload before game over (DD-25).
  if (mode === 'hiddenObjectives') {
    assert(g.objectiveResults && g.objectiveResults.length === numPlayers, 'objective results published');
  }

  // Serialization sanity
  const s = g.serialize();
  assert(s.players.length === numPlayers, 'serialize players');
  assert(s.zones.length === (mode === 'twoPlayer' ? 7 : 9), 'serialize zones');
  assert(Array.isArray(s.zones[0].slots) && 'volatileIndex' in s.zones[0], 'zones expose slots + volatile');
  JSON.stringify(s); // must not throw

  console.log(
    `  ✔ ${seedLabel}${mode !== 'standard' ? ` [${mode}]` : ''}: ${numPlayers}p, ${turns} turns, ${trades} trades, ${conspiracies} conspiracies, ${elites} elites, ${coalitions} coalitions${mode === 'homeTurfs' ? `, ${turfs} turfs` : ''}, ${headlines} headlines, ${gerrymanders} gerrymanders — winner: ${g.players
      .filter((p) => g.winnerIds.includes(p.id))
      .map((p) => `${p.name} (${p.score})`)
      .join(', ')}`
  );
}

// --- error-path checks ---
function errorPaths() {
  const g = new SystemGame([
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]);
  let threw = 0;
  const expectThrow = (fn) => {
    try {
      fn();
    } catch {
      threw++;
      return;
    }
    throw new Error('expected throw');
  };
  expectThrow(() => g.answerPolicy('a', 'a')); // wrong phase
  expectThrow(() => g.pickStartingResource('a', 'gold')); // bad resource
  for (const p of g.players) {
    while (p.startingPicksRemaining > 0) g.pickStartingResource(p.id, 'funds');
  }
  expectThrow(() => g.pickStartingResource(g.players[0].id, 'funds')); // no picks left
  const inactive = g.players[1];
  expectThrow(() => g.answerPolicy(inactive.id, 'a')); // not your turn
  g.answerPolicy(g.activePlayer.id, 'a');
  expectThrow(() => g.buyVoterCard(g.activePlayer.id, 0, 'XX')); // bad zone (may also fail on afford — force resources)
  expectThrow(() => g.gerrymander(g.activePlayer.id, 'N', 0, 'C')); // wrong phase
  expectThrow(() => g.skipGerrymander(g.activePlayer.id)); // wrong phase
  console.log(`  ✔ error paths: ${threw} invalid actions correctly rejected`);
}

console.log('Running The System engine simulation...');
errorPaths();
for (let run = 0; run < 5; run++) {
  for (const n of [2, 3, 4, 5]) {
    // Run-sets 3 and 4 play under a mode so bots exercise them (DD-24, DD-25);
    // 2-player games in those sets go head-to-head instead (DD-26).
    const mode =
      run === 2 ? (n === 2 ? 'twoPlayer' : 'homeTurfs')
      : run === 3 ? (n === 2 ? 'twoPlayer' : 'hiddenObjectives')
      : 'standard';
    playGame(n, `run ${run + 1}`, mode);
  }
}
console.log('All simulations passed.');

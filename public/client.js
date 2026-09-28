// The System — browser client
/* global io */
const socket = io();

const $ = (id) => document.getElementById(id);
// Display names. The `media` storage key predates the rename to Buzz; the key stays put
// because "media" also appears as ordinary prose throughout the card decks.
const RES_LABELS = { funds: 'Funds', clout: 'Clout', media: 'Buzz', trust: 'Trust' };
const RES_KEYS = ['funds', 'clout', 'media', 'trust'];
const IDEOLOGY_LABELS = {
  mogul: 'The Mogul',
  boss: 'The Boss',
  icon: 'The Icon',
  believer: 'The Believer',
};
// Each ideology shares its color with the resource it grants
const IDEOLOGY_RES = { mogul: 'funds', boss: 'clout', icon: 'media', believer: 'trust' };

// Session survives the phone discarding the tab (app switch, screen lock), so a player
// rejoins their seat instead of coming back as a stranger. Storage can throw (private mode).
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* no storage: reconnect just won't survive a reload */
    }
  },
  del: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};
let myToken = store.get('system_token');
let myRoomCode = store.get('system_room');
let myPid = null; // public player id, sent by server in every state payload
let myIsHost = false;
let state = null; // latest gameState
let selectedHqIndex = null;
let discardPicks = { funds: 0, clout: 0, media: 0, trust: 0 };
let policyKey = null; // identifies the current policy question (turn + card)
let policyDismissed = false; // observer closed the question overlay
let answerReveal = null; // lastAnsweredCard shown briefly after an answer
let revealTimer = null;
let prevPhase = null;
let gerrySel = null; // { zoneId, slot } — peg picked up during gerrymander
let headlineSeen = 0; // last state.lastHeadline.key already shown
let headlineOpen = null; // headline currently displayed in the modal
let headlineTimer = null;
let tradeGive = { funds: 0, clout: 0, media: 0, trust: 0 };
let tradeWant = { funds: 0, clout: 0, media: 0, trust: 0 };
let tradeGiveCards = []; // conspiracy card ids I'm offering
let tradeWantCards = []; // conspiracy card ids I'm requesting
let tradeModalOpen = false;
let coalitionModalOpen = false;
let coalitionMine = 1; // my peg share in the proposed split (DD-23)
let setupBidAmount = 0; // 2 Player secret first-move bid (DD-26)
let reqSel = null; // requirement card id mid-placement: awaiting a zone click
let conspiracyPlay = null; // { card } mid-targeting: awaiting a target click
const consExpanded = new Set(); // conspiracy card ids whose explanation is open (survives re-render)
let auctionBid = 0; // my in-progress bid amount in the auction modal
let auctionKey = null; // identity of the current auction, to reset my bid input
// Ideologue-power targeting in progress (DD-21).
let perkMode = null; // 'landGrab' | 'payback' | 'toughLove' | 'bench'
let prospectSel = { give: 'funds', a: 'clout', b: 'clout' };
let snatchSel = { fromId: null, res: 'funds' };
let paybackRes = 'funds';
let toughLoveSel = []; // up to 2 × { zoneId, slot } — same zone, same opponent
let toughLovePay = { funds: 0, clout: 0, media: 0, trust: 0 }; // the "any 2" half of the cost
let buyDiscounts = { funds: 0, clout: 0, media: 0, trust: 0 }; // Helping Hands (Believer L3)
let consBuyOpen = false; // conspiracy payment stepper is open
let consBuyPay = { funds: 0, clout: 0, media: 0, trust: 0 };
let lastActionScroll = null; // turn whose action phase already scrolled the board into view (phones)
let lastStripActive = null; // active player last scrolled into view in the phone dossier strip
let eliteExpanded = false; // show the full elite catalogue vs just what's relevant
// Elite active-power flows (DD-22). eliteAs is set to an eliteId when the Maverick borrows.
let eliteMode = null; // null | 'oracle' | 'insurgentFrom' | 'benefactorZone'
let eliteAs = null; // eliteId being borrowed by the Maverick, else null
let oracleSel = null; // { zoneId, slot } chosen own peg for the Oracle sacrifice
let oracleGains = { funds: 0, clout: 0, media: 0, trust: 0 }; // the 3 resources to receive
let insurgentMoves = []; // committed [{ fromZoneId, slotIndex, toZoneId }]
let insurgentFrom = null; // { zoneId, slot } awaiting a destination click
let backerSel = []; // opponent ids picked for Backer backing
let benefactorSel = { toId: null, hqIndex: null }; // then click a zone to seat

// Touch screens: say "tap", and on narrow ones keep the board in view while placing.
const mq = (q) => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(q).matches;
const TAP = mq('(pointer: coarse)') ? 'tap' : 'click';
const isPhone = () => mq('(max-width: 600px), (max-height: 500px)');

const zeroRes = () => ({ funds: 0, clout: 0, media: 0, trust: 0 });
function resTotal(m) {
  return RES_KEYS.reduce((s, r) => s + (m[r] || 0), 0);
}
function resetBuyDiscounts() {
  buyDiscounts = zeroRes();
}
// Helping Hands allowance still unspent this turn.
function discountsLeft() {
  return 2 - ((state && state.turnFlags && state.turnFlags.discounts) || 0);
}

// ---------- screen helpers ----------
function show(screen) {
  ['screen-home', 'screen-lobby', 'screen-game'].forEach((s) =>
    $(s).classList.toggle('hidden', s !== screen)
  );
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

// ---------- notifications ----------
// Every gameState push is diffed against the previous one to find what needs this player's
// attention. Each event shows as a card in the corner; while the tab is in the background
// it also counts in the tab title and, for urgent ones, raises a system notification (if
// the player turned them on) and a short vibration.
const BASE_TITLE = document.title || 'The System';
const NOTIFY_KEY = 'system_notify';
let notices = []; // { id, text, urgent, ttl, timer } on screen, newest last
let noticeId = 0;
let unseen = 0; // attention events since the tab was last visible

const isHidden = () => !!document.hidden;
const systemNotifySupported = () => typeof window.Notification === 'function';
const systemNotifyOn = () =>
  systemNotifySupported() && window.Notification.permission === 'granted' && store.get(NOTIFY_KEY) !== 'off';

function notify(text, urgent) {
  const n = { id: ++noticeId, text, urgent: !!urgent, ttl: urgent ? 9000 : 5000, timer: null };
  notices.push(n);
  if (notices.length > 4) notices.shift();
  // A card that expired while nobody was looking is a missed alert: start the clock on return.
  if (!isHidden()) armNotice(n);
  renderNotices();
  if (!isHidden()) return;
  unseen++;
  updateTitle();
  if (!urgent) return;
  if (systemNotifyOn()) {
    try {
      const sys = new window.Notification('The System', { body: text, tag: 'the-system' });
      sys.onclick = () => {
        window.focus();
        sys.close();
      };
    } catch {
      /* e.g. Android Chrome only allows notifications from a service worker */
    }
  }
  try {
    if (navigator.vibrate) navigator.vibrate(150);
  } catch {
    /* unsupported */
  }
}
function armNotice(n) {
  if (!n.timer) n.timer = setTimeout(() => dismissNotice(n.id), n.ttl);
}
function dismissNotice(id) {
  notices = notices.filter((n) => n.id !== id);
  renderNotices();
}
function renderNotices() {
  $('notify-stack').innerHTML = notices
    .map((n) => `<div class="notice${n.urgent ? ' urgent' : ''}" data-notice="${n.id}">${esc(n.text)}</div>`)
    .join('');
}
$('notify-stack').onclick = (ev) => {
  const card = ev.target.closest && ev.target.closest('[data-notice]');
  if (card) dismissNotice(Number(card.dataset.notice));
};
function clearAttention() {
  unseen = 0;
  updateTitle();
  notices.forEach(armNotice);
}
// A backgrounded tab (or a phone on another app) still says when the table is waiting on
// you, and how much happened while you were away.
function updateTitle() {
  const myMove = state && state.phase !== 'GAME_OVER' && isMyTurn();
  const base = myMove ? `● Your turn — ${BASE_TITLE}` : BASE_TITLE;
  document.title = unseen ? `(${unseen}) ${base}` : base;
}

// 🔔 in the banner: opt in to system notifications for when the tab is in the background.
function renderNotifyBtn() {
  const b = $('btn-notify');
  if (!systemNotifySupported()) return b.classList.add('hidden');
  b.classList.remove('hidden');
  const on = systemNotifyOn();
  b.textContent = on ? '🔔' : '🔕';
  b.title = on
    ? 'Background alerts on — click to turn off'
    : 'Get a system notification when it’s your move and this tab is in the background';
}
$('btn-notify').onclick = async () => {
  if (systemNotifyOn()) {
    store.set(NOTIFY_KEY, 'off');
  } else {
    store.set(NOTIFY_KEY, 'on');
    try {
      if (window.Notification.permission === 'default') await window.Notification.requestPermission();
    } catch {
      /* old Safari: callback-only API */
    }
    if (window.Notification.permission === 'denied') {
      toast('Notifications are blocked for this site — allow them in your browser settings.');
    }
  }
  renderNotifyBtn();
};
renderNotifyBtn();

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Log lines that are about this player but come from someone else's action. Lines that
// already have their own structured event (offers, conspiracies, headlines) are skipped.
function logLineAboutMe(line, myName) {
  if (!new RegExp(`(^|[^\\w])${escRe(myName)}($|[^\\w])`).test(line)) return false;
  if (/^(🎭|📰|🗞)/.test(line)) return false;
  if (/ proposed a (trade|coalition) |awaiting their response/.test(line)) return false;
  // "Alice buys…" is Alice's own doing; "Alice's majority… is broken" is done to her.
  const subject = line.replace(/^[^\p{L}\p{N}]+/u, '');
  return !subject.startsWith(myName) || subject.startsWith(`${myName}'s majority`);
}

// What changed between two states of the same viewer that this viewer should know about.
function detectEvents(prev, s) {
  const out = [];
  const you = s.you;
  const nameOf = (id) => (s.players.find((p) => p.id === id) || { name: 'Someone' }).name;
  const my = s.players.find((p) => p.id === you);
  const add = (text, urgent) => out.push({ text, urgent });

  if (s.phase === 'GAME_OVER') {
    if (prev.phase !== 'GAME_OVER') {
      const w = (s.winnerIds || []).map(nameOf).join(' & ');
      add(`🏁 Game over${w ? ` — ${w} ${s.winnerIds.length > 1 ? 'win' : 'wins'}` : ''}.`, true);
    }
    return out;
  }
  if (s.activePlayerId === you && prev.activePlayerId !== you) add('🗳 Your turn.', true);
  if (s.reqPlacerId === you && prev.reqPlacerId !== you) add('📜 Your turn to pin a zone requirement.', true);
  if (s.phase === 'DISCARD' && prev.phase !== 'DISCARD' && s.activePlayerId === you) {
    add(`🗑 Over the cap — discard ${s.discardRequired} before you act.`, true);
  }
  const r = s.pendingReaction;
  const pr = prev.pendingReaction;
  if (r && r.victimId === you && !(pr && pr.victimId === you && pr.conspiracyTitle === r.conspiracyTitle)) {
    add(`🎭 ${r.byName} is playing ${r.conspiracyTitle} on you — respond now.`, true);
  }
  const seenTrades = new Set((prev.tradeOffers || []).map((o) => o.id));
  for (const o of s.tradeOffers || []) {
    if (o.to === you && !seenTrades.has(o.id)) add(`🤝 ${nameOf(o.from)} offers you a trade.`, true);
  }
  const seenCoalitions = new Set((prev.coalitionOffers || []).map((o) => o.id));
  for (const o of s.coalitionOffers || []) {
    if (o.to !== you || seenCoalitions.has(o.id)) continue;
    const z = s.zones.find((zz) => zz.id === o.zoneId);
    add(`🤝 ${nameOf(o.from)} proposes a coalition${z ? ` in ${z.name}` : ''}.`, true);
  }
  if (s.auction && !prev.auction) {
    add(`🔨 Auction open${s.auction.card && s.auction.card.voters ? ` — a ${s.auction.card.voters}-voter bloc` : ''}. Place your bids.`, true);
  }
  if (s.auctionPlacement && s.auctionPlacement.winnerId === you && !prev.auctionPlacement) {
    add('🔨 You won the auction — seat your bloc.', true);
  }
  if (s.finalTurnsRemaining != null && prev.finalTurnsRemaining == null) {
    add('⏳ The board is full — everyone gets one final turn.', true);
  }
  const h = s.lastHeadline;
  if (h && h.playerId === you && (!prev.lastHeadline || prev.lastHeadline.key !== h.key)) {
    add(`📰 Headline hits you: ${h.title}`, true);
  }
  const c = s.lastConspiracy;
  if (c && c.byId !== you && (!prev.lastConspiracy || prev.lastConspiracy.key !== c.key)) {
    add(`🎭 ${c.summary}`, !!my && new RegExp(`(^|[^\\w])${escRe(my.name)}($|[^\\w])`).test(c.summary));
  }
  const fresh = Math.min((s.logSeq || 0) - (prev.logSeq || 0), s.log.length);
  if (my && fresh > 0) {
    for (const line of s.log.slice(-fresh)) if (logLineAboutMe(line, my.name)) add(line, false);
  }
  return out;
}

// ---------- ⓘ explanations ----------
// Every info button carries data-info="<topic>"; one delegated listener opens the sheet,
// so buttons inside re-rendered panels need no wiring. Fixed topics live in help.js.
function infoBtn(topic, label) {
  return `<button class="info-btn" data-info="${esc(topic)}" aria-label="Explain ${esc(label)}">i</button>`;
}

// What each elite's power does (engine: server/game.js, DD-22) and why you'd want it.
const ELITE_INFO = {
  fixer: {
    kind: 'Always on',
    power: 'Your policy answers pay double resources.',
    why: 'Pure economy: every turn funds more buying. Strongest when you get it early.',
  },
  operator: {
    kind: 'Always on',
    power: 'When buying a voter card you may hold its voters in reserve instead of placing them, for as long as you like. Place them later on your turn.',
    why: 'Rivals can’t see where you’ll strike. Drop a bloc in at the exact moment a zone tips.',
  },
  benefactor: {
    kind: 'Once per turn',
    power: 'Give a rival 2 resources, then take one Market card’s voters into a zone for free.',
    why: 'A 2-resource gift for a 3–5 resource card. The rival gains a little; you gain a lot.',
  },
  backer: {
    kind: 'Always on',
    power: 'Pick one or two rivals to back. Each time one of them buys a 3-voter card, you get 1 voter in reserve (place it by your next turn).',
    why: 'You profit from rivals doing well, so trade generously with the ones you back.',
  },
  agitator: {
    kind: 'Always on',
    power: 'Conspiracies cost 2 less, up to twice per turn.',
    why: 'Makes conspiracies cheaper than voter cards. Built for a sabotage-heavy game.',
  },
  spinner: {
    kind: 'Once per turn',
    power: 'Pay 3 to draw a Headline and aim it at a rival’s strongest zone.',
    why: 'Headlines are mostly bad news. You pick who gets them.',
  },
  organizer: {
    kind: 'Always on',
    power: 'See every rival’s conspiracy cards.',
    why: 'No surprises. You know who can hurt you, and whether they’re bluffing in trades.',
  },
  informant: {
    kind: 'Always on',
    power: 'When a rival plays a conspiracy, one of their unprotected voters is removed. After a full round with no conspiracies, you get 2 voters in reserve (place them by your next turn).',
    why: 'Punishes dirty play and pays you when the table stays clean. Either way you gain.',
  },
  oracle: {
    kind: 'Once per turn',
    power: 'Remove one of your own voters from the board and take any 3 resources.',
    why: 'Turns a wasted voter (in a zone you can’t win) into the exact resources you need.',
  },
  insurgent: {
    kind: 'Once per turn',
    power: 'Move up to 4 of your own voters (not majority or Volatile Area voters) each into a neighbouring zone. Works alongside gerrymandering.',
    why: 'Mobility without needing a majority first. Pull scattered voters together to finish a capture.',
  },
  enforcer: {
    kind: 'Always on',
    power: 'Whenever another player answers a policy question, you take 1 from their largest resource pile.',
    why: 'Steady income on everyone else’s turn, and it slows the leaders most.',
  },
  strongman: {
    kind: 'Always on',
    power: 'When you gerrymander a rival’s voter into another zone, it becomes yours.',
    why: 'Every gerrymander move becomes a two-voter swing. Pairs well with holding many majorities.',
  },
  maverick: {
    kind: 'Once per turn',
    power: 'Borrow the power of the Benefactor, Spinner, Oracle or Insurgent for one use.',
    why: 'Flexibility over depth. It expires once any ideology reaches 3 — by your 9th answer at the latest.',
  },
};

// Resolve a topic key to { title, body, see }: fixed topics from help.js, plus
// per-elite and per-turf sheets built from live game data.
function helpTopic(key) {
  if (HELP[key]) return HELP[key];
  const [kind, id] = key.split(':');
  if (kind === 'elite') {
    const e = state && (state.eliteCatalog || []).find((c) => c.id === id);
    const info = ELITE_INFO[id];
    if (!e || !info) return null;
    const my = me();
    const miss = my ? eliteMissing(e, my) : [];
    const active = my && (my.elites || []).includes(id);
    const status = active
      ? '<p class="info-status on">You have this elite now.</p>'
      : my
      ? `<p class="info-status">You need: ${esc(miss.join(', '))}.</p>`
      : '';
    const warn = e.negation
      ? `<p><b>Refuse ${esc(ideoShort(e.negation))}:</b> one ${esc(ideoShort(e.negation))} card anywhere in your manifesto switches this off — and cards don’t go away.</p>`
      : '';
    return {
      title: e.title,
      body: `<p class="info-req">${esc(eliteReqText(e))}</p>
        <p><b>${esc(info.kind)}:</b> ${esc(info.power)}</p>
        <p><b>Why go for it:</b> ${esc(info.why)}</p>
        ${warn}${status}
        <p class="info-flavour">${esc(e.text)}</p>`,
      see: ['elites'],
    };
  }
  if (kind === 'turf') {
    const t = state && (state.homeTurfs || []).find((x) => x.zoneId === id);
    if (!t) return null;
    const ex = explainConspiracy({ effect: t.effect, target: t.target });
    return {
      title: t.title,
      body: `${ex ? `<p><b>Power:</b> ${esc(ex.does)}</p>` : ''}
        <p>${t.compulsory ? 'Automatic: fires on its own at the end of the holder’s turn if unused.' : 'Whoever holds this zone’s majority may use it once per turn.'}</p>
        <p class="info-flavour">${esc(t.text)}</p>`,
      see: ['turfs'],
    };
  }
  return null;
}

function openInfo(key) {
  const t = helpTopic(key);
  if (!t) return;
  $('info-title').textContent = t.title;
  const see = (t.see || []).filter((k) => HELP[k]);
  $('info-body').innerHTML =
    t.body +
    (see.length
      ? `<div class="info-see">See also: ${see
          .map((k) => `<button class="link-btn" data-info="${k}">${esc(HELP[k].title)}</button>`)
          .join('')}</div>`
      : '');
  $('modal-info').classList.remove('hidden');
  $('info-body').scrollTop = 0;
}
function closeInfo() {
  $('modal-info').classList.add('hidden');
}
// Capture phase: an ⓘ inside a clickable card (voter card, player card) must not also
// trigger that card's own action.
document.addEventListener(
  'click',
  (ev) => {
    const btn = ev.target.closest && ev.target.closest('[data-info]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    openInfo(btn.dataset.info);
  },
  true
);
$('info-close').onclick = closeInfo;
$('modal-info').addEventListener('click', (ev) => {
  if (ev.target === $('modal-info')) closeInfo();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeInfo();
});

// ---------- home ----------
$('btn-join').onclick = () => {
  socket.emit(
    'joinRoom',
    { code: $('code-input').value, name: $('name-input').value },
    (res) => {
      if (!res || !res.ok) return ($('home-error').textContent = (res && res.error) || 'Failed');
      saveSession(res.code, res.token);
    }
  );
};
function saveSession(code, token) {
  myToken = token;
  myRoomCode = code;
  store.set('system_token', token);
  store.set('system_room', code);
  store.set('system_name', $('name-input').value);
  $('home-error').textContent = '';
}

// Attempt reconnect on load
socket.on('connect', () => {
  $('conn-status').classList.add('hidden');
  if (myToken && myRoomCode) {
    socket.emit('joinRoom', { code: myRoomCode, token: myToken }, (res) => {
      if (!res || !res.ok) {
        store.del('system_token');
        store.del('system_room');
        myToken = null;
        myRoomCode = null;
      }
    });
  }
});

socket.on('errorMsg', toast);

// ---------- staying live ----------
// The server pushes state on every change; the risk is a client that stops hearing it.
// Phones freeze background tabs and restore pages from cache with a dead socket, so on
// every return to the page: reconnect if the socket is down (rejoining re-sends state),
// otherwise ask for a fresh copy in case a push was missed while frozen.
socket.on('disconnect', () => {
  // Only surface drops that last — a sub-second blip reconnects on its own.
  setTimeout(() => {
    if (myToken && !socket.connected) $('conn-status').classList.remove('hidden');
  }, 1500);
});
function resume() {
  if (!myToken) return;
  if (!socket.connected) socket.connect();
  else socket.emit('resync');
}
document.addEventListener('visibilitychange', () => {
  if (isHidden()) return;
  clearAttention();
  resume();
});
if (typeof window.addEventListener === 'function') {
  window.addEventListener('pageshow', (ev) => ev.persisted && resume()); // back/forward cache
  window.addEventListener('online', resume);
}

// Invite links (?room=ABCD) prefill the join code; the last-used name is remembered.
{
  const inviteCode = new URLSearchParams(location.search).get('room');
  if (inviteCode) $('code-input').value = inviteCode.toUpperCase().slice(0, 4);
  const savedName = store.get('system_name');
  if (savedName) $('name-input').value = savedName;
}
function inviteUrl(code) {
  return `${location.origin}${location.pathname}?room=${code}`;
}
$('btn-invite').onclick = async () => {
  const url = inviteUrl(myRoomCode);
  try {
    if (navigator.share) return await navigator.share({ title: 'The System', text: `Join my game: ${myRoomCode}`, url });
    await navigator.clipboard.writeText(url);
    toast('Invite link copied');
  } catch {
    /* share sheet dismissed */
  }
};

// ---------- lobby ----------
$('btn-create').onclick = () => {
  socket.emit('createRoom', { name: $('name-input').value }, (res) => {
    if (!res || !res.ok) return ($('home-error').textContent = (res && res.error) || 'Failed');
    saveSession(res.code, res.token);
  });
};
$('btn-start').onclick = () => socket.emit('startGame', { mode: $('mode-select').value });

socket.on('lobbyState', (lobby) => {
  myPid = lobby.you;
  myIsHost = !!lobby.youAreHost;
  show('screen-lobby');
  $('lobby-code').textContent = lobby.code;
  const qrSrc = `qr.svg?u=${encodeURIComponent(inviteUrl(lobby.code))}`;
  if ($('lobby-qr').getAttribute('src') !== qrSrc) $('lobby-qr').src = qrSrc;
  $('lobby-players').innerHTML = lobby.players
    .map(
      (p) =>
        `<li class="${p.connected ? '' : 'disconnected'}">${esc(p.name)} ${
          p.isHost ? '<span class="host-tag">HOST</span>' : ''
        }</li>`
    )
    .join('');
  $('btn-start').classList.toggle('hidden', !myIsHost);
  $('mode-row').classList.toggle('hidden', !myIsHost); // mode is the host's call (DD-24)
  // Two players ALWAYS play head-to-head — the mode select yields to the rule (DD-26).
  const forced2p = lobby.players.length === 2;
  const sel = $('mode-select');
  if (forced2p) {
    sel.innerHTML = '<option value="twoPlayer">2 Player — head to head (automatic)</option>';
    sel.disabled = true;
  } else if (sel.disabled || !sel.options || sel.options.length < 2) {
    sel.innerHTML = [
      '<option value="standard">Standard</option>',
      '<option value="homeTurfs">Home Turfs</option>',
      '<option value="hiddenObjectives">Hidden Objectives</option>',
    ].join('');
    sel.disabled = false;
  }
  $('lobby-wait').classList.toggle('hidden', myIsHost);
});

// ---------- game state ----------
socket.on('gameState', (s) => {
  // Diff against the previous state for the same seat; a first state (page load, rejoin)
  // is only a baseline, so a reconnect doesn't replay old news.
  const prev = state && state.you === s.you ? state : null;
  const events = prev ? detectEvents(prev, s) : [];
  if (prev && (s.logSeq || 0) > (prev.logSeq || 0)) {
    const now = Date.now();
    for (let q = Math.max(prev.logSeq || 0, s.logSeq - s.log.length) + 1; q <= s.logSeq; q++) logArrivals.set(q, now);
    for (const q of logArrivals.keys()) if (q <= s.logSeq - s.log.length) logArrivals.delete(q);
    setTimeout(() => state && renderLog(), LOG_FRESH_MS + 50);
  }
  const key = s.currentCard ? `${s.turnIndex}:${s.currentCard.id}` : null;
  if (key && key !== policyKey) {
    policyKey = key;
    policyDismissed = false;
  }
  if (prevPhase === 'POLICY' && s.phase !== 'POLICY' && s.lastAnsweredCard) {
    answerReveal = s.lastAnsweredCard;
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      answerReveal = null;
      if (state) render();
    }, 3500);
  }
  prevPhase = s.phase;
  if (s.lastHeadline && s.lastHeadline.key !== headlineSeen) {
    headlineSeen = s.lastHeadline.key;
    headlineOpen = s.lastHeadline;
    clearTimeout(headlineTimer);
    headlineTimer = setTimeout(() => {
      headlineOpen = null;
      if (state) render();
    }, 8000);
  }
  if (s.phase !== 'GERRYMANDER' || s.activePlayerId !== s.you) gerrySel = null;
  // Cancel an in-progress conspiracy targeting only if I may no longer play one.
  // Non-active players keep their targeting through the POLICY window (DD-21).
  if (!s.youMayPlayConspiracy) conspiracyPlay = null;
  if (s.activePlayerId !== s.you || !['ACTION', 'GERRYMANDER'].includes(s.phase)) {
    perkMode = null;
    toughLoveSel = [];
    toughLovePay = zeroRes();
    consBuyOpen = false;
    resetBuyDiscounts();
    resetEliteFlow();
  }
  // Reset my bid input when a new auction starts or the high bid moves past mine.
  const aKey = s.auction ? `${s.auction.card.id}` : null;
  if (aKey !== auctionKey) {
    auctionKey = aKey;
    auctionBid = s.auction ? s.auction.bid + 1 : 0;
  } else if (s.auction && auctionBid <= s.auction.bid) {
    auctionBid = s.auction.bid + 1;
  }
  state = s;
  myPid = s.you;
  myIsHost = !!s.youAreHost;
  show('screen-game');
  render();
  events.forEach((e) => notify(e.text, e.urgent));
  // Phones: when my action phase opens, bring the board up once — that's where the turn is played.
  const actionKey = isMyTurn() && s.phase === 'ACTION' ? s.turnIndex : null;
  if (actionKey !== null && actionKey !== lastActionScroll && isPhone()) {
    $('board').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  lastActionScroll = actionKey;
});

function me() {
  return state.players.find((p) => p.id === myPid);
}
function playerById(id) {
  return state.players.find((p) => p.id === id);
}
function isMyTurn() {
  return state.activePlayerId === myPid;
}
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- render ----------
// Each panel renders independently: a bug in one must not leave the log, the modals or
// anything after it frozen on a stale state until the player reloads.
const PANELS = [
  renderBanner,
  renderPlayers,
  renderBoard,
  renderPolicyOutcome,
  renderHq,
  renderPerksBar,
  renderConspiracies,
  renderElites,
  renderTradeOffers,
  renderObjective,
  renderRequirementPanel,
  renderLog,
  renderModals,
];
const renderFailures = []; // read by the headless test harness
function render() {
  for (const panel of PANELS) {
    try {
      panel();
    } catch (e) {
      renderFailures.push({ panel: panel.name, error: e });
      console.error(`${panel.name} failed`, e);
    }
  }
}
function takeRenderFailures() {
  return renderFailures.splice(0);
}

// ---------- ideologue powers bar (L3/L5, DD-21) ----------
const resOptions = (sel) =>
  RES_KEYS.map((r) => `<option value="${r}" ${r === sel ? 'selected' : ''}>${RES_LABELS[r]}</option>`).join('');

function renderPerksBar() {
  const el = $('perks-bar');
  const my = me();
  if (!my) return el.classList.add('hidden');
  const inAction = isMyTurn() && state.phase === 'ACTION';
  const inGerry = isMyTurn() && state.phase === 'GERRYMANDER';
  const debt = myDebt();
  const tf = state.turnFlags || {};
  const parts = [];

  // Voters benched by a Land Grab — re-seat them before they disperse.
  if (inAction && my.benched > 0) {
    parts.push(
      perkMode === 'bench'
        ? `<span class="perk-hint">Click a constituency to seat ${my.benched} returned voter(s)… <button id="btn-cancel-perk">Cancel</button></span>`
        : `<button id="btn-bench">🪑 Seat ${my.benched} returned voter(s)</button>`
    );
  }

  // Prospecting — Mogul L3, once per turn: pay 1, take any 2.
  if (inAction && myPerk('mogul') >= 3 && !tf.prospecting && !debt) {
    parts.push(
      `<span class="bank-trade">⛏ Give 1 <select id="pro-give">${resOptions(prospectSel.give)}</select>
        take <select id="pro-a">${resOptions(prospectSel.a)}</select> +
        <select id="pro-b">${resOptions(prospectSel.b)}</select>
        <button id="btn-prospect">Prospect</button></span>`
    );
  }

  // Land Grab — Mogul L5, up to 3 per turn: evict any non-volatile voter.
  if ((inAction || inGerry) && myPerk('mogul') >= 5 && (tf.landGrabs || 0) < 3) {
    const left = 3 - (tf.landGrabs || 0);
    parts.push(
      perkMode === 'landGrab'
        ? `<span class="perk-hint">Click any voter to evict it (${left} left)… <button id="btn-cancel-perk">Cancel</button></span>`
        : `<button id="btn-landgrab">🏗 Land Grab (${left})</button>`
    );
  }

  // Snatch — Boss L3, twice per turn: take 1 resource from an opponent.
  if (inAction && myPerk('boss') >= 3 && (tf.snatches || 0) < 2) {
    const oppList = state.players.filter((p) => p.id !== myPid);
    if (!snatchSel.fromId || !oppList.some((p) => p.id === snatchSel.fromId)) {
      snatchSel.fromId = oppList.length ? oppList[0].id : null;
    }
    parts.push(
      `<span class="bank-trade">✊ Snatch 1 <select id="sn-res">${resOptions(snatchSel.res)}</select> from
        <select id="sn-from">${oppList
          .map((p) => `<option value="${p.id}" ${p.id === snatchSel.fromId ? 'selected' : ''}>${esc(p.name)}</option>`)
          .join('')}</select>
        <button id="btn-snatch">Take (${2 - (tf.snatches || 0)})</button></span>`
    );
  }

  // Payback — Boss L5, twice per turn: pay 1 to discard an opponent's voter.
  if ((inAction || inGerry) && myPerk('boss') >= 5 && (tf.paybacks || 0) < 2 && !debt) {
    parts.push(
      perkMode === 'payback'
        ? `<span class="perk-hint">Click an opponent's voter to discard it… <button id="btn-cancel-perk">Cancel</button></span>`
        : `<span class="bank-trade">💢 Payback: pay 1 <select id="pb-res">${resOptions(paybackRes)}</select>
            <button id="btn-payback">Target (${2 - (tf.paybacks || 0)})</button></span>`
    );
  }

  // Tough Love — Believer L5, once per turn: 2 trust + any 2 converts two voters.
  if (inAction && myPerk('believer') >= 5 && !tf.toughLove && !debt) {
    if (perkMode !== 'toughLove') {
      parts.push('<button id="btn-toughlove">💛 Tough Love</button>');
    } else if (toughLoveSel.length < 2) {
      parts.push(
        `<span class="perk-hint">💛 Pick ${2 - toughLoveSel.length} more voter(s) — one opponent, one zone…
          <button id="btn-cancel-perk">Cancel</button></span>`
      );
    } else {
      const t = resTotal(toughLovePay);
      parts.push(
        `<span class="perk-hint">💛 Pay 2 trust + any 2 (${t}/2)
          ${RES_KEYS.map((r) => `<button class="res-btn ${r}" data-tl="${r}">${RES_LABELS[r]} ${toughLovePay[r]}</button>`).join('')}
          <button id="btn-tl-confirm" ${t !== 2 ? 'disabled' : ''}>Confirm</button>
          <button id="btn-tl-reset">Reset</button>
          <button id="btn-cancel-perk">Cancel</button></span>`
      );
    }
  }

  // Helping Hands — Believer L3: up to 2 single-resource discounts on a purchase.
  if (inAction && myPerk('believer') >= 3 && discountsLeft() > 0 && !debt) {
    parts.push(
      `<span class="bank-trade">💚 Helping Hands (${discountsLeft() - resTotal(buyDiscounts)} left):
        ${RES_KEYS.map((r) => `<button class="res-btn ${r}" data-disc="${r}">−${buyDiscounts[r]} ${RES_LABELS[r]}</button>`).join('')}
        <button id="btn-disc-reset">Clear</button></span>`
    );
  }

  el.classList.toggle('hidden', parts.length === 0);
  if (parts.length === 0) return;
  el.innerHTML = infoBtn('perks', 'ideology powers') + parts.join('');
  wirePerkBar();
}

function wirePerkBar() {
  const my = me();
  const bind = (id, fn) => {
    const e = $(id);
    if (e) e.onclick = fn;
  };
  const onSel = (id, fn) => {
    const e = $(id);
    if (e) e.onchange = () => fn(e.value);
  };

  onSel('pro-give', (v) => (prospectSel.give = v));
  onSel('pro-a', (v) => (prospectSel.a = v));
  onSel('pro-b', (v) => (prospectSel.b = v));
  bind('btn-prospect', () =>
    socket.emit('prospect', { giveRes: prospectSel.give, getA: prospectSel.a, getB: prospectSel.b })
  );

  bind('btn-bench', () => {
    perkMode = 'bench';
    render();
  });
  bind('btn-landgrab', () => {
    perkMode = 'landGrab';
    render();
  });

  onSel('sn-res', (v) => (snatchSel.res = v));
  onSel('sn-from', (v) => (snatchSel.fromId = v));
  bind('btn-snatch', () => socket.emit('snatch', { fromId: snatchSel.fromId, res: snatchSel.res }));

  onSel('pb-res', (v) => (paybackRes = v));
  bind('btn-payback', () => {
    perkMode = 'payback';
    render();
  });

  bind('btn-toughlove', () => {
    perkMode = 'toughLove';
    toughLoveSel = [];
    toughLovePay = zeroRes();
    render();
  });
  document.querySelectorAll('[data-tl]').forEach((b) => {
    b.onclick = () => {
      const r = b.dataset.tl;
      if (resTotal(toughLovePay) < 2 && my.resources[r] > toughLovePay[r]) toughLovePay[r]++;
      render();
    };
  });
  bind('btn-tl-reset', () => {
    toughLovePay = zeroRes();
    render();
  });
  bind('btn-tl-confirm', () => {
    const [a, b] = toughLoveSel;
    socket.emit('toughLove', {
      zoneId: a.zoneId,
      slotIndex1: a.slot,
      slotIndex2: b.slot,
      extraPayment: toughLovePay,
      discounts: resTotal(buyDiscounts) ? buyDiscounts : null,
    });
    perkMode = null;
    toughLoveSel = [];
    toughLovePay = zeroRes();
    resetBuyDiscounts();
  });

  document.querySelectorAll('[data-disc]').forEach((b) => {
    b.onclick = () => {
      const r = b.dataset.disc;
      if (resTotal(buyDiscounts) < discountsLeft()) buyDiscounts[r]++;
      render();
    };
  });
  bind('btn-disc-reset', () => {
    resetBuyDiscounts();
    render();
  });

  bind('btn-cancel-perk', () => {
    perkMode = null;
    toughLoveSel = [];
    toughLovePay = zeroRes();
    render();
  });
}

// A conspiracy is mid-targeting; conspiracies follow the per-viewer window (DD-21).
function currentPlay() {
  return conspiracyPlay;
}
function targeting(kind) {
  const play = currentPlay();
  if (!play || play.card.target !== kind) return false;
  return !!state.youMayPlayConspiracy;
}

// ---------- perk helpers (mirror of engine, display/highlight only) ----------
function myPerk(ideology) {
  const my = me();
  return my ? my.manifesto[ideology] : 0;
}
// Land Grab (Mogul L5): ANY non-volatile voter, anywhere — majority and your own too.
function landGrabTargetable(zone, idx) {
  return zone.slots[idx] != null && idx !== zone.volatileIndex;
}
// Payback (Boss L5): any opponent's non-volatile voter, majority pegs included.
function paybackTargetable(zone, idx) {
  const owner = zone.slots[idx];
  return owner != null && owner !== myPid && idx !== zone.volatileIndex;
}
// Tough Love (Believer L5): two non-volatile voters of the SAME opponent in ONE zone.
function toughLoveTargetable(zone, idx) {
  const owner = zone.slots[idx];
  if (owner == null || owner === myPid || idx === zone.volatileIndex) return false;
  if (toughLoveSel.length === 0) return true;
  const first = toughLoveSel[0];
  if (first.zoneId !== zone.id) return false;
  if (first.slot === idx) return true; // click again to deselect
  return owner === zoneById(first.zoneId).slots[first.slot];
}
function toughLovePicked(zone, idx) {
  return toughLoveSel.some((s) => s.zoneId === zone.id && s.slot === idx);
}

function zoneById(id) {
  return state.zones.find((z) => z.id === id);
}

// ---------- gerrymander helpers (mirror of engine legality) ----------
function myGerrySets() {
  return state.zones
    .filter((z) => z.majorityOwner === myPid)
    .map((z) => [z.id, ...z.adjacent]);
}
function normalSpace(zone) {
  return zone.slots.some((s, i) => s === null && i !== zone.volatileIndex);
}
function pegMovable(zone, idx) {
  const owner = zone.slots[idx];
  if (owner == null || idx === zone.volatileIndex) return false;
  if (zone.blocked) return false;
  // Election Fever (Icon L5) frees majority pegs; volatile never moves (DD-21).
  if (owner === zone.majorityOwner && myPerk('icon') < 5) return false;
  if (coalitionLockedSlots(zone).has(idx)) return false; // joint-majority pegs never move (DD-23)
  return myGerrySets().some(
    (set) =>
      set.includes(zone.id) &&
      set.some((id) => {
        if (id === zone.id) return false;
        const dest = zoneById(id);
        return !dest.blocked && (normalSpace(dest) || dest.slots[dest.volatileIndex] === null);
      })
  );
}
function gerryDestinations(fromZoneId) {
  const dests = new Set();
  for (const set of myGerrySets()) {
    if (!set.includes(fromZoneId)) continue;
    for (const id of set) {
      if (id !== fromZoneId && !zoneById(id).blocked && normalSpace(zoneById(id))) dests.add(id);
    }
  }
  return dests;
}
// Zones whose empty Volatile Area can receive the picked-up peg — the trap play (DD-20).
function gerryTrapDests(fromZoneId) {
  const dests = new Set();
  for (const set of myGerrySets()) {
    if (!set.includes(fromZoneId)) continue;
    for (const id of set) {
      const z = zoneById(id);
      if (id !== fromZoneId && !z.blocked && z.slots[z.volatileIndex] === null) dests.add(id);
    }
  }
  return dests;
}

// A peg an opponent-peg conspiracy may target: opponent's, non-majority, non-volatile.
function pegTargetable(zone, idx) {
  const owner = zone.slots[idx];
  if (owner == null || owner === myPid) return false;
  if (idx === zone.volatileIndex) return false;
  if (owner === zone.majorityOwner) return false;
  if (coalitionLockedSlots(zone).has(idx)) return false; // protected like majority pegs (DD-23)
  return true;
}

// Oracle: any of your own non-volatile voters.
function oracleTargetable(zone, idx) {
  return zone.slots[idx] === myPid && idx !== zone.volatileIndex;
}
// Insurgent: your own non-majority, non-volatile voter with an adjacent zone that has room.
function insurgentFromTargetable(zone, idx) {
  if (zone.slots[idx] !== myPid || idx === zone.volatileIndex) return false;
  if (zone.slots[idx] === zone.majorityOwner) return false; // engine blocks the majority owner's pegs
  return zone.adjacent.some((a) => normalSpace(zoneById(a)));
}
function insurgentDestZones() {
  if (!insurgentFrom) return new Set();
  const from = zoneById(insurgentFrom.zoneId);
  return new Set(from.adjacent.filter((a) => normalSpace(zoneById(a))));
}

// Send the mid-targeting conspiracy (or home-turf power) with a resolved targetSpec.
function emitPlay(targetSpec) {
  if (!conspiracyPlay) return;
  if (conspiracyPlay.turfZoneId) {
    socket.emit('useHomeTurf', { zoneId: conspiracyPlay.turfZoneId, targetSpec });
  } else {
    socket.emit('playConspiracy', { cardId: conspiracyPlay.card.id, targetSpec });
  }
  conspiracyPlay = null;
  render();
}

function renderBanner() {
  const b = $('phase-banner');
  const active = playerById(state.activePlayerId);
  let text = '';
  if (state.phase === 'SETUP_PICK') text = 'SETUP — players are choosing starting resources';
  else if (state.phase === 'SETUP_BID') text = 'SETUP — secret bids for the first move';
  else if (state.phase === 'SETUP_REQUIREMENTS') {
    const placer = playerById(state.reqPlacerId);
    text = `SETUP — ${placer && placer.id === myPid ? 'YOU place' : `${placer ? placer.name : '…'} places`} a zone requirement`;
  }
  else if (state.phase === 'GAME_OVER') text = 'ELECTION OVER';
  else {
    if (state.phase === 'AUCTION') {
      text = '🔨 PUBLIC AUCTION — everyone may bid';
    } else if (state.phase === 'AUCTION_PLACE') {
      const w = state.auctionPlacement ? playerById(state.auctionPlacement.winnerId) : null;
      text = `🔨 ${w && w.id === myPid ? 'YOU' : w ? w.name : 'Winner'} — placing the won bloc`;
    } else {
      const who = isMyTurn() ? 'YOUR TURN' : `${active.name}'s turn`;
      const phase =
        state.phase === 'POLICY' ? 'Policy Question' :
        state.phase === 'ACTION' ? 'Action Phase — influence voters' :
        state.phase === 'GERRYMANDER' ? `Gerrymandering — ${state.gerryMovesLeft} move(s) left` :
        state.phase === 'REACTION' ? 'A conspiracy is in play…' :
        state.phase === 'DISCARD' ? 'Discard down to 12 before you act' : state.phase;
      text = `${who} — ${phase}`;
      if (state.finalTurnsRemaining !== null) text += ` · FINAL ROUND (${state.finalTurnsRemaining} turns left)`;
    }
  }
  // Non-standard modes wear a badge so nobody forgets the house rules (DD-24).
  if (state.mode && state.mode !== 'standard') {
    text = `${MODE_LABELS[state.mode] || state.mode} · ${text}`;
  }
  b.textContent = text;
  const myMove = isMyTurn() && state.phase !== 'GAME_OVER';
  b.classList.toggle('your-turn', myMove);
  // A backgrounded tab (or a phone on another app) still says when the table is waiting on you.
  updateTitle();
}

const MODE_LABELS = {
  homeTurfs: '🏘 HOME TURFS',
  hiddenObjectives: '🎯 HIDDEN OBJECTIVES',
  twoPlayer: '⚔ HEAD TO HEAD',
  edgeOfChaos: '🔥 EDGE OF CHAOS',
};

// Colour alone can't carry the resource (red/green is the classic colour-blind pair),
// so every chip names itself to hover and to screen readers.
function resChip(r, n) {
  return `<span class="res-chip ${r}" title="${n} ${RES_LABELS[r]}" aria-label="${n} ${RES_LABELS[r]}">${n}</span>`;
}

function renderPlayers() {
  // While targeting a player-aimed conspiracy, opponents' cards become click targets.
  const pickPlayer = targeting('player') || targeting('playerRes');
  $('players-panel').innerHTML = state.players
    .map((p) => {
      const active = p.id === state.activePlayerId;
      const manifesto = Object.entries(p.manifesto)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => {
          // Powers unlock at 3 and 5; every 2 cards also pays passive income (DD-21).
          const pips = [3, 5].filter((l) => n >= l).map((l) => `L${l}`).join(' ');
          return `<span class="track ${IDEOLOGY_RES[k]}" title="${IDEOLOGY_LABELS[k]}">${k[0].toUpperCase() + k.slice(1)} ×${n}${
            pips ? ` <b class="perk-pips">${pips}</b>` : ''
          }</span>`;
        })
        .join(' ') || 'No ideology cards yet';
      const targetable = pickPlayer && p.id !== myPid;
      const income = p.passiveIncome ? resTotal(p.passiveIncome) : 0;
      const badges =
        (p.conspiracyCount ? `<span class="mini-badge conspiracy" title="Conspiracy cards">🎭 ${p.conspiracyCount}</span>` : '') +
        (income ? `<span class="mini-badge" title="Passive ideologue income per policy answered">⚙ +${income}</span>` : '') +
        (p.benched ? `<span class="mini-badge" title="Voters benched by a Land Grab">🪑 ${p.benched}</span>` : '') +
        (p.iou && p.iou.debt > 0 ? `<span class="mini-badge iou" title="Owes an IOU">IOU ${p.iou.debt}</span>` : '');
      // The scoreboard: constituencies held (solo or in coalition) and voters on the map.
      const zonesHeld = state.zones.filter(
        (z) => z.majorityOwner === p.id || (z.coalition && (z.coalition.a === p.id || z.coalition.b === p.id))
      ).length;
      const voters = state.zones.reduce((n, z) => n + z.slots.filter((o) => o === p.id).length, 0);
      const cap = p.cap || state.resourceCap;
      return `<div class="player-card border-${p.color} ${active ? 'active' : ''} ${targetable ? 'targetable' : ''}" data-target-player="${targetable ? p.id : ''}">
        ${active && state.phase !== 'GAME_OVER' ? '<div class="turn-tag">▶ On the clock</div>' : ''}
        <div class="pname">${esc(p.name)} ${p.id === myPid ? '<span class="you-tag">YOU</span>' : ''} ${badges}</div>
        <div class="score-row"><span title="Constituencies held"><b>${zonesHeld}</b> zone${zonesHeld === 1 ? '' : 's'}</span> · <span title="Voters on the map"><b>${voters}</b> voter${voters === 1 ? '' : 's'}</span></div>
        <div class="res-row">
          ${RES_KEYS.map((r) => resChip(r, p.resources[r])).join('')}
          <span class="res-total ${p.resourceTotal > cap ? 'cap-warn' : ''}" title="Resources held / cap">${p.resourceTotal}/${cap}</span>
        </div>
        <div class="manifesto-row">${manifesto}</div>
      </div>`;
    })
    .join('');
  if (pickPlayer) {
    document.querySelectorAll('[data-target-player]').forEach((el) => {
      if (!el.dataset.targetPlayer) return;
      el.onclick = () => onPlayerTarget(el.dataset.targetPlayer);
    });
  }
  // On phones the dossiers are a sideways strip: bring the new active player into view
  // once per turn change (never on every render, so a player's own swipe isn't undone).
  const panel = $('players-panel');
  if (state.activePlayerId !== lastStripActive && panel.scrollWidth > panel.clientWidth) {
    const card = panel.querySelector('.player-card.active');
    if (card) panel.scrollLeft += card.getBoundingClientRect().left - panel.getBoundingClientRect().left;
  }
  lastStripActive = state.activePlayerId;
}

// A player card was clicked while targeting a conspiracy or elite.
function onPlayerTarget(playerId) {
  const play = currentPlay();
  if (play.card.target === 'playerRes') {
    // Two-step: now choose which resource to take. Stash the player.
    play.playerId = playerId;
    render(); // the panel shows resource buttons
  } else {
    emitPlay({ playerId });
  }
}

// ---- Peg scatter across the map ----------------------------------------
// A zone's voters are spread EVENLY over its whole territory via farthest-point
// sampling of candidate points that lie inside the polygon (clear of borders and
// the label plate). The result fills the region, keeps a minimum spacing so pegs
// never overlap, and is DETERMINISTIC — no RNG — so a peg's position (and its
// click target) is identical on every render.
function hash2(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Zone outlines in board % — these MUST match the clip-path polygons in style.css.
const ZONE_POLY = {
  NW: [[0, 0], [25, 6], [31, 50], [0, 33]],
  N:  [[25, 6], [75, 6], [69, 50], [50, 31], [31, 50]],
  NE: [[100, 0], [75, 6], [69, 50], [100, 33]],
  W:  [[0, 33], [31, 50], [0, 67]],
  C:  [[50, 31], [69, 50], [50, 69], [31, 50]],
  E:  [[100, 33], [69, 50], [100, 67]],
  SW: [[0, 100], [0, 67], [31, 50], [25, 94]],
  S:  [[25, 94], [75, 94], [69, 50], [50, 69], [31, 50]],
  SE: [[100, 100], [100, 67], [69, 50], [75, 94]],
  // 2 Player board (DD-26): six wards ringing the central hexagon.
  Z1: [[25, 0], [75, 0], [65, 30], [35, 30]],
  Z2: [[75, 0], [100, 0], [100, 50], [80, 50], [65, 30]],
  Z3: [[100, 50], [100, 100], [75, 100], [65, 70], [80, 50]],
  Z4: [[75, 100], [25, 100], [35, 70], [65, 70]],
  Z5: [[25, 100], [0, 100], [0, 50], [20, 50], [35, 70]],
  Z6: [[0, 50], [0, 0], [25, 0], [35, 30], [20, 50]],
  Z7: [[35, 30], [65, 30], [80, 50], [65, 70], [35, 70], [20, 50]],
};
// Rectangles (board %, [x0,y0,x1,y1]) the label plates occupy — pegs steer clear
// so text never sits on top of a voter (roomy enough to also clear a capture stamp).
const LABEL_BOX = {
  NW: [0, 1, 33, 22], N: [35, 1, 65, 14], NE: [67, 1, 100, 22],
  W:  [0, 32, 31, 48], C: [38, 32, 62, 49], E: [69, 32, 100, 48],
  SW: [0, 79, 33, 99], S: [35, 85, 65, 99], SE: [67, 78, 100, 99],
  Z1: [35, 1, 65, 12], Z2: [72, 1, 100, 16], Z3: [72, 84, 100, 99],
  Z4: [35, 88, 65, 99], Z5: [0, 84, 28, 99], Z6: [0, 1, 28, 16],
  Z7: [37, 42, 63, 57],
};
const PEG_MARGIN = 2.4; // board-% clearance a peg centre keeps from any border

function pointInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
function edgeClearance(poly, x, y) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    d = Math.min(d, segDist(x, y, poly[j], poly[i]));
  }
  return d;
}
function inBox(box, x, y) {
  return box && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

// Candidate lattice inside the polygon, clear of borders and the label box.
function zoneCandidates(zoneId, step) {
  const poly = ZONE_POLY[zoneId];
  const box = LABEL_BOX[zoneId];
  let minX = 100, minY = 100, maxX = 0, maxY = 0;
  for (const [px, py] of poly) {
    minX = Math.min(minX, px); minY = Math.min(minY, py);
    maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
  }
  const pts = [];
  for (let y = minY + step / 2; y <= maxY; y += step) {
    for (let x = minX + step / 2; x <= maxX; x += step) {
      // deterministic sub-cell jitter to shake off the grid look
      const h = hash2(zoneId + ':' + Math.round(x) + ':' + Math.round(y));
      const jx = ((h & 255) / 255 - 0.5) * step * 0.7;
      const jy = (((h >> 8) & 255) / 255 - 0.5) * step * 0.7;
      const cx = x + jx, cy = y + jy;
      if (!pointInPoly(poly, cx, cy)) continue;
      if (edgeClearance(poly, cx, cy) < PEG_MARGIN) continue;
      if (inBox(box, cx, cy)) continue;
      pts.push([cx, cy]);
    }
  }
  return pts;
}

function slotPositions(zoneId, n) {
  if (n <= 0) return [];
  const poly = ZONE_POLY[zoneId];
  if (!poly) {
    return Array.from({ length: n }, (_, i) => ({ x: 10 + (i % 6) * 4, y: 10 + Math.floor(i / 6) * 4 }));
  }
  // Grow the lattice step until it yields comfortably more candidates than pegs,
  // so farthest-point sampling has room to spread them.
  let cands = [];
  for (const step of [2.6, 2.2, 1.8, 1.5, 1.2, 1.0]) {
    cands = zoneCandidates(zoneId, step);
    if (cands.length >= n * 3) break;
  }
  if (cands.length === 0) return Array.from({ length: n }, () => ({ x: 50, y: 50 }));
  if (cands.length <= n) return cands.map(([x, y]) => ({ x, y }));

  // Farthest-point sampling: start deepest inside the zone, then repeatedly add
  // the candidate maximally far from everything chosen → an even, gap-free spread.
  let startIdx = 0, bestClear = -1;
  for (let i = 0; i < cands.length; i++) {
    const c = edgeClearance(poly, cands[i][0], cands[i][1]);
    if (c > bestClear) { bestClear = c; startIdx = i; }
  }
  const chosen = [cands[startIdx]];
  const dist = cands.map((c) => Math.hypot(c[0] - cands[startIdx][0], c[1] - cands[startIdx][1]));
  while (chosen.length < n) {
    let k = 0, best = -1;
    for (let i = 0; i < cands.length; i++) {
      if (dist[i] > best) { best = dist[i]; k = i; }
    }
    chosen.push(cands[k]);
    dist[k] = -1;
    for (let i = 0; i < cands.length; i++) {
      if (dist[i] < 0) continue;
      const d = Math.hypot(cands[i][0] - cands[k][0], cands[i][1] - cands[k][1]);
      if (d < dist[i]) dist[i] = d;
    }
  }
  return chosen.map(([x, y]) => ({ x, y }));
}

// Mirror of the engine's coalitionLockedSlots: the first split.a pegs of partner a and
// first split.b of partner b form the joint majority (DD-23). Cosmetic only.
function coalitionLockedSlots(z) {
  if (!z.coalition) return new Set();
  const { a, b, split } = z.coalition;
  const locked = new Set();
  const want = { [a]: split.a, [b]: split.b };
  for (let i = 0; i < z.slots.length; i++) {
    const owner = z.slots[i];
    if (owner != null && want[owner] > 0) {
      locked.add(i);
      want[owner]--;
    }
  }
  return locked;
}

// Dual-color capture tag for a coalition zone, with a walk-out button for partners.
function coalitionTag(z) {
  const a = playerById(z.coalition.a);
  const b = playerById(z.coalition.b);
  const canWithdraw =
    isMyTurn() &&
    (z.coalition.a === myPid || z.coalition.b === myPid) &&
    ['POLICY', 'ACTION', 'GERRYMANDER'].includes(state.phase);
  return `<div class="captured-tag coalition-tag">
    <span class="bg-${a.color}">${esc(a.name)} ${z.coalition.split.a}</span><span class="bg-${b.color}">${esc(b.name)} ${z.coalition.split.b}</span>
    ${canWithdraw ? `<button class="coalition-leave" data-withdraw="${z.id}" title="Walk out of the coalition">✕</button>` : ''}
  </div>`;
}

// Home turf chip on a zone: the zone's power, a Use button for the rights-holder (DD-24).
function turfChip(z) {
  const turf = (state.homeTurfs || []).find((t) => t.zoneId === z.id);
  if (!turf) return '';
  const usedThisTurn = state.turfUsed && state.turfUsed[z.id] === state.turnCounter;
  const usable =
    isMyTurn() &&
    ['ACTION', 'GERRYMANDER'].includes(state.phase) &&
    z.majorityOwner === myPid &&
    !usedThisTurn &&
    !conspiracyPlay &&
    !perkMode &&
    !eliteMode;
  return `<div class="turf-chip" title="${esc(turf.text)}">🏘 ${esc(turf.title)} ${infoBtn('turf:' + z.id, turf.title)}${
    turf.compulsory ? ' <i>(auto)</i>' : ''
  }${usedThisTurn ? ' ✓' : ''}${usable ? ` <button class="turf-use" data-turf="${z.id}">Use</button>` : ''}</div>`;
}

function renderBoard() {
  const useVolatile = $('volatile-check').checked;
  const canPlace = isMyTurn() && state.phase === 'ACTION' && selectedHqIndex !== null && !perkMode && !eliteMode;
  const inGerry = isMyTurn() && state.phase === 'GERRYMANDER';
  const insurgentDests = eliteMode === 'insurgentFrom' && insurgentFrom ? insurgentDestZones() : new Set();
  // Auction winner placing their won bloc: any zone with room is a valid drop.
  const inAuctionPlace =
    state.phase === 'AUCTION_PLACE' && state.auctionPlacement && state.auctionPlacement.winnerId === myPid;
  const gerryDests = inGerry && gerrySel ? gerryDestinations(gerrySel.zoneId) : new Set();
  const trapDests = inGerry && gerrySel ? gerryTrapDests(gerrySel.zoneId) : new Set();

  const pickPeg = targeting('opponentPeg');
  const pickZone = targeting('zone');

  // Two layers: clipped territory FILLS (the map shapes + click targets) and an
  // UNCLIPPED overlay carrying labels + scattered pegs, so long names and edge
  // pegs are never cut off by a zone's clip-path.
  const fills = [];
  const overlays = [];
  state.zones.forEach((z) => {
      const owner = z.majorityOwner ? playerById(z.majorityOwner) : null;
      const locked = coalitionLockedSlots(z); // joint-majority pegs render like majority pegs
      const volatileFree = z.slots[z.volatileIndex] === null;
      const placeable = normalSpace(z) || (useVolatile && volatileFree);
      const selectable =
        (reqSel && state.phase === 'SETUP_REQUIREMENTS' && !z.requirement) ||
        (canPlace && placeable) ||
        (inAuctionPlace && placeable) ||
        (inGerry && gerryDests.has(z.id)) ||
        (perkMode === 'bench' && normalSpace(z)) ||
        (eliteMode === 'benefactorZone' && normalSpace(z)) ||
        (eliteMode === 'insurgentFrom' && insurgentFrom && insurgentDests.has(z.id)) ||
        pickZone;
      let ownerSeen = 0;
      const pegPos = slotPositions(z.id, z.slots.length);
      const slots = z.slots.map((pid, i) => {
        const pegOwner = pid ? playerById(pid) : null;
        // The first `majority` pegs of the owner are the flipped (locked) majority pegs.
        let isMajorityPeg = locked.has(i);
        if (pegOwner && owner && pegOwner.id === owner.id) {
          ownerSeen++;
          isMajorityPeg = ownerSeen <= z.majority;
        }
        const movable = inGerry && !perkMode && pegMovable(z, i);
        const hittable = pickPeg && pegTargetable(z, i);
        const grabbable = perkMode === 'landGrab' && landGrabTargetable(z, i);
        const payable = perkMode === 'payback' && paybackTargetable(z, i);
        const tlPick = perkMode === 'toughLove' && toughLoveSel.length < 2 && toughLoveTargetable(z, i);
        const oraclePick = eliteMode === 'oracle' && !oracleSel && oracleTargetable(z, i);
        const insurgentPick = eliteMode === 'insurgentFrom' && !insurgentFrom && insurgentFromTargetable(z, i);
        // An empty volatile slot in a legal destination is a trap drop (DD-20).
        const trapTarget =
          inGerry && !perkMode && gerrySel && i === z.volatileIndex && pid === null && trapDests.has(z.id);
        const picked =
          (gerrySel && gerrySel.zoneId === z.id && gerrySel.slot === i) ||
          (perkMode === 'toughLove' && toughLovePicked(z, i)) ||
          (oracleSel && oracleSel.zoneId === z.id && oracleSel.slot === i) ||
          (insurgentFrom && insurgentFrom.zoneId === z.id && insurgentFrom.slot === i);
        const p = pegPos[i];
        return `<div class="slot ${pegOwner ? 'peg-' + pegOwner.color : ''} ${isMajorityPeg ? 'majority' : ''} ${
          i === z.volatileIndex ? 'volatile' : ''
        } ${movable || hittable || grabbable || payable || tlPick || oraclePick || insurgentPick ? 'movable' : ''} ${
          trapTarget ? 'trap-target' : ''
        } ${picked ? 'picked' : ''}" data-zone="${z.id}" data-slot="${i}" style="left:${p.x.toFixed(
          2
        )}%;top:${p.y.toFixed(2)}%"></div>`;
      });
      fills.push(
        `<div class="zone ${selectable ? 'selectable' : ''} ${z.blocked ? 'blocked' : ''} ${
          owner ? 'owned-' + owner.color : ''
        }" data-zone="${z.id}"></div>`
      );
      overlays.push(`<div class="zgroup" data-zone="${z.id}">
        <div class="zbody">
          <div class="zname">${z.name}</div>
          <div class="zreq">majority ${z.majority} / ${z.capacity}${z.blocked ? ' · 🔒 frozen' : ''}</div>
          ${owner ? `<div class="captured-tag bg-${owner.color}">${esc(owner.name)}</div>` : ''}
          ${z.coalition ? coalitionTag(z) : ''}
          ${turfChip(z)}
          ${reqChip(z)}
        </div>
        <div class="zpegs">${slots.join('')}</div>
      </div>`);
    });
  $('board').innerHTML = fills.join('') + `<div id="board-overlay">${overlays.join('')}</div>`;

  document.querySelectorAll('[data-withdraw]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      socket.emit('withdrawCoalition', { zoneId: b.dataset.withdraw });
    };
  });

  document.querySelectorAll('[data-turf]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const turf = (state.homeTurfs || []).find((t) => t.zoneId === b.dataset.turf);
      if (!turf) return;
      if (turf.target === 'none' || turf.target === 'self') {
        socket.emit('useHomeTurf', { zoneId: turf.zoneId, targetSpec: null });
      } else {
        // Targeted turf: reuse the conspiracy click-a-target flow (DD-24).
        conspiracyPlay = { card: { id: null, target: turf.target, title: turf.title }, turfZoneId: turf.zoneId };
        render();
      }
    };
  });

  if (reqSel && state.phase === 'SETUP_REQUIREMENTS') {
    document.querySelectorAll('.zone.selectable').forEach((el) => {
      el.onclick = () => {
        socket.emit('placeRequirement', { cardId: reqSel, zoneId: el.dataset.zone });
        reqSel = null;
      };
    });
  } else if (eliteMode === 'oracle') {
    document.querySelectorAll('.slot.movable').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        oracleSel = { zoneId: el.dataset.zone, slot: Number(el.dataset.slot) };
        render(); // panel now shows the gains picker
      };
    });
  } else if (eliteMode === 'insurgentFrom' && !insurgentFrom) {
    document.querySelectorAll('.slot.movable').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        insurgentFrom = { zoneId: el.dataset.zone, slot: Number(el.dataset.slot) };
        render(); // adjacent zones with room light up as destinations
      };
    });
  } else if (eliteMode === 'insurgentFrom' && insurgentFrom) {
    document.querySelectorAll('.zone.selectable').forEach((el) => {
      el.onclick = () => {
        insurgentMoves.push({
          fromZoneId: insurgentFrom.zoneId,
          slotIndex: insurgentFrom.slot,
          toZoneId: el.dataset.zone,
        });
        insurgentFrom = null;
        if (insurgentMoves.length >= 4) emitElitePower(eliteAs || 'insurgent', { moves: insurgentMoves });
        else render(); // stage more moves or press Send
      };
    });
  } else if (eliteMode === 'benefactorZone') {
    document.querySelectorAll('.zone.selectable').forEach((el) => {
      el.onclick = () => {
        const pay = autoPay(2);
        if (!pay) {
          toast('Need 2 resources to gift.');
          return;
        }
        emitElitePower(eliteAs || 'benefactor', {
          toId: benefactorSel.toId,
          payment: pay,
          hqIndex: benefactorSel.hqIndex,
          zoneId: el.dataset.zone,
        });
      };
    });
  } else if (perkMode === 'landGrab') {
    document.querySelectorAll('.slot.movable').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        socket.emit('landGrab', { zoneId: el.dataset.zone, slotIndex: Number(el.dataset.slot) });
      };
    });
  } else if (perkMode === 'payback') {
    document.querySelectorAll('.slot.movable').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        socket.emit('payback', {
          payRes: paybackRes,
          zoneId: el.dataset.zone,
          slotIndex: Number(el.dataset.slot),
        });
        perkMode = null;
      };
    });
  } else if (perkMode === 'toughLove') {
    document.querySelectorAll('.slot.movable, .slot.picked').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        const zoneId = el.dataset.zone;
        const slot = Number(el.dataset.slot);
        if (toughLovePicked(zoneById(zoneId), slot)) {
          toughLoveSel = toughLoveSel.filter((s) => !(s.zoneId === zoneId && s.slot === slot));
        } else if (toughLoveSel.length < 2) {
          toughLoveSel.push({ zoneId, slot });
        }
        render();
      };
    });
  } else if (perkMode === 'bench') {
    document.querySelectorAll('.zone.selectable').forEach((el) => {
      el.onclick = () => {
        socket.emit('placeBenched', { zoneId: el.dataset.zone, n: me().benched });
        perkMode = null;
      };
    });
  } else if (pickPeg) {
    document.querySelectorAll('.slot.movable').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        emitPlay({ zoneId: el.dataset.zone, slotIndex: Number(el.dataset.slot) });
      };
    });
  } else if (pickZone) {
    document.querySelectorAll('.zone.selectable').forEach((el) => {
      el.onclick = () => emitPlay({ zoneId: el.dataset.zone });
    });
  } else if (canPlace) {
    document.querySelectorAll('.zone.selectable').forEach((el) => {
      el.onclick = () => {
        socket.emit('buyVoterCard', {
          hqIndex: selectedHqIndex,
          zoneId: el.dataset.zone,
          useVolatile: $('volatile-check').checked,
          discounts: resTotal(buyDiscounts) ? buyDiscounts : null,
        });
        selectedHqIndex = null;
        resetBuyDiscounts();
        $('volatile-check').checked = false;
      };
    });
  } else if (inAuctionPlace) {
    document.querySelectorAll('.zone.selectable').forEach((el) => {
      el.onclick = () => {
        socket.emit('placeAuctionWin', {
          zoneId: el.dataset.zone,
          useVolatile: $('volatile-check').checked,
        });
        $('volatile-check').checked = false;
      };
    });
  } else if (inGerry) {
    document.querySelectorAll('.slot.movable').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        const zoneId = el.dataset.zone;
        const slot = Number(el.dataset.slot);
        gerrySel = gerrySel && gerrySel.zoneId === zoneId && gerrySel.slot === slot ? null : { zoneId, slot };
        render();
      };
    });
    // Drop into a Volatile Area — traps the peg's owner with a headline (DD-20).
    document.querySelectorAll('.slot.trap-target').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        if (!gerrySel) return;
        socket.emit('gerrymander', {
          fromZoneId: gerrySel.zoneId,
          slotIndex: gerrySel.slot,
          toZoneId: el.dataset.zone,
          toVolatile: true,
        });
        gerrySel = null;
      };
    });
    document.querySelectorAll('.zone.selectable').forEach((el) => {
      el.onclick = () => {
        if (!gerrySel) return;
        socket.emit('gerrymander', {
          fromZoneId: gerrySel.zoneId,
          slotIndex: gerrySel.slot,
          toZoneId: el.dataset.zone,
        });
        gerrySel = null;
      };
    });
  }
}

function rewardChips(chosen) {
  const rewards = Object.entries(chosen.rewards)
    .map(([r, n]) => `<span class="res-chip ${r}">+${n} ${RES_LABELS[r]}</span>`)
    .join('');
  const ideo = chosen.ideology;
  return `${rewards}<span class="res-chip ${IDEOLOGY_RES[ideo]}">+1 ${IDEOLOGY_LABELS[ideo] || esc(ideo)} card</span>`;
}

function renderPolicyOutcome() {
  const el = $('policy-outcome');
  const last = state.lastAnsweredCard;
  // Only shown during ACTION, when the last answer is the active player's
  const visible = state.phase === 'ACTION' && !!last;
  el.classList.toggle('hidden', !visible);
  if (!visible) return;
  const active = playerById(state.activePlayerId);
  const who = isMyTurn() ? 'You' : esc(active.name);
  el.innerHTML = `<div class="hq-title">Policy Outcome ${infoBtn('outcome', 'the policy outcome')}</div>
    <p class="outcome-line">${who} chose “${esc(last.chosen.text)}”</p>
    <div class="res-row">${rewardChips(last.chosen)}</div>`;
}

// The cost after applying the Helping Hands discounts staged in the perks bar (DD-21).
function effectiveBuyCost(cost) {
  const out = { ...cost };
  for (const r of RES_KEYS) {
    if (buyDiscounts[r]) out[r] = Math.max(0, (out[r] || 0) - buyDiscounts[r]);
  }
  return out;
}

function renderHq() {
  $('deck-count').textContent = `(deck: ${state.voterDeckCount})`;
  const my = me();
  const canBuy = isMyTurn() && state.phase === 'ACTION' && !perkMode && !eliteMode;
  const pickHq = targeting('hqCard');
  $('hq-cards').innerHTML = state.hq
    .map((c, i) => {
      if (!c) return '<div class="voter-card unaffordable">empty</div>';
      // Helping Hands (Believer L3): show the cost you'd actually pay with your discounts.
      const eff = effectiveBuyCost(c.cost);
      const affordable = my && Object.entries(eff).every(([r, n]) => my.resources[r] >= n);
      const cls = pickHq ? 'buyable' : canBuy ? (affordable ? 'buyable' : 'unaffordable') : '';
      const sel = selectedHqIndex === i ? 'selected' : '';
      const discounted = JSON.stringify(eff) !== JSON.stringify(c.cost);
      return `<div class="voter-card ${cls} ${sel}" data-hq="${i}">
        <div class="vcount">${c.voters} 🗳</div>
        <div class="vcost">${Object.entries(eff)
          .map(([r, n]) => resChip(r, n))
          .join('')}${discounted ? '<span class="discount-tag" title="Helping Hands discount">▾</span>' : ''}</div>
      </div>`;
    })
    .join('');

  if (pickHq) {
    document.querySelectorAll('.voter-card[data-hq]').forEach((el) => {
      el.onclick = () => emitPlay({ hqIndex: Number(el.dataset.hq) });
    });
  } else if (canBuy) {
    document.querySelectorAll('.voter-card.buyable').forEach((el) => {
      el.onclick = () => {
        const i = Number(el.dataset.hq);
        selectedHqIndex = selectedHqIndex === i ? null : i;
        render();
        // On a phone the market sits under the board: bring the constituencies back
        // on screen so the next tap (where to place) doesn't need a scroll.
        if (selectedHqIndex !== null && isPhone()) {
          $('board').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      };
    });
  }

  const inGerry = isMyTurn() && state.phase === 'GERRYMANDER';
  const inAuctionPlace =
    state.phase === 'AUCTION_PLACE' && state.auctionPlacement && state.auctionPlacement.winnerId === myPid;
  $('btn-end-turn').classList.toggle('hidden', !canBuy);
  $('btn-skip-gerry').classList.toggle('hidden', !inGerry);
  $('gerry-info').classList.toggle('hidden', !inGerry);
  $('volatile-toggle').classList.toggle('hidden', !((canBuy && selectedHqIndex !== null) || inAuctionPlace));
  // Operator (elite): bank the selected card's voters in reserve instead of seating them.
  const canHold = canBuy && selectedHqIndex !== null && (my.elites || []).includes('operator');
  $('btn-hold').classList.toggle('hidden', !canHold);
  if (canHold) {
    $('btn-hold').onclick = () => {
      socket.emit('buyVoterCard', {
        hqIndex: selectedHqIndex,
        hold: true,
        discounts: resTotal(buyDiscounts) ? buyDiscounts : null,
      });
      selectedHqIndex = null;
      resetBuyDiscounts();
    };
  }
  // Anyone can negotiate while trading is open — bystanders deal with the active player.
  const canTrade = state.tradingOpen && !!me();
  $('btn-trade').classList.toggle('hidden', !canTrade);
  // Coalitions need 3+ players and at least one jointly reachable unowned zone (DD-23).
  $('btn-coalition').classList.toggle(
    'hidden',
    !canTrade || state.players.length < 3 || coalitionZones().length === 0
  );
  $('action-hint').textContent = inAuctionPlace
    ? `You won the bloc — ${TAP} a constituency to seat your new voters.`
    : inGerry
    ? gerrySel
      ? `Drop the voter in a highlighted constituency — or onto a flashing Volatile Area to trap its owner with a Headline. (${state.gerryMovesLeft} move(s) left)`
      : `You hold a majority: ${TAP} a highlighted voter to move it, or skip. (${state.gerryMovesLeft} move(s) left)`
    : !canBuy
    ? ''
    : selectedHqIndex !== null
    ? `Now ${TAP} a constituency to place these voters (one zone only).`
    : `${TAP === 'tap' ? 'Tap' : 'Click'} a voter card you can afford, or end your turn.`;
  // Phones pin the action bar to the bottom of the screen; drop it when there's nothing in it.
  const bar = $('action-bar');
  const barIdle =
    !$('action-hint').textContent &&
    ['volatile-toggle', 'btn-hold', 'btn-trade', 'btn-coalition', 'btn-skip-gerry', 'btn-end-turn'].every((id) =>
      $(id).classList.contains('hidden')
    );
  bar.classList.toggle('idle', barIdle);
}

// ---------- 2 Player requirement placement (DD-26) ----------
function renderRequirementPanel() {
  const el = $('requirement-panel');
  const placing = state.phase === 'SETUP_REQUIREMENTS';
  el.classList.toggle('hidden', !placing);
  if (!placing) {
    reqSel = null;
    return;
  }
  const myTurn = state.reqPlacerId === myPid;
  const hand = state.yourRequirementHand || [];
  if (!myTurn) {
    reqSel = null;
    const placer = playerById(state.reqPlacerId);
    el.innerHTML = `<div class="hq-title">Zone Requirements ${infoBtn('requirements', 'zone requirements')}</div>
      <p class="tagline">${esc(placer ? placer.name : 'Rival')} is pinning a requirement on a constituency…</p>`;
    return;
  }
  el.innerHTML =
    `<div class="hq-title">Zone Requirements — your placement ${infoBtn('requirements', 'zone requirements')}</div>` +
    `<p class="tagline">${reqSel ? 'Now click a constituency without a requirement.' : 'Pick a card to pin on a constituency.'}</p>` +
    `<div id="req-hand">` +
    hand
      .map(
        (c) => `<div class="conspiracy-card ${reqSel === c.id ? 'picked' : ''}" data-req="${c.id}">
          <div class="cons-title">📜 ${esc(c.title)}</div>
          <div class="cons-text">${esc(c.text)}</div>
          <div class="cons-tag">${c.kind === 'zonalRule' ? 'PERMANENT RULE' : c.kind === 'onMajority' ? 'CHECKED AT CAPTURE' : 'ONE-TIME HURDLE'}</div>
        </div>`
      )
      .join('') +
    `</div>`;
  el.querySelectorAll('[data-req]').forEach((card) => {
    card.onclick = () => {
      reqSel = reqSel === card.dataset.req ? null : card.dataset.req;
      render();
    };
  });
}

// Requirement chip on a zone (DD-26): the terms of capture, met-status for the viewer.
function reqChip(z) {
  if (!z.requirement) return '';
  const c = z.requirement.card;
  const met = c.kind === 'oneTime' && z.requirement.metBy && z.requirement.metBy[myPid];
  return `<div class="req-chip" title="${esc(c.text)}">📜 ${esc(c.title)}${met ? ' ✓' : ''}</div>`;
}

// ---------- hidden objective card (DD-25, own eyes only) ----------
function renderObjective() {
  const el = $('objective-card');
  const obj = state.yourObjective;
  const show = !!obj && state.phase !== 'GAME_OVER';
  el.classList.toggle('hidden', !show);
  if (!show) return;
  el.innerHTML = `<div class="hq-title">🎯 Secret Objective ${infoBtn('objective', 'secret objectives')}</div>
    <div class="objective-title">${esc(obj.title)}</div>
    <div class="objective-text">${esc(obj.text)}</div>
    <div class="objective-bonus">Worth +${obj.bonus} at the count — only you can see this.</div>`;
}

// ---------- trade + coalition offers panel ----------
function renderTradeOffers() {
  const el = $('trade-offers');
  const offers = (state.tradeOffers || []).filter((o) => o.from === myPid || o.to === myPid);
  const coalOffers = (state.coalitionOffers || []).filter((o) => o.from === myPid || o.to === myPid);
  el.classList.toggle('hidden', offers.length === 0 && coalOffers.length === 0);
  if (offers.length === 0 && coalOffers.length === 0) return;
  const chips = (m, cards) =>
    RES_KEYS.filter((r) => m[r] > 0)
      .map((r) => `<span class="res-chip ${r}">${m[r]} ${RES_LABELS[r]}</span>`)
      .concat((cards || []).map(() => `<span class="res-chip conspiracy-chip">🎭 card</span>`))
      .join('') || '<span class="muted-chip">nothing</span>';
  const coalitionHtml = coalOffers
    .map((o) => {
      const mine = o.from === myPid;
      const other = playerById(mine ? o.to : o.from);
      const zone = state.zones.find((z) => z.id === o.zoneId);
      return `<div class="trade-offer">
        <div class="offer-line">🤝 Coalition ${mine ? `with <b>${esc(other.name)}</b>` : `from <b>${esc(other.name)}</b>`}</div>
        <div class="offer-line">${esc(zone.name)} — split ${mine ? o.split.from : o.split.to} you / ${
        mine ? o.split.to : o.split.from
      } them</div>
        <div class="offer-line muted-chip">Both exchange one card of your most-held ideology</div>
        <div class="offer-actions">
          ${
            mine
              ? `<button data-coal-cancel="${o.id}">Withdraw</button>`
              : `<button class="primary" data-coal-accept="${o.id}">Accept</button>
                 <button data-coal-decline="${o.id}">Decline</button>`
          }
        </div>
      </div>`;
    })
    .join('');
  el.innerHTML =
    `<div class="hq-title">Trade Offers ${infoBtn('trade', 'trading')}</div>` +
    coalitionHtml +
    offers
      .map((o) => {
        const mine = o.from === myPid;
        const other = playerById(mine ? o.to : o.from);
        return `<div class="trade-offer">
          <div class="offer-line">${mine ? `To <b>${esc(other.name)}</b>` : `From <b>${esc(other.name)}</b>`}</div>
          <div class="offer-line">${mine ? 'You give' : 'They give'} ${chips(o.give, o.giveCards)}</div>
          <div class="offer-line">${mine ? 'You get' : 'They want'} ${chips(o.want, o.wantCards)}</div>
          <div class="offer-actions">
            ${
              mine
                ? `<button data-cancel="${o.id}">Withdraw</button>`
                : `<button class="primary" data-accept="${o.id}">Accept</button>
                   <button data-decline="${o.id}">Decline</button>`
            }
          </div>
        </div>`;
      })
      .join('');
  el.querySelectorAll('[data-accept]').forEach((b) => {
    b.onclick = () => socket.emit('respondTrade', { offerId: b.dataset.accept, accept: true });
  });
  el.querySelectorAll('[data-decline]').forEach((b) => {
    b.onclick = () => socket.emit('respondTrade', { offerId: b.dataset.decline, accept: false });
  });
  el.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = () => socket.emit('cancelTrade', { offerId: b.dataset.cancel });
  });
  el.querySelectorAll('[data-coal-accept]').forEach((b) => {
    b.onclick = () => socket.emit('respondCoalition', { offerId: b.dataset.coalAccept, accept: true });
  });
  el.querySelectorAll('[data-coal-decline]').forEach((b) => {
    b.onclick = () => socket.emit('respondCoalition', { offerId: b.dataset.coalDecline, accept: false });
  });
  el.querySelectorAll('[data-coal-cancel]').forEach((b) => {
    b.onclick = () => socket.emit('cancelCoalition', { offerId: b.dataset.coalCancel });
  });
}

// ---------- conspiracies ----------
function renderConspiracies() {
  const el = $('conspiracy-panel');
  const my = me();
  const hand = state.yourConspiracies || [];
  // No hand cap any more; the price comes off the top of the deck (DD-21).
  const canBuy =
    isMyTurn() && state.phase === 'ACTION' && !perkMode && !myDebt() &&
    state.conspiracyDeckCount > 0 && state.conspiracyPrice != null;
  // Show the panel whenever I have cards, can buy, am mid-play, have a peek, or spy (Organizer).
  const show =
    hand.length > 0 || canBuy || conspiracyPlay || (state.yourPeek && isMyTurn()) || !!state.spyHands;
  el.classList.toggle('hidden', !show);
  if (!show) return;

  let html = `<div class="hq-title">Conspiracies ${infoBtn('conspiracies', 'conspiracies')}</div>`;

  if (state.yourPeek && state.yourPeek.card && isMyTurn()) {
    const c = state.yourPeek.card;
    html += `<div class="peek-note">🔮 Next voter card: <b>${c.voters} 🗳</b> for ${Object.entries(c.cost)
      .map(([r, n]) => `${n} ${RES_LABELS[r]}`)
      .join(' + ')}</div>`;
  }

  // Mid-targeting banner (with resource picker for playerRes second step).
  if (conspiracyPlay) {
    const card = conspiracyPlay.card;
    if (card.target === 'playerRes' && conspiracyPlay.playerId) {
      const t = playerById(conspiracyPlay.playerId);
      html += `<div class="target-banner">Take which resource from ${esc(t.name)}?
        <span class="res-pick">${RES_KEYS.map(
          (r) => `<button class="res-btn ${r}" data-take="${r}">${RES_LABELS[r]}</button>`
        ).join('')}</span>
        <button data-cancel-play="1">Cancel</button></div>`;
    } else {
      html += `<div class="target-banner">${esc(card.title)}: ${targetHint(card.target)}
        <button data-cancel-play="1">Cancel</button></div>`;
    }
  }

  // The hand.
  html += '<div id="conspiracy-hand">';
  html += hand
    .map((c) => {
      // Your window: your ACTION/GERRYMANDER, or — for bystanders — the POLICY window.
      const playable =
        state.youMayPlayConspiracy && !c.reaction && !conspiracyPlay && !state.pendingReaction;
      const ex = explainConspiracy(c);
      return `<div class="conspiracy-card ${c.reaction ? 'reaction' : ''}">
        <div class="cons-title">${esc(c.title)}</div>
        ${ex ? `<div class="cons-does">${esc(ex.does)}</div>` : ''}
        <details class="cons-more" data-cons="${c.id}" ${consExpanded.has(c.id) ? 'open' : ''}>
          <summary>${ex ? 'Why play it' : 'Flavour'}</summary>
          ${ex ? `<p class="cons-why">${esc(ex.why)}</p>` : ''}
          ${ex && ex.when ? `<p class="cons-why">${esc(ex.when)}</p>` : ''}
          <p class="cons-text">${esc(c.text)}</p>
        </details>
        ${
          c.reaction
            ? '<div class="cons-tag">REACTION — plays when targeted</div>'
            : playable
            ? `<button class="cons-play" data-play="${c.id}">Play</button>`
            : ''
        }
      </div>`;
    })
    .join('');
  html += '</div>';

  // Organizer (elite): read every rival's conspiracy hand (DD-22).
  if (state.spyHands) {
    html += '<div class="spy-hands"><div class="cons-subtitle">🕵 Organizer intel</div>';
    html += state.spyHands
      .map((o) => {
        const titles = o.conspiracies.length
          ? o.conspiracies.map((c) => esc(c.title)).join(', ')
          : '<i>no cards</i>';
        return `<div class="spy-row"><b>${esc(o.name)}:</b> ${titles}</div>`;
      })
      .join('');
    html += '</div>';
  }

  // Buy control: pay the top card's price in any mix of resources.
  const disc = Math.min(resTotal(buyDiscounts), discountsLeft());
  const required = canBuy ? Math.max(0, state.conspiracyPrice - disc) : 0;
  if (canBuy && !consBuyOpen) {
    html += `<div class="cons-buy"><button id="btn-cons-buy">Buy conspiracy (price ${state.conspiracyPrice}${
      disc ? ` − ${disc}` : ''
    })</button></div>`;
  } else if (canBuy) {
    const total = resTotal(consBuyPay);
    html += `<div class="cons-buy">Pay exactly ${required} in any mix (${total}/${required})
      <div id="cons-pay-rows">${stepperRows(consBuyPay, my.resources)}</div>
      <button id="btn-cons-confirm" ${total !== required ? 'disabled' : ''}>Buy</button>
      <button id="btn-cons-cancel">Cancel</button></div>`;
  }

  el.innerHTML = html;
  el.querySelectorAll('details[data-cons]').forEach((d) => {
    d.ontoggle = () => (d.open ? consExpanded.add(d.dataset.cons) : consExpanded.delete(d.dataset.cons));
  });

  el.querySelectorAll('[data-play]').forEach((b) => {
    b.onclick = () => startConspiracyPlay(b.dataset.play);
  });
  el.querySelectorAll('[data-take]').forEach((b) => {
    b.onclick = () => emitPlay({ playerId: conspiracyPlay.playerId, res: b.dataset.take });
  });
  el.querySelectorAll('[data-cancel-play]').forEach((b) => {
    b.onclick = () => {
      conspiracyPlay = null;
      render();
    };
  });

  const openBuy = $('btn-cons-buy');
  if (openBuy)
    openBuy.onclick = () => {
      consBuyOpen = true;
      consBuyPay = zeroRes();
      render();
    };
  const rows = $('cons-pay-rows');
  if (rows)
    rows.querySelectorAll('[data-step]').forEach((b) => {
      b.onclick = () => {
        const r = b.dataset.res;
        const next = consBuyPay[r] + Number(b.dataset.step);
        if (next >= 0 && next <= my.resources[r]) consBuyPay[r] = next;
        render();
      };
    });
  const confirmBuy = $('btn-cons-confirm');
  if (confirmBuy)
    confirmBuy.onclick = () => {
      socket.emit('buyConspiracy', {
        payment: consBuyPay,
        discounts: disc ? buyDiscounts : null,
      });
      consBuyOpen = false;
      consBuyPay = zeroRes();
      resetBuyDiscounts();
    };
  const cancelBuy = $('btn-cons-cancel');
  if (cancelBuy)
    cancelBuy.onclick = () => {
      consBuyOpen = false;
      render();
    };
}

function myDebt() {
  const my = me();
  return !!(my && my.iou && my.iou.debt > 0);
}

// Plain-language rules for a conspiracy card, derived from its effect so the wording
// can't drift from what the engine does. `does` is the rule; `why` is when it's worth it.
function explainConspiracy(card) {
  const e = card.effect || {};
  const res = (m) => Object.entries(m).map(([r, n]) => `${n} ${RES_LABELS[r]}`).join(' + ');
  const x = {
    steal: {
      does: `Pick an opponent and a resource. Take up to ${e.n} of it from them and add it to yours.`,
      why: `A ${e.n * 2}-point swing: they lose what you gain. Rob the rival sitting on the resource you're short of.`,
    },
    burn: {
      does:
        card.target === 'self'
          ? `You lose up to ${e.n} of whichever resource you hold the most of.`
          : `Pick an opponent. They lose up to ${e.n} of whichever resource they hold the most of. Nobody gets it.`,
      why: 'Knock a leader below the price of the voter card or conspiracy they are saving for.',
    },
    removePeg: {
      does: "Remove one opponent voter from the board. Voters in a zone they hold majority in, Volatile Area voters and coalition voters are protected.",
      why: 'Aim at a zone where a rival is one voter short of majority. It sets them back a whole buy.',
    },
    convertPeg: {
      does: "Turn one opponent voter into yours, in place. Same protections as removal: majority, Volatile Area and coalition voters are safe.",
      why: 'Counts twice: they lose a voter and you gain one. Can hand you the majority in a tight zone.',
    },
    blockZone: {
      does: 'Freeze a constituency for one full round. Nobody can gerrymander voters into or out of it.',
      why: "Shields a zone you're contesting from a rival who holds the majority next door.",
    },
    peekVoter: {
      does: 'Privately see the next voter card before it reaches the Market.',
      why: "Plan your next buy, or decide whether it's worth cycling a Market card.",
    },
    gain: {
      does: `Gain ${res(e.resources || {})} straight away.`,
      why: 'Guaranteed value and nobody can cancel it. Good for topping up to an expensive voter card.',
    },
    cycleHq: {
      does: 'Discard one voter card from the Market and replace it with the top of the deck.',
      why: 'Deny a rival the card they can afford, or fish for one that matches your resources.',
    },
    drawConspiracy: {
      does: `Draw ${e.n} more conspiracy card${e.n === 1 ? '' : 's'} for free.`,
      why: 'Card advantage: one card becomes two. Pays off if either one is useful.',
    },
    addPegs: {
      does: `Place ${e.n} free voter${e.n === 1 ? '' : 's'} of yours in any constituency with room.`,
      why: 'Free board presence, wherever it matters most.',
    },
    cancel: {
      does: 'Keep it in hand. When an opponent targets you with a cancellable conspiracy, play this to cancel it. Both cards are discarded.',
      why: "You can't play it on your own turn. It only stops cards marked Cancellable.",
    },
  }[e.type];
  if (!x) return null;
  let when = '';
  if (!card.reaction) {
    when = card.cancellable
      ? 'Cancellable: the target can block it with a Reaction card.'
      : "Can't be cancelled.";
  }
  return { ...x, when };
}

function targetHint(target) {
  return {
    player: 'click an opponent to target.',
    playerRes: 'click an opponent to rob.',
    opponentPeg: 'click a highlighted opponent voter.',
    zone: 'click a constituency to freeze.',
    hqCard: 'click an HQ card.',
  }[target] || 'choose a target.';
}

function startConspiracyPlay(cardId) {
  const card = (state.yourConspiracies || []).find((c) => c.id === cardId);
  if (!card) return;
  if (card.target === 'none') {
    socket.emit('playConspiracy', { cardId, targetSpec: null });
    return;
  }
  conspiracyPlay = { card };
  render();
}

// ---------- elites: persistent auto-expressing hybrids (DD-22) ----------
const ELITE_POWERS = ['benefactor', 'spinner', 'oracle', 'insurgent']; // Maverick-borrowable
const ideoShort = (i) => (IDEOLOGY_LABELS[i] || i).replace('The ', '');

function resetEliteFlow() {
  eliteMode = null;
  eliteAs = null;
  oracleSel = null;
  oracleGains = zeroRes();
  insurgentMoves = [];
  insurgentFrom = null;
  backerSel = [];
  benefactorSel = { toId: null, hqIndex: null };
}

// What this player still needs for an elite to express (empty ⇒ active).
function eliteMissing(e, my) {
  const out = [];
  if (e.special === 'maverick') {
    const twos = IDEOLOGIES_C.filter((i) => my.manifesto[i] >= 2).length;
    if (twos < 3) out.push(`reach 2 cards in ${3 - twos} more ideolog${3 - twos === 1 ? 'y' : 'ies'}`);
    const over = IDEOLOGIES_C.filter((i) => my.manifesto[i] >= 3).map(ideoShort);
    if (over.length) out.push(`keep every ideology below 3 (drop ${over.join(', ')})`);
    return out;
  }
  for (const [ideo, lvl] of Object.entries(e.requires)) {
    if (my.manifesto[ideo] < lvl) out.push(`+${lvl - my.manifesto[ideo]} ${ideoShort(ideo)}`);
  }
  if (my.manifesto[e.negation] > 0) out.push(`drop ${ideoShort(e.negation)} to 0`);
  return out;
}
function eliteReqText(e) {
  if (e.special === 'maverick') return '2 cards in three ideologies, none at 3';
  return (
    Object.entries(e.requires).map(([i, l]) => `${ideoShort(i)} ${l}`).join(' + ') +
    `, no ${ideoShort(e.negation)}`
  );
}

const IDEOLOGIES_C = ['mogul', 'boss', 'icon', 'believer'];

function renderElites() {
  const el = $('elite-panel');
  const my = me();
  const catalog = state.eliteCatalog || [];
  if (!my || catalog.length === 0) return el.classList.add('hidden');
  const active = new Set(my.elites || []);
  // Near-miss: not active but I already meet at least one of its ideology thresholds.
  const nearMiss = catalog.filter((e) => {
    if (active.has(e.id) || e.special === 'maverick') return false;
    return Object.entries(e.requires).some(([i, l]) => my.manifesto[i] >= l);
  });
  // Always visible (header + catalogue link) so new players can discover elites early.
  el.classList.remove('hidden');

  let html = `<div class="hq-title">Elites ${infoBtn('elites', 'elites')} <button id="elite-toggle" class="link-btn">${
    eliteExpanded ? 'hide catalogue' : 'show catalogue'
  }</button></div>`;

  // My active elites (gold), with power controls where invocable.
  for (const e of catalog.filter((c) => active.has(c.id))) {
    html += `<div class="elite-card mine">
      <div class="cons-title">👑 ${esc(e.title)} ${infoBtn('elite:' + e.id, e.title)}</div>
      <div class="cons-text">${esc(e.text)}</div>
      ${elitePowerControls(e, my)}
    </div>`;
  }

  // Near-miss hybrids (grey), with what's still missing.
  const misses = eliteExpanded ? catalog.filter((c) => !active.has(c.id)) : nearMiss;
  if (misses.length) {
    html += '<div id="elite-list">';
    html += misses
      .map((e) => {
        const miss = eliteMissing(e, my);
        return `<div class="elite-card ${miss.length ? '' : 'eligible'}">
          <div class="cons-title">${esc(e.title)} ${infoBtn('elite:' + e.id, e.title)}</div>
          <div class="elite-req">${esc(eliteReqText(e))}</div>
          ${miss.length ? `<div class="cons-tag">needs ${esc(miss.join(', '))}</div>` : ''}
        </div>`;
      })
      .join('');
    html += '</div>';
  }

  el.innerHTML = html;
  $('elite-toggle').onclick = () => {
    eliteExpanded = !eliteExpanded;
    render();
  };
  wireEliteControls();
}

// The interactive control(s) for one active elite. Only the four invocable powers plus
// the Backer target-picker and Maverick borrow menu render controls; the rest are passive.
function elitePowerControls(e, my) {
  const canAct = isMyTurn() && state.phase === 'ACTION';
  const canActG = isMyTurn() && (state.phase === 'ACTION' || state.phase === 'GERRYMANDER');
  const tf = state.turnFlags || {};
  if (e.power === 'backer') {
    const opp = state.players.filter((p) => p.id !== myPid);
    const cur = (my.backerTargets || []).map((id) => esc(playerById(id).name)).join(', ');
    if (!canAct) return cur ? `<div class="cons-tag">Backing ${cur}</div>` : '';
    return (
      (cur ? `<div class="cons-tag">Backing ${cur}</div>` : '') +
      `<div class="elite-flow">${opp
        .map(
          (p) =>
            `<button class="chip ${backerSel.includes(p.id) ? 'on' : ''}" data-backer="${p.id}">${esc(p.name)}</button>`
        )
        .join('')}
        <button data-backer-go="1" ${backerSel.length ? '' : 'disabled'}>Back ${backerSel.length || ''}</button></div>`
    );
  }
  if (e.power === 'oracle') {
    if (!canAct || tf.oracle) return tf.oracle ? '<div class="cons-tag">Used this turn</div>' : '';
    return eliteFlowGuru('oracle');
  }
  if (e.power === 'insurgent') {
    if (!canActG || tf.insurgent) return tf.insurgent ? '<div class="cons-tag">Used this turn</div>' : '';
    return eliteFlowGuerilla('insurgent');
  }
  if (e.power === 'benefactor') {
    if (!canAct || tf.benefactor) return tf.benefactor ? '<div class="cons-tag">Used this turn</div>' : '';
    return eliteFlowPhilanthrop('benefactor');
  }
  if (e.power === 'spinner') {
    if (!canAct || tf.spinner) return tf.spinner ? '<div class="cons-tag">Used this turn</div>' : '';
    return eliteFlowPropaganda('spinner');
  }
  if (e.power === 'operator') {
    return '<div class="cons-tag">Buy a card with “Hold” to bank it in reserve.</div>';
  }
  if (e.power === 'maverick') {
    if (!canActG || tf.maverick) return tf.maverick ? '<div class="cons-tag">Borrowed this turn</div>' : '';
    if (eliteAs === 'benefactor') return eliteFlowPhilanthrop('benefactor');
    if (eliteAs === 'spinner') return eliteFlowPropaganda('spinner');
    if (eliteAs === 'oracle') return eliteFlowGuru('oracle');
    if (eliteAs === 'insurgent') return eliteFlowGuerilla('insurgent');
    return `<div class="elite-flow">Borrow: ${ELITE_POWERS.map(
      (p) => `<button data-borrow="${p}">${esc(elitePowerName(p))}</button>`
    ).join(' ')} ${eliteAs ? '<button data-elite-cancel="1">Cancel</button>' : ''}</div>`;
  }
  return ''; // fixer, enforcer, agitator, organizer, informant, strongman — passive
}

function elitePowerName(power) {
  const c = (state.eliteCatalog || []).find((e) => e.power === power);
  return c ? c.title.replace('The ', '') : power;
}

// --- flow fragments (shared by the direct elite and the Maverick borrow of it) ---
function eliteFlowGuru(power) {
  const borrow = eliteAs ? ' (borrowed)' : '';
  if (eliteMode === 'oracle' && oracleSel) {
    const t = resTotal(oracleGains);
    return `<div class="elite-flow">Take 3 (${t}/3):
      ${RES_KEYS.map((r) => `<button class="res-btn ${r}" data-oracle-gain="${r}">${RES_LABELS[r]} ${oracleGains[r]}</button>`).join('')}
      <button data-oracle-go="1" ${t !== 3 ? 'disabled' : ''}>Sacrifice</button>
      <button data-elite-cancel="1">Cancel</button></div>`;
  }
  if (eliteMode === 'oracle') {
    return `<div class="elite-flow">Click one of your voters to sacrifice…${borrow} <button data-elite-cancel="1">Cancel</button></div>`;
  }
  return `<button class="cons-play" data-elite-start="oracle">🙏 Sacrifice a voter</button>`;
}
function eliteFlowGuerilla(power) {
  if (eliteMode === 'insurgentFrom') {
    const staged = insurgentMoves.length ? ` (${insurgentMoves.length} staged)` : '';
    const hint = insurgentFrom ? 'Now click an adjacent zone…' : 'Click one of your voters…';
    return `<div class="elite-flow">${hint}${staged}
      ${insurgentMoves.length ? `<button data-insurgent-go="1">Send ${insurgentMoves.length}</button>` : ''}
      <button data-elite-cancel="1">Cancel</button></div>`;
  }
  return `<button class="cons-play" data-elite-start="insurgent">🥷 Redeploy voters</button>`;
}
function eliteFlowPhilanthrop(power) {
  const opp = state.players.filter((p) => p.id !== myPid);
  if (eliteMode === 'benefactorZone') {
    return `<div class="elite-flow">Click a zone to seat the free voters… <button data-elite-cancel="1">Cancel</button></div>`;
  }
  return `<div class="elite-flow">Gift 2 to
    <select data-benef-to>${opp.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>,
    take HQ <select data-benef-hq>${state.hq
      .map((c, i) => (c ? `<option value="${i}">#${i + 1} (${c.voters}v)</option>` : ''))
      .join('')}</select>
    <button data-benef-zone="1">Choose zone →</button></div>`;
}
function eliteFlowPropaganda(power) {
  const opp = state.players.filter((p) => p.id !== myPid);
  return `<div class="elite-flow">Pay 3, hit
    <select data-prop-to>${opp.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
    <button data-prop-go="1">🗞 Plant headline</button></div>`;
}

// Auto-pay n from the largest piles (client-side convenience; engine re-validates).
function autoPay(n) {
  const my = me();
  const out = zeroRes();
  let need = n;
  for (const r of RES_KEYS.slice().sort((a, b) => my.resources[b] - my.resources[a])) {
    const t = Math.min(need, my.resources[r]);
    out[r] = t;
    need -= t;
    if (!need) break;
  }
  return need === 0 ? out : null;
}

function emitElitePower(power, args) {
  if (eliteAs) {
    socket.emit('maverickCopy', { eliteId: power, args });
  } else if (power === 'oracle') {
    socket.emit('oracleSacrifice', args);
  } else if (power === 'insurgent') {
    socket.emit('insurgentMove', args);
  } else if (power === 'benefactor') {
    socket.emit('benefactorGift', args);
  } else if (power === 'spinner') {
    socket.emit('buyHeadline', args);
  }
  resetEliteFlow();
}

function startEliteFlow(power, borrowedAs) {
  perkMode = null;
  conspiracyPlay = null;
  resetEliteFlow();
  eliteAs = borrowedAs || null;
  if (power === 'oracle') eliteMode = 'oracle';
  else if (power === 'insurgent') eliteMode = 'insurgentFrom';
  render();
}

function wireEliteControls() {
  const el = $('elite-panel');
  const bind = (sel, fn) => el.querySelectorAll(sel).forEach(fn);
  bind('[data-backer]', (b) => {
    b.onclick = () => {
      const id = b.dataset.backer;
      if (backerSel.includes(id)) backerSel = backerSel.filter((x) => x !== id);
      else if (backerSel.length < 2) backerSel.push(id);
      render();
    };
  });
  bind('[data-backer-go]', (b) => {
    b.onclick = () => {
      socket.emit('pickPatronTargets', { targets: backerSel });
      backerSel = [];
    };
  });
  bind('[data-elite-start]', (b) => {
    b.onclick = () => startEliteFlow(b.dataset.eliteStart, null);
  });
  bind('[data-borrow]', (b) => {
    b.onclick = () => {
      const power = b.dataset.borrow;
      if (power === 'oracle' || power === 'insurgent') startEliteFlow(power, power);
      else {
        // benefactor / spinner show inline forms; render them as the borrowed elite.
        perkMode = null;
        resetEliteFlow();
        eliteAs = power;
        render();
      }
    };
  });
  bind('[data-oracle-gain]', (b) => {
    b.onclick = () => {
      if (resTotal(oracleGains) < 3) oracleGains[b.dataset.oracleGain]++;
      render();
    };
  });
  bind('[data-oracle-go]', (b) => {
    b.onclick = () =>
      emitElitePower(eliteAs || 'oracle', {
        zoneId: oracleSel.zoneId,
        slotIndex: oracleSel.slot,
        gains: oracleGains,
      });
  });
  bind('[data-insurgent-go]', (b) => {
    b.onclick = () => emitElitePower(eliteAs || 'insurgent', { moves: insurgentMoves });
  });
  bind('[data-elite-cancel]', (b) => {
    b.onclick = () => {
      resetEliteFlow();
      render();
    };
  });
  bind('[data-benef-to]', (s) => {
    s.onchange = () => (benefactorSel.toId = s.value);
  });
  bind('[data-benef-hq]', (s) => {
    s.onchange = () => (benefactorSel.hqIndex = Number(s.value));
  });
  bind('[data-benef-zone]', (b) => {
    b.onclick = () => {
      const to = el.querySelector('[data-benef-to]');
      const hq = el.querySelector('[data-benef-hq]');
      benefactorSel.toId = to ? to.value : benefactorSel.toId;
      benefactorSel.hqIndex = hq ? Number(hq.value) : benefactorSel.hqIndex;
      eliteMode = 'benefactorZone';
      render();
    };
  });
  bind('[data-prop-to]', () => {});
  bind('[data-prop-go]', (b) => {
    b.onclick = () => {
      const sel = el.querySelector('[data-prop-to]');
      const pay = autoPay(3);
      if (!pay) return toast('Need 3 resources to plant a headline.');
      emitElitePower(eliteAs || 'spinner', { payment: pay, targetPlayerId: sel.value });
    };
  });
}

const LOG_FRESH_MS = 6000; // how long a just-arrived log line stays highlighted
const logArrivals = new Map(); // logSeq of a line → when it reached this client
function renderLog() {
  const seq = state.logSeq || 0;
  const n = state.log.length;
  const now = Date.now();
  const fresh = (i) => now - (logArrivals.get(seq - (n - 1 - i)) || 0) < LOG_FRESH_MS;
  $('log').innerHTML = state.log
    .map((l, i) => `<p${fresh(i) ? ' class="fresh"' : ''}>${esc(l)}</p>`)
    .reverse()
    .join('');
}

// ---------- modals ----------
function renderModals() {
  const my = me();

  // 2 Player setup bid (DD-26): secret, once each; ties re-open the modal.
  const inBid = state.phase === 'SETUP_BID';
  const iBid = inBid && state.setupBid && state.setupBid.submitted.includes(myPid);
  $('modal-setupbid').classList.toggle('hidden', !inBid);
  if (inBid && my) {
    setupBidAmount = Math.max(0, Math.min(setupBidAmount, resTotal(my.resources)));
    $('setupbid-amount').textContent = setupBidAmount;
    $('setupbid-dec').onclick = () => { setupBidAmount = Math.max(0, setupBidAmount - 1); render(); };
    $('setupbid-inc').onclick = () => { setupBidAmount = Math.min(resTotal(my.resources), setupBidAmount + 1); render(); };
    $('btn-setupbid').classList.toggle('hidden', iBid);
    $('setupbid-dec').disabled = iBid;
    $('setupbid-inc').disabled = iBid;
    $('setupbid-waiting').classList.toggle('hidden', !iBid);
    $('btn-setupbid').onclick = () => socket.emit('submitSetupBid', { amount: setupBidAmount });
  }

  // Setup
  const inSetup = state.phase === 'SETUP_PICK';
  $('modal-setup').classList.toggle('hidden', !inSetup);
  if (inSetup && my) {
    // Turn order is drawn by lot (DD-8) — say so up front.
    const myIndex = state.players.findIndex((p) => p.id === myPid) + 1;
    $('setup-order').textContent = `Turn order was drawn randomly: ${state.players
      .map((p) => p.name)
      .join(' → ')}. You go ${myIndex === 1 ? 'first' : `#${myIndex}`}.`;
    const left = my.startingPicksRemaining;
    $('picks-left').textContent = left;
    document.querySelectorAll('.res-btn').forEach((b) => {
      b.disabled = left === 0;
      const n = my.resources[b.dataset.res] || 0;
      b.classList.toggle('picked', n > 0);
      const badge = b.querySelector('.res-count');
      if (badge) {
        badge.textContent = n > 0 ? `✓ ${n}` : '';
        badge.classList.toggle('hidden', n === 0);
      }
    });
    $('setup-waiting').classList.toggle('hidden', left > 0);
  }

  // Policy — everyone sees the question; only the active player can answer.
  const inPolicy = state.phase === 'POLICY' && !!state.currentCard;
  if (inPolicy) answerReveal = null; // a new question supersedes the reveal
  const showQuestion = inPolicy && (isMyTurn() || !policyDismissed);
  // Skip the reveal if it would cover the answerer's own discard prompt.
  const showReveal =
    !inPolicy && !!answerReveal &&
    (!policyDismissed || state.activePlayerId === myPid) && // the answerer always sees their reveal
    !(state.phase === 'DISCARD' && isMyTurn()) && state.phase !== 'GAME_OVER';
  $('modal-policy').classList.toggle('hidden', !(showQuestion || showReveal));
  if (showQuestion) renderPolicyQuestion();
  else if (showReveal) renderPolicyReveal();

  // Discard
  const showDiscard = state.phase === 'DISCARD' && isMyTurn();
  $('modal-discard').classList.toggle('hidden', !showDiscard);
  if (showDiscard) renderDiscard();

  // Headline (takes visual priority over the policy modal via z-index)
  const showHeadline = !!headlineOpen && state.phase !== 'GAME_OVER';
  $('modal-headline').classList.toggle('hidden', !showHeadline);
  if (showHeadline) {
    const h = headlineOpen;
    const trigger = playerById(h.playerId);
    const zone = zoneById(h.zoneId);
    $('headline-title').textContent = h.title;
    $('headline-text').textContent = h.text;
    $('headline-summary').textContent = `${zone ? zone.name : ''} — triggered by ${
      trigger ? (trigger.id === myPid ? 'you' : trigger.name) : '?'
    }. ${h.summary}`;
  }

  // Reaction — only the victim of a pending conspiracy sees it.
  const showReaction = !!state.pendingReaction && state.pendingReaction.victimId === myPid;
  $('modal-reaction').classList.toggle('hidden', !showReaction);
  if (showReaction) renderReaction();

  // Auction — everyone sees the bidding; placement happens on the board, not here.
  const showAuction = state.phase === 'AUCTION' && !!state.auction;
  $('modal-auction').classList.toggle('hidden', !showAuction);
  if (showAuction) renderAuction();

  // Trade modal
  if (tradeModalOpen && !state.tradingOpen) tradeModalOpen = false; // window closed under us
  $('modal-trade').classList.toggle('hidden', !tradeModalOpen);
  if (tradeModalOpen) renderTradeModal();

  // Coalition modal (DD-23)
  if (coalitionModalOpen && !state.tradingOpen) coalitionModalOpen = false;
  $('modal-coalition').classList.toggle('hidden', !coalitionModalOpen);
  if (coalitionModalOpen) renderCoalitionModal();

  // Game over
  const over = state.phase === 'GAME_OVER';
  $('modal-gameover').classList.toggle('hidden', !over);
  if (over) {
    const sorted = state.players.slice().sort((a, b) => b.score - a.score);
    // The reveal: everyone's secret objective, met or missed (DD-25).
    const objByPlayer = {};
    for (const r of state.objectiveResults || []) objByPlayer[r.playerId] = r;
    $('results').innerHTML = sorted
      .map((p) => {
        const r = objByPlayer[p.id];
        return `<div class="result-row ${state.winnerIds.includes(p.id) ? 'winner' : ''}">
            <span>${state.winnerIds.includes(p.id) ? '👑 ' : ''}${esc(p.name)}</span>
            <span>${p.score} majority voters</span>
          </div>${
            r
              ? `<div class="result-objective">🎯 ${esc(r.title)} — ${
                  r.met ? `<b>met, +${r.bonus}</b>` : 'missed'
                }</div>`
              : ''
          }`;
      })
      .join('');
    // The Reckoning: the winner's dominant ideology pair names the dystopia (DD-22).
    const reck = state.reckoning;
    const reckEl = $('reckoning');
    reckEl.classList.toggle('hidden', !reck);
    if (reck) {
      const w = playerById(reck.playerId);
      reckEl.innerHTML = `<div class="reck-title">📕 The Reckoning — ${esc(reck.title)}</div>
        <div class="reck-text">${esc(reck.text)}</div>
        <div class="reck-who">${esc(w ? w.name : '')}'s new order.</div>`;
    }
    $('btn-again').classList.toggle('hidden', !myIsHost);
  }
}

function renderAuction() {
  const a = state.auction;
  const high = a.highBidder ? playerById(a.highBidder) : null;
  const iPassed = a.passed.includes(myPid);
  const iAmHigh = a.highBidder === myPid;
  const my = me();
  $('auction-title').textContent = `A bloc of ${a.card.voters} voters is up for grabs`;
  $('auction-status').textContent = high
    ? `High bid: ${a.bid} by ${high.id === myPid ? 'you' : high.name}.`
    : 'No bids yet.';
  const canAct = !!my && !iPassed && !iAmHigh && !(my.iou && my.iou.debt > 0);
  $('auction-controls').classList.toggle('hidden', !canAct);
  if (canAct) {
    if (auctionBid <= a.bid) auctionBid = a.bid + 1;
    if (auctionBid > state.resourceCap) auctionBid = state.resourceCap;
    $('bid-amount').textContent = auctionBid;
    $('btn-bid').disabled = auctionBid <= a.bid || auctionBid > state.resourceCap;
  }
  $('auction-note').textContent = iAmHigh
    ? 'You hold the high bid — waiting on the others.'
    : iPassed
    ? 'You dropped out.'
    : my && my.iou && my.iou.debt > 0
    ? 'You owe an IOU and cannot bid.'
    : `Bid up to the cap of ${state.resourceCap}, even beyond what you hold (you’ll owe an IOU).`;
}

function renderReaction() {
  const pr = state.pendingReaction;
  $('reaction-text').textContent = `${pr.byName} played ${pr.conspiracyTitle} on you. Cancel it with a reaction card, or let it happen.`;
  const ex = pr.conspiracyEffect && explainConspiracy({ effect: pr.conspiracyEffect, target: pr.conspiracyTarget });
  $('reaction-explain').textContent = ex ? `What it does: ${ex.does}` : '';
  $('reaction-explain').classList.toggle('hidden', !ex);
  const reactions = (state.yourConspiracies || []).filter((c) => c.reaction);
  $('reaction-cards').innerHTML = reactions
    .map(
      (c) => `<button class="cons-play react-btn" data-react="${c.id}">Cancel with ${esc(c.title)}</button>`
    )
    .join('') || '<p class="tagline">You have no reaction cards.</p>';
  $('reaction-timer').textContent = 'This window closes automatically.';
  document.querySelectorAll('[data-react]').forEach((b) => {
    b.onclick = () => socket.emit('respondReaction', { cardId: b.dataset.react });
  });
}

function renderPolicyQuestion() {
  const mine = isMyTurn();
  const active = playerById(state.activePlayerId);
  $('policy-title').textContent = mine ? 'Policy Question' : `${active.name} is answering`;
  $('policy-question').textContent = state.currentCard.question;
  const opts = { a: state.currentCard.option_a.text, b: state.currentCard.option_b.text };
  for (const k of ['a', 'b']) {
    const btn = $('policy-' + k);
    btn.textContent = `${k.toUpperCase()}. ${opts[k]}`;
    btn.disabled = !mine;
    btn.classList.toggle('spectator', !mine);
    btn.classList.remove('chosen', 'dimmed');
  }
  $('policy-note').textContent = mine
    ? 'Rewards are hidden until you choose. Vote your gut.'
    : `Only ${active.name} can answer. Close this to watch the board.`;
  $('policy-close').classList.toggle('hidden', mine);
}

function renderPolicyReveal() {
  const r = answerReveal;
  $('policy-title').textContent = 'Answer locked in';
  $('policy-question').textContent = r.question;
  for (const k of ['a', 'b']) {
    const btn = $('policy-' + k);
    const chosen = r.choice === k;
    btn.disabled = true;
    btn.classList.remove('spectator');
    btn.classList.toggle('chosen', chosen);
    btn.classList.toggle('dimmed', !chosen);
    btn.innerHTML =
      `${k.toUpperCase()}. ${esc(r.options ? r.options[k] : r.chosen.text)}` +
      (chosen ? `<span class="btn-chips">${rewardChips(r.chosen)}</span>` : '');
  }
  $('policy-note').textContent = 'Returning to the board…';
  $('policy-close').classList.remove('hidden');
}

document.querySelectorAll('.res-btn').forEach((b) => {
  b.onclick = () => socket.emit('pickStartingResource', { resource: b.dataset.res });
});
$('policy-a').onclick = () => answerPolicy('a');
$('policy-b').onclick = () => answerPolicy('b');
function answerPolicy(choice) {
  if (!isMyTurn() || state.phase !== 'POLICY') return;
  socket.emit('answerPolicy', { choice });
}
$('policy-close').onclick = () => {
  policyDismissed = true;
  answerReveal = null;
  render();
};
$('btn-end-turn').onclick = () => {
  selectedHqIndex = null;
  socket.emit('endTurn');
};
$('btn-skip-gerry').onclick = () => {
  gerrySel = null;
  socket.emit('skipGerrymander');
};
$('volatile-check').onchange = () => render();
$('btn-again').onclick = () => socket.emit('playAgain');
$('headline-close').onclick = () => {
  headlineOpen = null;
  clearTimeout(headlineTimer);
  render();
};
$('btn-reaction-pass').onclick = () => socket.emit('respondReaction', { cardId: null });
$('bid-inc').onclick = () => {
  if (state.auction && auctionBid < state.resourceCap) {
    auctionBid++;
    render();
  }
};
$('bid-dec').onclick = () => {
  if (state.auction && auctionBid > state.auction.bid + 1) {
    auctionBid--;
    render();
  }
};
$('btn-bid').onclick = () => socket.emit('placeBid', { amount: auctionBid });
$('btn-pass').onclick = () => socket.emit('passBid');

// ---------- trade modal ----------
function tradePartners() {
  // Active player deals with anyone; bystanders can only approach the active player.
  return isMyTurn()
    ? state.players.filter((p) => p.id !== myPid)
    : state.players.filter((p) => p.id === state.activePlayerId);
}

$('btn-trade').onclick = () => {
  tradeGive = { funds: 0, clout: 0, media: 0, trust: 0 };
  tradeWant = { funds: 0, clout: 0, media: 0, trust: 0 };
  tradeGiveCards = [];
  tradeWantCards = [];
  tradeModalOpen = true;
  const partners = tradePartners();
  $('trade-partner').innerHTML = partners
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
    .join('');
  render();
};
$('trade-close').onclick = () => {
  tradeModalOpen = false;
  render();
};
$('trade-partner').onchange = () => render();

function stepperRows(map, limits) {
  return RES_KEYS.map(
    (r) => `<div class="discard-row">
      <span class="res-chip ${r}">${RES_LABELS[r]}${limits ? `: ${limits[r]}` : ''}</span>
      <span class="stepper">
        <button data-step="-1" data-res="${r}">−</button>
        <b>${map[r]}</b>
        <button data-step="1" data-res="${r}">+</button>
      </span>
    </div>`
  ).join('');
}

function renderTradeModal() {
  const my = me();
  const partner = playerById($('trade-partner').value) || tradePartners()[0];
  if (!partner) {
    tradeModalOpen = false;
    return;
  }
  const giveBox = $('trade-give-rows');
  const wantBox = $('trade-want-rows');
  giveBox.innerHTML = stepperRows(tradeGive, my.resources);
  wantBox.innerHTML = stepperRows(tradeWant, partner.resources);
  const wire = (box, map, limits) => {
    box.querySelectorAll('[data-step]').forEach((b) => {
      b.onclick = () => {
        const r = b.dataset.res;
        const next = map[r] + Number(b.dataset.step);
        if (next >= 0 && next <= limits[r]) map[r] = next;
        renderTradeModal();
      };
    });
  };
  wire(giveBox, tradeGive, my.resources);
  wire(wantBox, tradeWant, partner.resources);

  // Conspiracy cards trade only in the direction the proposer can name: your own hand.
  // You can't blind-request an opponent's hidden cards, so the "you get" side is
  // resources only. (An opponent offering you a card comes through as their proposal.)
  const myHand = state.yourConspiracies || [];
  tradeGiveCards = tradeGiveCards.filter((id) => myHand.some((c) => c.id === id));
  $('trade-give-cards').innerHTML = myHand.length
    ? '<div class="cards-label">Cards to give</div>' +
      myHand
        .map(
          (c) => `<label class="card-check"><input type="checkbox" data-give-card="${c.id}" ${
            tradeGiveCards.includes(c.id) ? 'checked' : ''
          }/> 🎭 ${esc(c.title)}</label>`
        )
        .join('')
    : '';
  $('trade-want-cards').innerHTML = '';
  $('trade-give-cards').querySelectorAll('[data-give-card]').forEach((cb) => {
    cb.onchange = () => {
      const id = cb.dataset.giveCard;
      if (cb.checked) tradeGiveCards.push(id);
      else tradeGiveCards = tradeGiveCards.filter((x) => x !== id);
      renderTradeModal();
    };
  });

  // Trades need not be equitable — any non-empty give/want counts, uneven or not.
  const giveTotal = RES_KEYS.reduce((s, r) => s + tradeGive[r], 0) + tradeGiveCards.length;
  const wantTotal = RES_KEYS.reduce((s, r) => s + tradeWant[r], 0);
  const hint = $('trade-hint');
  if (hint) {
    hint.textContent =
      giveTotal > 0 && wantTotal > 0
        ? `Trade: ${giveTotal} for ${wantTotal}.`
        : 'Offer something and ask for something in return.';
  }
  $('btn-propose-trade').disabled = giveTotal < 1 || wantTotal < 1;
}

$('btn-propose-trade').onclick = () => {
  socket.emit('proposeTrade', {
    toId: $('trade-partner').value,
    give: tradeGive,
    want: tradeWant,
    giveCards: tradeGiveCards,
    wantCards: [],
  });
  tradeModalOpen = false;
  render();
};

// ---------- coalition modal (DD-23) ----------
function pegsIn(z, pid) {
  return z.slots.filter((s) => s === pid).length;
}

// Zones where the viewer could anchor a coalition: unowned, uncoalitioned, and some
// partner's pegs complete the threshold with theirs. Cosmetic — the engine re-validates.
function coalitionZones() {
  if (!me()) return [];
  return state.zones.filter((z) => {
    if (z.majorityOwner || z.coalition) return false;
    const mine = pegsIn(z, myPid);
    if (mine < 1) return false;
    return state.players.some(
      (p) => p.id !== myPid && pegsIn(z, p.id) >= z.majority - Math.min(mine, z.majority - 1)
    );
  });
}

$('btn-coalition').onclick = () => {
  const zones = coalitionZones();
  if (!zones.length) return;
  coalitionModalOpen = true;
  $('coalition-zone').innerHTML = zones
    .map((z) => `<option value="${z.id}">${esc(z.name)} (majority ${z.majority})</option>`)
    .join('');
  coalitionMine = 1;
  syncCoalitionPartners();
  render();
};
$('coalition-close').onclick = () => {
  coalitionModalOpen = false;
  render();
};
$('coalition-zone').onchange = () => {
  coalitionMine = 1;
  syncCoalitionPartners();
  render();
};
$('coalition-partner').onchange = () => render();

// Partners with any pegs in the picked zone (viability is checked per-split below).
function syncCoalitionPartners() {
  const z = state.zones.find((x) => x.id === $('coalition-zone').value);
  if (!z) return;
  $('coalition-partner').innerHTML = state.players
    .filter((p) => p.id !== myPid && pegsIn(z, p.id) >= 1)
    .map((p) => `<option value="${p.id}">${esc(p.name)} (${pegsIn(z, p.id)} pegs here)</option>`)
    .join('');
}

function renderCoalitionModal() {
  const z = state.zones.find((x) => x.id === $('coalition-zone').value);
  const partner = playerById($('coalition-partner').value);
  if (!z || !partner) {
    $('coalition-split').innerHTML = '';
    $('coalition-hint').textContent = 'No viable partner in that constituency.';
    $('btn-propose-coalition').disabled = true;
    return;
  }
  const myPegs = pegsIn(z, myPid);
  const maxMine = Math.min(myPegs, z.majority - 1);
  coalitionMine = Math.max(1, Math.min(coalitionMine, maxMine));
  const theirShare = z.majority - coalitionMine;
  $('coalition-split').innerHTML = `<div class="discard-row">
    <span>Your voters in the majority</span>
    <span class="stepper">
      <button id="coal-dec">−</button>
      <b>${coalitionMine}</b>
      <button id="coal-inc">+</button>
    </span>
  </div>
  <div class="discard-row"><span>${esc(partner.name)} contributes</span><b>${theirShare}</b></div>`;
  $('coal-dec').onclick = () => {
    coalitionMine--;
    render();
  };
  $('coal-inc').onclick = () => {
    coalitionMine++;
    render();
  };
  const viable = pegsIn(z, partner.id) >= theirShare;
  $('coalition-hint').textContent = viable
    ? `You score ${coalitionMine}, they score ${theirShare}. Both exchange one card of your most-held ideology — it is not returned if the coalition breaks.`
    : `${partner.name} only has ${pegsIn(z, partner.id)} pegs in ${z.name} — lower your share.`;
  $('btn-propose-coalition').disabled = !viable;
}

$('btn-propose-coalition').onclick = () => {
  const z = state.zones.find((x) => x.id === $('coalition-zone').value);
  socket.emit('proposeCoalition', {
    toId: $('coalition-partner').value,
    zoneId: z.id,
    split: { from: coalitionMine, to: z.majority - coalitionMine },
  });
  coalitionModalOpen = false;
  render();
};

function renderDiscard() {
  const my = me();
  $('discard-count').textContent = state.discardRequired;
  const total = RES_KEYS.reduce((s, r) => s + discardPicks[r], 0);
  $('discard-rows').innerHTML = RES_KEYS.map(
    (r) => `<div class="discard-row">
      <span class="res-chip ${r}">${RES_LABELS[r]}: ${my.resources[r]}</span>
      <span class="stepper">
        <button data-dec="${r}">−</button>
        <b>${discardPicks[r]}</b>
        <button data-inc="${r}">+</button>
      </span>
    </div>`
  ).join('');
  document.querySelectorAll('[data-inc]').forEach((b) => {
    b.onclick = () => {
      const r = b.dataset.inc;
      if (discardPicks[r] < my.resources[r] && total < state.discardRequired) discardPicks[r]++;
      renderDiscard();
    };
  });
  document.querySelectorAll('[data-dec]').forEach((b) => {
    b.onclick = () => {
      const r = b.dataset.dec;
      if (discardPicks[r] > 0) discardPicks[r]--;
      renderDiscard();
    };
  });
  $('btn-discard').disabled = total !== state.discardRequired;
}
$('btn-discard').onclick = () => {
  socket.emit('discardResources', { discards: discardPicks });
  discardPicks = { funds: 0, clout: 0, media: 0, trust: 0 };
};

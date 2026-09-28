// The System — in-game ⓘ explanations. Plain-language rules for every part of the
// screen, written against the engine (server/game.js). Per-elite and per-turf topics are
// built from game data in client.js (helpTopic); everything fixed lives here.
/* exported HELP */
const HELP = {
  basics: {
    see: ['policy', 'market', 'board', 'gerrymander', 'headline', 'trade'],
    title: 'How to win',
    body: `
      <p><b>Goal:</b> capture constituencies. When the game ends, every zone you hold scores its
      majority number (the figure shown on the zone). Highest total wins; ties go to whoever has
      more voters on the board.</p>
      <p><b>Your turn, in order:</b></p>
      <ol>
        <li><b>Policy question</b> — pick an answer. You gain resources and an ideology card.</li>
        <li><b>Action</b> — buy voter cards from the Market and place voters on the board. Use
        powers, conspiracies and trades. Then end your turn.</li>
        <li><b>Gerrymander</b> — only if you hold a majority somewhere: move voters around it.</li>
        <li><b>Headlines</b> — anyone with a voter newly in a Volatile Area gets a Headline.</li>
      </ol>
      <p><b>The game ends</b> the moment every zone is captured, or when the board fills up —
      then everyone gets one final turn.</p>
      <p>Trading is open during the active player's turn, so deal with them while it's their go.</p>
      <p><button class="link-btn" data-walkthrough>New to the game? Replay the walkthrough</button></p>`,
  },
  players: {
    see: ['perks', 'elites', 'auction'],
    title: 'Players & resources',
    body: `
      <p>Each card shows a player's four resources: <b>Funds</b> (green), <b>Clout</b> (red),
      <b>Buzz</b> (blue) and <b>Trust</b> (yellow), and their total against the cap.</p>
      <p><b>Cap of 12.</b> You can go over mid-turn, but at the start of your next action you must
      discard down to 12. Spend or trade before then.</p>
      <p><b>Manifesto</b> (the ideology counts): every policy answer adds one card —
      <b>Mogul</b>, <b>Boss</b>, <b>Icon</b> or <b>Believer</b>. Cards never go away on their own.
      They unlock ideology powers at 3 and 5 (shown as L3/L5), passive income, and elites.</p>
      <p><b>Badges:</b></p>
      <ul>
        <li>🎭 conspiracy cards in hand (contents hidden)</li>
        <li>⚙ resources their manifesto pays them every time they answer a policy question</li>
        <li>🪑 voters in reserve, waiting to be placed</li>
        <li>IOU — owes the bank; can't spend or bid until it's paid</li>
      </ul>`,
  },
  perks: {
    see: ['elites', 'players'],
    title: 'Ideology powers',
    body: `
      <p><b>Passive income:</b> every 2 cards in an ideology pays +1 of its resource each time you
      answer a policy question (Mogul → Funds, Boss → Clout, Icon → Buzz, Believer → Trust).</p>
      <p>At <b>3 cards</b> and <b>5 cards</b> in one ideology you unlock its powers:</p>
      <ul>
        <li><b>Mogul 3 — Prospecting:</b> once a turn, pay 1 resource and take any 2.</li>
        <li><b>Mogul 5 — Land Grab:</b> up to 3 times a turn, remove any voter from the board
        (even a majority voter, not the Volatile Area). Its owner gets it back in reserve and must
        re-place it by their next turn or lose it.</li>
        <li><b>Boss 3 — Snatch:</b> up to twice a turn, take 1 resource from an opponent.</li>
        <li><b>Boss 5 — Payback:</b> up to twice a turn, pay 1 to destroy an opponent's voter
        (majority voters included).</li>
        <li><b>Icon 3 — Going Viral:</b> up to twice a turn, a voter card you buy gives +1 voter.</li>
        <li><b>Icon 5 — Election Fever:</b> double gerrymander moves, and you can move majority
        voters too.</li>
        <li><b>Believer 3 — Helping Hands:</b> up to 2 discounts a turn, each takes 1 off a voter
        card or conspiracy price.</li>
        <li><b>Believer 5 — Tough Love:</b> once a turn, pay 2 Trust + any 2 to convert two of one
        opponent's voters in the same zone (majority voters included).</li>
      </ul>
      <p><b>Why it matters:</b> going deep in one ideology buys strong powers; spreading out keeps
      elites like the Maverick open. You choose with every policy answer.</p>`,
  },
  board: {
    see: ['gerrymander', 'headline', 'market'],
    title: 'Constituencies',
    body: `
      <p>The board has 9 constituencies of different sizes. Each shows how many seats it has and
      its <b>majority</b> number.</p>
      <p><b>Capture:</b> get that many of your voters into a zone and you hold it. A captured zone
      scores exactly its majority number at the end, no matter how many extra voters you have.</p>
      <p><b>Majority voters are protected</b> from most conspiracies and can't be moved by normal
      gerrymandering. But if your count drops below the majority (a strong power, a Headline) the
      majority breaks and the zone is up for grabs again.</p>
      <p><b>Volatile Area:</b> each zone has one risky seat (⚡). You only enter it by choice when
      buying, or when a rival gerrymanders you in. It counts toward the majority and can't be
      touched by powers — but whoever lands there takes a Headline at the end of the turn.</p>
      <p><b>Gerrymandering:</b> holding a majority lets you move voters between that zone and its
      neighbours at the end of your turn.</p>`,
  },
  market: {
    see: ['board', 'headline', 'perks'],
    title: 'The Market',
    body: `
      <p>Three voter cards are face up. Each shows how many voters it brings and what it costs.</p>
      <p><b>To buy:</b> tap a card you can afford, then tap a constituency. All of that card's
      voters go into that one zone. If the zone runs out of room, the extras are lost.</p>
      <p>The bought card is replaced from the deck straight away, so you can buy again if you can
      afford it.</p>
      <p><b>Volatile Area:</b> tick "Risk the Volatile Area" to put one voter into the zone's risky
      seat. It's your only way into a nearly full zone — but you'll draw a Headline.</p>
      <p><b>Tip:</b> bigger cards are cheaper per voter. Small cards are for finishing a
      majority exactly.</p>`,
  },
  policy: {
    see: ['perks', 'elites'],
    title: 'Policy questions',
    body: `
      <p>Every turn starts with a question and two answers. Each answer belongs to an ideology and
      pays <b>+2 of that ideology's resource and +1 of another</b>. Rewards stay hidden until you
      choose.</p>
      <p>Your answer also adds a card to your <b>manifesto</b>, which drives your powers, passive
      income and elites. That usually matters more than the resources.</p>
      <p><b>Watch out:</b> most elites require that you have <i>never</i> taken one particular
      ideology. One answer can close several elites for the rest of the game.</p>
      <p>Answer positions are shuffled, so read the answer, not the letter.</p>
      <p>While the question is open, other players may play conspiracies.</p>`,
  },
  outcome: {
    see: ['policy', 'perks'],
    title: 'Policy outcome',
    body: `<p>What the active player just chose and what it paid them. The ideology card goes into
      their manifesto; passive income from their manifesto is added on top.</p>`,
  },
  gerrymander: {
    see: ['board', 'headline'],
    title: 'Gerrymandering',
    body: `
      <p>If you hold at least one majority when you end your action, you get <b>one move per
      majority held</b> (two with Icon 5).</p>
      <p><b>A move:</b> take any voter — yours or a rival's — from a zone and put it in another,
      as long as both zones are your majority zone or border it.</p>
      <ul>
        <li>Majority voters, coalition voters and Volatile Area voters can't be moved (Icon 5 can
        move majority voters).</li>
        <li><b>Trap play:</b> drop a rival's voter into an empty Volatile Area and they take the
        Headline.</li>
        <li>Frozen zones (🔒 frozen, hatched) can't be gerrymandered in or out of.</li>
      </ul>
      <p><b>Why:</b> breaking a rival's near-majority or completing your own without spending.</p>`,
  },
  conspiracies: {
    see: ['reaction', 'trade'],
    title: 'Conspiracies',
    body: `
      <p>Hidden cards bought blind from the deck on your turn. The price (4 or 5, any mix of
      resources) belongs to the top card.</p>
      <p><b>When to play:</b> during your own action or gerrymander phase, or on someone else's turn
      while their policy question is still open.</p>
      <p><b>Cancellable</b> cards can be blocked: if the target holds a Reaction card, they get the
      chance to cancel. <b>Reaction</b> cards only work that way.</p>
      <p>Tap <b>Why play it</b> on a card for its strategy. Conspiracies can also be traded.</p>`,
  },
  reaction: {
    see: ['conspiracies'],
    title: 'Reacting to a conspiracy',
    body: `<p>Someone played a cancellable conspiracy on you and you hold a Reaction card. Play it to
      cancel their card (both are discarded), or let it happen and keep your Reaction for later.</p>`,
  },
  elites: {
    see: ['perks', 'coalition', 'policy'],
    title: 'Elites',
    body: `
      <p>An elite is a political identity you earn from your manifesto. You never buy one — it
      switches on by itself when you qualify and off when you stop qualifying.</p>
      <p><b>Most elites need:</b> 3 cards in two ideologies <b>and zero</b> in a third. Each pair of
      ideologies has two elites, told apart by which ideology you refuse.</p>
      <p><b>The Maverick</b> is the exception: 2+ cards in three ideologies, none at 3.</p>
      <ul>
        <li><b>Refusal is permanent.</b> Cards don't go away, so the first answer in an ideology
        closes every elite that forbids it.</li>
        <li><b>Coalitions can break an elite.</b> Forming one hands you your partner's most-held
        ideology card.</li>
        <li><b>They stack.</b> Refusing one ideology completely can unlock three elites at once.</li>
      </ul>
      <p>Tap ⓘ on any elite for its power. "show catalogue" lists all 13.</p>`,
  },
  trade: {
    see: ['coalition', 'conspiracies'],
    title: 'Trading',
    body: `
      <p>Swap resources and conspiracy cards with another player. Every trade must involve the
      active player, so deals happen on whoever's turn it is.</p>
      <p>Offers don't have to be equal — 1 for 3 is fine — but both sides must give something. The
      other player accepts or declines; open offers expire when the turn ends.</p>
      <p><b>Why:</b> you'll rarely have the exact mix a voter card needs. Trading turns surplus into
      what you need, and favours into alliances.</p>`,
  },
  coalition: {
    see: ['elites', 'trade'],
    title: 'Coalitions',
    body: `
      <p>Two players capture a zone together (3+ player games only). Pick an uncaptured zone where
      you both have voters, and split the majority number between you — each side at least 1.</p>
      <ul>
        <li><b>Cost:</b> each partner gives the other one card of their most-held ideology. The
        cards aren't returned, so your powers or elites can drop.</li>
        <li><b>Scoring:</b> each partner scores their share of the split.</li>
        <li>Coalition voters are protected. The coalition collapses if the combined voters fall
        below the majority. Either partner may walk out on their own turn.</li>
      </ul>
      <p><b>Why:</b> lock down a zone neither of you can win alone, or keep a third player out.</p>`,
  },
  auction: {
    see: ['headline'],
    title: 'Auctions & IOUs',
    body: `
      <p>Some Headlines put a bloc of voters up for public auction. Everyone may bid, up to 12. A new
      high bid keeps everyone in; you're out only when you drop out.</p>
      <p><b>The winner pays</b> from their resources and places the voters. If they can't cover the
      bid, the rest becomes an <b>IOU</b> to the bank.</p>
      <p><b>While you owe an IOU</b> you can't buy, bid or use paid powers. Every resource you gain
      pays the debt first.</p>
      <p><b>Why:</b> overbidding is legal and sometimes right — but it freezes you until you pay.</p>`,
  },
  headline: {
    see: ['board', 'auction', 'gerrymander'],
    title: 'Headlines',
    body: `
      <p>Whoever has a voter newly in a Volatile Area takes a Headline at the end of the turn. It hits
      that zone.</p>
      <p>Roughly two in three Headlines hurt (losing resources or voters); some help, and a few start
      a public auction.</p>
      <p><b>Why risk it:</b> the Volatile Area is sometimes the last seat you need, and its voter can't
      be moved or removed by powers. Rivals can also trap you there by gerrymandering.</p>`,
  },
  log: {
    title: 'Campaign Trail',
    body: `<p>The running log of everything that has happened — answers, purchases, captures,
      conspiracies and Headlines — newest first. Check it when something changes and you missed it.</p>`,
  },
  setup: {
    title: 'Starting resources',
    body: `<p>Turn order is drawn at random. The first player picks 1 resource, the second 2, and so
      on — later players get more to make up for going later. Pick the mix you'll need for your
      first voter card.</p>`,
  },
  discard: {
    title: 'Over the cap',
    body: `<p>You can hold at most 12 resources when your action starts. Choose which to discard;
      keep the ones that match the voter cards in the Market.</p>`,
  },
  setupbid: {
    see: ['requirements'],
    title: 'Bidding for first move',
    body: `<p>Head to head: both players start with 8 resources and secretly bid any part of them. Both
      bids are paid, win or lose. The higher bid moves first; ties bid again. The second player
      then places the first zone requirement.</p>`,
  },
  requirements: {
    see: ['setupbid', 'board'],
    title: 'Zone requirements',
    body: `
      <p>Head to head only. Each of the 7 constituencies carries a condition, placed alternately by
      both players at the start.</p>
      <ul>
        <li><b>One-time:</b> meet it once (for example, play 2 conspiracies) and it's satisfied for
        you for good.</li>
        <li><b>On capture:</b> must be true at the moment you'd take the majority, every time.</li>
        <li><b>Zone rules:</b> change the zone itself — bigger or smaller majority, or no
        gerrymandering.</li>
      </ul>
      <p>Without meeting the requirement, you can have the numbers and still not hold the zone.</p>`,
  },
  objective: {
    see: ['gameover'],
    title: 'Secret objective',
    body: `<p>Hidden Objectives mode: you alone know this goal. If it's true when the game ends, you
      score its bonus on top of your constituencies. Don't make it obvious.</p>`,
  },
  gameover: {
    see: ['board', 'coalition', 'objective'],
    title: 'Election results',
    body: `<p>Each captured zone scores its majority number; coalition zones split it by the agreed
      shares. Secret objectives add their bonus. Ties go to the most voters on the board.</p>
      <p><b>The Reckoning</b> shows what the winner's two strongest ideologies turned the country
      into.</p>`,
  },
  modes: {
    see: ['turfs', 'objective', 'requirements'],
    title: 'Game modes',
    body: `
      <ul>
        <li><b>Standard:</b> the full game.</li>
        <li><b>Home Turfs:</b> each constituency has its own power, usable by whoever holds it. Some
        fire on their own.</li>
        <li><b>Hidden Objectives:</b> everyone gets a secret goal worth bonus points.</li>
        <li><b>2 Player</b> (automatic with two): a 7-zone board, a bid for first move, and zone
        requirements.</li>
      </ul>`,
  },
  turfs: {
    see: ['board'],
    title: 'Home Turfs',
    body: `<p>In this mode each constituency has a power. Whoever holds its majority may use it once
      a turn during their action or gerrymander phase. Powers marked <i>(auto)</i> fire on their own at
      the end of the holder's turn if not used.</p>`,
  },
};

// First-time player walkthrough: the whole game in six cards, reachable from the home
// screen, the lobby and the "How to win" sheet. Each card is one idea; the ⓘ sheets
// above hold the detail.
/* exported WALKTHROUGH */
const WALKTHROUGH = [
  {
    kicker: 'The goal',
    title: 'Win the most seats',
    body: `
      <p>The board has <b>9 constituencies</b>. Each shows a <b>majority number</b>.</p>
      <p>Get that many of your voters into a zone and you <b>capture</b> it. At the end, every zone
      you hold scores its majority number. Highest total wins.</p>
      <p>The game ends when every zone is captured, or when the board fills up and everyone has
      had one final turn.</p>`,
  },
  {
    kicker: 'Your turn',
    title: 'Four beats, every turn',
    body: `
      <ol>
        <li><b>Answer a policy question.</b> Pick the answer you like — it pays resources.</li>
        <li><b>Act.</b> Buy voter cards, place voters, trade, use powers. Then <b>End Turn</b>.</li>
        <li><b>Gerrymander</b> — only if you hold a majority: shift voters around it.</li>
        <li><b>Headlines</b> — news events hit anyone who landed in a risky ⚡ seat.</li>
      </ol>
      <p>The banner at the top always says whose turn it is and what happens now.</p>`,
  },
  {
    kicker: 'Buying voters',
    title: 'The Market',
    body: `
      <p>You have four resources: <b class="wt-funds">Funds</b>, <b class="wt-clout">Clout</b>,
      <b class="wt-media">Buzz</b> and <b class="wt-trust">Trust</b>.</p>
      <p>Three voter cards sit in the Market. {Tap} one you can afford, then {tap} a
      constituency — all its voters go there.</p>
      <p><b>Tip:</b> bigger cards are cheaper per voter; small ones finish a majority exactly.
      You can hold at most <b>12</b> resources, so don't hoard.</p>`,
  },
  {
    kicker: 'The table',
    title: 'Every turn is a negotiation',
    body: `
      <p>You'll rarely have the exact mix a card costs. <b>Trade</b> with whoever's turn it is —
      offers don't have to be equal, just agreed.</p>
      <p>In 3+ player games, two rivals can form a <b>coalition</b> to share a zone neither can
      take alone.</p>
      <p>Most of this game is played in the deals, not the dice. Talk.</p>`,
  },
  {
    kicker: 'Your identity',
    title: 'Answers build your manifesto',
    body: `
      <p>Every policy answer adds a card to your <b>manifesto</b>: Mogul, Boss, Icon or Believer.</p>
      <p><b>3 or 5</b> cards in one ideology unlock powers. Certain mixes switch on an
      <b>elite</b> — a strong identity that turns on by itself.</p>
      <p><b>Careful:</b> most elites need you to <i>never</i> take one ideology. Cards never go away,
      so one answer can close a door for good.</p>`,
  },
  {
    kicker: 'Dirty tricks',
    title: 'Politics is not polite',
    body: `
      <p><b>Conspiracies</b> are hidden cards that hurt a rival. Buy them blind; play them on your
      turn or while someone else's question is open.</p>
      <p><b>⚡ Volatile Areas</b> get you into a nearly full zone — but draw a Headline.</p>
      <p><b>Gerrymandering</b> lets a majority holder drag rivals' voters out, or trap them in a ⚡ seat.</p>
      <p class="wt-ready">Stuck mid-game? Every panel has an <span class="wt-i">i</span> that explains
      it, and your first few turns come with tips.</p>`,
  },
];

// In-game coaching: one short tip the first time a player meets each moment of play.
// Shown beside the table, never over it — the game doesn't wait for a tip to be read.
// `target` is the element it points at; `more` is the ⓘ sheet for the full rule.
/* exported COACH */
const COACH = {
  policy: {
    target: 'policy-options',
    title: 'Your first question',
    body: `Pick the answer you agree with. It pays resources <b>and</b> adds a card to your
      manifesto, which unlocks powers later. Rewards stay hidden until you choose.`,
    more: 'policy',
  },
  action: {
    target: 'hq-mat',
    title: 'Time to buy voters',
    body: `{Tap} a voter card you can afford, then {tap} a constituency to place its voters.
      Buy as many as you can pay for, then press <b>End Turn</b>.`,
    more: 'market',
  },
  gerrymander: {
    target: 'board',
    title: 'You hold a majority',
    body: `You get one move per majority. {Tap} a voter in or next to your zone, then {tap}
      where it goes. Rivals' voters count too. Or skip it.`,
    more: 'gerrymander',
  },
  watch: {
    target: 'players-panel',
    title: 'Not your turn — still your game',
    body: `It's <b>{active}</b>'s turn. You can propose a trade with them now, and keep an eye on
      everyone's resources here. The Campaign Trail logs every move.`,
    more: 'trade',
  },
};

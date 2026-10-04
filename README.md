# The System

A multiplayer web game of political-strategy area control: 2–5 players compete for
control of 9 electoral zones through resource management, trading, gerrymandering,
conspiracies, and coalition-building — no installs, just a browser.

> **Origin note, for transparency:** This project started as a digital adaptation of
> **Shasn** (designed by Zain Memon, published by Memesys Culture Lab) — several early
> design decisions were made by directly consulting Shasn's rulebooks. Before making this
> repo public, we renamed every distinctive game element (the game's name, the four
> ideologies, their resources, the elite-power roster, and the endgame mechanic) to
> original names, so nothing here reuses Shasn's specific names or copied rulebook
> content. What's left is a game in the same *genre* (area control + hidden-resource
> negotiation), built with original card text throughout, but it is **not** Shasn, and
> isn't affiliated with or endorsed by Memesys Culture Lab or Zain Memon.

**Why build this:** a physical board game needs 2–5 people, a table, and 2–6 hours in one
room — a real barrier to who gets to play it and how often. Putting the game in a browser
removes that: anyone with a laptop can play, replay, or study a session. That accessibility
angle is also why this exists as an open project rather than a closed one — it doubles as a
research and education vehicle for area-control game design, negotiation-driven mechanics,
and multiplayer web-game architecture, in a way a physical box can't easily support.

---

## What is The System?

Each player picks an **ideology** and fights to win the popular vote across 9 zones on
the board. You buy voter cards to grow your manifesto, place campaign pegs to build
majorities, and use each ideology's resource to trade, bribe, sabotage, and gerrymander
your way to power. It's part area-control, part social-deduction, all played at the
negotiating table — most of the game happens in the deals players cut with each other,
not in isolated turns.

### Ideologies

| Name | Color | Resource |
|---|---|---|
| The Mogul | Green | Funds |
| The Boss | Red | Clout |
| The Icon | Blue | Buzz |
| The Believer | Yellow | Trust |

### Core concepts

| Term | Meaning |
|---|---|
| **The Market** | Central board where face-up Voter Cards are displayed for purchase |
| **Manifesto** | A player's collection of ideology cards; higher count = level-up perks |
| **Constituency / Zone** | One of 9 electoral zones; captured by reaching the majority threshold |
| **Gerrymandering Phase** | Move a non-majority peg adjacent to a zone where you hold majority |
| **Headline Card** | Event card triggered when a peg is placed in a Volatile Area |
| **Conspiracy Card** | Hidden-hand card with a targeted effect on another player |
| **IOU** | "I Owe You" token — player-to-player and bank debt mechanic |
| **Elite Card** | Passive/active power that turns on automatically once your manifesto qualifies |

---

## Screenshots

| Room lobby | Policy question |
|---|---|
| ![Room lobby](docs/screenshots/lobby.png) | ![Policy question](docs/screenshots/policy-question.png) |

| Board mid-game | Proposing a trade |
|---|---|
| ![Board mid-game](docs/screenshots/board.png) | ![Proposing a trade](docs/screenshots/trade.png) |

---

## Status

**Full rule set is implemented and playable.** Trading, gerrymandering, majority breaking,
headlines/volatile areas, conspiracies, IOU + auctions, manifesto perks, elite powers, and
four selectable game modes (Coalitions, Home Turfs, Hidden Objectives, 2-Player) are all
built and covered by automated tests.

### Playing together

- **Chat** — a **Table** channel the whole room reads, plus a **private line** to each
  player for side deals. Works in the lobby and in-game: open it from the 💬 button
  (bottom-right) or the 💬 on any rival's dossier. Private lines are only ever sent to
  their two ends, history comes back when you reconnect, and an unread badge shows what
  you've missed.
- **Phones first** — board and Market on one screen, a docked action bar in portrait,
  a side-by-side layout in landscape, and touch-sized targets throughout.
- **Easy to join** — a 4-letter room code, a scannable invite QR, and a share link.
- **Never lose your seat** — reconnects automatically after a dropped connection, a
  locked screen or a closed tab; lobby seats are held for 90 seconds.
- **Notifications** — your turn, offers to you, conspiracies aimed at you and private
  messages appear as alert cards, count up in the tab title while you're away, and can
  raise an opt-in system notification (🔔).
- **Nobody stalls the table** — reactions, auctions and setup steps time out and
  auto-resolve if a player goes quiet.

### Learning the game

- **How to play** — a two-minute walkthrough, from the home screen or the lobby.
- **ⓘ on everything** — every panel, modal and card opens a plain-language rule sheet,
  including one per elite and home turf.
- **Coach tips** — a one-time pointer the first time you meet each part of a turn.

### What's left before this is a polished product

- **Edge of Chaos mode** — not yet built.
- **Art** — all card content (150 policy cards, 36 headlines, 24 conspiracies, 13 elites,
  34 voter cards) is original text and in place; none of it has illustration/art yet.
- **Chat moderation** — mute/block and reporting, needed before strangers play each other.
- **Visible countdowns and board highlights** — timeouts run on the server but aren't
  shown as a clock, and board changes are highlighted in the log, not on the map.

---

## Tech stack

- **Server:** Node.js + Express + Socket.IO. An authoritative, framework-free game engine
  (`server/game.js`) drives all rules; rooms/sockets (`server/index.js`) are a thin
  transport layer on top, so the engine is fully unit-testable without a network.
- **Client:** Vanilla JS, no build step (`public/`).
- **Persistence:** Debounced JSON snapshot to disk (`server/persistence.js`) so in-progress
  games and chat history survive a server restart; players reconnect automatically via a
  session token.

## Getting started

```bash
npm install
npm start          # serves the game on http://localhost:3000
```

Open `http://localhost:3000` in 2–5 browser tabs (or devices on the same network), create
a room, share the 4-letter code or invite QR, and play. Settings (`PORT`, `STATE_FILE`)
are listed in [`.env.example`](./.env.example).

### Running tests

```bash
npm test           # full suite: bot-simulated games, rule invariants, modes, persistence, chat, socket e2e
```

## Deploying

See [`DEPLOY.md`](./DEPLOY.md) for Railway/Render/Fly/Docker instructions. The short
version: it's a single Node process, needs sticky WebSocket sessions (no scaling out
behind a buffering proxy), and a mounted volume if you want game state to survive
restarts.

---

## Repo guide

| File | Purpose |
|---|---|
| `server/game.js` | The authoritative rules engine — pure logic, no networking |
| `server/index.js` | Rooms, Socket.IO wiring, reconnect handling, timeouts |
| `server/chat.js` | Room chat: table + private channels, who may read what, limits |
| `server/persistence.js` | Snapshot rooms (games + chat) to disk and restore on boot |
| `public/` | Browser client (HTML/CSS/vanilla JS); rule sheets and walkthrough in `help.js` |
| `data/*.json` | Card decks, zones, modes data — original content |
| `test/` | Bot-simulation, rule-invariant, client-render, chat and end-to-end socket tests |

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the branch/PR workflow. Short version:
branch off `main`, open a PR, get a review, squash-merge.

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE). You're free to
use, modify, and share this for any noncommercial purpose — personal projects, research,
education. Commercial use requires permission. Open an issue or reach out if you want to
discuss that.

---

*Built by the project team.*

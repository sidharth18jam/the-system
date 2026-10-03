// Snapshot-to-disk persistence so in-progress games survive a server restart.
// Rooms live in memory (a Map); we mirror them to one JSON file, debounced on change,
// and reload it on boot. Transient per-socket fields (socketId, connected, timers) are
// NOT persisted — restored players start disconnected and rejoin with their token.
const fs = require('fs');
const path = require('path');
const { SystemGame } = require('./game');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '../data/.rooms-state.json');
const SAVE_DEBOUNCE_MS = 400;

let saveTimer = null;

// Serialize the whole rooms map (+ the pid counter) to disk, debounced.
function scheduleSave(rooms, getPidCounter) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = {
        pidCounter: getPidCounter(),
        rooms: [...rooms.values()].map((room) => ({
          code: room.code,
          hostToken: room.hostToken,
          players: [...room.players.values()].map((p) => ({ token: p.token, pid: p.pid, name: p.name })),
          game: room.game ? room.game.snapshot() : null,
          chat: room.chat || [],
          chatSeq: room.chatSeq || 0,
        })),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data));
    } catch (e) {
      console.error('persistence: save failed:', e.message);
    }
  }, SAVE_DEBOUNCE_MS);
}

// Rebuild the rooms map from disk. Returns { rooms, pidCounter } or null if no/invalid file.
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch {
    return null; // no snapshot yet — fresh start
  }
  try {
    const data = JSON.parse(raw);
    const rooms = new Map();
    for (const r of data.rooms) {
      const players = new Map();
      for (const p of r.players) {
        // Restored players are offline until they reconnect with their token.
        players.set(p.token, { token: p.token, pid: p.pid, name: p.name, socketId: null, connected: false });
      }
      rooms.set(r.code, {
        code: r.code,
        hostToken: r.hostToken,
        players,
        game: r.game ? SystemGame.restore(r.game) : null,
        chat: r.chat || [],
        chatSeq: r.chatSeq || 0,
      });
    }
    console.log(`persistence: restored ${rooms.size} room(s) from ${STATE_FILE}`);
    return { rooms, pidCounter: data.pidCounter || 0 };
  } catch (e) {
    console.error('persistence: state file unreadable, starting fresh:', e.message);
    return null;
  }
}

module.exports = { scheduleSave, loadState, STATE_FILE };

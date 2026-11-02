// Snapshot-to-disk persistence so in-progress games survive a server restart.
// Rooms live in memory (a Map); we mirror them to one JSON file and reload it on boot.
// Transient per-socket fields (socketId, connected, timers) are NOT persisted — restored
// players start disconnected and rejoin with their token.
//
// Three guarantees:
// - A save always happens within SAVE_MAX_WAIT_MS of a change, however busy the server is
//   (a pure debounce would never fire while games keep producing events).
// - The file is replaced atomically (write a temp file, fsync, rename), so a crash mid-write
//   leaves the previous snapshot intact instead of a truncated one.
// - flushSave() writes any pending change synchronously; the server calls it on shutdown.
//
// Only rooms that changed since the last save are re-serialized; the rest reuse a cached
// JSON string, so a save costs O(changed rooms), not O(all rooms).
const fs = require('fs');
const path = require('path');
const { SystemGame } = require('./game');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '../data/.rooms-state.json');
const SAVE_DEBOUNCE_MS = 400;
const SAVE_MAX_WAIT_MS = Number(process.env.SAVE_MAX_WAIT_MS) || 2000;

let saveTimer = null;
let pendingSince = 0;
let lastRooms = null;
let lastGetPidCounter = null;
const roomJson = new Map(); // code -> cached JSON of that room's snapshot

function serializeRoom(room) {
  return JSON.stringify({
    code: room.code,
    hostToken: room.hostToken,
    players: [...room.players.values()].map((p) => ({ token: p.token, pid: p.pid, name: p.name })),
    game: room.game ? room.game.snapshot() : null,
    chat: room.chat || [],
    chatSeq: room.chatSeq || 0,
  });
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Write the snapshot now. Never throws: a failed save is logged and retried on the next change.
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  pendingSince = 0;
  if (!lastRooms) return;
  try {
    for (const code of roomJson.keys()) if (!lastRooms.has(code)) roomJson.delete(code);
    for (const room of lastRooms.values()) {
      if (room.dirty || !roomJson.has(room.code)) {
        roomJson.set(room.code, serializeRoom(room));
        room.dirty = false;
      }
    }
    const text = `{"pidCounter":${Number(lastGetPidCounter()) || 0},"rooms":[${[...roomJson.values()].join(',')}]}`;
    writeAtomic(STATE_FILE, text);
  } catch (e) {
    console.error('persistence: save failed:', e.message);
  }
}

// Record a change and schedule a save. Pass the room that changed; with no room (e.g. after
// rooms were deleted) every room is treated as changed.
function scheduleSave(rooms, getPidCounter, room = null) {
  lastRooms = rooms;
  lastGetPidCounter = getPidCounter;
  if (room) room.dirty = true;
  else for (const r of rooms.values()) r.dirty = true;
  const now = Date.now();
  if (!pendingSince) pendingSince = now;
  clearTimeout(saveTimer);
  const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, pendingSince + SAVE_MAX_WAIT_MS - now));
  saveTimer = setTimeout(saveNow, delay);
}

// Write any pending change immediately (used on shutdown).
function flushSave() {
  if (saveTimer) saveNow();
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
    // Keep the unreadable file for inspection rather than overwriting it on the next save.
    const aside = `${STATE_FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(STATE_FILE, aside);
    } catch {
      /* best effort */
    }
    console.error(`persistence: state file unreadable (moved to ${aside}), starting fresh:`, e.message);
    return null;
  }
}

module.exports = { scheduleSave, flushSave, loadState, STATE_FILE };

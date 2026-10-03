// Room chat: one group channel ("table talk") plus a private channel between any two seats.
// Lives on the room, not the game, so it works in the lobby and carries across Play Again.
// Private lines are only ever sent to their two ends — the server is the privacy boundary.
const CHAT_MAX_LEN = 300;
const CHAT_KEEP = 300; // oldest lines drop off past this, across all channels
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 6; // lines per window per player

// Validate and append a line. Returns the stored message; throws with a player-facing reason.
function postMessage(room, sender, to, rawText, now = Date.now()) {
  const text = String(rawText == null ? '' : rawText)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
  if (!text) throw new Error('Message is empty');
  if (text.length > CHAT_MAX_LEN) throw new Error(`Keep it under ${CHAT_MAX_LEN} characters`);
  let recipient = null;
  if (to != null) {
    recipient = [...room.players.values()].find((p) => p.pid === to);
    if (!recipient) throw new Error('That player is not in this room');
    if (recipient.pid === sender.pid) throw new Error('You cannot message yourself');
  }
  sender.chatTimes = (sender.chatTimes || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (sender.chatTimes.length >= RATE_MAX) throw new Error('Slow down — too many messages');
  sender.chatTimes.push(now);

  room.chatSeq = (room.chatSeq || 0) + 1;
  const msg = {
    id: room.chatSeq,
    from: sender.pid,
    fromName: sender.name,
    to: recipient ? recipient.pid : null,
    toName: recipient ? recipient.name : null,
    text,
    ts: now,
  };
  room.chat = room.chat || [];
  room.chat.push(msg);
  if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
  return msg;
}

const canSee = (msg, pid) => msg.to === null || msg.from === pid || msg.to === pid;

// Every line this seat is allowed to read, oldest first.
function chatHistory(room, pid) {
  return (room.chat || []).filter((m) => canSee(m, pid));
}

module.exports = { postMessage, chatHistory, canSee, CHAT_MAX_LEN };

// Abuse limits for a public server: sliding-window counters keyed by client IP or socket.
// Limits are generous enough for a classroom sharing one NAT'd IP; they exist to stop a script
// from creating thousands of rooms or scanning room codes, not to police normal play.

// A sliding-window limiter: allow(key) returns false once `max` hits land within `windowMs`.
function makeLimiter(max, windowMs) {
  const hits = new Map(); // key -> timestamps (oldest first)
  return {
    allow(key, now = Date.now()) {
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      return true;
    },
    // Drop keys with no recent hits so the map doesn't grow without bound.
    prune(now = Date.now()) {
      for (const [key, list] of hits) {
        if (!list.length || now - list[list.length - 1] >= windowMs) hits.delete(key);
      }
    },
    size: () => hits.size,
  };
}

// Best-effort client IP. Fly-Client-IP is set by Fly's proxy and can't be forged by the client;
// elsewhere (Render, local) fall back to the forwarded chain, then the socket address.
function clientIp(socket) {
  const h = socket.handshake.headers || {};
  const fwd = String(h['fly-client-ip'] || h['cf-connecting-ip'] || h['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return fwd || socket.handshake.address || 'unknown';
}

const num = (name, dflt) => Number(process.env[name]) || dflt;

module.exports = {
  makeLimiter,
  clientIp,
  // Rooms one IP may create per 10 minutes.
  ROOM_CREATE_MAX: num('ROOM_CREATE_MAX', 30),
  ROOM_CREATE_WINDOW_MS: 10 * 60 * 1000,
  // Joins to a room code that doesn't exist, per IP per 10 minutes (stops code scanning).
  JOIN_MISS_MAX: num('JOIN_MISS_MAX', 40),
  JOIN_MISS_WINDOW_MS: 10 * 60 * 1000,
  // Any events from one socket per 2 seconds (a flood guard; real play is far below this).
  SOCKET_EVENT_MAX: num('SOCKET_EVENT_MAX', 120),
  SOCKET_EVENT_WINDOW_MS: 2000,
  // Open sockets one IP may hold at once (each open tab is one).
  MAX_CONNS_PER_IP: num('MAX_CONNS_PER_IP', 40),
  // Hard ceiling on rooms held in memory at once.
  MAX_ROOMS: num('MAX_ROOMS', 2000),
};

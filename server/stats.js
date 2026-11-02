// Funnel counters: how many people get from landing on the page to finishing a game, and
// where they drop off. Anonymous counts only — no names, IPs, cookies or third-party scripts.
// Totals plus per-day (UTC) buckets for the last DAYS_KEPT days; persisted in the room snapshot.
const DAYS_KEPT = 60;

// The funnel, in order. Labels are what /stats shows.
const FUNNEL = [
  ['pageViews', 'Page views'],
  ['roomsCreated', 'Rooms created'],
  ['roomsWith2', 'Rooms that got a 2nd player'],
  ['gamesStarted', 'Games started'],
  ['gamesFinished', 'Games finished'],
];
// Supporting counters (not a strict funnel).
const OTHER = [
  ['tablesOpened', 'Tables listed as open'],
  ['joinsViaList', 'Joins from the open-tables list'],
  ['joinsViaInvite', 'Joins from an invite link / QR'],
  ['joinsViaCode', 'Joins by typing a code'],
  ['gamesAbandoned', 'Games abandoned (swept unfinished)'],
  ['lobbiesAbandoned', 'Lobbies that emptied before starting'],
];
const KEYS = new Set([...FUNNEL, ...OTHER].map(([k]) => k));

function createStats(saved) {
  const data = {
    since: (saved && saved.since) || new Date().toISOString(),
    totals: { ...((saved && saved.totals) || {}) },
    days: { ...((saved && saved.days) || {}) },
    modes: { ...((saved && saved.modes) || {}) }, // games started per mode
    sizes: { ...((saved && saved.sizes) || {}) }, // games started per player count
  };
  let onChange = () => {};

  const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

  function bump(key, n = 1, now = Date.now()) {
    if (!KEYS.has(key)) throw new Error(`unknown stat ${key}`);
    data.totals[key] = (data.totals[key] || 0) + n;
    const d = today(now);
    const day = (data.days[d] = data.days[d] || {});
    day[key] = (day[key] || 0) + n;
    const keep = Object.keys(data.days).sort().slice(-DAYS_KEPT);
    if (keep.length < Object.keys(data.days).length) {
      for (const k of Object.keys(data.days)) if (!keep.includes(k)) delete data.days[k];
    }
    onChange();
  }

  function gameStarted(mode, players) {
    data.modes[mode] = (data.modes[mode] || 0) + 1;
    data.sizes[players] = (data.sizes[players] || 0) + 1;
    bump('gamesStarted');
  }

  return {
    bump,
    gameStarted,
    toJSON: () => data,
    setOnChange(fn) {
      onChange = fn;
    },
    report(live = {}) {
      const t = data.totals;
      const steps = FUNNEL.map(([k, label], i) => {
        const n = t[k] || 0;
        const prev = i ? t[FUNNEL[i - 1][0]] || 0 : null;
        return { key: k, label, count: n, fromPrevious: prev ? Math.round((100 * n) / prev) : null };
      });
      return {
        since: data.since,
        live,
        funnel: steps,
        other: OTHER.map(([k, label]) => ({ key: k, label, count: t[k] || 0 })),
        modes: data.modes,
        playerCounts: data.sizes,
        days: Object.keys(data.days)
          .sort()
          .reverse()
          .map((d) => ({ date: d, ...data.days[d] })),
      };
    },
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A plain, self-contained page for the owner to glance at; no scripts, no external assets.
function renderStatsPage(r) {
  const row = (cells, tag = 'td') => `<tr>${cells.map((c) => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`;
  const dayKeys = FUNNEL.map(([k]) => k).concat(['tablesOpened', 'joinsViaList']);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>The System — stats</title>
<style>
body{font-family:system-ui,sans-serif;background:#f0ebdd;color:#2a2456;margin:0;padding:16px;max-width:820px}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1rem;margin:24px 0 8px}
p{color:#6e6884;margin:0 0 12px;font-size:.85rem}
table{border-collapse:collapse;width:100%;font-size:.9rem;background:#fff8}
th,td{border:1px solid #c9c2ab;padding:6px 8px;text-align:right}th:first-child,td:first-child{text-align:left}
.live{display:flex;gap:12px;flex-wrap:wrap}.live div{border:2px solid #2a2456;padding:8px 12px;background:#fff8}
.live b{display:block;font-size:1.4rem}.wrap{overflow-x:auto}
</style></head><body>
<h1>The System — funnel</h1>
<p>Counting since ${esc(r.since.slice(0, 16).replace('T', ' '))} UTC. Anonymous counts only. JSON: <a href="stats.json${r.keyQuery}">stats.json</a></p>
<div class="live">${Object.entries(r.live)
    .map(([k, v]) => `<div><b>${esc(v)}</b>${esc(k)}</div>`)
    .join('')}</div>
<h2>Funnel (all time)</h2>
<table>${row(['Step', 'Count', '% of previous step'], 'th')}${r.funnel
    .map((s) => row([s.label, s.count, s.fromPrevious == null ? '' : s.fromPrevious + '%']))
    .join('')}</table>
<h2>Other</h2>
<table>${r.other.map((s) => row([s.label, s.count])).join('')}
${row(['Games by mode', Object.entries(r.modes).map(([m, n]) => `${m}: ${n}`).join(', ') || '—'])}
${row(['Games by player count', Object.entries(r.playerCounts).map(([m, n]) => `${m}p: ${n}`).join(', ') || '—'])}</table>
<h2>By day (UTC)</h2>
<div class="wrap"><table>${row(['Date', 'Views', 'Rooms', '2nd player', 'Started', 'Finished', 'Opened', 'List joins'], 'th')}${r.days
    .map((d) => row([d.date, ...dayKeys.map((k) => d[k] || 0)]))
    .join('')}</table></div>
</body></html>`;
}

module.exports = { createStats, renderStatsPage, FUNNEL, OTHER };

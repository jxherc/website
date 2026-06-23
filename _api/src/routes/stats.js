// GET /stats.svg — a wide tokscale stats banner. github-dark background, system font, minimal.
// big TOKENS number + TOP MODELS bars on top, a year-long contribution grid below.
// embedded as an <img> in a readme, so: no web fonts (system stack renders fine), edge-cached ~30 min.

const TOKSCALE = 'https://tokscale.ai/api/users/jxherc';

// github dark palette
const C = {
  bg: '#0d1117', border: '#30363d', divider: '#21262d',
  text: '#c9d1d9', muted: '#8b949e', faint: '#6e7681',
  blue: '#58a6ff', empty: '#161b22',
};
const BAR  = ['#58a6ff', '#3fb950', '#bc8cff', '#f0883e'];        // top-models bar colours
const RAMP = ['#161b22', '#352a5a', '#4c3a85', '#6e4fc0', '#a371f7']; // grid intensity 0..4 (violet)
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif";

const W = 840, H = 235, P = 22;

// bump this when the design changes so a worker redeploy doesn't keep serving
// the old bytes that caches.default stashed under the plain url.
const CACHE_KEY = 'https://api.jxherc.com/stats.svg?cv=3';

export async function handleStats(request, env, path) {
  const cache = caches.default;
  const hit = await cache.match(CACHE_KEY);
  if (hit) return hit;

  let svg, maxAge;
  try {
    const ts = await fetchTokscale();
    svg = renderSvg(ts);
    maxAge = ts ? 1800 : 300;
  } catch {
    svg = renderSvg(null);
    maxAge = 120;
  }

  const resp = new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    },
  });
  await cache.put(CACHE_KEY, resp.clone());
  return resp;
}

async function fetchTokscale() {
  try {
    const r = await fetch(TOKSCALE, { headers: { 'User-Agent': 'jxherc-api' } });
    if (!r.ok) return null;
    const j = await r.json();
    const s = j?.stats;
    if (!s) return null;

    const map = {};
    (j.contributions || []).forEach(c => { map[c.date] = c.intensity || 0; });

    return {
      tokens: humanTokens(s.totalTokens),
      cost: humanCost(s.totalCost),
      rank: j.user?.rank ?? 0,
      sessions: s.sessionCount ?? 0,
      models: (j.modelUsage || []).slice(0, 4).map(m => ({ name: m.model, pct: m.percentage || 0 })),
      weeks: yearWeeks(map),
    };
  } catch { return null; }
}

// ~53 week-columns ending today; days with no tokscale activity stay empty.
function yearWeeks(map) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const cur = new Date(end);
  cur.setUTCDate(cur.getUTCDate() - (7 * 52 + end.getUTCDay()));
  const weeks = [];
  while (cur <= end) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      if (cur > end) col.push(null);
      else { const k = cur.toISOString().slice(0, 10); col.push(map[k] || 0); }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    weeks.push(col);
  }
  return weeks;
}

// ── formatting ──
function humanTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
const humanCost = n => (Number(n) || 0) >= 1000 ? '$' + ((Number(n)) / 1000).toFixed(1) + 'k' : '$' + (Number(n) || 0).toFixed(0);
const fmtInt = n => Number(n || 0).toLocaleString('en-US');

function prettyModel(s) {
  s = String(s).replace(/^anthropic\//, '').replace(/-/g, ' ').replace(/\bgpt\b/i, 'GPT');
  return s.length > 22 ? s.slice(0, 22) : s;
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── svg ──
function renderSvg(d) {
  const p = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="jxherc tokscale stats">`);
  p.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="6" fill="${C.bg}"/>`);

  // ── tokens (left) ──
  p.push(`<text x="${P}" y="46" fill="${C.blue}" font-size="11" font-weight="600" letter-spacing="0.8">TOKENS</text>`);
  p.push(`<text x="${P}" y="84" fill="${C.blue}" font-size="36" font-weight="800" letter-spacing="-0.5">${esc(d ? d.tokens : '—')}</text>`);
  if (d)
    p.push(`<text x="${P}" y="108" fill="${C.muted}" font-size="11.5">rank #${fmtInt(d.rank)}  ·  ${esc(d.cost)}  ·  ${fmtInt(d.sessions)} sessions</text>`);

  // ── top models (right) ──
  const mx = 400;
  p.push(`<text x="${mx}" y="46" fill="${C.muted}" font-size="11" font-weight="600" letter-spacing="0.8">TOP MODELS</text>`);
  const models = d ? d.models : [];
  if (models.length) {
    const top = models[0].pct || 1;
    const yc = [64, 84, 104, 124], tw = 150;
    models.forEach((m, i) => {
      const y = yc[i];
      const fw = Math.round(tw * Math.min(1, Math.max(0.06, m.pct / (top || 1))));
      p.push(`<rect x="${mx}" y="${y - 9}" width="${tw}" height="8" rx="4" fill="${C.divider}"/>`);
      p.push(`<rect x="${mx}" y="${y - 9}" width="${fw}" height="8" rx="4" fill="${BAR[i]}"/>`);
      p.push(`<text x="${mx + tw + 14}" y="${y - 1}" fill="${C.text}" font-size="12">${esc(prettyModel(m.name))}</text>`);
      p.push(`<text x="${W - P}" y="${y - 1}" fill="${C.muted}" font-size="12" text-anchor="end">${m.pct.toFixed(0)}%</text>`);
    });
  } else {
    p.push(`<text x="${mx}" y="84" fill="${C.faint}" font-size="12">tokscale unavailable</text>`);
  }

  // ── divider ──
  p.push(`<line x1="${P}" y1="140" x2="${W - P}" y2="140" stroke="${C.divider}" stroke-width="1"/>`);

  // ── contribution grid (year, violet) ──
  const weeks = d ? d.weeks : [];
  const gx = P, gy = 156, PITCH = 11, CS = 9;
  weeks.forEach((w, col) => w.forEach((b, row) => {
    if (b == null) return;
    p.push(`<rect x="${gx + col * PITCH}" y="${gy + row * PITCH}" width="${CS}" height="${CS}" rx="2" fill="${RAMP[b]}"/>`);
  }));

  // less→more legend, bottom-right
  const lx = W - P - 118, ly = 224;
  p.push(`<text x="${lx}" y="${ly + 8}" fill="${C.faint}" font-size="10">Less</text>`);
  for (let i = 0; i < 5; i++)
    p.push(`<rect x="${lx + 30 + i * 13}" y="${ly}" width="9" height="9" rx="2" fill="${RAMP[i]}"/>`);
  p.push(`<text x="${lx + 30 + 5 * 13 + 4}" y="${ly + 8}" fill="${C.faint}" font-size="10">More</text>`);

  p.push(`</svg>`);
  return p.join('');
}

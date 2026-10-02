const PAGE_SIZE = 500;
const MAX_PAGES = 100;
const KINDS = { tracks: 'track', albums: 'album', artists: 'artist' };
const norm = value => String(value || '').normalize('NFKC').trim().toLowerCase();

export function parseTop(item, kind) {
  const sub = item[kind] || item;
  const rawSid = sub.externalIds?.spotify?.[0] || sub.spotifyIds?.[0] || '';
  return {
    id: sub.id,
    name: sub.name || '',
    artistName: kind === 'artist' ? '' : (sub.artists?.[0]?.name || item.artists?.[0]?.name || sub.artist?.name || ''),
    imgUrl: kind === 'track' ? (sub.albums?.[0]?.image || '') : (sub.image || ''),
    streams: Number(item.streams ?? item.count ?? 0),
    // Round only after accounts and duplicate recordings have been combined.
    minutes: item.playedMs != null ? Number(item.playedMs) / 60000 : Number(item.minutes || 0),
    spotifyUrl: /^[A-Za-z0-9]+$/.test(rawSid) ? `https://open.spotify.com/${kind}/${rawSid}` : '',
  };
}

export function mergeTops(a, b, kind) {
  const byName = new Map(), byId = new Map();
  for (const raw of [...a, ...b]) {
    const it = parseTop(raw, kind);
    if (!it.name) continue;
    const key = `${norm(it.name)}::${norm(it.artistName)}`;
    const prev = (it.id != null && byId.get(it.id)) || byName.get(key);
    if (prev) {
      prev.streams += it.streams;
      prev.minutes += it.minutes;
      for (const field of ['artistName', 'imgUrl', 'spotifyUrl']) if (!prev[field]) prev[field] = it[field];
      byName.set(key, prev);
      if (it.id != null) byId.set(it.id, prev);
    } else {
      byName.set(key, it);
      if (it.id != null) byId.set(it.id, it);
    }
  }
  return [...new Set(byName.values())];
}

function queryString(query) {
  return new URLSearchParams(query).toString();
}

export async function loadAccountTops(api, user, category, query, fetchJSON) {
  const items = new Map(), pages = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchJSON(`${api}/users/${user}/top/${category}?${queryString({ ...query, orderBy: 'COUNT', limit: PAGE_SIZE, offset: page * PAGE_SIZE })}`);
    if (!Array.isArray(data?.items)) throw new Error(`top stats unavailable: ${user}`);
    const rows = data.items;
    if (!rows.length) return [...items.values()];
    const kind = KINDS[category];
    const keys = rows.map(raw => {
      const it = parseTop(raw, kind);
      return it.id != null ? `id:${it.id}` : `${norm(it.name)}::${norm(it.artistName)}`;
    });
    const signature = JSON.stringify(keys);
    if (pages.has(signature)) throw new Error(`top pagination repeated: ${user}`);
    pages.add(signature);
    rows.forEach((raw, i) => { if (!items.has(keys[i])) items.set(keys[i], raw); });
    // The API can omit deleted items within a page; short pages can still have successors.
  }
  throw new Error(`top pagination incomplete: ${user}`);
}

export async function loadCombinedTops(api, users, query, fetchJSON) {
  const pairs = await Promise.all(Object.entries(KINDS).map(async ([category, kind]) => {
    const lists = await Promise.all(users.map(user => loadAccountTops(api, user, category, query, fetchJSON)));
    return [kind, mergeTops(lists[0], lists[1], kind)];
  }));
  return Object.fromEntries(pairs);
}

export async function loadCombinedStats(api, users, query, fetchJSON) {
  const stats = await Promise.all(users.map(async user => {
    const data = await fetchJSON(`${api}/users/${user}/streams/stats?${queryString(query)}`);
    const value = data?.items;
    if (!Number.isFinite(value?.count) || !Number.isFinite(value?.durationMs)) throw new Error(`stats unavailable: ${user}`);
    return value;
  }));
  return {
    streams: stats.reduce((n, value) => n + value.count, 0),
    minutes: Math.round(stats.reduce((n, value) => n + value.durationMs, 0) / 60000),
  };
}

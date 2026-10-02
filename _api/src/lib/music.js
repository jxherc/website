const encoder = new TextEncoder();
export const normalize = value => String(value || '').normalize('NFKC').trim().toLowerCase();
export function safeURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
}
const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function normalizeEvent(raw) {
  const source = text(raw?.source, 80), externalId = text(raw?.id, 200);
  const name = text(raw?.name), artist = text(raw?.artist), album = text(raw?.album);
  const playedAt = raw?.playedAt, playedMs = raw?.playedMs;
  if (!source || !externalId || !name || !Number.isSafeInteger(playedAt) || playedAt <= 0 ||
      playedAt > Date.now() + 300000 || !Number.isSafeInteger(playedMs) || playedMs < 0 || playedMs > 86400000) {
    throw new Error('each listen needs an id, source, name, playedAt in milliseconds and playedMs');
  }
  if (!Array.isArray(raw.artists) || raw.artists.length > 30) throw new Error('each listen needs an artists array');
  const artists = [...new Map(raw.artists.map(a => {
    if (!text(a?.name)) throw new Error('artist name missing');
    const name = text(a.name);
    return [normalize(name), { key: normalize(name), name, image: safeURL(a.image), url: safeURL(a.url) }];
  })).values()];
  const event = { source, playedAt, playedMs, name, artist, album,
    trackKey: text(raw.recordingId,200) || `${normalize(name)}::${normalize(artist)}`,
    albumKey: album ? `${normalize(album)}::${normalize(artist)}` : '',
    artists, image: safeURL(raw.image), url: safeURL(raw.url),
    metadataMissing: raw.metadataMissing ? 1 : 0, albumImage: safeURL(raw.albumImage), albumURL: safeURL(raw.albumURL) };
  return { ...event, id: await digest(`${source}\n${externalId}`), fingerprint: await digest(JSON.stringify(event)) };
}
export function listeningIdentity(event) {
  const artists=event.artists.map(({key,name})=>[key,name]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  return JSON.stringify([event.source,event.playedAt,event.playedMs,event.name,event.artist,event.album,
    event.trackKey,event.albumKey,event.metadataMissing,artists]);
}
export function insertEvent(db, e) {
  // Compare listen identity, not catalog artwork/links. Existing full fingerprints remain untouched.
  // A conflicting upsert violates fingerprint's NOT NULL constraint, aborting the whole D1 batch.
  return db.prepare(`INSERT INTO music_events
    (id,source,played_at,played_ms,name,artist,album,track_key,album_key,artists,image,url,album_image,album_url,metadata_missing,fingerprint)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET fingerprint=NULL WHERE
      music_events.source!=excluded.source OR music_events.played_at!=excluded.played_at
      OR music_events.played_ms!=excluded.played_ms OR music_events.name!=excluded.name
      OR music_events.artist!=excluded.artist OR music_events.album!=excluded.album
      OR music_events.track_key!=excluded.track_key OR music_events.album_key!=excluded.album_key
      OR music_events.metadata_missing!=excluded.metadata_missing
      OR json_array_length(music_events.artists)!=json_array_length(excluded.artists)
      OR EXISTS(SELECT json_extract(value,'$.key'),json_extract(value,'$.name') FROM json_each(music_events.artists)
        EXCEPT SELECT json_extract(value,'$.key'),json_extract(value,'$.name') FROM json_each(excluded.artists))`).bind(e.id,e.source,e.playedAt,e.playedMs,e.name,e.artist,e.album,e.trackKey,e.albumKey,
    JSON.stringify(e.artists),e.image,e.url,e.albumImage,e.albumURL,e.metadataMissing,e.fingerprint);
}
const stateSQL = `SELECT
  (SELECT value FROM music_settings WHERE key='active') AS active,
  (SELECT value FROM music_settings WHERE key='generation') AS generation`;
const published = (state, generation = state?.generation) => state?.active === 'true' && !!generation && state.generation === generation;
async function saveCache(db, key, generation, payload) {
  // A paused or superseded calculation cannot write or return a published cache entry.
  const [state,write] = await db.batch([
    db.prepare(stateSQL),
    db.prepare(`INSERT INTO music_cache(key,generation,payload,created_at)
      SELECT ?,?,?,? WHERE (SELECT value FROM music_settings WHERE key='active')='true'
      AND (SELECT value FROM music_settings WHERE key='generation')=?
      ON CONFLICT(key) DO UPDATE SET generation=excluded.generation,payload=excluded.payload,created_at=excluded.created_at`)
      .bind(key,generation,JSON.stringify(payload),Date.now(),generation),
    db.prepare(`DELETE FROM music_cache WHERE key IN
      (SELECT key FROM music_cache WHERE key!='summary' ORDER BY created_at DESC,key DESC LIMIT -1 OFFSET 64)`),
  ]);
  return published(state.results[0],generation) && write.meta.changes > 0;
}
export async function databaseSummary(db, { publishedOnly = false } = {}) {
  const [cachedState,cache] = await db.batch([
    db.prepare(stateSQL),
    db.prepare(`SELECT payload FROM music_cache WHERE key='summary'
      AND generation=(SELECT value FROM music_settings WHERE key='generation')`),
  ]);
  if (published(cachedState.results[0]) && cache.results[0]) return JSON.parse(cache.results[0].payload);
  if (publishedOnly && !published(cachedState.results[0])) {
    return { ready:false, owned:!!cachedState.results[0].active };
  }
  const [state,totals,sources] = await db.batch([
    db.prepare(stateSQL),
    db.prepare('SELECT COUNT(*) AS streams, COALESCE(SUM(played_ms),0) AS playedMs, MAX(played_at) AS lastPlayedAt, COALESCE(SUM(metadata_missing),0) AS metadataMissing FROM music_events'),
    db.prepare('SELECT source,COUNT(*) AS streams,SUM(played_ms) AS playedMs FROM music_events GROUP BY source ORDER BY source'),
  ]);
  const total=totals.results[0],current=state.results[0];
  const summary = { ...total, minutes: Math.round(total.playedMs/60000), sources:sources.results, ready:current.active==='true', owned:!!current.active };
  if (summary.ready && !await saveCache(db,'summary',current.generation,summary)) throw new Error('history changed during summary');
  return summary;
}
export async function musicView(db, after, before) {
  // Equivalent ranges contain exactly the same timestamp groups, including boundary ties.
  const [initial,first,last] = await db.batch([
    db.prepare(stateSQL),
    db.prepare('SELECT played_at FROM music_events WHERE played_at>=? AND played_at<? ORDER BY played_at LIMIT 1').bind(after,before),
    db.prepare('SELECT played_at FROM music_events WHERE played_at>=? AND played_at<? ORDER BY played_at DESC LIMIT 1').bind(after,before),
  ]);
  const generation=initial.results[0].generation;
  if (!published(initial.results[0])) return null;
  const key=`view:${first.results[0]?.played_at ?? 'empty'}:${last.results[0]?.played_at ?? 'empty'}`;
  const [cachedState,cache] = await db.batch([
    db.prepare(stateSQL),
    db.prepare('SELECT payload FROM music_cache WHERE key=? AND generation=?').bind(key,generation),
  ]);
  if (!published(cachedState.results[0],generation)) return null;
  if (cache.results[0]) return JSON.parse(cache.results[0].payload);
  const select = {
    track: `SELECT track_key AS id,name,artist AS artistName,MAX(image) AS imgUrl,MAX(url) AS spotifyUrl,COUNT(*) AS streams,SUM(played_ms)/60000.0 AS minutes FROM music_events WHERE played_at>=? AND played_at<? GROUP BY track_key`,
    album: `SELECT album_key AS id,album AS name,artist AS artistName,MAX(album_image) AS imgUrl,MAX(album_url) AS spotifyUrl,COUNT(*) AS streams,SUM(played_ms)/60000.0 AS minutes FROM music_events WHERE played_at>=? AND played_at<? AND album_key!='' GROUP BY album_key`,
    artist: `SELECT json_extract(a.value,'$.key') AS id,json_extract(a.value,'$.name') AS name,'' AS artistName,MAX(json_extract(a.value,'$.image')) AS imgUrl,MAX(json_extract(a.value,'$.url')) AS spotifyUrl,COUNT(*) AS streams,SUM(e.played_ms)/60000.0 AS minutes FROM music_events e,json_each(e.artists) a WHERE played_at>=? AND played_at<? GROUP BY json_extract(a.value,'$.key')`,
  };
  // D1 batches are transactional: readiness, totals and both ranking orders share one snapshot.
  const kinds=Object.keys(select);
  const [state,totals,...rankings]=await db.batch([
    db.prepare(stateSQL),
    db.prepare('SELECT COUNT(*) AS streams,COALESCE(SUM(played_ms),0) AS playedMs FROM music_events WHERE played_at>=? AND played_at<?').bind(after,before),
    ...kinds.flatMap(kind=>['streams','minutes'].map(order=>db.prepare(`${select[kind]} ORDER BY ${order} DESC,id LIMIT 100`).bind(after,before)))
  ]);
  if (!published(state.results[0],generation)) return null;
  const tops={};
  kinds.forEach((kind,i)=>{
    const rows=[...rankings[i*2].results,...rankings[i*2+1].results];
    tops[kind]=[...new Map(rows.map(r=>[r.id,r])).values()];
  });
  const total=totals.results[0];
  const view = { stats:{streams:total.streams,minutes:Math.round(total.playedMs/60000)},tops };
  return await saveCache(db,key,generation,view) ? view : null;
}

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
export function insertEvent(db, e) {
  // A conflicting upsert violates fingerprint's NOT NULL constraint, aborting the whole D1 batch.
  return db.prepare(`INSERT INTO music_events
    (id,source,played_at,played_ms,name,artist,album,track_key,album_key,artists,image,url,album_image,album_url,metadata_missing,fingerprint)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET fingerprint=NULL WHERE music_events.fingerprint!=excluded.fingerprint`).bind(e.id,e.source,e.playedAt,e.playedMs,e.name,e.artist,e.album,e.trackKey,e.albumKey,
    JSON.stringify(e.artists),e.image,e.url,e.albumImage,e.albumURL,e.metadataMissing,e.fingerprint);
}
export async function databaseSummary(db) {
  const [totals,sources,state] = await db.batch([
    db.prepare('SELECT COUNT(*) AS streams, COALESCE(SUM(played_ms),0) AS playedMs, MAX(played_at) AS lastPlayedAt, COALESCE(SUM(metadata_missing),0) AS metadataMissing FROM music_events'),
    db.prepare('SELECT source,COUNT(*) AS streams,SUM(played_ms) AS playedMs FROM music_events GROUP BY source ORDER BY source'),
    db.prepare("SELECT value FROM music_settings WHERE key='active'")
  ]);
  const total=totals.results[0],active=state.results[0];
  return { ...total, minutes: Math.round(total.playedMs/60000), sources:sources.results, ready:active?.value==='true', owned:!!active };
}
export async function musicView(db, after, before) {
  const select = {
    track: `SELECT track_key AS id,name,artist AS artistName,MAX(image) AS imgUrl,MAX(url) AS spotifyUrl,COUNT(*) AS streams,SUM(played_ms)/60000.0 AS minutes FROM music_events WHERE played_at>=? AND played_at<? GROUP BY track_key`,
    album: `SELECT album_key AS id,album AS name,artist AS artistName,MAX(album_image) AS imgUrl,MAX(album_url) AS spotifyUrl,COUNT(*) AS streams,SUM(played_ms)/60000.0 AS minutes FROM music_events WHERE played_at>=? AND played_at<? AND album_key!='' GROUP BY album_key`,
    artist: `SELECT json_extract(a.value,'$.key') AS id,json_extract(a.value,'$.name') AS name,'' AS artistName,MAX(json_extract(a.value,'$.image')) AS imgUrl,MAX(json_extract(a.value,'$.url')) AS spotifyUrl,COUNT(*) AS streams,SUM(e.played_ms)/60000.0 AS minutes FROM music_events e,json_each(e.artists) a WHERE played_at>=? AND played_at<? GROUP BY json_extract(a.value,'$.key')`,
  };
  // D1 batches are transactional: readiness, totals and both ranking orders share one snapshot.
  const kinds=Object.keys(select);
  const [state,totals,...rankings]=await db.batch([
    db.prepare("SELECT value FROM music_settings WHERE key='active'"),
    db.prepare('SELECT COUNT(*) AS streams,COALESCE(SUM(played_ms),0) AS playedMs FROM music_events WHERE played_at>=? AND played_at<?').bind(after,before),
    ...kinds.flatMap(kind=>['streams','minutes'].map(order=>db.prepare(`${select[kind]} ORDER BY ${order} DESC,id LIMIT 100`).bind(after,before)))
  ]);
  if(state.results[0]?.value!=='true') return null;
  const tops={};
  kinds.forEach((kind,i)=>{
    const rows=[...rankings[i*2].results,...rankings[i*2+1].results];
    tops[kind]=[...new Map(rows.map(r=>[r.id,r])).values()];
  });
  const total=totals.results[0];
  return { stats:{streams:total.streams,minutes:Math.round(total.playedMs/60000)},tops };
}

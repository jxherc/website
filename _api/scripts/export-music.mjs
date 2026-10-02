import { open, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAccountTops } from '../../music-data.mjs';
const API = 'https://api.stats.fm/api/v1';
export async function getJSON(url) {
  const r = await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});
  if (!r.ok) throw new Error(`history request failed (${r.status})`);
  return r.json();
}
export async function exportAccount(user,before,fetchJSON=getJSON) {
  const query={after:1,before}, expected=(await fetchJSON(`${API}/users/${user}/streams/stats?${new URLSearchParams(query)}`)).items;
  if (!Number.isSafeInteger(expected?.count) || !Number.isSafeInteger(expected?.durationMs)) throw new Error('history totals unavailable');
  const listens=new Map(); let cursor=before;
  for(let page=0;page<1000;page++) {
    const data=await fetchJSON(`${API}/users/${user}/streams?after=1&before=${cursor}&limit=500`);
    if(!Array.isArray(data?.items)) throw new Error('history unavailable');
    const rows=data.items;
    if(!rows.length) break;
    let oldest=cursor;
    for(const row of rows) {
      const time=Date.parse(row.endTime);
      if(!row.id || !Number.isSafeInteger(time) || time>cursor || !Number.isSafeInteger(row.playedMs)) throw new Error('invalid history record');
      listens.set(row.id,row); oldest=Math.min(oldest,time);
    }
    // Inclusive time cursor retains every record sharing the boundary timestamp.
    if(oldest===cursor) {
      if(rows.length>=500) throw new Error('too many listens at one timestamp; use the original export');
      cursor=oldest-1;
    } else cursor=oldest;
    if(page===999) throw new Error('history pagination incomplete');
  }
  const playedMs=[...listens.values()].reduce((n,r)=>n+r.playedMs,0);
  if(listens.size!==expected.count || playedMs!==expected.durationMs) throw new Error(`${user}: exported history does not match account totals (${listens.size}/${expected.count})`);
  const metadata={};
  for(const kind of ['tracks','albums','artists']) metadata[kind]=new Map((await loadAccountTops(API,user,kind,query,fetchJSON)).map(r=>{
    const key={tracks:'track',albums:'album',artists:'artist'}[kind];return [r[key]?.id,r[key]];
  }));
  let missingMetadata=0;
  const events=[...listens.values()].map(r=>{
    const t=metadata.tracks.get(r.trackId);
    const album=metadata.albums.get(r.albumId) || t?.albums?.find(a=>a.id===r.albumId) || t?.albums?.[0];
    const artists=(r.artistIds||[]).map(id=>metadata.artists.get(id)||t?.artists?.find(a=>a.id===id)).filter(Boolean);
    const metadataMissing=!t || artists.length!==(r.artistIds||[]).length || !album;
    if(metadataMissing) missingMetadata++;
    const link=(item,kind)=>{
      const sid=item?.externalIds?.spotify?.[0], aid=item?.externalIds?.appleMusic?.[0];
      if(/^[A-Za-z0-9]+$/.test(sid||'')) return `https://open.spotify.com/${kind}/${sid}`;
      if(/^\d+$/.test(aid||'') && kind==='track') return `https://music.apple.com/ca/song/${aid}`;
      return '';
    };
    return {metadataMissing,recordingId:`statsfm:track:${r.trackId}`,id:r.id,source:`statsfm:${user}`,playedAt:Date.parse(r.endTime),playedMs:r.playedMs,
      name:t?.name||r.trackName||'unavailable track',artist:t?.artists?.[0]?.name||artists[0]?.name||'',
      album:album?.name||'',image:t?.albums?.[0]?.image||album?.image||'',url:link(t,'track'),
      albumImage:album?.image||'',albumURL:link(album,'album'),
      artists:artists.map(a=>({name:a.name,image:a.image||'',url:link(a,'artist')}))};
  });
  return {events,streams:expected.count,playedMs:expected.durationMs,missingMetadata};
}
export async function saveExport(output,data) {
  await mkdir(dirname(output),{recursive:true});
  const file=await open(output,'w',0o600);
  try { await file.chmod(0o600); await file.writeFile(JSON.stringify(data)); }
  finally { await file.close(); }
}
async function main() {
  const output=process.argv[2]; if(!output) throw new Error('usage: node scripts/export-music.mjs /private/path/history.json');
  const before=Date.now(),events=[],accounts=[];
  for(const user of ['jxherc01','jxherc']) {
    console.log(`exporting ${user}…`);
    const result=await exportAccount(user,before); events.push(...result.events);
    accounts.push({user,streams:result.streams,playedMs:result.playedMs,missingMetadata:result.missingMetadata});
    console.log(`${user}: verified ${result.streams} listens; ${result.missingMetadata} with incomplete catalog metadata`);
  }
  const expected={streams:accounts.reduce((n,a)=>n+a.streams,0),playedMs:accounts.reduce((n,a)=>n+a.playedMs,0)};
  await saveExport(output,{version:1,exportedAt:before,expected,accounts,events});
  console.log(`saved ${expected.streams} verified listens to ${output}`);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});

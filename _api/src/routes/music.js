import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';
import { normalizeEvent, insertEvent, databaseSummary, musicView } from '../lib/music.js';
import { syncAppleRecent } from './applemusic.js';

export async function handleMusic(request, env, path) {
  const url = new URL(request.url);
  const mutation = request.method === 'POST';
  if (mutation) { const denied = await requireAuth(request,env); if (denied) return denied; }
  if (!['GET','POST'].includes(request.method)) return json({error:'method not allowed'},405);
  if (!env.MUSIC_DB) return request.method === 'GET' && path === '/music/status'
    ? json({ready:false,owned:false,configured:false}) : json({error:'music database not configured'},503);
  try {
    const db = env.MUSIC_DB;
    if (mutation && path === '/music/import/start') {
      const expected = await request.json().catch(()=>null);
      if (!expected || !Number.isSafeInteger(expected.streams) || expected.streams <= 0 || !Number.isSafeInteger(expected.playedMs) || expected.playedMs < 0) return json({error:'verified expected streams and playedMs required'},400);
      const target=JSON.stringify({streams:expected.streams,playedMs:expected.playedMs});
      await db.prepare("INSERT INTO music_settings(key,value) VALUES('import_target',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(target).run();
      return json({ok:true});
    }
    if (request.method === 'GET' && path === '/music/status') return json({...await databaseSummary(db),configured:true});
    if (request.method === 'GET' && path === '/music/view') {
      const after = Number(url.searchParams.get('after') || 1), before = Number(url.searchParams.get('before') || Date.now());
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(before) || after < 0 || before <= after) return json({error:'invalid date range'},400);
      const view=await musicView(db,after,before);
      return view ? json(view) : json({error:'history has not been verified'},503);
    }
    if (request.method === 'GET' && path === '/music/recent') {
      const apple = env.APPLE_KV ? await env.APPLE_KV.get('apple:recent:snapshot','json') : null;
      // Apple gives order, not individual play timestamps. Never turn a fetch into a listen.
      if (apple?.items?.length) return json({...apple,source:'apple',timestamps:false});
      const [state,rows]=await db.batch([
        db.prepare("SELECT value FROM music_settings WHERE key='active'"),
        db.prepare('SELECT name,artist,image AS img,url,played_at FROM music_events ORDER BY played_at DESC,id LIMIT 25')
      ]);
      if(state.results[0]?.value!=='true') return json({error:'history has not been verified'},503);
      return json({source:'history',timestamps:true,items:rows.results.map(r=>({...r,endTime:new Date(r.played_at).toISOString()}))});
    }
    if (mutation && path === '/music/import') {
      if (Number(request.headers.get('Content-Length')) > 1000000) return json({error:'import batch too large'},413);
      const body = await request.text();
      if (body.length > 1000000) return json({error:'import batch too large'},413);
      let data; try { data=JSON.parse(body); } catch { return json({error:'invalid JSON'},400); }
      if (!Array.isArray(data.events) || !data.events.length || data.events.length > 40) return json({error:'send 1–40 listens per batch'},400);
      let events; try { events = await Promise.all(data.events.map(normalizeEvent)); } catch(e) { return json({error:e.message},400); }
      const ids = new Map();
      for (const e of events) {
        if (ids.has(e.id) && ids.get(e.id) !== e.fingerprint) return json({error:'conflicting listen ids'},409);
        ids.set(e.id,e.fingerprint);
      }
      const keys=[...ids.keys()];
      const stored=await db.prepare(`SELECT id,fingerprint FROM music_events WHERE id IN (${keys.map(()=>'?').join(',')})`).bind(...keys).all();
      const existing=new Map(stored.results.map(r=>[r.id,r.fingerprint]));
      if(events.some(e=>existing.has(e.id) && existing.get(e.id)!==e.fingerprint)) return json({error:'a listen id already has different data'},409);
      const pause=db.prepare(`UPDATE music_settings SET value='paused' WHERE key='active' AND value='true' AND
        (SELECT COUNT(*) FROM music_events WHERE id IN (${keys.map(()=>'?').join(',')}))<?`).bind(...keys,keys.length);
      let results;
      try { results=await db.batch([pause,...events.map(e=>insertEvent(db,e))]); }
      catch(e) { if (String(e.message).includes('music_events.fingerprint')) return json({error:'conflicting listen ids'},409); throw e; }
      return json({received:events.length,inserted:results.slice(1).reduce((n,r)=>n+r.meta.changes,0)});
    }
    if (mutation && path === '/music/activate') {
      const expected = await request.json().catch(()=>null), actual = await databaseSummary(db);
      if (!expected || !Number.isSafeInteger(expected.streams) || expected.streams <= 0 || !Number.isSafeInteger(expected.playedMs)) return json({error:'verified expected streams and playedMs required'},400);
      // Compare and enable inside one SQL statement so an overlapping import cannot invalidate the check.
      const result = await db.prepare(`INSERT INTO music_settings(key,value) SELECT 'active','true' WHERE
        (SELECT COUNT(*) FROM music_events)=? AND (SELECT COALESCE(SUM(played_ms),0) FROM music_events)=?
        AND (SELECT value FROM music_settings WHERE key='import_target')=?
        ON CONFLICT(key) DO UPDATE SET value='true'`).bind(expected.streams,expected.playedMs,JSON.stringify({streams:expected.streams,playedMs:expected.playedMs})).run();
      if (!result.meta.changes) return json({error:'history does not match the saved import target',actual:{streams:actual.streams,playedMs:actual.playedMs}},409);
      return json({ok:true});
    }
    if (mutation && path === '/music/sync') { await syncAppleRecent(env); return json({ok:true}); }
    return json({error:'not found'},404);
  } catch { return json({error:'music service unavailable'},503); }
}

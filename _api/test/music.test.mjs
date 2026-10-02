import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {makeToken} from '../src/lib/auth.js';
import {exportAccount,saveExport} from '../scripts/export-music.mjs';
let mf,db,headers;
before(async()=>{
  const result=await build({entryPoints:[new URL('../src/index.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser'});
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{modules:true,script:result.outputFiles[0].text,compatibilityDate:'2024-01-01',d1Databases:['MUSIC_DB'],kvNamespaces:['APPLE_KV'],bindings:{TOKEN_SECRET:'test',ALLOWED_ORIGINS:'https://fixture.test'}}]}));
  db=await mf.getD1Database('MUSIC_DB');
  const schema=await readFile(new URL('../migrations/0001_music.sql',import.meta.url),'utf8');
  await db.batch(schema.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  headers={'Content-Type':'application/json',Authorization:`Bearer ${await makeToken({TOKEN_SECRET:'test'})}`};
});
after(async()=>{await mf?.dispose();});
const listen=(id,name,playedAt,playedMs,artist='artist')=>({id,source:'fixture',name,playedAt,playedMs,artist,album:'album',artists:[{name:artist}],url:'javascript:alert(1)',image:'http://unsafe.test/a'});
async function call(path,body,authorized=true) {
  return mf.dispatchFetch(`https://fixture.test${path}`,body===undefined?{}:{method:'POST',headers:authorized?headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}
test('real D1 import, retry, verification, ranges and rankings',async()=>{
  assert.equal((await call('/music/view')).status,503);
  const rows=[listen('a','many plays',Date.UTC(2025,11,31,23,59),60000),listen('b','many plays',Date.UTC(2026,0,1),60000),listen('c','long play',Date.UTC(2026,0,2),600000,'other')];
  assert.equal((await call('/music/import',{events:rows},false)).status,401);
  assert.equal((await call('/music/status')).status,200);
  assert.equal((await (await call('/music/status')).json()).streams,0);
  assert.equal((await call('/music/import/start',{streams:3,playedMs:720000},false)).status,401);
  assert.equal((await call('/music/import/start',{streams:3,playedMs:720000})).status,200);
  assert.equal((await call('/music/import',{events:rows.slice(0,2)})).status,200);
  assert.equal((await call('/music/activate',{streams:2,playedMs:120000})).status,409);
  assert.deepEqual(await (await call('/music/import',{events:rows})).json(),{received:3,inserted:1});
  assert.deepEqual(await (await call('/music/import',{events:rows})).json(),{received:3,inserted:0});
  assert.equal((await call('/music/import',{events:[{...rows[0],playedMs:1}]})).status,409);
  assert.equal((await call('/music/import',{events:[listen('valid','ok',Date.now()-1000,1),{...rows[0],playedMs:-1}]})).status,400);
  assert.equal((await call('/music/activate',{streams:2,playedMs:720000})).status,409);
  assert.equal((await call('/music/activate',{streams:3,playedMs:720000})).status,200);
  const all=await (await call('/music/view?after=1&before=1800000000000')).json();
  assert.deepEqual(all.stats,{streams:3,minutes:12});
  assert.equal(all.tops.track.find(t=>t.name==='many plays').streams,2);
  assert.equal(all.tops.track.find(t=>t.name==='long play').minutes,10);
  assert.ok(all.tops.track.every(t=>!t.spotifyUrl && !t.imgUrl));
  const year=await (await call(`/music/view?after=${Date.UTC(2026,0,1)}&before=${Date.UTC(2027,0,1)}`)).json();
  assert.deepEqual(year.stats,{streams:2,minutes:11});
  assert.equal((await call('/music/view?after=x')).status,400);
  const empty=await (await call('/music/view?after=1&before=2')).json();
  assert.deepEqual(empty.stats,{streams:0,minutes:0}); assert.deepEqual(empty.tops.track,[]);
  const recent=await (await call('/music/recent')).json(); assert.equal(recent.items[0].name,'long play');
  const kv=await mf.getKVNamespace('APPLE_KV');
  await kv.put('apple:recent:snapshot',JSON.stringify({items:[{name:'apple track',artist:'apple artist'}],observedAt:1000}));
  const apple=await (await call('/music/recent')).json();assert.equal(apple.timestamps,false);assert.equal(apple.items[0].endTime,undefined);
  assert.equal((await (await call('/music/status')).json()).streams,3);
  assert.equal((await call('/music/sync',{})).status,503);
  assert.equal((await (await call('/music/recent')).json()).items[0].name,'apple track');
});
test('concurrent identical imports keep one record; changed data cannot overwrite a listen',async()=>{
  const row=listen('parallel','parallel',Date.now()-10000,1234);
  const results=await Promise.all([call('/music/import',{events:[row]}),call('/music/import',{events:[row]})]);
  assert.ok(results.every(r=>r.status===200));
  const bodies=await Promise.all(results.map(r=>r.json()));assert.equal(bodies.reduce((n,r)=>n+r.inserted,0),1);
  const matches=await db.prepare("SELECT COUNT(*) AS n FROM music_events WHERE name='parallel'").first();assert.equal(matches.n,1);
});
test('history export retains timestamp boundary ties and rejects incomplete totals',async()=>{
  const a={id:'a',endTime:'2026-01-02T00:00:00Z',playedMs:10,trackName:'a',artistIds:[]};
  const b={id:'b',endTime:'2026-01-01T00:00:00Z',playedMs:20,trackName:'b',artistIds:[]};
  const c={id:'c',endTime:b.endTime,playedMs:30,trackName:'c',artistIds:[]};
  let page=0;
  const fetchJSON=async url=>url.includes('/streams/stats?')?{items:{count:3,durationMs:60}}:url.includes('/top/')?{items:[]}:{items:[[a,b],[b,c],[]][page++]};
  const exported=await exportAccount('fixture',Date.UTC(2026,0,3),fetchJSON);assert.equal(exported.events.length,3);assert.equal(exported.playedMs,60);
  await assert.rejects(exportAccount('fixture',Date.UTC(2026,0,3),async url=>url.includes('stats?')?{items:{count:1,durationMs:10}}:{items:[]}),/does not match/);
});

test('new imports pause published totals atomically; verified history stays owned',async()=>{
  const status=await (await call('/music/status')).json();
  await call('/music/import/start',{streams:status.streams,playedMs:status.playedMs});
  assert.equal((await call('/music/activate',{streams:status.streams,playedMs:status.playedMs})).status,200);
  await call('/music/import/start',{streams:status.streams+1,playedMs:status.playedMs+50});
  const row=listen('new-import','new import',Date.now()-10000,50);
  assert.equal((await call('/music/import',{events:[row]})).status,200);
  const paused=await (await call('/music/status')).json();assert.equal(paused.ready,false);assert.equal(paused.owned,true);
  assert.equal((await call('/music/view')).status,503);
  assert.equal((await call('/music/activate',{streams:paused.streams,playedMs:paused.playedMs})).status,200);
  await call('/music/import',{events:[row]});assert.equal((await (await call('/music/status')).json()).ready,true);
});
test('conflicting concurrent payloads never mutate the winning fingerprint',async()=>{
  const row=listen('race-conflict','race conflict',Date.now()-10000,100);
  const responses=await Promise.all([call('/music/import',{events:[row]}),call('/music/import',{events:[{...row,playedMs:200}]})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const stored=await db.prepare("SELECT played_ms,fingerprint FROM music_events WHERE name='race conflict'").first();
  assert.ok(stored.fingerprint);assert.equal((await call('/music/import',{events:[{...row,playedMs:stored.played_ms}]})).status,200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM music_events WHERE name='race conflict'").first()).n,1);
});

test('missing artist and album metadata retain a listen and its duration',async()=>{
  const row={...listen('missing-catalog','source track name',Date.now()-1000,54321,''),album:'',artists:[],metadataMissing:true};
  assert.equal((await call('/music/import',{events:[row]})).status,200);
  const r=await db.prepare("SELECT name,artist,album,played_ms,metadata_missing FROM music_events WHERE name='source track name'").first();
  assert.deepEqual(r,{name:'source track name',artist:'',album:'',played_ms:54321,metadata_missing:1});
});

test('maximum import fits the free D1 invocation budget and rejects larger batches',async()=>{
  const {handleMusic}=await import('../src/routes/music.js');let queries=0;
  const limited={prepare(sql){queries++;if(queries>50)throw new Error('D1 free query budget exceeded');return db.prepare(sql);},batch(statements){return db.batch(statements);}};
  const rows=Array.from({length:40},(_,i)=>listen(`budget-${i}`,'budget track',Date.now()-10000-i,1000));
  const request=new Request('https://fixture.test/music/import',{method:'POST',headers,body:JSON.stringify({events:rows})});
  assert.equal((await handleMusic(request,{TOKEN_SECRET:'test',MUSIC_DB:limited},'/music/import')).status,200);
  assert.equal(queries,42);
  assert.equal((await call('/music/import',{events:[...rows,listen('over-budget','over budget',Date.now()-10000,1)]})).status,400);
});
test('public stats and recent history gate readiness within their read snapshot',async()=>{
  const {musicView}=await import('../src/lib/music.js');const {handleMusic}=await import('../src/routes/music.js');
  async function activate(){const s=await (await call('/music/status')).json();await call('/music/import/start',{streams:s.streams,playedMs:s.playedMs});assert.equal((await call('/music/activate',{streams:s.streams,playedMs:s.playedMs})).status,200);}
  const wrapper=()=>({prepare(sql){return db.prepare(sql);},async batch(statements){
    await db.prepare("UPDATE music_settings SET value='paused' WHERE key='active'").run();
    return db.batch(statements);
  }});
  await activate();assert.equal(await musicView(wrapper(),1,Date.now()),null);
  await activate();
  const response=await handleMusic(new Request('https://fixture.test/music/recent'),{MUSIC_DB:wrapper()},'/music/recent');
  assert.equal(response.status,503);
});

test('overwriting a history export restricts permissions before writing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'music-export-'));const path=join(dir,'history.json');
  try {
    await writeFile(path,'old',{mode:0o644});await saveExport(path,{version:1});
    assert.equal((await stat(path)).mode&0o777,0o600);
    assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{version:1});
  } finally {await rm(dir,{recursive:true,force:true});}
});

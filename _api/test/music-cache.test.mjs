import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {makeToken} from '../src/lib/auth.js';
import {handleMusic} from '../src/routes/music.js';
import {databaseSummary,musicView,normalizeEvent,insertEvent} from '../src/lib/music.js';
let mf,db,headers;
before(async()=>{
  const result=await build({entryPoints:[new URL('../src/index.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser'});
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{modules:true,script:result.outputFiles[0].text,compatibilityDate:'2024-01-01',d1Databases:['MUSIC_DB'],bindings:{TOKEN_SECRET:'dummy'}}]}));
  db=await mf.getD1Database('MUSIC_DB');
  for(const migration of ['0001_music.sql','0002_music_cache.sql']) {
    const sql=await readFile(new URL(`../migrations/${migration}`,import.meta.url),'utf8');
    await db.exec(sql.replace(/\n/g,' '));
  }
  headers={'Content-Type':'application/json',Authorization:`Bearer ${await makeToken({TOKEN_SECRET:'dummy'})}`};
});
after(async()=>{await mf?.dispose();});
async function call(path,body) {
  const request=new Request(`https://fixture.test${path}`,body?{method:'POST',headers,body:JSON.stringify(body)}:{});
  return handleMusic(request,{TOKEN_SECRET:'dummy',MUSIC_DB:db},path);
}
const listen=(id,playedAt,playedMs=60000)=>({id,source:'cache-fixture',name:id,playedAt,playedMs,artist:'artist',album:'album',artists:[{name:'artist'}]});
async function activate() {
  const summary=await databaseSummary(db);
  const target={streams:summary.streams,playedMs:summary.playedMs};
  assert.equal((await call('/music/import/start',target)).status,200);
  assert.equal((await call('/music/activate',target)).status,200);
}
function measured() {
  const queries=[];
  return {queries,prepare(sql){return db.prepare(sql)},async batch(statements){const r=await db.batch(statements);queries.push(...r.map(row=>row.meta));return r;}};
}
test('persistent exact-range cache reuses moving bounds but preserves inclusive/exclusive ties',async()=>{
  const rows=[listen('before',1000),listen('boundary-a',2000),listen('boundary-b',2000),listen('last',3000)];
  assert.equal((await call('/music/import',{events:rows})).status,200);await activate();
  const cold=measured(),first=await musicView(cold,1500,4000);
  assert.deepEqual(first.stats,{streams:3,minutes:3});
  const entries=await db.prepare("SELECT COUNT(*) AS n FROM music_cache WHERE key LIKE 'view:%'").first();
  assert.equal(entries.n,1);
  const warm=measured(),second=await musicView(warm,1999,Date.now());
  assert.deepEqual(second,first);
  assert.ok(warm.queries.reduce((n,m)=>n+m.rows_read,0)<40);
  assert.equal(warm.queries.reduce((n,m)=>n+m.rows_written,0),0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM music_cache WHERE key LIKE 'view:%'").first()).n,1);
  assert.deepEqual((await musicView(db,2000,3000)).stats,{streams:2,minutes:2});
  assert.deepEqual((await musicView(db,2001,3001)).stats,{streams:1,minutes:1});
  const empty=await musicView(db,3001,4000);
  assert.deepEqual(empty,{stats:{streams:0,minutes:0},tops:{track:[],album:[],artist:[]}});
  assert.deepEqual(await musicView(db,4001,5000),empty);
});
test('status uses persistent summary after warmup and new imports cannot reuse old published views',async()=>{
  const first=await databaseSummary(db);
  const warm=measured();assert.deepEqual(await databaseSummary(warm),first);
  assert.ok(warm.queries.reduce((n,m)=>n+m.rows_read,0)<15);
  assert.equal(warm.queries.reduce((n,m)=>n+m.rows_written,0),0);
  const generation=await db.prepare("SELECT value FROM music_settings WHERE key='generation'").first();
  assert.equal((await call('/music/import',{events:[listen('new',3500,120000)]})).status,200);
  assert.equal(await musicView(db,1500,Date.now()),null);
  const paused=await databaseSummary(db);assert.equal(paused.ready,false);assert.equal(paused.owned,true);assert.equal(paused.streams,5);
  await activate();
  assert.notEqual((await db.prepare("SELECT value FROM music_settings WHERE key='generation'").first()).value,generation.value);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM music_cache').first()).n,0);
  assert.deepEqual((await musicView(db,1500,Date.now())).stats,{streams:4,minutes:5});
  assert.equal((await databaseSummary(db)).streams,5);
});
test('a cold fill overlapping pause or reactivation cannot publish the previous generation',async()=>{
  await db.prepare('DELETE FROM music_cache').run();
  let calls=0;
  const pauseBeforeFill={prepare(sql){return db.prepare(sql)},async batch(statements){
    calls++;if(calls===4)await db.prepare("UPDATE music_settings SET value='paused' WHERE key='active'").run();
    return db.batch(statements);
  }};
  assert.equal(await musicView(pauseBeforeFill,1500,Date.now()),null);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM music_cache').first()).n,0);
  await activate();
  calls=0;
  const reactivateBeforeFill={prepare(sql){return db.prepare(sql)},async batch(statements){
    calls++;if(calls===4)await activate();
    return db.batch(statements);
  }};
  assert.equal(await musicView(reactivateBeforeFill,1500,Date.now()),null);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM music_cache').first()).n,0);
  assert.deepEqual((await musicView(db,1500,Date.now())).stats,{streams:4,minutes:5});
});
test('unactivated or paused public status is cheap; owners retain actual import progress',async()=>{
  await db.prepare("UPDATE music_settings SET value='paused' WHERE key='active'").run();
  const limited=measured();
  assert.deepEqual(await databaseSummary(limited,{publishedOnly:true}),{ready:false,owned:true});
  assert.ok(limited.queries.reduce((n,m)=>n+m.rows_read,0)<10);
  const publicStatus=await call('/music/status');
  assert.deepEqual(await publicStatus.json(),{ready:false,owned:true,configured:true});
  const ownerStatus=await handleMusic(new Request('https://fixture.test/music/status',{headers}),{TOKEN_SECRET:'dummy',MUSIC_DB:db},'/music/status');
  assert.equal((await ownerStatus.json()).streams,5);
  const invalid=await handleMusic(new Request('https://fixture.test/music/status',{headers:{Authorization:'Bearer invalid'}}),{TOKEN_SECRET:'dummy',MUSIC_DB:db},'/music/status');
  assert.equal(invalid.status,401);
  await db.prepare("DELETE FROM music_settings WHERE key='active'").run();
  assert.deepEqual(await databaseSummary(db,{publishedOnly:true}),{ready:false,owned:false});
  await activate();
});
test('direct SQL inserts, updates and deletes pause cached history until verified activation',async()=>{
  await musicView(db,1,Date.now());await databaseSummary(db);
  await insertEvent(db,await normalizeEvent(listen('sql-new',4000))).run();
  assert.equal(await musicView(db,1,Date.now()),null);
  assert.deepEqual(await databaseSummary(db,{publishedOnly:true}),{ready:false,owned:true});
  await activate();assert.deepEqual((await musicView(db,1,Date.now())).stats,{streams:6,minutes:7});
  await db.prepare("UPDATE music_events SET played_ms=0 WHERE name='sql-new'").run();
  assert.equal(await musicView(db,1,Date.now()),null);
  await activate();assert.deepEqual((await musicView(db,1,Date.now())).stats,{streams:6,minutes:6});
  await db.prepare("DELETE FROM music_events WHERE name='sql-new'").run();
  assert.equal(await musicView(db,1,Date.now()),null);
  await activate();assert.deepEqual((await musicView(db,1,Date.now())).stats,{streams:5,minutes:6});
});
test('persistent ranges stay bounded without evicting the published summary',async()=>{
  const rows=Array.from({length:70},(_,i)=>listen(`range-${i}`,10000+i));
  for(let i=0;i<rows.length;i+=40)assert.equal((await call('/music/import',{events:rows.slice(i,i+40)})).status,200);
  await activate();await databaseSummary(db);
  for(let i=0;i<rows.length;i++)assert.equal((await musicView(db,10000+i,10001+i)).stats.streams,1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM music_cache WHERE key LIKE 'view:%'").first()).n,64);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM music_cache WHERE key='summary'").first()).n,1);
});
test('legacy full fingerprints accept decorative catalog drift without changing stored listens',async()=>{
  const original={...listen('catalog-drift',20000),image:'https://old.test/track.jpg',url:'https://old.test/track',albumImage:'https://old.test/album.jpg',albumURL:'https://old.test/album',artists:[{name:'artist',image:'https://old.test/artist.jpg',url:'https://old.test/artist'}]};
  const normalized=await normalizeEvent(original);
  assert.equal((await call('/music/import',{events:[original]})).status,200);await activate();
  const old=await db.prepare('SELECT * FROM music_events WHERE id=?').bind(normalized.id).first();
  assert.equal(old.fingerprint,normalized.fingerprint);
  const refreshed={...original,image:'https://new.test/track.jpg',url:'https://new.test/track',albumImage:'https://new.test/album.jpg',albumURL:'https://new.test/album',artists:[{name:'artist',image:'https://new.test/artist.jpg',url:'https://new.test/artist'}]};
  assert.notEqual((await normalizeEvent(refreshed)).fingerprint,old.fingerprint);
  const response=await call('/music/import',{events:[refreshed]});assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{received:1,inserted:0});
  assert.deepEqual(await db.prepare('SELECT * FROM music_events WHERE id=?').bind(normalized.id).first(),old);
  assert.equal((await databaseSummary(db)).ready,true);
  assert.deepEqual(await (await call('/music/import',{events:[original,refreshed]})).json(),{received:2,inserted:0});
  for(const changed of [{playedMs:120000},{playedAt:20001},{recordingId:'different-recording'},{name:'different song'},{artist:'different artist'},{album:'different album'},{artists:[{name:'different artist'}]}]) {
    const rejected=await call('/music/import',{events:[listen('must-rollback',21000),{...refreshed,...changed}]});
    assert.equal(rejected.status,409);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM music_events WHERE name='must-rollback'").first()).n,0);
  }
  await assert.rejects(db.batch([
    insertEvent(db,await normalizeEvent(listen('sql-must-rollback',22000))),
    insertEvent(db,await normalizeEvent({...refreshed,playedMs:120000})),
  ]),/music_events.fingerprint/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM music_events WHERE name='sql-must-rollback'").first()).n,0);
  assert.equal((await databaseSummary(db)).ready,true);
});

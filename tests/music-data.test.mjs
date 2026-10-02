import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAccountTops, loadCombinedTops, loadCombinedStats, mergeTops } from '../music-data.mjs';
const raw = (id, name, streams, playedMs = 60000, artist = 'artist') => ({ track: { id, name, artists: [{ name: artist }] }, streams, playedMs });

test('pagination follows short pages and includes an item beyond the first 500', async () => {
  const calls = [];
  const result = await loadAccountTops('https://fixture.test', 'apple', 'tracks', {after:1,before:1000}, async url => {
    const q = new URL(url).searchParams; calls.push(Number(q.get('offset')));
    assert.equal(q.get('orderBy'), 'COUNT'); assert.equal(q.get('limit'), '500');
    assert.equal(q.get('after'), '1'); assert.equal(q.get('before'), '1000');
    return {items: Number(q.get('offset')) === 0 ? [raw(1,'a',2)] : Number(q.get('offset')) === 500 ? [raw(2,'winner',100)] : []};
  });
  assert.deepEqual(calls,[0,500,1000]); assert.equal(result[1].track.name,'winner');
});

test('failed later page never returns an incomplete ranking', async () => {
  let n = 0;
  await assert.rejects(loadAccountTops('https://fixture.test','apple','tracks',{},async()=> ++n === 1 ? {items:[raw(1,'a',2)]} : null), /unavailable/);
});

test('repeated pages fail instead of looping or double-counting', async () => {
  await assert.rejects(loadAccountTops('https://fixture.test','apple','tracks',{},async()=>({items:[raw(1,'a',2)]})), /repeated/);
});

test('overlapping pages deduplicate within an account', async () => {
  let n=0;
  const result = await loadAccountTops('https://fixture.test','apple','tracks',{},async()=>({items:[ [raw(1,'a',2)], [raw(1,'a',2),raw(2,'b',3)], [] ][n++]}));
  assert.equal(result.length,2); assert.equal(result.reduce((sum,x)=>sum+x.streams,0),5);
});

test('combined winners include contributions outside each account top 20', async () => {
  const result = await loadCombinedTops('https://fixture.test',['spotify','apple'],{range:'lifetime'},async url => {
    const u = new URL(url), kind={tracks:'track',albums:'album',artists:'artist'}[u.pathname.split('/').pop()];
    if (u.searchParams.get('offset') !== '0') return {items:[]};
    const rows=Array.from({length:25},(_,i)=>({[kind]:{id:i,name:'item '+i,artists:[{name:'artist'}]},streams:u.pathname.includes('/spotify/')?100-i:(i===24?100:1),playedMs:60000}));
    return {items:rows};
  });
  for (const kind of ['track','album','artist']) {
    const winner=result[kind].sort((a,b)=>b.streams-a.streams)[0];
    assert.equal(winner.name,'item 24'); assert.equal(winner.streams,176);
  }
});

test('merge uses shared ids and normalized names without mixing distinct artists', () => {
  const result=mergeTops([raw(1,' song ',10,20000)], [raw(2,'SONG',8,20000),raw(3,'SONG',5,60000,'other')],'track');
  assert.equal(result.length,2); assert.equal(result[0].streams,18); assert.equal(Math.round(result[0].minutes),1);
  const sameId=mergeTops([raw(1,'song',10,60000,'')],[raw(1,'song',8)],'track');
  assert.equal(sameId.length,1); assert.equal(sameId[0].artistName,'artist');
});

test('totals require both accounts, with valid zero distinguished from failure', async () => {
  const result=await loadCombinedStats('https://fixture.test',['spotify','apple'],{},async url=>({items:{count:url.includes('/spotify/')?116:8,durationMs:20000}}));
  assert.deepEqual(result,{streams:124,minutes:1});
  assert.deepEqual(await loadCombinedStats('', ['a','b'],{},async()=>({items:{count:0,durationMs:0}})),{streams:0,minutes:0});
  await assert.rejects(loadCombinedStats('', ['a','b'],{},async url=>url.includes('/a/')?{items:{count:116,durationMs:60000}}:null),/unavailable/);
  await assert.rejects(loadCombinedStats('', ['a','b'],{},async()=>({items:{}})),/unavailable/);
});

test('own music view shares one request and rejects unavailable totals', async () => {
  const { ownMusicView } = await import('../music-data.mjs');
  const cache=new Map();let calls=0;
  const data={stats:{streams:0,minutes:0},tops:{track:[],album:[],artist:[]}};
  const fetchJSON=async()=>{calls++;return data;};
  const [a,b]=await Promise.all([ownMusicView('https://fixture.test',{after:1,before:2},fetchJSON,cache),ownMusicView('https://fixture.test',{after:1,before:2},fetchJSON,cache)]);
  assert.equal(calls,1);assert.deepEqual(a,b);
  await assert.rejects(ownMusicView('https://fixture.test',{after:2,before:3},async()=>({error:'unavailable'}),cache),/unavailable/);
});

test('source selection preserves an activated source through outages and paused imports',async()=>{
  const {usesOwnHistory}=await import('../music-data.mjs');
  assert.equal(usesOwnHistory(null),false);
  assert.equal(usesOwnHistory({ready:false,owned:false}),false);
  assert.equal(usesOwnHistory({ready:true}),true);
  assert.equal(usesOwnHistory(null,true),true);
  assert.equal(usesOwnHistory({ready:false,owned:true}),true);
});

import { requireLogin, apiFetch } from './admin.js';
requireLogin();
const $ = id => document.getElementById(id);
const feedback = text => { $('feedback').textContent = text; };
let expected = null;
async function request(path,options) {
  const res = await apiFetch(path,options);
  const data = await res.json();
  if(!res.ok) throw new Error(data.error || 'music service unavailable');
  return data;
}
async function refresh() {
  const data = await request('/music/status');
  if (data.configured === false) throw new Error('music database not configured');
  $('plays').textContent = data.streams.toLocaleString();
  $('minutes').textContent = data.minutes.toLocaleString();
  $('state').textContent = data.ready ? 'own history' : (data.owned ? 'verify import' : 'stats.fm');
  $('sources').textContent = data.sources.map(s=>`${s.source}: ${s.streams.toLocaleString()} listens`).join(' · ');
}
const post = body => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function busy(value) { for(const id of ['import','sync']) $(id).disabled=value; $('history').disabled=value; $('activate').disabled=value || !expected; }
$('history').addEventListener('change',()=>{ expected=null; $('activate').disabled=true; });
$('import').addEventListener('click',async()=>{
  const file=$('history').files[0];
  if(!file) { feedback('choose a verified history export first.'); return; }
  if(file.size>100*1024*1024) { feedback('export is too large (maximum 100 MB).'); return; }
  expected=null; busy(true);
  try {
    const data=JSON.parse(await file.text());
    if(data.version!==1 || !Array.isArray(data.events) || !data.events.length || !data.expected ||
      data.events.length!==data.expected.streams || data.events.reduce((n,e)=>n+e.playedMs,0)!==data.expected.playedMs ||
      new Set(data.events.map(e=>`${e.source}\n${e.id}`)).size!==data.events.length) throw new Error('export verification failed; use the project export tool');
    let inserted=0;
    await request('/music/import/start',post(data.expected));
    for(let i=0;i<data.events.length;i+=40) {
      const r=await request('/music/import',post({events:data.events.slice(i,i+40)})); inserted+=r.inserted;
      feedback(`importing ${Math.min(i+40,data.events.length).toLocaleString()} / ${data.events.length.toLocaleString()} listens…`);
    }
    await refresh(); expected=data.expected;
    feedback(`imported ${inserted.toLocaleString()} new listens. duplicates were kept once. enable the website after reviewing the totals.`);
  } catch(e) { feedback(`${e.message}. you can retry the same file safely.`); }
  finally { busy(false); }
});
$('activate').addEventListener('click',async()=>{
  if(!expected) return; busy(true);
  try { await request('/music/activate',post(expected)); await refresh(); feedback('the music page now uses your own history.'); }
  catch(e) { feedback(e.message); }
  finally { busy(false); }
});
$('sync').addEventListener('click',async()=>{
  busy(true);
  try { await request('/music/sync',post({})); feedback('apple recent tracks refreshed. listening totals stay based on play records.'); }
  catch(e) { feedback(e.message); }
  finally { busy(false); }
});
refresh().catch(e=>feedback(e.message));

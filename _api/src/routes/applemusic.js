import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';

// apple music api. dev token = ES256 JWT signed from your .p8, music-user-token = the one-time login.
// catalog/personal data straight from apple, no 3rd party.

const ENC = new TextEncoder();

function b64url(input) {
  const bin = typeof input === 'string' ? input : String.fromCharCode(...input);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToBuf(pem) {
  // strip the -----BEGIN/END----- lines + whitespace, decode the base64 body
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin  = atob(body);
  const buf  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// cached per-isolate so we're not re-signing on every request
let _dev = null; // { jwt, exp }
async function getDevToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_dev && _dev.exp - now > 86400) return _dev.jwt;

  const exp     = now + 150 * 24 * 60 * 60; // ~150d, under apple's 6mo cap
  const header  = b64url(JSON.stringify({ alg: 'ES256', kid: env.APPLE_KEY_ID }));
  const payload = b64url(JSON.stringify({ iss: env.APPLE_TEAM_ID, iat: now, exp }));
  const data    = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuf(env.APPLE_PRIVATE_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  // webcrypto ECDSA already returns raw r||s — exactly what JWS wants
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, ENC.encode(data));
  const jwt = `${data}.${b64url(new Uint8Array(sig))}`;

  _dev = { jwt, exp };
  return jwt;
}

async function getUserToken(env) {
  const kv = env.APPLE_KV ? await env.APPLE_KV.get('apple:user_token') : null;
  return kv || env.APPLE_MUSIC_USER_TOKEN || '';
}

async function appleGet(env, endpoint) {
  if (!env.APPLE_PRIVATE_KEY) return { error: 'no key configured', status: 500 };
  const usr = await getUserToken(env);
  if (!usr) return { error: 'not connected', status: 503 };

  const dev = await getDevToken(env);
  const r = await fetch(`https://api.music.apple.com${endpoint}`, {
    headers: { Authorization: `Bearer ${dev}`, 'Music-User-Token': usr }
  });
  if (!r.ok) return { error: 'apple', status: r.status };
  return r.json();
}

function artURL(art, size = 200) {
  if (!art || !art.url) return '';
  return art.url.replace('{w}', size).replace('{h}', size).replace('{f}', 'jpg');
}

function normTrack(it) {
  const a = it.attributes || {};
  return { name: a.name || '', artist: a.artistName || '', album: a.albumName || '', img: artURL(a.artwork), url: a.url || '' };
}

function normRotation(it) {
  const a = it.attributes || {};
  return { name: a.name || '', artist: a.artistName || '', img: artURL(a.artwork), url: a.url || '', kind: it.type || '' };
}

// thin KV cache so apple isn't hit on every page load
async function cached(env, key, ttl, fn) {
  if (env.APPLE_KV) {
    const hit = await env.APPLE_KV.get(key, 'json');
    if (hit) return hit;
  }
  const fresh = await fn();
  if (env.APPLE_KV && fresh && !fresh.error) {
    await env.APPLE_KV.put(key, JSON.stringify(fresh), { expirationTtl: ttl });
  }
  return fresh;
}

export async function handleApple(request, env, path) {
  const method = request.method;
  const sub    = path.split('/')[2] || '';

  if (method === 'GET' && sub === 'recent') {
    const data = await cached(env, 'apple:cache:recent', 600, async () => {
      const r = await appleGet(env, '/v1/me/recent/played/tracks?limit=25');
      return r.error ? r : { items: (r.data || []).map(normTrack) };
    });
    return json(data, data.error ? (data.status || 502) : 200);
  }

  if (method === 'GET' && sub === 'heavy-rotation') {
    const data = await cached(env, 'apple:cache:heavy', 600, async () => {
      const r = await appleGet(env, '/v1/me/history/heavy-rotation?limit=20');
      return r.error ? r : { items: (r.data || []).map(normRotation) };
    });
    return json(data, data.error ? (data.status || 502) : 200);
  }

  if (method === 'GET' && sub === 'status') {
    const usr = await getUserToken(env);
    return json({ connected: !!usr, hasKey: !!env.APPLE_PRIVATE_KEY });
  }

  // the auth page pulls a dev token to boot MusicKit JS
  if (method === 'GET' && sub === 'devtoken') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    if (!env.APPLE_PRIVATE_KEY) return json({ error: 'no key configured' }, 500);
    return json({ token: await getDevToken(env) });
  }

  // auth page posts the music-user-token here after you log in
  if (method === 'POST' && sub === 'token') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    if (!env.APPLE_KV) return json({ error: 'no kv bound' }, 500);
    const { token } = await request.json().catch(() => ({}));
    if (!token) return json({ error: 'missing token' }, 400);
    await env.APPLE_KV.put('apple:user_token', token);
    // bust caches so fresh data shows up right away
    await env.APPLE_KV.delete('apple:cache:recent');
    await env.APPLE_KV.delete('apple:cache:heavy');
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

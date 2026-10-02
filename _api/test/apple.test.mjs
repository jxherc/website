import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleApple } from '../src/routes/applemusic.js';
import { makeToken } from '../src/lib/auth.js';

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
// Generate fresh PKCS#8 key data for each run; no stored credentials.
const pem = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
const config = { TOKEN_SECRET: 'example', APPLE_KEY_ID: 'TESTKEY001', APPLE_TEAM_ID: 'TESTTEAM01', APPLE_PRIVATE_KEY: pem };

function kv(initial = {}) {
  const values = new Map(Object.entries(initial));
  const deleted = [];
  return {
    values, deleted,
    async get(key, type) {
      const value = values.get(key) ?? null;
      return type === 'json' && value !== null ? JSON.parse(value) : value;
    },
    async put(key, value) { values.set(key, value); },
    async delete(key) { deleted.push(key); values.delete(key); }
  };
}

async function call(path, env, { method = 'GET', body, admin = false } = {}) {
  const headers = new Headers();
  if (admin) headers.set('Authorization', `Bearer ${await makeToken(env)}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`https://local.test${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const response = await handleApple(request, env, path);
  return { status: response.status, data: await response.json() };
}

test('developer token includes both Apple IDs, a valid signature and reuses its cache', async t => {
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  let imports = 0;
  t.mock.method(crypto.subtle, 'importKey', (...args) => {
    if (args[0] === 'pkcs8') imports++;
    return original(...args);
  });
  const first = await call('/apple/devtoken', config, { admin: true });
  assert.equal(first.status, 200);
  const [header, payload, signature] = first.data.token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: config.APPLE_KEY_ID });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, config.APPLE_TEAM_ID);
  assert.equal(claims.exp - claims.iat, 150 * 24 * 60 * 60);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${payload}`)), true);
  const second = await call('/apple/devtoken', config, { admin: true });
  assert.equal(second.data.token, first.data.token);
  assert.equal(imports, 1);
});

test('missing and placeholder config cannot reuse a previously cached developer token', async () => {
  for (const name of ['APPLE_KEY_ID', 'APPLE_TEAM_ID', 'APPLE_PRIVATE_KEY']) {
    const env = { ...config };
    delete env[name];
    const result = await call('/apple/devtoken', env, { admin: true });
    assert.equal(result.status, 503);
    assert.match(result.data.error, new RegExp(name));
    assert.equal(result.data.token, undefined);
  }
  for (const name of ['APPLE_KEY_ID', 'APPLE_TEAM_ID']) {
    const result = await call('/apple/devtoken', { ...config, [name]: `REPLACE_WITH_${name}` }, { admin: true });
    assert.equal(result.status, 503);
    assert.match(result.data.error, new RegExp(name));
  }
});

test('invalid private keys return a controlled configuration error', async () => {
  const result = await call('/apple/devtoken', { ...config, APPLE_PRIVATE_KEY: 'invalid' }, { admin: true });
  assert.deepEqual(result, { status: 503, data: { error: 'invalid APPLE_PRIVATE_KEY' } });
});

test('changing signing config does not reuse the old developer token', async () => {
  const result = await call('/apple/devtoken', { ...config, APPLE_KEY_ID: 'TESTKEY002', APPLE_TEAM_ID: 'TESTTEAM02' }, { admin: true });
  assert.equal(result.status, 200);
  const [header, payload] = result.data.token.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).kid, 'TESTKEY002');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, 'TESTTEAM02');
});

test('developer tokens and relinking require admin auth before configuration errors', async () => {
  assert.equal((await call('/apple/devtoken', {})).status, 401);
  assert.equal((await call('/apple/token', {}, { method: 'POST', body: '{}' })).status, 401);
});

test('relink replaces the user token and invalidates both response caches', async () => {
  const store = kv({ 'apple:user_token': 'old-token', 'apple:cache:recent': '{}', 'apple:cache:heavy': '{}' });
  const result = await call('/apple/token', { ...config, APPLE_KV: store },
    { admin: true, method: 'POST', body: JSON.stringify({ token: 'new' }) });
  assert.deepEqual(result, { status: 200, data: { ok: true } });
  assert.equal(store.values.get('apple:user_token'), 'new');
  assert.deepEqual(store.deleted, ['apple:cache:recent', 'apple:cache:heavy']);
  assert.equal(store.values.has('apple:cache:recent'), false);
  assert.equal(store.values.has('apple:cache:heavy'), false);
});

test('relink rejects non-string, empty, whitespace and malformed JSON without writes', async () => {
  const store = kv({ 'apple:user_token': 'keep-token' });
  const env = { ...config, APPLE_KV: store };
  const bodies = ['null', '{}', '[]', '{', ...[null, 1, true, {}, [], '', ' ', ' token', 'token\n'].map(token => JSON.stringify({ token }))];
  for (const body of bodies) {
    assert.deepEqual(await call('/apple/token', env, { admin: true, method: 'POST', body }),
      { status: 400, data: { error: 'invalid token' } });
  }
  assert.equal(store.values.get('apple:user_token'), 'keep-token');
  assert.deepEqual(store.deleted, []);
});

test('relink reports missing KV and storage failure without leaking submitted tokens', async () => {
  const options = { admin: true, method: 'POST', body: JSON.stringify({ token: 'private' }) };
  assert.deepEqual(await call('/apple/token', config, options), { status: 503, data: { error: 'configure APPLE_KV' } });
  const store = kv();
  store.put = async () => { throw new Error('private: storage failure'); };
  assert.deepEqual(await call('/apple/token', { ...config, APPLE_KV: store }, options),
    { status: 502, data: { error: 'apple unavailable' } });
});

test('status distinguishes configured service and persisted reconnect support', async () => {
  assert.deepEqual((await call('/apple/status', { ...config, APPLE_KV: kv({ 'apple:user_token': 'user-token' }) })).data,
    { connected: true, hasKey: true, configured: true, canRelink: true });
  assert.deepEqual((await call('/apple/status', { ...config, APPLE_MUSIC_USER_TOKEN: 'legacy' })).data,
    { connected: true, hasKey: true, configured: true, canRelink: false });
  assert.equal((await call('/apple/status', { APPLE_PRIVATE_KEY: pem })).data.configured, false);
});

test('Apple recent data uses the relinked token and caches a successful response', async t => {
  const store = kv({ 'apple:user_token': 'new' });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    assert.match(url, /\/v1\/me\/recent\/played\/tracks/);
    assert.equal(options.headers['Music-User-Token'], 'new');
    assert.match(options.headers.Authorization, /^Bearer /);
    return Response.json({ data: [{ attributes: { name: 'song', artistName: 'artist', albumName: 'album', artwork: { url: 'https://art.test/{w}x{h}.{f}' } } }] });
  });
  const first = await call('/apple/recent', { ...config, APPLE_KV: store });
  assert.deepEqual(first, { status: 200, data: { items: [{ name: 'song', artist: 'artist', album: 'album', img: 'https://art.test/200x200.jpg', url: '' }] } });
  assert.deepEqual(await call('/apple/recent', { ...config, APPLE_KV: store }), first);
  assert.equal(requests, 1);
});

test('Apple errors do not enter response cache; retries can recover', async t => {
  const store = kv({ 'apple:user_token': 'user-token' });
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => ++attempts === 1 ? new Response('', { status: 401 }) : Response.json({ data: [] }));
  const env = { ...config, APPLE_KV: store };
  assert.deepEqual(await call('/apple/heavy-rotation', env), { status: 401, data: { error: 'apple', status: 401 } });
  assert.equal(store.values.has('apple:cache:heavy'), false);
  assert.deepEqual(await call('/apple/heavy-rotation', env), { status: 200, data: { items: [] } });
  assert.equal(attempts, 2);
});

test('Apple requests handle missing connection and upstream network failure', async t => {
  assert.deepEqual(await call('/apple/recent', config), { status: 503, data: { error: 'not connected', status: 503 } });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network failure'); });
  assert.deepEqual(await call('/apple/recent', { ...config, APPLE_MUSIC_USER_TOKEN: 'example' }),
    { status: 502, data: { error: 'apple unavailable' } });
});

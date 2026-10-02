import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './fixtures.mjs';
import { handlePosts } from '../src/routes/posts.js';
import { handleBookmarks } from '../src/routes/bookmarks.js';
import { handlePhotos } from '../src/routes/photos.js';
import { handleDiscord } from '../src/routes/discord.js';
import { makeToken } from '../src/lib/auth.js';
import { readCollection } from '../src/lib/storage.js';

class MemoryKV {
  constructor() { this.values = new Map(); this.listCalls = []; this.getCalls = []; }
  async get(key, type) {
    this.getCalls.push(key);
    if (Array.isArray(key)) { assert.ok(key.length <= 100); return new Map(key.map(k => [k, this.decode(k, type)])); }
    return this.decode(key, type);
  }
  decode(key, type) { const value = this.values.get(key); return value == null ? null : type === 'json' ? JSON.parse(value) : value; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async list(options = {}) {
    this.listCalls.push(options);
    const keys = [...this.values.keys()].filter(key => key.startsWith(options.prefix || '')).sort();
    const start = Number(options.cursor || 0);
    const end = start + 1000;
    return { keys: keys.slice(start, end).map(name => ({ name })), list_complete: end >= keys.length, cursor: String(end) };
  }
}
function environment() {
  const objects = new Map();
  return { TOKEN_SECRET: 'example', POSTS_KV: new MemoryKV(), BOOKMARKS_KV: new MemoryKV(), PHOTOS_KV: new MemoryKV(),
    PHOTOS_R2: { objects, async put(key, data, options) { objects.set(key, { body: data, httpMetadata: options.httpMetadata }); }, async get(key) { return objects.get(key) || null; }, async delete(key) { objects.delete(key); } } };
}
async function authHeaders(env) { return { Authorization: `Bearer ${await makeToken(env)}` }; }
function req(path, options = {}) { return new Request(`https://fixture.test${path}`, options); }
async function upload(env, data, name, type = 'image/jpeg', options = {}) {
  const form = new FormData(); form.set('file', new File([data], name, { type })); form.set('caption', 'fixture');
  return handlePhotos(req('/photos', { method: 'POST', headers: options.unauthorized ? {} : await authHeaders(env), body: form }), env, '/photos');
}
const fixture = async name => Buffer.from(fixtures[name], 'base64');

test('oversized bulk responses fall back to smaller reads and preserve every record', async () => {
  const store = new MemoryKV();
  for (let i = 0; i < 5; i++) await store.put(`post:${i}`, JSON.stringify({ id: String(i) }));
  const get = store.get.bind(store);
  let oversized = 0;
  store.get = async (keys, type) => {
    if (Array.isArray(keys) && keys.length > 2) { oversized++; throw new Error('KV response too large'); }
    return get(keys, type);
  };
  assert.deepEqual((await readCollection(store, 'post:')).map(row => row.id), ['0', '1', '2', '3', '4']);
  assert.ok(oversized > 0);
  store.get = async (keys, type) => {
    if (Array.isArray(keys)) throw new Error('KV response too large');
    return get(keys, type);
  };
  assert.equal((await readCollection(store, 'post:')).length, 5);
});

test('unavailable individual values fail rather than return a partial collection', async () => {
  const store = new MemoryKV();
  await store.put('post:one', '{}');
  store.get = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(readCollection(store, 'post:'), /storage unavailable/);
});

for (const [name, handler, binding, prefix] of [['posts', handlePosts, 'POSTS_KV', 'post:'], ['bookmarks', handleBookmarks, 'BOOKMARKS_KV', 'bm:'], ['photos', handlePhotos, 'PHOTOS_KV', 'photo:']]) {
  test(`${name} includes all pages and preserves ordering`, async () => {
    const env = environment();
    for (let i = 0; i < 1001; i++) await env[binding].put(`${prefix}${String(1700000000000 + i)}`, JSON.stringify({ id: `${1700000000000 + i}`, order: 1000 - i }));
    const response = await handler(req(`/${name}`), env, `/${name}`);
    const rows = await response.json();
    assert.equal(rows.length, 1001);
    assert.equal(rows[0].id, '1700000001000');
    assert.equal(rows.at(-1).id, '1700000000000');
    assert.equal(env[binding].listCalls.length, 2);
    assert.equal(env[binding].getCalls.length, 11);
    assert.ok(env[binding].getCalls.every(keys => Array.isArray(keys) && keys.length <= 100));
    assert.equal(env[binding].listCalls[1].prefix, prefix);
  });
  test(`${name} continues through an empty intermediate KV page`, async () => {
    const env = environment();
    let calls = 0;
    env[binding].list = async options => ++calls === 1 ? { keys: [], list_complete: false, cursor: 'next' } : { keys: [{ name: `${prefix}old` }], list_complete: true, cursor: '' };
    await env[binding].put(`${prefix}old`, JSON.stringify({ id: 'old', order: 0 }));
    const response = await handler(req(`/${name}`), env, `/${name}`);
    assert.deepEqual(await response.json(), [{ id: 'old', order: 0 }]);
    assert.equal(calls, 2);
  });
  test(`${name} rejects unauthorized creation/deletion without mutations`, async () => {
    const env = environment();
    for (const method of ['POST', 'DELETE']) {
      const path = method === 'DELETE' ? `/${name}/1700000000000` : `/${name}`;
      const response = await handler(req(path, { method }), env, path);
      assert.equal(response.status, 401);
    }
    assert.equal(env[binding].values.size, 0);
  });
  test(`${name} deletion accepts legacy timestamp ids`, async () => {
    const env = environment(); const id = '1700000000000';
    await env[binding].put(`${prefix}${id}`, JSON.stringify({ id, key: 'legacy.jpg' }));
    env.PHOTOS_R2.objects.set('legacy.jpg', { body: new Uint8Array([1]) });
    const path = `/${name}/${id}`;
    const response = await handler(req(path, { method: 'DELETE', headers: await authHeaders(env) }), env, path);
    assert.equal(response.status, 200); assert.equal(env[binding].values.size, 0);
    if (name === 'photos') assert.equal(env.PHOTOS_R2.objects.size, 0);
  });
}
for (const [name, handler, binding, data] of [['posts', handlePosts, 'POSTS_KV', { body: 'fixture' }], ['bookmarks', handleBookmarks, 'BOOKMARKS_KV', { url: 'https://example.test', label: 'fixture' }]]) {
  test(`${name} concurrent creates in one millisecond retain both records and new ids delete`, async () => {
    const env = environment(); const headers = { ...await authHeaders(env), 'Content-Type': 'application/json' };
    const originalNow = Date.now; Date.now = () => 1790960000000;
    let responses;
    try { responses = await Promise.all([1, 2].map(i => handler(req(`/${name}`, { method: 'POST', headers, body: JSON.stringify({ ...data, title: `record ${i}` }) }), env, `/${name}`))); }
    finally { Date.now = originalNow; }
    assert.ok(responses.every(r => r.status === 201));
    const rows = await Promise.all(responses.map(r => r.json()));
    assert.notEqual(rows[0].id, rows[1].id); assert.equal(env[binding].values.size, 2);
    for (const row of rows) { const path = `/${name}/${row.id}`; assert.equal((await handler(req(path, { method: 'DELETE', headers }), env, path)).status, 200); }
    assert.equal(env[binding].values.size, 0);
  });
}
for (const name of ['camera.jpg', 'camera-little.jpg']) test(`${name} camera and EXIF sub-IFD metadata survive upload`, async () => {
  const env = environment(); const response = await upload(env, await fixture(name), name);
  assert.equal(response.status, 201);
  const photo = await response.json();
  assert.deepEqual(photo.exif, { device: 'Fixture Camera', aperture: 'f/1.8', shutter: '1/125s', iso: 'ISO 200', focalLength: '26mm', takenAt: '2026-10-02T12:34:56' });
});

test('EXIF tags with the wrong value type cannot crash photo formatting', async () => {
  for (const tag of [0x829d, 0x0132]) {
    const bytes = Buffer.from(await fixture('inline.jpg'));
    const entry = bytes.indexOf(Buffer.from([0x01, 0x0f, 0x00, 0x02]));
    assert.ok(entry > 0);
    bytes.writeUInt16BE(tag, entry);
    if (tag === 0x0132) {
      bytes.writeUInt16BE(3, entry + 2);
      bytes.writeUInt32BE(1, entry + 4);
    }
    const response = await upload(environment(), bytes, 'wrong-tag-type.jpg');
    assert.equal(response.status, 201);
    const photo = await response.json();
    assert.equal(photo.exif.aperture, undefined);
    assert.equal(photo.exif.takenAt, '2026-10-02T01:02:03');
  }
});

test('AVIF compatible brands determine the served MIME type', async () => {
  const bytes = Buffer.from(await fixture('plain.avif'));
  bytes.write('mif1', 8);
  const env = environment();
  const response = await upload(env, bytes, 'compatible.avif', 'image/heif');
  assert.equal(response.status, 201);
  const photo = await response.json();
  const image = await handlePhotos(req(photo.url), env, photo.url);
  assert.equal(image.headers.get('Content-Type'), 'image/avif');
  const truncated = bytes.subarray(0, 20);
  assert.equal((await upload(environment(), truncated, 'truncated.avif')).status, 400);
});
for (const [name, type] of [['plain.jpg', 'image/jpeg'], ['plain.png', 'image/png'], ['plain.webp', 'image/webp'], ['plain.gif', 'image/gif'], ['plain.avif', 'image/avif']]) {
  test(`${type} without EXIF uploads and serves correctly`, async () => {
    const env = environment(); const response = await upload(env, await fixture(name), name, type);
    assert.equal(response.status, 201); const photo = await response.json(); assert.deepEqual(photo.exif, {});
    const served = await handlePhotos(req(photo.url), env, photo.url);
    assert.equal(served.status, 200); assert.equal(served.headers.get('Content-Type'), type);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), await fixture(name));
  });
}
test('photo simultaneous uploads with identical names retain both objects and records', async () => {
  const env = environment(); const data = await fixture('plain.jpg'); const headers = await authHeaders(env);
  function request() { const body = new FormData(); body.set('file', new File([data], 'same.jpg', { type: 'image/jpeg' })); return req('/photos', { method: 'POST', headers, body }); }
  const requests = [request(), request()]; const originalNow = Date.now; Date.now = () => 1790960000000;
  let responses;
  try { responses = await Promise.all(requests.map(r => handlePhotos(r, env, '/photos'))); } finally { Date.now = originalNow; }
  const rows = await Promise.all(responses.map(r => r.json())); assert.ok(responses.every(r => r.status === 201));
  assert.notEqual(rows[0].id, rows[1].id); assert.notEqual(rows[0].key, rows[1].key);
  assert.equal(env.PHOTOS_KV.values.size, 2); assert.equal(env.PHOTOS_R2.objects.size, 2);
  for (const row of rows) await handlePhotos(req(`/photos/${row.id}`, { method: 'DELETE', headers }), env, `/photos/${row.id}`);
  assert.equal(env.PHOTOS_KV.values.size, 0); assert.equal(env.PHOTOS_R2.objects.size, 0);
});
test('missing, non-file, empty, tiny, and non-image photo inputs return 400 without writes', async () => {
  for (const data of [new Uint8Array(), new Uint8Array([0]), new TextEncoder().encode('<html>not an image</html>')]) {
    const env = environment(); const response = await upload(env, data, 'bad.jpg');
    assert.equal(response.status, 400); assert.equal(env.PHOTOS_KV.values.size, 0); assert.equal(env.PHOTOS_R2.objects.size, 0);
  }
  for (const nonFile of [null, 'text']) {
    const env = environment(); const body = new FormData(); if (nonFile) body.set('file', nonFile);
    const response = await handlePhotos(req('/photos', { method: 'POST', headers: await authHeaders(env), body }), env, '/photos');
    assert.equal(response.status, 400);
  }
});
test('malformed EXIF cannot crash or prevent an otherwise readable JPEG upload', async () => {
  const env = environment(); const jpeg = Buffer.from(await fixture('camera.jpg'));
  const offset = jpeg.indexOf(Buffer.from('Exif\0\0'));
  assert.ok(offset > 0); jpeg.fill(0xff, offset + 10, offset + 14);
  const response = await upload(env, jpeg, 'bad-exif.jpg'); assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).exif, {});
});
test('Discord signed concurrent posts retain independent ids', async () => {
  const env = environment(); const keypair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  env.DISCORD_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', keypair.publicKey)).toString('hex');
  const signed = async text => { const body = JSON.stringify({ type: 2, data: { name: 'post', options: [{ value: text }] } }); const timestamp = '1790960000'; const signature = await crypto.subtle.sign('Ed25519', keypair.privateKey, new TextEncoder().encode(timestamp + body)); return req('/discord', { method: 'POST', headers: { 'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': Buffer.from(signature).toString('hex') }, body }); };
  const requests = await Promise.all([signed('first'), signed('second')]);
  // Cloudflare supports this legacy alias; Node only accepts the standard algorithm name.
  const subtle = crypto.subtle; const importKey = subtle.importKey; const verify = subtle.verify;
  subtle.importKey = function(format, data, algorithm, ...rest) { return importKey.call(this, format, data, algorithm.name === 'NODE-ED25519' ? { name: 'Ed25519' } : algorithm, ...rest); };
  subtle.verify = function(algorithm, ...rest) { return verify.call(this, algorithm === 'NODE-ED25519' ? 'Ed25519' : algorithm, ...rest); };
  const originalNow = Date.now; Date.now = () => 1790960000000;
  try { const responses = await Promise.all(requests.map(r => handleDiscord(r, env))); assert.ok(responses.every(r => r.status === 200)); }
  finally { Date.now = originalNow; subtle.importKey = importKey; subtle.verify = verify; }
  const rows = [...env.POSTS_KV.values.values()].map(JSON.parse); assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
  assert.equal((await handleDiscord(req('/discord', { method: 'POST', body: '{}' }), env)).status, 401);
});

test('inline TIFF strings and IFD0 date are read', async () => {
  const env = environment(); const response = await upload(env, await fixture('inline.jpg'), 'inline.jpg');
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).exif, { device: 'AB XYZ', takenAt: '2026-10-02T01:02:03' });
});
test('XMP APP1 before EXIF does not hide camera metadata', async () => {
  const env = environment(); const jpeg = await fixture('camera.jpg');
  const xmp = Buffer.from('http://ns.adobe.com/xap/1.0/\0<xml/>');
  const marker = Buffer.alloc(4); marker.writeUInt16BE(0xffe1); marker.writeUInt16BE(xmp.length + 2, 2);
  const response = await upload(env, Buffer.concat([jpeg.subarray(0, 2), marker, xmp, jpeg.subarray(2)]), 'xmp.jpg');
  assert.equal(response.status, 201); assert.equal((await response.json()).exif.device, 'Fixture Camera');
});
test('out-of-bounds APP1 metadata does not crash upload', async () => {
  const env = environment(); const jpeg = Buffer.from(await fixture('camera.jpg'));
  const offset = jpeg.indexOf(Buffer.from([0xff, 0xe1])); assert.ok(offset > 0);
  jpeg.writeUInt16BE(0xffff, offset + 2);
  const response = await upload(env, jpeg, 'truncated-metadata.jpg');
  assert.equal(response.status, 201); assert.deepEqual((await response.json()).exif, {});
});
test('detected image content type wins over a missing upload MIME type', async () => {
  const env = environment(); const response = await upload(env, await fixture('plain.png'), 'image.png', '');
  assert.equal(response.status, 201); const photo = await response.json();
  assert.equal(env.PHOTOS_R2.objects.get(photo.key).httpMetadata.contentType, 'image/png');
});
for (const [name, handler, binding, prefix] of [['posts', handlePosts, 'POSTS_KV', 'post:'], ['bookmarks', handleBookmarks, 'BOOKMARKS_KV', 'bm:'], ['photos', handlePhotos, 'PHOTOS_KV', 'photo:']]) {
  test(`${name} empty and expired/deleted KV records return an empty list`, async () => {
    const env = environment();
    assert.deepEqual(await (await handler(req(`/${name}`), env, `/${name}`)).json(), []);
    assert.equal(env[binding].getCalls.length, 0);
    env[binding].list = async () => ({ keys: [{ name: `${prefix}gone` }], list_complete: true, cursor: '' });
    assert.deepEqual(await (await handler(req(`/${name}`), env, `/${name}`)).json(), []);
  });
}

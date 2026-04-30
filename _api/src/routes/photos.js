import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';

function parseExif(buffer) {
  const view = new DataView(buffer);
  const exif  = {};
  let offset  = 2;

  if (view.getUint16(0) !== 0xFFD8) return exif;

  while (offset < view.byteLength - 2) {
    const marker = view.getUint16(offset);
    offset += 2;
    if (marker === 0xFFE1) {
      const segLen = view.getUint16(offset);
      const seg    = new DataView(buffer, offset + 2, segLen - 2);
      parseIfd(seg, exif);
      break;
    }
    if ((marker & 0xFF00) !== 0xFF00) break;
    offset += view.getUint16(offset);
  }
  return exif;
}

function parseIfd(seg, exif) {
  try {
    const id = seg.getUint32(0);
    if (id !== 0x45786966) return;
    const little = seg.getUint16(6) === 0x4949;
    const get16  = o => seg.getUint16(o, little);
    const get32  = o => seg.getUint32(o, little);
    const getString = (o, len) => {
      let s = '';
      for (let i = 0; i < len - 1; i++) {
        const c = seg.getUint8(o + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    };
    const getRational = o => {
      const n = get32(o), d = get32(o + 4);
      return d ? n / d : 0;
    };

    const tags = {
      0x010F: 'make',    0x0110: 'model',
      0x829A: 'exposure', 0x829D: 'fNumber',
      0x8827: 'iso',      0x920A: 'focalLength',
      0x9003: 'dateTime',
    };

    const ifdOffset = 8 + get32(8);
    const count     = get16(ifdOffset);

    for (let i = 0; i < count; i++) {
      const e  = ifdOffset + 2 + i * 12;
      const tag = get16(e);
      const typ = get16(e + 2);
      const cnt = get32(e + 4);
      const off = e + 8;

      if (!tags[tag]) continue;
      const name = tags[tag];

      if (typ === 2) {
        const dataOff = cnt > 4 ? get32(off) + 8 : off;
        exif[name] = getString(dataOff, cnt);
      } else if (typ === 3) {
        exif[name] = get16(off);
      } else if (typ === 5) {
        const dataOff = get32(off) + 8;
        exif[name] = getRational(dataOff);
      }
    }
  } catch { /* skip malformed EXIF */ }
}

function formatExif(raw) {
  const out = {};
  if (raw.make || raw.model) {
    out.device = [raw.make, raw.model].filter(Boolean).join(' ').replace(/apple /i, '');
  }
  if (raw.fNumber)    out.aperture    = `f/${raw.fNumber.toFixed(1)}`;
  if (raw.exposure)   out.shutter     = raw.exposure < 1 ? `1/${Math.round(1/raw.exposure)}s` : `${raw.exposure}s`;
  if (raw.iso)        out.iso         = `ISO ${raw.iso}`;
  if (raw.focalLength) out.focalLength = `${Math.round(raw.focalLength)}mm`;
  if (raw.dateTime)   out.takenAt     = raw.dateTime.replace(':', '-').replace(':', '-').replace(' ', 'T');
  return out;
}

export async function handlePhotos(request, env, path) {
  const method = request.method;
  const id     = path.split('/')[2] || null;

  if (method === 'GET') {
    const list = await env.PHOTOS_KV.list({ prefix: 'photo:' });
    const items = await Promise.all(
      list.keys
        .sort((a, b) => (a.metadata?.order ?? 999) - (b.metadata?.order ?? 999))
        .map(k => env.PHOTOS_KV.get(k.name, 'json'))
    );
    return json(items.filter(Boolean));
  }

  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (method === 'POST') {
    const formData = await request.formData().catch(() => null);
    if (!formData) return json({ error: 'expected multipart/form-data' }, 400);

    const file    = formData.get('file');
    const caption = String(formData.get('caption') || '').trim();
    if (!file) return json({ error: 'file required' }, 400);

    const buf     = await file.arrayBuffer();
    const rawExif = parseExif(buf);
    const exif    = formatExif(rawExif);

    const ts  = Date.now();
    const key = `photo-${ts}-${file.name.replace(/[^a-z0-9._-]/gi, '_')}`;

    await env.PHOTOS_R2.put(key, buf, {
      httpMetadata: { contentType: file.type || 'image/jpeg' }
    });

    const photo = {
      id:      `${ts}`,
      key,
      caption,
      exif,
      url:     `/photos/${key}`,
      order:   ts,
      date:    new Date(ts).toISOString(),
    };
    await env.PHOTOS_KV.put(`photo:${ts}`, JSON.stringify(photo));
    return json(photo, 201);
  }

  if (method === 'GET' && path.startsWith('/photos/')) {
    const key = path.slice('/photos/'.length);
    const obj = await env.PHOTOS_R2.get(key);
    if (!obj) return new Response('not found', { status: 404 });
    return new Response(obj.body, {
      headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg' }
    });
  }

  if (method === 'DELETE' && id) {
    const photo = await env.PHOTOS_KV.get(`photo:${id}`, 'json');
    if (photo?.key) await env.PHOTOS_R2.delete(photo.key);
    await env.PHOTOS_KV.delete(`photo:${id}`);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

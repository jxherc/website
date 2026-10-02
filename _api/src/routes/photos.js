import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';
import { readCollection, recordId } from '../lib/storage.js';

function imageType(buffer) {
  const bytes = new Uint8Array(buffer);
  const matches = (offset, signature) => signature.every((byte, i) => bytes[offset + i] === byte);
  if (bytes.length >= 4 && matches(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matches(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  const text = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'image/gif';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 16 && text(4, 8) === 'ftyp') {
    const length = new DataView(buffer).getUint32(0);
    if (length < 16 || length > bytes.length) return '';
    const brands = [text(8, 12)];
    for (let offset = 16; offset + 4 <= length; offset += 4) brands.push(text(offset, offset + 4));
    if (brands.some(brand => ['avif', 'avis'].includes(brand))) return 'image/avif';
    if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx'].includes(brand))) return 'image/heic';
    if (brands.some(brand => ['mif1', 'msf1'].includes(brand))) return 'image/heif';
  }
  return '';
}

function parseExif(buffer) {
  const view = new DataView(buffer);
  const exif = {};
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return exif;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset++;
    if (offset >= view.byteLength) break;
    const marker = view.getUint8(offset++);
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > view.byteLength) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > view.byteLength) break;
    if (marker === 0xe1 && length >= 8) {
      const segment = new DataView(buffer, offset + 2, length - 2);
      if (segment.getUint32(0) === 0x45786966 && segment.getUint16(4) === 0) {
        parseIfd(segment, exif);
        break;
      }
    }
    offset += length;
  }
  return exif;
}

function parseIfd(segment, exif) {
  try {
    // All TIFF pointers are relative to the byte after Exif\0\0.
    const origin = 6;
    if (segment.byteLength < origin + 8) return;
    const byteOrder = segment.getUint16(origin);
    if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return;
    const little = byteOrder === 0x4949;
    const get16 = offset => segment.getUint16(offset, little);
    const get32 = offset => segment.getUint32(offset, little);
    if (get16(origin + 2) !== 42) return;
    const tags = {
      0x010f: 'make', 0x0110: 'model', 0x0132: 'dateTime',
      0x829a: 'exposure', 0x829d: 'fNumber', 0x8827: 'iso',
      0x920a: 'focalLength', 0x9003: 'dateTime',
    };
    const seen = new Set();
    const readIfd = (offset, followExif = true) => {
      if (seen.has(offset) || offset < origin + 8 || offset + 2 > segment.byteLength) return;
      seen.add(offset);
      const count = get16(offset);
      if (offset + 2 + count * 12 > segment.byteLength) return;
      for (let i = 0; i < count; i++) {
        const entry = offset + 2 + i * 12;
        const tag = get16(entry);
        const type = get16(entry + 2);
        const size = get32(entry + 4);
        const value = entry + 8;
        if (tag === 0x8769 && type === 4 && size === 1 && followExif) {
          readIfd(origin + get32(value), false);
          continue;
        }
        if (!tags[tag] || !size || (tag === 0x0132 && exif.dateTime)) continue;
        if (type === 2 && [0x010f, 0x0110, 0x0132, 0x9003].includes(tag)) {
          const data = size > 4 ? origin + get32(value) : value;
          if (data < origin || data + size > segment.byteLength) continue;
          let text = '';
          for (let n = 0; n < size; n++) {
            const char = segment.getUint8(data + n);
            if (!char) break;
            text += String.fromCharCode(char);
          }
          exif[tags[tag]] = text.trim();
        } else if (type === 3 && size === 1 && tag === 0x8827) {
          exif[tags[tag]] = get16(value);
        } else if (type === 5 && size === 1 && [0x829a, 0x829d, 0x920a].includes(tag)) {
          const data = origin + get32(value);
          if (data < origin || data + 8 > segment.byteLength) continue;
          const denominator = get32(data + 4);
          if (denominator) exif[tags[tag]] = get32(data) / denominator;
        }
      }
    };
    readIfd(origin + get32(origin + 4));
  } catch { /* metadata can be malformed even when the image itself is readable */ }
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
    // serve a single object: /photos/<key>  (must come before the gallery list,
    // otherwise this branch swallows it and returns json for the <img> src)
    if (path.startsWith('/photos/')) {
      const key = path.slice('/photos/'.length);
      const obj = await env.PHOTOS_R2.get(key);
      if (!obj) return new Response('not found', { status: 404 });
      return new Response(obj.body, {
        headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg' }
      });
    }

    // bare /photos → gallery list
    const items = await readCollection(env.PHOTOS_KV, 'photo:');
    return json(items.sort((a, b) => (a.order ?? 999) - (b.order ?? 999)));
  }

  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (method === 'POST') {
    const formData = await request.formData().catch(() => null);
    if (!formData) return json({ error: 'expected multipart/form-data' }, 400);

    const file    = formData.get('file');
    const caption = String(formData.get('caption') || '').trim();
    if (!file || typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string') {
      return json({ error: 'image file required' }, 400);
    }

    const buf     = await file.arrayBuffer();
    const contentType = imageType(buf);
    if (!contentType) return json({ error: 'unsupported or invalid image' }, 400);
    const rawExif = parseExif(buf);
    const exif    = formatExif(rawExif);

    const ts  = Date.now();
    const photoId = recordId(ts);
    const key = `photo-${photoId}-${file.name.replace(/[^a-z0-9._-]/gi, '_')}`;

    await env.PHOTOS_R2.put(key, buf, {
      httpMetadata: { contentType }
    });

    const photo = {
      id:      photoId,
      key,
      caption,
      exif,
      url:     `/photos/${key}`,
      order:   ts,
      date:    new Date(ts).toISOString(),
    };
    await env.PHOTOS_KV.put(`photo:${photoId}`, JSON.stringify(photo));
    return json(photo, 201);
  }

  if (method === 'DELETE' && id) {
    const photo = await env.PHOTOS_KV.get(`photo:${id}`, 'json');
    if (photo?.key) await env.PHOTOS_R2.delete(photo.key);
    await env.PHOTOS_KV.delete(`photo:${id}`);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

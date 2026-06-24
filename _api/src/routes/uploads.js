import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';

// lightweight image upload for the shitpost bot — straight to R2, no gallery entry.
// the curated /photos endpoint is separate (it builds exif + a photos.html entry).
export async function handleUploads(request, env) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file) return json({ error: 'file required' }, 400);

  const ts  = Date.now();
  const key = `upload-${ts}-${file.name.replace(/[^a-z0-9._-]/gi, '_')}`;

  await env.PHOTOS_R2.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'image/webp' }
  });

  // full url — bot drops this straight into the post, and /photos/<key> serves it
  const origin = new URL(request.url).origin;
  return json({ url: `${origin}/photos/${key}` }, 201);
}

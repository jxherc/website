import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';
import { readCollection, recordId } from '../lib/storage.js';

export async function handleBookmarks(request, env, path) {
  const method = request.method;
  const id     = path.split('/')[2] || null;

  if (method === 'GET') {
    const items = await readCollection(env.BOOKMARKS_KV, 'bm:');
    return json(items.sort((a, b) => b.id.localeCompare(a.id)));
  }

  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ts   = Date.now();
    const item = {
      id:       recordId(ts),
      url:      String(body.url   || '').trim(),
      label:    String(body.label || '').trim(),
      category: String(body.category || 'link').trim(),
      thumb:    String(body.thumb || '').trim(),
      date:     new Date(ts).toISOString(),
    };
    if (!item.url) return json({ error: 'url required' }, 400);
    await env.BOOKMARKS_KV.put(`bm:${item.id}`, JSON.stringify(item));
    return json(item, 201);
  }

  if (method === 'DELETE' && id) {
    await env.BOOKMARKS_KV.delete(`bm:${id}`);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

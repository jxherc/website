import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';

export async function handleBookmarks(request, env, path) {
  const method = request.method;
  const id     = path.split('/')[2] || null;

  if (method === 'GET') {
    const list = await env.BOOKMARKS_KV.list({ prefix: 'bm:' });
    const items = await Promise.all(
      list.keys
        .sort((a, b) => b.name.localeCompare(a.name))
        .map(k => env.BOOKMARKS_KV.get(k.name, 'json'))
    );
    return json(items.filter(Boolean));
  }

  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ts   = Date.now();
    const item = {
      id:       `${ts}`,
      url:      String(body.url   || '').trim(),
      label:    String(body.label || '').trim(),
      category: String(body.category || 'link').trim(),
      thumb:    String(body.thumb || '').trim(),
      date:     new Date(ts).toISOString(),
    };
    if (!item.url) return json({ error: 'url required' }, 400);
    await env.BOOKMARKS_KV.put(`bm:${ts}`, JSON.stringify(item));
    return json(item, 201);
  }

  if (method === 'DELETE' && id) {
    await env.BOOKMARKS_KV.delete(`bm:${id}`);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

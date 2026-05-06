import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';

export async function handleGuestbook(request, env, path) {
  const method = request.method;
  const id     = path.split('/')[2] || null;

  if (method === 'GET') {
    const wantsAll = new URL(request.url).searchParams.get('all') === '1';
    if (wantsAll) {
      const denied = await requireAuth(request, env);
      if (denied) return denied;
    }
    const list  = await env.GUESTBOOK_KV.list({ prefix: 'gb:' });
    const items = await Promise.all(
      list.keys
        .sort((a, b) => b.name.localeCompare(a.name))
        .map(k => env.GUESTBOOK_KV.get(k.name, 'json'))
    );
    const entries = items.filter(Boolean).filter(e => wantsAll || e.approved);
    return json({ entries });
  }

  if (method === 'POST') {
    const body    = await request.json().catch(() => ({}));
    const name    = String(body.name    || '').trim().slice(0, 60);
    const message = String(body.message || '').trim().slice(0, 500);
    if (!name || !message) return json({ error: 'name and message required' }, 400);
    const ts   = Date.now();
    const entry = { id: `${ts}`, name, message, approved: false, date: new Date(ts).toISOString() };
    await env.GUESTBOOK_KV.put(`gb:${ts}`, JSON.stringify(entry));
    return json({ ok: true }, 201);
  }

  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (method === 'PUT' && id) {
    const existing = await env.GUESTBOOK_KV.get(`gb:${id}`, 'json');
    if (!existing) return json({ error: 'not found' }, 404);
    const body  = await request.json().catch(() => ({}));
    const entry = { ...existing, ...body, id: existing.id, date: existing.date };
    await env.GUESTBOOK_KV.put(`gb:${id}`, JSON.stringify(entry));
    return json(entry);
  }

  if (method === 'DELETE' && id) {
    await env.GUESTBOOK_KV.delete(`gb:${id}`);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

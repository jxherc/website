import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';

export async function handlePosts(request, env, path) {
  const method = request.method;
  const id     = path.split('/')[2] || null;

  if (method === 'GET') {
    const list = await env.POSTS_KV.list({ prefix: 'post:' });
    const posts = await Promise.all(
      list.keys
        .sort((a, b) => b.name.localeCompare(a.name))
        .map(k => env.POSTS_KV.get(k.name, 'json'))
    );
    return json(posts.filter(Boolean));
  }

  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ts   = Date.now();
    const post = {
      id:   `${ts}`,
      body: String(body.body || '').trim(),
      title: String(body.title || '').trim(),
      date: new Date(ts).toISOString(),
    };

    // images / via come from the discord bot
    const imgs = Array.isArray(body.images) ? body.images.map(String).filter(Boolean) : [];
    if (body.image) post.image = String(body.image);
    if (imgs.length) post.images = imgs;
    if (body.via) post.via = String(body.via);

    // allow image-only posts (no text)
    if (!post.body && !post.image && !imgs.length) return json({ error: 'body or image required' }, 400);

    await env.POSTS_KV.put(`post:${ts}`, JSON.stringify(post));
    return json(post, 201);
  }

  if (method === 'DELETE' && id) {
    await env.POSTS_KV.delete(`post:${id}`);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';
import { readCollection, recordId } from '../lib/storage.js';

export async function handlePosts(request, env, path) {
  const method = request.method;
  const id     = path.split('/')[2] || null;

  if (method === 'GET') {
    const posts = await readCollection(env.POSTS_KV, 'post:');
    return json(posts.sort((a, b) => b.id.localeCompare(a.id)));
  }

  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ts   = Date.now();
    const post = {
      id:   recordId(ts),
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

    await env.POSTS_KV.put(`post:${post.id}`, JSON.stringify(post));
    return json(post, 201);
  }

  if (method === 'DELETE' && id) {
    await env.POSTS_KV.delete(`post:${id}`);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

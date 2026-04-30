import { requireAuth } from '../lib/auth.js';
import { json } from '../lib/json.js';

export async function handleStatus(request, env) {
  if (request.method === 'GET') {
    const status = await env.STATUS_KV.get('status', 'json');
    return json(status || { workingOn: '', vibe: '' });
  }

  if (request.method === 'PUT') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    const status = {
      workingOn: String(body.workingOn || '').trim(),
      vibe:      String(body.vibe      || '').trim(),
      updatedAt: new Date().toISOString(),
    };
    await env.STATUS_KV.put('status', JSON.stringify(status));
    return json(status);
  }

  return json({ error: 'method not allowed' }, 405);
}

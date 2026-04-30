import { hashPassword, makeToken } from '../lib/auth.js';
import { json } from '../lib/json.js';

export async function handleAuth(request, env) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const { password } = await request.json().catch(() => ({}));
  if (!password) return json({ error: 'missing password' }, 400);

  const hash = await hashPassword(password);
  if (hash !== env.ADMIN_PASSWORD_HASH) return json({ error: 'invalid password' }, 401);

  const token = await makeToken(env);
  return json({ token });
}

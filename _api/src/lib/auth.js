const ENC = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', ENC.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  const sig = await crypto.subtle.sign('HMAC', key, ENC.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function makeToken(env) {
  const exp     = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = `exp:${exp}`;
  const sig     = await hmac(env.TOKEN_SECRET, payload);
  return btoa(`${payload}.${sig}`);
}

export async function verifyToken(token, env) {
  try {
    const decoded  = atob(token);
    const lastDot  = decoded.lastIndexOf('.');
    const payload  = decoded.slice(0, lastDot);
    const sig      = decoded.slice(lastDot + 1);
    const expected = await hmac(env.TOKEN_SECRET, payload);
    if (sig !== expected) return false;
    const exp = parseInt(payload.replace('exp:', ''), 10);
    return Date.now() < exp;
  } catch { return false; }
}

export async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await verifyToken(token, env))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }
  return null;
}

export async function hashPassword(password) {
  const buf = await crypto.subtle.digest('SHA-256', ENC.encode(password));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

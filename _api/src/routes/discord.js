import { json } from '../lib/json.js';

async function verifyDiscordSignature(request, env) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp) return false;

  const body    = await request.clone().text();
  const message = timestamp + body;
  const key     = await crypto.subtle.importKey(
    'raw',
    hexToBytes(env.DISCORD_PUBLIC_KEY),
    { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
    false,
    ['verify']
  );
  return crypto.subtle.verify('NODE-ED25519', key, hexToBytes(signature), new TextEncoder().encode(message))
    .catch(() => false);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

export async function handleDiscord(request, env) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const valid = await verifyDiscordSignature(request, env);
  if (!valid) return new Response('invalid signature', { status: 401 });

  const body = await request.json();

  if (body.type === 1) return json({ type: 1 });

  if (body.type === 2 && body.data?.name === 'post') {
    const text = body.data.options?.[0]?.value || '';
    if (!text.trim()) {
      return json({ type: 4, data: { content: 'empty post, nothing happened', flags: 64 } });
    }

    const ts   = Date.now();
    const post = {
      id:    `${ts}`,
      body:  text.trim(),
      title: '',
      date:  new Date(ts).toISOString(),
      via:   'discord',
    };
    await env.POSTS_KV.put(`post:${ts}`, JSON.stringify(post));

    return json({
      type: 4,
      data: { content: 'posted 🗿', flags: 64 }
    });
  }

  return json({ type: 4, data: { content: 'unknown command', flags: 64 } });
}

# jxherc api

Cloudflare Worker powering jxherc.com backend.

## setup

1. Create KV namespaces in Cloudflare dashboard, update IDs in `wrangler.toml`
2. Create R2 bucket named `jxherc-photos`
3. Set Worker secrets:
   ```
   wrangler secret put ADMIN_PASSWORD_HASH
   wrangler secret put TOKEN_SECRET
   wrangler secret put DISCORD_PUBLIC_KEY
   ```
   - `ADMIN_PASSWORD_HASH`: SHA-256 of your password, base64-encoded
   - `TOKEN_SECRET`: any random string (used to sign session tokens)
   - `DISCORD_PUBLIC_KEY`: from Discord developer portal

## generate password hash

```js
// run in browser console or node
const hash = btoa(String.fromCharCode(...new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode('YOUR_PASSWORD'))
)));
console.log(hash);
```

## deploy

```
npm install
npx wrangler deploy
```

## add custom domain

In Cloudflare Workers dashboard → your worker → Settings → Domains → add `api.jxherc.com`

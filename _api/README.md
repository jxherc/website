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
   wrangler secret put GITHUB_TOKEN
   ```
   - `ADMIN_PASSWORD_HASH`: SHA-256 of your password, base64-encoded
   - `TOKEN_SECRET`: any random string (used to sign session tokens)
   - `DISCORD_PUBLIC_KEY`: from Discord developer portal
   - `GITHUB_TOKEN`: PAT with `read:user` scope, for the `/stats.svg` card (add `repo` to count private contributions)

## apple music

Pulls recently-played + heavy-rotation straight from Apple (no 3rd party). Needs a MusicKit key from
the Apple Developer portal.

1. Create the `APPLE_KV` namespace and put its id in `wrangler.toml`:
   ```
   wrangler kv namespace create APPLE_KV
   ```
2. Team ID + Key ID live in `wrangler.toml` `[vars]` (they're not secret — they're inside every JWT).
   The private key is:
   ```
   wrangler secret put APPLE_PRIVATE_KEY   # paste the full .p8 contents incl. the BEGIN/END lines
   ```
3. `wrangler deploy`, then go to `admin.jxherc.com/apple-auth.html` → **connect apple music** (one
   Apple ID login). That stores your music-user-token in KV. Done.

Endpoints: `/apple/recent`, `/apple/heavy-rotation` (public, KV-cached ~10min), `/apple/status`
(public), `/apple/devtoken` + `/apple/token` (admin only, used by the auth page).

## /stats.svg

Self-contained stats card (github + tokscale) in the kokuen style, edge-cached ~30 min. Embed as an
`<img>`. SF Mono is base64-inlined so it renders inside github's readme sandbox — regenerate that
inlined font module with `bash scripts/subset-sfmono.sh` (needs `gh`, `fonttools`, `brotli`).

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

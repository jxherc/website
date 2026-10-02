# jxherc api

Cloudflare Worker powering jxherc.com backend.

Local development and tests require Node.js 22 or newer. Run `npm ci` to install the locked tools.

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
the Apple Developer portal; see Apple's [developer-token requirements](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens).

1. Create the `APPLE_KV` namespace and put its id in `wrangler.toml`:
   ```
   wrangler kv namespace create APPLE_KV
   ```
2. Replace `REPLACE_WITH_APPLE_KV_ID` with the namespace ID returned by that command. Replace
   `APPLE_TEAM_ID` and `APPLE_KEY_ID` in `wrangler.toml` `[vars]` with the 10-character IDs from
   your Apple Developer account and MusicKit key. These IDs are public claims in the developer
   token; placeholders cannot sign a valid token. Set the private key as a Worker secret:
   ```
   wrangler secret put APPLE_PRIVATE_KEY   # paste the full .p8 contents incl. the BEGIN/END lines
   ```
3. `wrangler deploy`, then go to `admin.jxherc.com/apple-auth.html` → **connect apple music** (one
   Apple ID login). That stores your music-user-token in KV and clears both cached Apple responses.
   Reconnecting replaces the token. The developer-token endpoint returns a 503 configuration
   error until both IDs and a valid P-256 private key are present; storing the user token also
   requires `APPLE_KV`.

For local development, set the real IDs in your local Worker configuration and put the
`APPLE_PRIVATE_KEY` secret in an ignored `.dev.vars` file. Keep the `.p8` file and user tokens out
of git. An existing `APPLE_MUSIC_USER_TOKEN` secret can supply the user token without KV, but
the admin reconnect flow needs KV to persist a replacement. Verify the actual deployed bindings
and variables in Cloudflare before deploying; the checked-in file is a template.

Endpoints: `/apple/recent`, `/apple/heavy-rotation` (public, KV-cached ~10min), `/apple/status`
(public), `/apple/devtoken` + `/apple/token` (admin only, used by the auth page).
`/apple/status` reports `configured` and `canRelink` alongside the existing connection state.
The recent and heavy-rotation endpoints cover Apple's returned history, not lifetime rankings.

Run the Apple route regressions locally with `node --test test/apple.test.mjs` from `_api`.
They use generated signing keys, mock KV and mock Apple responses, without an Apple account.

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

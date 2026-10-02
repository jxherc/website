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

## own music history

The music page uses D1 after a verified import is activated. Until then it keeps both existing
stats.fm accounts. After a browser learns that history is activated, it remembers that source. Failed requests show an error or previously loaded data;
they do not substitute stats.fm totals. A browser that has not yet learned the source uses clearly labeled stats.fm data when the own-service status is unreachable. Public routes are `/music/status`, `/music/view?after=…&before=…`
and `/music/recent`. Date bounds are UTC milliseconds, with an inclusive start and exclusive end.
Imports use at most 40 records and 42 queries per request to stay below the
[free-plan D1 query limit](https://developers.cloudflare.com/d1/platform/limits/). Readiness, totals
and rankings are read in one transactional batch so concurrent imports cannot leak unverified rows.
Admin-only POST routes are `/music/import/start`, `/music/import`, `/music/activate` and `/music/sync`.

1. Log into Cloudflare from `_api`: `npx wrangler login`. Verify the existing deployed Worker
   bindings first; this repository's `wrangler.toml` contains placeholders, not production IDs.
2. Create the database with `npx wrangler d1 create jxherc-music`. Put its returned database ID
   in the `MUSIC_DB` binding, then run `npx wrangler d1 migrations apply MUSIC_DB --remote`.
3. Export both public stats.fm accounts from the project root:
   `node _api/scripts/export-music.mjs /private/path/history.json`.
   The tool reads individual listens, retains timestamp-boundary ties and verifies each account's
   record count and total listening milliseconds before writing the file. Keep this private backup
   outside the published site and git.
4. Deploy the Worker and website using their existing deployment process. In
   `admin.jxherc.com/music.html`, import the verified JSON file and review the totals. Click
   **use this history on the website**. The server enables it only if the entire database matches
   the count and milliseconds saved by the admin importer before uploading the first batch.
   Submitting an interrupted import's current totals cannot activate it. Repeating interrupted imports is safe; changed records
   with an existing ID are rejected rather than overwritten. New records pause previously
   activated totals until the completed import is verified again. Duplicate retries do not pause them.
5. Link Apple Music from the admin page using the configuration described above. The five-minute
   cron saves the recent track list even with the website closed. **It does not create listening
   events.** Apple's recent-track response supplies order and song metadata, not a full playback
   log or individual play times. A failed refresh preserves the last successful list and its
   observation time. Relinking clears the old list.

The export covers what stats.fm currently holds, not proof that the original Apple/Spotify archive
was complete. Catalog metadata may be missing or reassigned by stats.fm. For unavailable album
IDs the importer uses the track's returned album; absent catalog entries retain the source track
name and listening time. Artist rankings credit each returned artist. Recording IDs merge matching
recordings across accounts and keep distinct recordings separate. Events without recording IDs use
normalized track and artist names; unavailable metadata can affect album/artist grouping.
The page reports incomplete catalog details instead of dropping those listens from totals.

Apply both D1 migrations before running the current Worker. Verified summary totals and exact
range rankings use a persistent D1 cache. Each range key uses its first and last included listen
timestamps, so a moving `before=Date.now()` reuses the result only when it includes the same
events; dates are never rounded. Every response checks the live publication state and activation
generation. New imports pause publication, and activation renews the generation and clears cached
results atomically. A calculation overlapping either action cannot publish stale results. The
cache retains the summary and at most 64 range results, avoiding unbounded cached range growth.
Public inactive status reports readiness and ownership only; authenticated admin status retains
full import-progress totals. SQL insert/update/delete triggers pause an active history too, so
direct database maintenance cannot silently leave published caches current. Finish all imports
before activating through the authenticated `/music/activate` route.

The initial 51,440-listen archive writes over 200,000 indexed D1 rows, exceeding the Free plan's
100,000-row daily write allowance. Import across quota reset days or use an existing paid plan;
do not repeatedly retry after a quota error. Cache reuse reduces repeated public reads, while
cold or distinct ranges still aggregate listening history. Monitor actual D1 row metrics.

Exact automatic play counts across devices need a playback collector or dated source export.
Neither recent-track polling nor linking Apple Music supplies that. Discord presence and device
collectors are a separate step. The import endpoint accepts canonical timestamped events with
source-specific IDs for future collectors. Original-provider archives should be reconciled with
existing listens before import so the same playback is not counted under two different sources.

For a disposable local database run `npx wrangler d1 migrations apply MUSIC_DB --local`, then
`npm run dev`. Serve the static site separately on localhost. Admin and music pages use the local
Worker at port 8787 on localhost; allow the static server's origin in local `ALLOWED_ORIGINS`.
Use a local test admin login and `.dev.vars` for local secrets. Never publish that file.

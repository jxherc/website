# jxherc.com — claude context

## who
- jxherc / Jingxing (Eric) Hou
- git: name=jxherc, email=houjx0103@gmail.com (ALWAYS use this for commits)
- student, toronto, born jan 3 2010 11:30 UTC
- communicates casually

## site
- hosted on cloudflare pages, auto-deploys from `main` on push
- repo: github.com/jxherc/website
- domain: jxherc.com

## file structure
```
index.html       homepage
music.html       music stats (stats.fm api)
intro.html       self-intro (placeholder text, user will fill in)
style.css        shared styles (currently v18)
theme.js         shared light/dark mode logic, used by all pages
_api/            cloudflare worker api (NOT deployed yet — see phase 2)
_admin/          admin panel source (NOT deployed yet — see phase 3)
images/          photos + album art
  spongebob-eyes.jpg  MISSING — user needs to add this for light mode meme modal
```

## design system
- font: inter (google fonts, 300/400/500/600)
- bg: #0a0a0a, text: #e8e6e3, muted: #6e6e6e, faint: #2e2e2e, accent: #00ff2a
- NO text-transform (user writes lowercase manually)
- css version bump in ALL html files when style.css changes (currently v18)
- enter animations: translateY(6px) rise, staggered per child

## what's done (phase 1 ✅)
- removed text-transform: lowercase from body
- portrait on index is plain image; intro has a proper card button like music
- light mode toggle (◐ top-right) with spongebob meme modal + 3-2-1 countdown
  - theme saved to localStorage, applied instantly via inline script in <head>
  - theme.js is shared across all pages
  - NEEDS: images/spongebob-eyes.jpg added by user
- page-edit-stamp auto-fetches last commit for that specific file from github api
  - shows: "page last edited {date} · {commit message}"
  - each page fetches ?path=index.html / music.html / intro.html respectively
- apple note moved inside setup section (margin-top: 0.85rem)
- music + intro cards grouped in one section (width: fit-content flex column)

## phase 2 — cloudflare worker api (built, NOT deployed)
code is in `_api/` directory. needs its own github repo + cloudflare worker.

### what to do
1. create new github repo `jxherc/api`, push `_api/` contents to it
2. in cloudflare dashboard, create:
   - kv namespaces: POSTS_KV, STATUS_KV, BOOKMARKS_KV, PHOTOS_KV
   - r2 bucket: `jxherc-photos`
3. deploy with `npx wrangler deploy`
4. set worker secrets:
   - ADMIN_PASSWORD_HASH: sha-256 of password, base64 encoded
     ```js
     // run in browser console to generate:
     const h = btoa(String.fromCharCode(...new Uint8Array(
       await crypto.subtle.digest('SHA-256', new TextEncoder().encode('YOUR_PASSWORD'))
     ))); console.log(h);
     ```
   - TOKEN_SECRET: any random string
   - DISCORD_PUBLIC_KEY: from discord developer portal
5. add custom domain `api.jxherc.com` in worker settings

### api endpoints
- POST   /auth            — login → token
- GET    /posts           — public list
- POST   /posts           — create post (auth)
- DELETE /posts/:id       — delete (auth)
- GET    /status          — public
- PUT    /status          — update (auth)
- GET    /bookmarks       — public list
- POST   /bookmarks       — add (auth)
- DELETE /bookmarks/:id   — delete (auth)
- GET    /photos          — public list
- POST   /photos          — upload to r2, exif extracted (auth)
- DELETE /photos/:id      — delete from r2 (auth)
- POST   /discord         — discord slash command webhook

## phase 3 — admin panel (built, NOT deployed)
code is in `_admin/` directory. needs its own github repo + cloudflare pages project.

### what to do
1. create new github repo `jxherc/admin`, push `_admin/` contents to it
2. create new cloudflare pages project pointed at that repo
3. add custom domain `admin.jxherc.com`
4. update `_admin/admin.js` — API constant is already set to `https://api.jxherc.com`

### pages
- login.html    — password → token stored in localStorage
- index.html    — dashboard with counts + nav
- posts.html    — create/delete blog posts
- status.html   — edit "working on" + "vibe", previews now section
- bookmarks.html — add/delete bookmarks, youtube auto-title
- photos.html   — INCOMPLETE (not built yet, needs drag-drop upload + exif display)

## phase 4 — main site new pages (NOT started)
pages to create: blog.html, now.html, photos.html, bookmarks.html
each fetches from https://api.jxherc.com endpoints
add cards on index.html linking to them (same inline-grid section as music/intro)

## phase 5 — discord bot (NOT started)
- discord slash command /post [text] → calls POST /api.jxherc.com/discord
- discord app setup at discord.com/developers
- interactions endpoint: https://api.jxherc.com/discord
- register /post command with one string option "text"
- bot responds ephemeral "posted 🗿"
- no persistent server needed, runs as part of the cloudflare worker

## known quirks
- stats.fm api shape is undocumented, parseTop() in music.html handles known shapes
- safari caches css aggressively — ALWAYS bump ?v=N in ALL html files when editing style.css
- image filenames must be lowercase with hyphens
- page-edit-stamp is now automatic (github api fetch), do NOT manually edit it
- _redirects: /gbp → discord server (302)
- 2026 comparison in music.html: frozen spotify jan-feb data hardcoded, live apple music added on top

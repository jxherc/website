overly simplified website
jxherc.com

## build

Run `node scripts/build-site.mjs` from the project root. It writes reviewed public assets to
`dist/site` for jxherc.com and standalone admin assets to `dist/admin` for admin.jxherc.com.
Deploy only those respective directories. Never deploy the checkout root: it contains private
listening exports, local instructions and backend files. The builder uses explicit file lists,
rejects symlinked inputs and clears old output files; add new public assets to those lists.

Validate both directories locally with the installed Worker tools:

```
node _api/node_modules/wrangler/bin/wrangler.js pages project validate dist/site
node _api/node_modules/wrangler/bin/wrangler.js pages project validate dist/admin
```

Run release packaging checks with `node --test tests/build-site.test.mjs`.
Worker configuration and database setup are in [_api/README.md](_api/README.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { adminFiles, buildSite, siteFiles } from '../scripts/build-site.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'website-release-'));
  for (const file of [...siteFiles, ...adminFiles.map(file => `_admin/${file}`)]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), `public:${file}`);
  }
  return root;
}
async function files(root, prefix = '') {
  const result = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) result.push(...await files(root, path));
    else result.push(path);
  }
  return result.sort();
}
test('release allowlist excludes private files and preserves standalone admin paths', async () => {
  const root = await fixture();
  try {
    for (const file of ['.agent/music/history.json', '.git/config', 'AGENTS.md',
      '.dev.vars', 'history.json', 'secret.html', '_api/src/index.js', '_api/.dev.vars',
      'tests/private.json', 'images/private.jpg', '_admin/private.html']) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), 'private');
    }
    const output = await buildSite(root);
    assert.deepEqual(await files(output.site), [...siteFiles].sort());
    assert.deepEqual(await files(output.admin), [...adminFiles].sort());
    assert.equal(await readFile(join(output.site, 'music-data.mjs'), 'utf8'), 'public:music-data.mjs');
    assert.equal(await readFile(join(output.site, 'images/nectar.jpg'), 'utf8'), 'public:images/nectar.jpg');
    assert.equal(await readFile(join(output.admin, 'music.html'), 'utf8'), 'public:_admin/music.html');
    assert.equal(await readFile(join(output.admin, 'style.css'), 'utf8'), 'public:_admin/style.css');
    assert.equal(await readFile(join(output.site, '_redirects'), 'utf8'), 'public:_redirects');
    await assert.rejects(lstat(join(output.admin, '_redirects')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(output.site, '_admin')), { code: 'ENOENT' });
    await writeFile(join(output.site, 'old-private.json'), 'private');
    await writeFile(join(output.admin, 'old-private.json'), 'private');
    await buildSite(root);
    await assert.rejects(lstat(join(output.site, 'old-private.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(output.admin, 'old-private.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('symlinked assets and output directories cannot copy or overwrite private files', async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'website-private-'));
  try {
    const privateFile = join(outside, 'private');
    await writeFile(privateFile, 'private');
    await rm(join(root, 'music.html'));
    await symlink(privateFile, join(root, 'music.html'));
    await assert.rejects(buildSite(root), /real public file/);
    await rm(join(root, 'music.html'));
    await writeFile(join(root, 'music.html'), 'public');
    await symlink(outside, join(root, 'dist'));
    await assert.rejects(buildSite(root), /real directory/);
    assert.equal(await readFile(privateFile, 'utf8'), 'private');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test('missing required assets leave the previous build intact and fail the build', async () => {
  const root = await fixture();
  try {
    const output = await buildSite(root);
    await rm(join(root, 'music-data.mjs'));
    await assert.rejects(buildSite(root), { code: 'ENOENT' });
    assert.equal(await readFile(join(output.site, 'music-data.mjs'), 'utf8'), 'public:music-data.mjs');
  } finally { await rm(root, { recursive: true, force: true }); }
});

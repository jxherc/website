import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Only reviewed public assets belong here. Never copy the checkout recursively.
export const siteFiles = [
  '_redirects', 'about.html', 'bookmarks.html', 'faq.html', 'index.html',
  'intro.html', 'music.html', 'now.html', 'photos.html', 'shitpost.html',
  'favicon.svg', 'music-data.mjs', 'og-image.png', 'style.css', 'theme.js',
  ...[
    '4-your-eyez-only.jpg', '808s-and-heartbreak.jpg', 'about.png',
    'after-hours.jpg', 'american-dream.jpg', 'back-to-wonderland.jpg',
    'ballads-1.jpg', 'blonde.jpg', 'blue-island.jpg', 'bully-deluxe.jpg',
    'cant-rush-greatness.jpg', 'case-study-01.jpg', 'channel-orange.jpg',
    'chromakopia.jpg', 'college-dropout.jpg', 'damn.jpg', 'dawn-fm.jpg',
    'dttg.jpg', 'flower-boy.jpg', 'freudian.jpg', 'gnx.jpg',
    'good-kid-maad-city.jpg', 'graduation.jpg', 'hurry-up-tomorrow.jpg',
    'igor.jpg', 'in-tongues.jpg', 'keshi-gabriel.jpg', 'keshi-requiem.jpg',
    'late-registration.jpg', 'life-of-pablo.jpg', 'luvsic-hexalogy.jpg',
    'mbdtf.jpg', 'me.jpg', 'modal-soul.jpg', 'mr-morale.jpg', 'nectar.jpg',
    'never-enough.jpg', 'petal.jpg', 'pilgrims-paradise.jpg',
    'piss-in-the-wind-deluxe.jpg', 'poems-of-the-past.jpg',
    'private-blizzard.jpg', 'rapunzel.jpg', 'sad-songs.jpg', 'smithereens.jpg',
    'son-of-spergy.jpg', 'sos.jpg', 'spongebob-eyes.jpg', 'starboy.jpg',
    'the-fall-off.jpg', 'u-made-me-a-st4r.jpg', 'yeezus.jpg',
    'yoasobi-the-book-2.jpg', 'yoasobi-the-book-3.jpg', 'yoasobi-the-book.jpg',
  ].map(name => `images/${name}`),
];
export const adminFiles = [
  'admin.js', 'apple-auth.html', 'bookmarks.html', 'index.html',
  'login.html', 'music.html', 'music.js', 'photos.html', 'photos.js', 'posts.html', 'status.html', 'style.css',
];

async function directory(path, optional = false) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`expected a real directory: ${path}`);
}

export async function buildSite(root = fileURLToPath(new URL('../', import.meta.url))) {
  root = resolve(root);
  const dist = join(root, 'dist');
  await directory(join(root, 'images'));
  await directory(join(root, '_admin'));
  await directory(dist, true);
  const releases = [
    { output: join(dist, 'site'), input: root, files: siteFiles },
    { output: join(dist, 'admin'), input: join(root, '_admin'), files: adminFiles },
  ];
  // Validate everything before removing a previous build, including symlink boundaries.
  for (const release of releases) {
    await directory(release.output, true);
    for (const file of release.files) {
      const source = join(release.input, file);
      if (!(await lstat(source)).isFile()) throw new Error(`expected a real public file: ${source}`);
    }
  }
  for (const release of releases) {
    await rm(release.output, { recursive: true, force: true });
    await mkdir(release.output, { recursive: true });
    for (const file of release.files) {
      const target = join(release.output, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(release.input, file), target);
    }
  }
  return { site: releases[0].output, admin: releases[1].output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildSite().then(result => console.log(`built ${result.site}\nbuilt ${result.admin}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

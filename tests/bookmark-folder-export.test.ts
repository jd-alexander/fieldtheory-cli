import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportReadableBookmarkArchive } from '../src/bookmark-folder-export.js';

async function withIsolatedDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ft-folder-export-'));
  const saved = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (saved !== undefined) process.env.FT_DATA_DIR = saved;
    else delete process.env.FT_DATA_DIR;
  }
}

test('exportReadableBookmarkArchive writes folder directories, tweet markdown, and local media links', async () => {
  await withIsolatedDataDir(async (dir) => {
    const records = [
      {
        id: '2060204743000240157',
        tweetId: '2060204743000240157',
        url: 'https://x.com/example/status/2060204743000240157',
        text: 'A full bookmark with multiple screenshots and useful context.',
        authorHandle: 'example',
        authorName: 'Example Author',
        syncedAt: '2026-05-31T00:04:10.948Z',
        postedAt: '2026-05-29T15:00:00.000Z',
        sortIndex: '999',
        folderIds: ['f-app-store'],
        folderNames: ['App Store Screenshots'],
        mediaObjects: [
          { type: 'photo', url: 'https://pbs.twimg.com/media/source.jpg', mediaUrl: 'https://pbs.twimg.com/media/source.jpg' },
        ],
        links: ['https://example.com'],
      },
    ];
    await writeFile(path.join(dir, 'bookmarks.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(path.join(dir, 'bookmark-folders-state.json'), JSON.stringify({
      folders: [
        {
          id: 'f-app-store',
          name: 'App Store Screenshots',
          order: 1,
          active: true,
          lastSyncedAt: '2026-05-31T00:04:10.948Z',
          recordCount: 1,
          recordIdsHash: 'hash-1',
        },
      ],
    }, null, 2));
    await mkdir(path.join(dir, 'media'), { recursive: true });
    const mediaPath = path.join(dir, 'media', '2060204743000240157-local.jpg');
    await writeFile(mediaPath, 'not really an image');
    await writeFile(path.join(dir, 'media-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-31T00:06:36.455Z',
      limit: 1,
      maxBytes: 1024,
      processed: 1,
      downloaded: 1,
      skippedTooLarge: 0,
      failed: 0,
      entries: [
        {
          bookmarkId: '2060204743000240157',
          tweetId: '2060204743000240157',
          tweetUrl: 'https://x.com/example/status/2060204743000240157',
          authorHandle: 'example',
          sourceUrl: 'https://pbs.twimg.com/media/source.jpg',
          localPath: mediaPath,
          contentType: 'image/jpeg',
          bytes: 18,
          status: 'downloaded',
          fetchedAt: '2026-05-31T00:06:36.455Z',
        },
      ],
    }, null, 2));

    const result = await exportReadableBookmarkArchive({ clean: true });
    assert.equal(result.folders, 1);
    assert.equal(result.records, 1);

    const folderDir = path.join(dir, 'readable', 'folders', '001 - App Store Screenshots');
    const files = await readdir(folderDir);
    assert.ok(files.includes('README.md'));
    const bookmarkFile = files.find((file) => file.endsWith('.md') && file !== 'README.md');
    assert.ok(bookmarkFile);

    const content = await readFile(path.join(folderDir, bookmarkFile), 'utf8');
    assert.match(content, /# @example - 2060204743000240157/);
    assert.match(content, /A full bookmark with multiple screenshots/);
    assert.match(content, /!\[2060204743000240157-local\.jpg\]\(\.\.\/\.\.\/\.\.\/media\/2060204743000240157-local\.jpg\)/);
    assert.match(content, /## Links\n- https:\/\/example\.com/);

    const folderIndex = await readFile(path.join(folderDir, 'README.md'), 'utf8');
    assert.match(folderIndex, /Record hash: `hash-1`/);
    assert.match(folderIndex, /\| 2026-05-29 \| @example \|/);

    const rootIndex = await readFile(path.join(dir, 'readable', 'README.md'), 'utf8');
    assert.match(rootIndex, /\[App Store Screenshots\]\(folders\/001 - App Store Screenshots\/README\.md\)/);
  });
});

test('exportReadableBookmarkArchive clean removes stale generated files', async () => {
  await withIsolatedDataDir(async (dir) => {
    await writeFile(path.join(dir, 'bookmarks.jsonl'), '');
    await mkdir(path.join(dir, 'readable', 'old'), { recursive: true });
    await writeFile(path.join(dir, 'readable', 'old', 'stale.md'), 'stale');

    await exportReadableBookmarkArchive({ clean: true });

    const rootEntries = await readdir(path.join(dir, 'readable'));
    assert.deepEqual(rootEntries, ['README.md']);
  });
});

test('exportReadableBookmarkArchive treats downloaded Twitter quality variants as covered media', async () => {
  await withIsolatedDataDir(async (dir) => {
    const records = [
      {
        id: '2060416230641881336',
        tweetId: '2060416230641881336',
        url: 'https://x.com/example/status/2060416230641881336',
        text: 'https://x.com/i/article/2060411306759585792',
        authorHandle: 'example',
        syncedAt: '2026-05-31T00:04:10.948Z',
        postedAt: '2026-05-29T15:00:00.000Z',
        folderIds: ['f-ai'],
        folderNames: ['AI Code Gen'],
        articleTitle: 'Article title',
        articleText: 'Article body',
        articleCoverMedia: {
          media_info: {
            original_img_url: 'https://pbs.twimg.com/media/HJgQHecacAATqaV.jpg',
          },
        },
      },
    ];
    await writeFile(path.join(dir, 'bookmarks.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(path.join(dir, 'bookmark-folders-state.json'), JSON.stringify({
      folders: [{ id: 'f-ai', name: 'AI Code Gen', order: 1, active: true, recordCount: 1 }],
    }, null, 2));
    await mkdir(path.join(dir, 'media'), { recursive: true });
    const mediaPath = path.join(dir, 'media', '2060416230641881336-local.jpg');
    await writeFile(mediaPath, 'not really an image');
    await writeFile(path.join(dir, 'media-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-31T00:06:36.455Z',
      limit: 1,
      maxBytes: 1024,
      processed: 1,
      downloaded: 1,
      skippedTooLarge: 0,
      failed: 0,
      entries: [
        {
          bookmarkId: '2060416230641881336',
          tweetId: '2060416230641881336',
          tweetUrl: 'https://x.com/example/status/2060416230641881336',
          authorHandle: 'example',
          sourceUrl: 'https://pbs.twimg.com/media/HJgQHecacAATqaV.jpg?name=large',
          localPath: mediaPath,
          contentType: 'image/jpeg',
          bytes: 18,
          status: 'downloaded',
          fetchedAt: '2026-05-31T00:06:36.455Z',
        },
      ],
    }, null, 2));

    await exportReadableBookmarkArchive({ clean: true });

    const folderDir = path.join(dir, 'readable', 'folders', '001 - AI Code Gen');
    const files = await readdir(folderDir);
    const bookmarkFile = files.find((file) => file.endsWith('.md') && file !== 'README.md');
    assert.ok(bookmarkFile);
    const content = await readFile(path.join(folderDir, bookmarkFile), 'utf8');
    assert.match(content, /2060416230641881336-local\.jpg/);
    assert.doesNotMatch(content, /Remote media not downloaded yet/);
  });
});

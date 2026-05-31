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
        folderNames: ['App Store Screenshots '],
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
          name: 'App Store Screenshots ',
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
    assert.ok(
      content.startsWith('# @example - Example Author\n\nA full bookmark with multiple screenshots and useful context.'),
      'readable bookmark files should open with the useful tweet content, not metadata frontmatter',
    );
    assert.doesNotMatch(content.slice(0, 200), /---|tweet_id:|posted_at:|synced_at:/);
    assert.match(content, /A full bookmark with multiple screenshots/);
    assert.match(content, /!\[2060204743000240157-local\.jpg\]\(\.\.\/\.\.\/\.\.\/media\/2060204743000240157-local\.jpg\)/);
    assert.match(content, /## Links\n- https:\/\/example\.com/);
    assert.match(content, /## Metadata[\s\S]*Tweet ID: `2060204743000240157`/);
    assert.doesNotMatch(content, /- Folder: App Store Screenshots\n/);
    assert.doesNotMatch(content, /- Folders: App Store Screenshots\n/);
    assert.doesNotMatch(content, /App Store Screenshots \n/);

    const folderIndex = await readFile(path.join(folderDir, 'README.md'), 'utf8');
    assert.match(folderIndex, /Record hash: `hash-1`/);
    assert.match(folderIndex, /\| 1 \| 2026-05-29 \| @example \|/);

    const rootIndex = await readFile(path.join(dir, 'readable', 'README.md'), 'utf8');
    assert.match(rootIndex, /\[App Store Screenshots\]\(folders\/001 - App Store Screenshots\/README\.md\)/);
  });
});

test('exportReadableBookmarkArchive shows folder metadata only for multi-folder bookmarks', async () => {
  await withIsolatedDataDir(async (dir) => {
    const records = [
      {
        id: 'multi',
        tweetId: 'multi',
        url: 'https://x.com/example/status/multi',
        text: 'Bookmark filed in two folders.',
        authorHandle: 'example',
        syncedAt: '2026-05-31T00:04:10.948Z',
        postedAt: '2026-05-01T00:00:00.000Z',
        folderIds: ['f-ads', 'f-ai'],
        folderNames: ['Ads', 'AI Code Gen'],
        tags: [],
        ingestedVia: 'graphql',
      },
    ];
    await writeFile(path.join(dir, 'bookmarks.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(path.join(dir, 'bookmark-folders-state.json'), JSON.stringify({
      folders: [
        { id: 'f-ads', name: 'Ads', order: 1, active: true },
        { id: 'f-ai', name: 'AI Code Gen', order: 2, active: true },
      ],
    }, null, 2));

    await exportReadableBookmarkArchive({ clean: true });

    const folderDir = path.join(dir, 'readable', 'folders', '001 - Ads');
    const files = await readdir(folderDir);
    const bookmarkFile = files.find((file) => file.endsWith('.md') && file !== 'README.md');
    assert.ok(bookmarkFile);
    const content = await readFile(path.join(folderDir, bookmarkFile), 'utf8');
    assert.doesNotMatch(content, /- Folder:/);
    assert.match(content, /- Folders: Ads, AI Code Gen\n/);
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

test('exportReadableBookmarkArchive sorts and names folder entries by tweet date newest first', async () => {
  await withIsolatedDataDir(async (dir) => {
    const records = [
      {
        id: 'old',
        tweetId: 'old',
        url: 'https://x.com/example/status/old',
        text: 'Older bookmark with a larger opaque sort index.',
        authorHandle: 'example',
        syncedAt: '2026-05-31T00:04:10.948Z',
        postedAt: '2025-01-01T00:00:00.000Z',
        sortIndex: '999',
        folderIds: ['f-ads'],
        folderNames: ['Ads'],
        folderSortIndices: ['999'],
        tags: [],
        ingestedVia: 'graphql',
      },
      {
        id: 'new',
        tweetId: 'new',
        url: 'https://x.com/example/status/new',
        text: 'Newer bookmark with a smaller opaque sort index.',
        authorHandle: 'example',
        syncedAt: '2026-05-31T00:04:10.948Z',
        postedAt: '2026-05-01T00:00:00.000Z',
        sortIndex: '1',
        folderIds: ['f-ads'],
        folderNames: ['Ads'],
        folderSortIndices: ['001'],
        tags: [],
        ingestedVia: 'graphql',
      },
    ];
    await writeFile(path.join(dir, 'bookmarks.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(path.join(dir, 'bookmark-folders-state.json'), JSON.stringify({
      folders: [{ id: 'f-ads', name: 'Ads', order: 1, active: true }],
    }, null, 2));

    await exportReadableBookmarkArchive({ clean: true });

    const folderIndex = await readFile(path.join(dir, 'readable', 'folders', '001 - Ads', 'README.md'), 'utf8');
    assert.ok(
      folderIndex.indexOf('Newer bookmark') < folderIndex.indexOf('Older bookmark'),
      'README order should put newer tweet dates before older tweet dates even when X folder sort index points the other way',
    );
    const files = (await readdir(path.join(dir, 'readable', 'folders', '001 - Ads')))
      .filter((file) => file.endsWith('.md') && file !== 'README.md')
      .sort();
    assert.match(files[0], /^0001 - .*new\.md$/);
    assert.match(files[1], /^0002 - .*old\.md$/);
  });
});

test('exportReadableBookmarkArchive renders quoted X Article bodies', async () => {
  await withIsolatedDataDir(async (dir) => {
    const records = [
      {
        id: 'quoted-parent',
        tweetId: 'quoted-parent',
        url: 'https://x.com/example/status/quoted-parent',
        text: 'This quote should not leave the article as a bare link.',
        authorHandle: 'example',
        syncedAt: '2026-05-31T00:04:10.948Z',
        postedAt: '2026-05-01T00:00:00.000Z',
        folderIds: ['f-ads'],
        folderNames: ['Ads'],
        quotedStatusId: 'quoted-article',
        quotedTweet: {
          id: 'quoted-article',
          text: 'https://x.com/i/article/quoted-article-id',
          links: ['https://x.com/i/article/quoted-article-id'],
          url: 'https://x.com/quoted/status/quoted-article',
          articleTitle: 'Quoted article title',
          articleText: 'Quoted article body should appear verbatim in the readable markdown file.',
        },
      },
    ];
    await writeFile(path.join(dir, 'bookmarks.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(path.join(dir, 'bookmark-folders-state.json'), JSON.stringify({
      folders: [{ id: 'f-ads', name: 'Ads', order: 1, active: true }],
    }, null, 2));

    await exportReadableBookmarkArchive({ clean: true });

    const folderDir = path.join(dir, 'readable', 'folders', '001 - Ads');
    const files = await readdir(folderDir);
    const tweetFile = files.find((file) => file.endsWith('.md') && file !== 'README.md');
    assert.ok(tweetFile);
    const markdown = await readFile(path.join(folderDir, tweetFile), 'utf8');
    assert.match(markdown, /## Quoted Tweet/);
    assert.match(markdown, /### Article/);
    assert.match(markdown, /Quoted article title/);
    assert.match(markdown, /Quoted article body should appear verbatim/);

    const folderIndex = await readFile(path.join(folderDir, 'README.md'), 'utf8');
    assert.match(folderIndex, /\| yes \|/);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { acquireSyncLock, archiveSyncMain, availableRequestBudget, recentFolderBookmarks, renderBatchPreview } from '../src/archive-sync.js';
import { HttpSafetyStopError } from '../src/http-safety.js';
import type { BookmarkRecord } from '../src/types.js';

const now = Date.parse('2026-10-18T20:00:00Z');

test('hourly allowance includes prior processes, excludes expired requests and honors 429 reset', () => {
  const entries = [
    { ts: '2026-10-18T19:59:00Z', status: 200 },
    { ts: '2026-10-18T19:58:00Z', errorName: 'TypeError' },
    { ts: '2026-10-18T18:59:00Z', status: 200 },
  ];
  assert.equal(availableRequestBudget(entries, now, 20, 3), 1);
  assert.equal(availableRequestBudget(entries, now, 20, 2), 0);
  assert.throws(() => availableRequestBudget([
    { ts: '2026-10-18T19:59:00Z', status: 429, responseHeaders: { 'x-rate-limit-reset': String((now + 60_000) / 1000) } },
  ], now, 20, 30), /cooldown/);
  assert.equal(availableRequestBudget([
    { ts: '2026-10-18T19:30:00Z', status: 429 },
  ], now, 20, 30), 20);
});

test('a second sync cannot acquire the same archive lock', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ft-sync-lock-'));
  const release = acquireSyncLock(directory);
  try { assert.throws(() => acquireSyncLock(directory), /Another bookmark sync/); }
  finally { release(); rmSync(directory, { recursive: true }); }
});

function record(id: string): BookmarkRecord {
  return { id, tweetId: id, url: `https://x.com/alice/status/${id}`, text: `Post ${id}`,
    authorHandle: 'alice', authorName: 'Alice', syncedAt: '2026-10-18T20:00:00Z',
    postedAt: '2020-01-01T00:00:00Z', links: [], tags: [], ingestedVia: 'graphql' };
}

test('preview preserves quotes and article text, escapes source HTML, and rejects script links', () => {
  const bookmark = record('1');
  bookmark.text = '<script>alert(1)</script>';
  bookmark.links = ['javascript:alert(1)', 'https://example.org/?q="test"'];
  bookmark.quotedTweet = { id: '2', url: 'https://x.com/bob/status/2', text: 'quoted', authorHandle: 'bob',
    articleTitle: 'A title', articleText: 'Full quoted article\nSecond paragraph' };
  const html = renderBatchPreview([bookmark], [], os.tmpdir());
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Full quoted article\nSecond paragraph'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('Content-Security-Policy'));
  assert.throws(() => renderBatchPreview([bookmark], [{ bookmarkId: '1', tweetId: '1', tweetUrl: bookmark.url,
    sourceUrl: 'https://example.org/a.jpg', localPath: '/nonexistent/ft-missing-image.jpg', status: 'downloaded', fetchedAt: '' }], os.tmpdir()), /media is missing/);
});

async function withArchive(task: (directory: string, write: (records: BookmarkRecord[]) => void) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ft-archive-sync-'));
  const previousDir = process.env.FT_DATA_DIR;
  const previousCode = process.exitCode;
  process.env.FT_DATA_DIR = directory;
  process.exitCode = 0;
  const write = (records: BookmarkRecord[]): void => writeFileSync(path.join(directory, 'bookmarks.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const git = (...args: string[]): void => { execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' }); };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Archive Test');
  git('config', 'user.email', 'archive-test@example.invalid');
  write([record('old')]);
  git('add', '.');
  git('commit', '-m', 'Fixture');
  try { await task(directory, write); } finally {
    if (previousDir === undefined) delete process.env.FT_DATA_DIR;
    else process.env.FT_DATA_DIR = previousDir;
    process.exitCode = previousCode;
    rmSync(directory, { recursive: true, force: true });
  }
}

test('archive command saves a budget pause and resumes enrichment for the original batch on the next sync', async () => {
  await withArchive(async (directory, write) => {
    const read = (): BookmarkRecord[] => readFileSync(path.join(directory, 'bookmarks.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const phases: string[] = [];
    const records = [record('new'), record('old')];
    const result = (added: number) => ({ added, addedIds: added ? ['new'] : [], totalBookmarks: 2, pages: 1,
      bookmarkedAtRepaired: 0, bookmarkedAtMissing: 2, stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' });
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push'], {
      timeline: async () => { write(records); return result(1); },
      threads: async () => { throw new HttpSafetyStopError('fixture stop', 'request budget reached'); },
      gaps: async () => { throw new Error('Must not run gaps after a pause'); },
      media: async () => { throw new Error('Must not run media after a pause'); },
      folders: async () => { throw new Error('Must not run folders after a pause'); },
    });
    assert.equal(process.exitCode, 2);
    const firstSummary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.equal(firstSummary.newCount, 1);
    assert.deepEqual(firstSummary.pending.media, ['new']);
    assert.ok(readFileSync(path.join(directory, 'previews/latest-batch.html'), 'utf8').includes('Post new'));
    execFileSync('git', ['-C', directory, 'add', '-A']);
    execFileSync('git', ['-C', directory, 'commit', '-m', 'Save paused fixture']);
    process.exitCode = 0;
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push'], {
      timeline: async () => result(0),
      threads: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['new']); phases.push('threads');
        return { total: 1, contextFilled: 0, belowFilled: 0, emptyChecked: 1, failed: 0, failures: [] };
      },
      gaps: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['new']); phases.push('gaps');
        const current = read(); current[0].articleText = 'Saved article'; write(current);
        return { total: 1, quotedTweetsFilled: 0, textExpanded: 0, articlesEnriched: 1, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 1, failed: 0, failures: [] };
      },
      media: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['new']); phases.push('media');
        mkdirSync(path.join(directory, 'media'), { recursive: true });
        const image = path.join(directory, 'media', 'image.jpg'); writeFileSync(image, 'fixture');
        const manifest = { schemaVersion: 1 as const, generatedAt: '', limit: 1, maxBytes: 10, processed: 1, downloaded: 1, failed: 0, skippedTooLarge: 0,
          entries: [{ bookmarkId: 'new', tweetId: 'new', tweetUrl: records[0].url, sourceUrl: 'https://example.org/a.jpg', localPath: image, contentType: 'image/jpeg', status: 'downloaded' as const, fetchedAt: '' }] };
        writeFileSync(path.join(directory, 'media-manifest.json'), JSON.stringify(manifest));
        return manifest;
      },
      folders: async () => {
        phases.push('folders');
        const current = read(); current[0].folderIds = ['folder']; current[0].folderNames = ['Research']; write(current);
        return { folders: [], perFolder: [], targetFolderCount: 1, totalAdded: 0, totalTagged: 1, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [],
          coverage: { targetRecordIds: 1, taggedRecordIds: 1, remainingRecordIds: [], stoppedAfterCoverage: true } };
      },
    });
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.deepEqual(phases, ['threads', 'gaps', 'media', 'folders']);
    assert.equal(summary.newCount, 0);
    assert.equal(summary.batchCount, 1);
    assert.equal(summary.media.downloaded, 1);
    assert.ok(Object.values(summary.pending).every((ids: any) => ids.length === 0));
    const preview = readFileSync(summary.previewPath, 'utf8');
    assert.ok(preview.includes('Saved article'));
    assert.ok(preview.includes('../media/image.jpg'));
    assert.ok(preview.includes('Research'));
    assert.equal(process.exitCode, 0);
  });
});

test('a no-change sync does not accidentally enrich or download the full archive', async () => {
  await withArchive(async (directory) => {
    const unexpected = async (): Promise<never> => { throw new Error('Empty scopes must not mean the entire archive'); };
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push'], {
      timeline: async () => ({ added: 0, addedIds: [], totalBookmarks: 1, pages: 1, bookmarkedAtRepaired: 0,
        bookmarkedAtMissing: 1, stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' }),
      threads: unexpected, gaps: unexpected, media: unexpected,
      folders: async (options) => {
        assert.equal(options?.folderLimit, 0);
        return { folders: [], perFolder: [], targetFolderCount: 0, totalAdded: 0, totalTagged: 0, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [] };
      },
    });
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.equal(summary.newCount, 0);
    assert.equal(summary.batchCount, 0);
  });
});

test('a page-limited timeline resumes its saved cursor rather than skipping to the new head', async () => {
  await withArchive(async (directory, write) => {
    const result = { added: 1, addedIds: ['new'], totalBookmarks: 2, pages: 12,
      bookmarkedAtRepaired: 0, bookmarkedAtMissing: 2, stopReason: 'max pages reached', cachePath: '', statePath: '' };
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push'], {
      timeline: async () => {
        write([record('new'), record('old')]);
        writeFileSync(path.join(directory, 'bookmarks-backfill-state.json'), JSON.stringify({ lastCursor: 'next-page' }));
        return result;
      },
    });
    const statePath = path.join(directory, 'logs/archive-sync-state.json');
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).timelineCursor, 'next-page');
    execFileSync('git', ['-C', directory, 'add', '-A']);
    execFileSync('git', ['-C', directory, 'commit', '-m', 'Save page boundary']);
    process.exitCode = 0;
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push'], {
      timeline: async (options) => {
        assert.equal(options?.resumeCursor, 'next-page');
        return { ...result, added: 0, addedIds: [], pages: 1, stopReason: 'end of bookmarks' };
      },
      threads: async () => { throw new HttpSafetyStopError('fixture stop', 'request budget reached'); },
    });
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).timelineCursor, undefined);
  });
});

test('a large capture finishes media for ten bookmarks before expanding the next group of threads', async () => {
  await withArchive(async (directory, write) => {
    const records = Array.from({ length: 14 }, (_, i) => ({ ...record(String(i)), folderIds: ['f'], folderNames: ['Research'] }));
    const calls: string[] = [];
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push'], {
      timeline: async () => {
        write([...records, record('old')]);
        return { added: 14, addedIds: records.map((r) => r.id), totalBookmarks: 15, pages: 1,
          bookmarkedAtRepaired: 0, bookmarkedAtMissing: 15, stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' };
      },
      threads: async (options) => {
        calls.push(`threads:${options?.onlyTweetIds?.length}`);
        return { total: 0, contextFilled: 0, belowFilled: 0, emptyChecked: 0, failed: 0, failures: [] };
      },
      gaps: async (options) => {
        calls.push(`gaps:${options?.onlyTweetIds?.length}`);
        return { total: 0, quotedTweetsFilled: 0, textExpanded: 0, articlesEnriched: 0, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 0, failed: 0, failures: [] };
      },
      media: async (options) => {
        calls.push(`media:${options?.onlyTweetIds?.length}`);
        return { schemaVersion: 1, generatedAt: '', limit: 0, maxBytes: 10, processed: 0, downloaded: 0, failed: 0, skippedTooLarge: 0, entries: [] };
      },
      folders: async () => ({ folders: [], perFolder: [], targetFolderCount: 0, totalAdded: 0,
        totalTagged: 0, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [] }),
    });
    assert.deepEqual(calls, ['threads:10', 'gaps:10', 'media:10', 'threads:4', 'gaps:4', 'media:4']);
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.equal(summary.newCount, 14);
    assert.ok(Object.values(summary.pending).every((ids: any) => ids.length === 0));
  });
});

test('focused folder ordering uses bookmark positions even for recently saved older tweets', () => {
  const savedOlderTweet = { ...record('older-tweet'), postedAt: '2018-01-01T00:00:00Z', folderNames: ['Other', 'Ads'], folderSortIndices: ['1', '1000'] };
  const newerTweet = { ...record('newer-tweet'), postedAt: '2026-10-23T00:00:00Z', folderNames: ['Ads'], folderSortIndices: ['999'] };
  assert.deepEqual(recentFolderBookmarks([newerTweet, record('unrelated'), savedOlderTweet], 'ads').map((r) => r.id), ['older-tweet', 'newer-tweet']);
});

test('focused conversations run before old backlog and include newly discovered folder bookmarks', async () => {
  await withArchive(async (directory, write) => {
    mkdirSync(path.join(directory, 'logs'));
    writeFileSync(path.join(directory, 'logs/archive-sync-state.json'), JSON.stringify({ pending: { media: ['old'] } }));
    execFileSync('git', ['-C', directory, 'add', '-A']);
    execFileSync('git', ['-C', directory, 'commit', '-m', 'Save backlog']);
    const focused = ['a', 'b', 'c'].map((id, i) => ({ ...record(id), folderIds: ['f'], folderNames: ['Ads'], folderSortIndices: [String(1000 - i)], engagement: { replyCount: [10, 90, 20][i] } }));
    const phases: string[] = [];
    const emptyFolders = { folders: [], perFolder: [], targetFolderCount: 0, totalAdded: 0, totalTagged: 0, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [] };
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--focus-folder', 'Ads', '--comments', '2'], {
      timeline: async () => ({ added: 0, totalBookmarks: 1, pages: 1, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 1,
        stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' }),
      folders: async (options) => {
        if (options?.onlyFolderName) { phases.push('focus'); write([...focused, record('old')]); }
        return emptyFolders;
      },
      conversation: async (options) => {
        phases.push(`comments:${options.tweetId}`);
        assert.equal(options.expandBranches, true);
        const out = path.join(directory, `conversation-${options.tweetId}.md`);
        writeFileSync(out, 'Captured public replies');
        return { path: out, status: 'ok', tweetCount: 12, authorReplyCount: 3, participantCount: 7,
          topLevelReplyCount: 4, branchFetches: 2, branchTweetsAdded: 3 };
      },
      threads: async (options) => {
        phases.push('threads');
        assert.deepEqual(options?.onlyTweetIds, ['a', 'b', 'c']);
        return { total: 0, contextFilled: 0, belowFilled: 0, emptyChecked: 0, failed: 0, failures: [] };
      },
      gaps: async () => ({ total: 0, quotedTweetsFilled: 0, textExpanded: 0, articlesEnriched: 0, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 0, failed: 0, failures: [] }),
      media: async (options) => {
        phases.push('media');
        assert.deepEqual(options?.onlyTweetIds, ['a', 'b', 'c', 'old']);
        return { schemaVersion: 1, generatedAt: '', limit: 0, maxBytes: 10, processed: 0, downloaded: 0, failed: 0, skippedTooLarge: 0, entries: [] };
      },
    });
    assert.deepEqual(phases, ['focus', 'comments:b', 'comments:c', 'threads', 'media']);
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.equal(summary.newCount, 3);
    assert.equal(summary.conversations.length, 2);
    assert.deepEqual(summary.pendingConversations, []);
    assert.deepEqual(summary.pending.folders, []);
  });
});

test('a conversation guardrail saves its pending ID and skips older enrichment', async () => {
  await withArchive(async (directory, write) => {
    const focused = { ...record('ad'), folderIds: ['f'], folderNames: ['Ads'], folderSortIndices: ['999'] };
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--focus-folder', 'Ads', '--comments', '1'], {
      timeline: async () => ({ added: 0, totalBookmarks: 1, pages: 1, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 1,
        stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' }),
      folders: async () => { write([focused, record('old')]); return { folders: [], perFolder: [], targetFolderCount: 0, totalAdded: 1, totalTagged: 0, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [] }; },
      conversation: async () => { throw new HttpSafetyStopError('fixture stop', 'request budget reached'); },
      threads: async () => { throw new Error('must not run older threads after a conversation stop'); },
    });
    const state = JSON.parse(readFileSync(path.join(directory, 'logs/archive-sync-state.json'), 'utf8'));
    assert.deepEqual(state.pendingConversations, ['ad']);
    assert.equal(process.exitCode, 2);
  });
});

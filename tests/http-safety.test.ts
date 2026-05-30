import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configureHttpSafety,
  controlledFetch,
  HttpSafetyStopError,
  resetHttpSafetyForTests,
} from '../src/http-safety.js';

test('controlledFetch writes redacted HTTP audit entries', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-http-audit-'));
  const logPath = path.join(tmpDir, 'audit.jsonl');
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: 'bad auth_token=secret-token ct0=secret-csrf' }),
    {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'x-rate-limit-remaining': '12',
      },
    },
  )) as typeof globalThis.fetch;

  try {
    configureHttpSafety({ auditHttp: true, auditLogPath: logPath, minDelayMs: 0 });
    await controlledFetch('https://x.com/i/api/graphql/query-id/Bookmarks?variables=%7B%22cursor%22%3A%22private%22%7D', {
      headers: {
        cookie: 'ct0=secret-csrf; auth_token=secret-token',
        'x-csrf-token': 'secret-csrf',
      },
    }, {
      operation: 'Bookmarks',
      category: 'x-graphql',
      tweetId: '1234567890',
      cursorPresent: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    resetHttpSafetyForTests();
  }

  const entry = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
  assert.equal(entry.operation, 'Bookmarks');
  assert.equal(entry.status, 403);
  assert.equal(entry.url.path, '/i/api/graphql/query-id/Bookmarks');
  assert.deepEqual(entry.url.queryKeys, ['variables']);
  assert.equal(entry.requestHeaders.cookie, '[redacted]');
  assert.equal(entry.requestHeaders['x-csrf-token'], '[redacted]');
  assert.equal(entry.responseHeaders['x-rate-limit-remaining'], '12');

  const rawLog = fs.readFileSync(logPath, 'utf8');
  assert.doesNotMatch(rawLog, /secret-token/);
  assert.doesNotMatch(rawLog, /secret-csrf/);
  assert.doesNotMatch(rawLog, /1234567890/);
  assert.match(rawLog, /tweetIdHash/);
});

test('controlledFetch stops when the per-run request budget is reached', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    configureHttpSafety({ requestBudget: 1, minDelayMs: 0 });
    await controlledFetch('https://x.com/i/api/graphql/query-id/Bookmarks');
    await assert.rejects(
      () => controlledFetch('https://x.com/i/api/graphql/query-id/Bookmarks'),
      (error) => error instanceof HttpSafetyStopError && error.stopReason === 'request budget reached',
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetHttpSafetyForTests();
  }
});

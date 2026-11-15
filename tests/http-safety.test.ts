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
  serverCooldownUntil,
} from '../src/http-safety.js';

test('server cooldown parsing handles non-429 responses, HTTP dates and the later 429 reset', () => {
  const now = Date.parse('2026-11-15T19:00:00Z');
  assert.equal(serverCooldownUntil(524, new Headers({ 'retry-after': '120' }), now), now + 120_000);
  assert.equal(serverCooldownUntil(503, new Headers({ 'retry-after': 'Sun, 15 Nov 2026 19:02:00 GMT' }), now), now + 120_000);
  assert.equal(serverCooldownUntil(429, new Headers({ 'retry-after': '120', 'x-rate-limit-reset': String((now + 180_000) / 1000) }), now), now + 180_000);
  assert.equal(serverCooldownUntil(429, new Headers(), now), now + 900_000);
  assert.equal(serverCooldownUntil(200, new Headers({ 'x-rate-limit-reset': String((now + 180_000) / 1000) }), now), undefined);
  for (const value of ['invalid', '-1', '1e100']) {
    assert.equal(serverCooldownUntil(524, new Headers({ 'retry-after': value }), now), undefined);
  }
  assert.equal(serverCooldownUntil(524, new Headers({ 'retry-after': '0' }), now), now);
  assert.equal(serverCooldownUntil(503, new Headers({ 'retry-after': 'Sun, 15 Nov 2026 18:59:00 GMT' }), now), now - 60_000);
});

test('server-directed cooldowns stop manual and unattended callers before their retry loops', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-server-cooldown-'));
  let now = Date.parse('2026-11-15T19:00:00Z');
  Date.now = () => now;
  try {
    for (const stopOnBlockedResponse of [false, true]) {
      for (const status of [524, 503]) {
        let calls = 0;
        const log = path.join(directory, `${stopOnBlockedResponse}-${status}.jsonl`);
        const retryAfter = status === 524 ? '120' : new Date(now + 120_000).toUTCString();
        globalThis.fetch = (async () => {
          calls++;
          return new Response('{}', { status, headers: { 'retry-after': retryAfter } });
        }) as typeof fetch;
        configureHttpSafety({ auditHttp: true, auditLogPath: log, minDelayMs: 0, stopOnBlockedResponse });
        await assert.rejects(() => controlledFetch('https://x.com/test'), (error) =>
          error instanceof HttpSafetyStopError && error.stopReason === 'server cooldown requested');
        now += 180_000;
        await assert.rejects(() => controlledFetch('https://x.com/test'), HttpSafetyStopError);
        assert.equal(calls, 1, 'the run stays stopped even if the caller catches the error or time advances');
        const entry = JSON.parse(fs.readFileSync(log, 'utf8'));
        assert.equal(entry.status, status);
        assert.equal(entry.responseHeaders['retry-after'], retryAfter);
      }
    }
  } finally {
    globalThis.fetch = originalFetch; Date.now = originalNow; resetHttpSafetyForTests();
    fs.rmSync(directory, { recursive: true });
  }
});

test('audit snippets bound untrusted response bodies without consuming the original response', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-audit-size-'));
  const log = path.join(directory, 'audit.jsonl'), previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response('A'.repeat(20000), { status: 503 })) as typeof fetch;
  try {
    configureHttpSafety({ auditHttp: true, auditLogPath: log, minDelayMs: 0 });
    const response = await controlledFetch('https://example.org/unavailable', {}, { category: 'external' });
    assert.equal((await response.text()).length, 20000);
    const entry = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.equal(entry.responseSnippet.length, 500); assert.equal(entry.responseSnippetTruncated, true);
  } finally { globalThis.fetch = previous; resetHttpSafetyForTests(); fs.rmSync(directory, { recursive: true }); }
});

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

test('scheduled request deadline prevents requests, including after waiting for spacing', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalTimeout = globalThis.setTimeout;
  let now = 1_000_000;
  Date.now = () => now;
  globalThis.setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    now += Number(delay ?? 0);
    return originalTimeout(handler, 0, ...args);
  }) as typeof setTimeout;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  try {
    configureHttpSafety({ minDelayMs: 0, stopAt: Date.now() - 1 });
    await assert.rejects(() => controlledFetch('https://x.com/test'), (error) =>
      error instanceof HttpSafetyStopError && error.stopReason === 'scheduled request window ended');
    assert.equal(calls, 0);
    configureHttpSafety({ minDelayMs: 50, stopAt: Date.now() + 30 });
    await controlledFetch('https://x.com/test');
    await assert.rejects(() => controlledFetch('https://x.com/test'), (error) =>
      error instanceof HttpSafetyStopError && error.stopReason === 'scheduled request window ended');
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow; globalThis.setTimeout = originalTimeout;
    globalThis.fetch = originalFetch; resetHttpSafetyForTests();
  }
});

test('unattended response guard stops immediately on 429 and authentication failures', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [429, 401, 403]) {
      let calls = 0;
      globalThis.fetch = (async () => { calls++; return new Response('{}', { status }); }) as typeof fetch;
      configureHttpSafety({ minDelayMs: 0, stopOnBlockedResponse: true });
      await assert.rejects(() => controlledFetch('https://x.com/test'), (error) =>
        error instanceof HttpSafetyStopError && error.stopReason === (status === 429 ? 'X returned HTTP 429' : 'Authentication or access failure'));
      await assert.rejects(() => controlledFetch('https://x.com/test'), HttpSafetyStopError);
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = originalFetch; resetHttpSafetyForTests(); }
});

test('rate-floor stops remain latched even if a caller catches the first stop', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{}', { headers: { 'x-rate-limit-remaining': '200' } });
  }) as typeof fetch;
  try {
    configureHttpSafety({ minDelayMs: 0, rateLimitFloor: 200 });
    await assert.rejects(() => controlledFetch('https://x.com/test'), HttpSafetyStopError);
    await assert.rejects(() => controlledFetch('https://x.com/test'), HttpSafetyStopError);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; resetHttpSafetyForTests(); }
});

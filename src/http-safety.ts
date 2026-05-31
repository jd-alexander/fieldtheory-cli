import { createHash } from 'node:crypto';
import { appendLine } from './fs.js';
import { httpAuditLogPath } from './paths.js';

export type HttpRequestCategory = 'x-graphql' | 'x-syndication' | 'media' | 'x-api' | 'external';

export interface ControlledFetchMetadata {
  operation?: string;
  category?: HttpRequestCategory;
  attempt?: number;
  cursorPresent?: boolean;
  tweetId?: string;
  folderId?: string;
}

export interface HttpSafetyConfig {
  auditHttp?: boolean;
  auditHttpBody?: boolean;
  auditLogPath?: string;
  minDelayMs?: number;
  jitterMs?: number;
  requestBudget?: number;
  maxRequestsPerHour?: number;
  rateLimitFloor?: number;
}

type HttpSafetyStopReason = 'request budget reached' | 'hourly request budget reached' | 'rate limit floor reached';

export class HttpSafetyStopError extends Error {
  constructor(
    message: string,
    readonly stopReason: HttpSafetyStopReason,
  ) {
    super(message);
    this.name = 'HttpSafetyStopError';
  }
}

interface ResolvedHttpSafetyConfig {
  auditHttp: boolean;
  auditHttpBody: boolean;
  auditLogPath: string;
  minDelayMs?: number;
  jitterMs: number;
  requestBudget?: number;
  maxRequestsPerHour?: number;
  rateLimitFloor?: number;
}

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'x-twitter-auth-type',
  'x-twitter-client-language',
]);

let controller: HttpSafetyController | undefined;
let currentConfig: ResolvedHttpSafetyConfig | undefined;

function truthyEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInt(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function nonNegativeInt(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function resolveConfig(config: HttpSafetyConfig = {}): ResolvedHttpSafetyConfig {
  const auditHttpBody = config.auditHttpBody ?? truthyEnv(process.env.FT_HTTP_AUDIT_BODY);
  const auditHttp = config.auditHttp ?? (truthyEnv(process.env.FT_HTTP_AUDIT) || auditHttpBody);
  const minDelayMs = nonNegativeInt(config.minDelayMs ?? numberFromEnv('FT_HTTP_MIN_DELAY_MS'));
  return {
    auditHttp,
    auditHttpBody,
    auditLogPath: config.auditLogPath ?? process.env.FT_HTTP_AUDIT_PATH ?? httpAuditLogPath(),
    minDelayMs,
    jitterMs: nonNegativeInt(config.jitterMs ?? numberFromEnv('FT_HTTP_JITTER_MS')) ?? 0,
    requestBudget: positiveInt(config.requestBudget ?? numberFromEnv('FT_HTTP_REQUEST_BUDGET')),
    maxRequestsPerHour: positiveInt(config.maxRequestsPerHour ?? numberFromEnv('FT_HTTP_MAX_REQUESTS_PER_HOUR')),
    rateLimitFloor: nonNegativeInt(config.rateLimitFloor ?? numberFromEnv('FT_HTTP_RATE_LIMIT_FLOOR')),
  };
}

export function configureHttpSafety(config: HttpSafetyConfig = {}): void {
  currentConfig = resolveConfig(config);
  controller = new HttpSafetyController(currentConfig);
}

export function getHttpSafetyConfig(): ResolvedHttpSafetyConfig {
  if (!currentConfig) configureHttpSafety();
  return currentConfig!;
}

export function resetHttpSafetyForTests(): void {
  controller = undefined;
  currentConfig = undefined;
}

export function isHttpSafetyStop(error: unknown): error is HttpSafetyStopError {
  return error instanceof HttpSafetyStopError;
}

export function httpSafetyAuditPath(): string | undefined {
  const config = getHttpSafetyConfig();
  return config.auditHttp ? config.auditLogPath : undefined;
}

function hashValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function headerObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    out[lower] = SENSITIVE_HEADER_NAMES.has(lower) ? '[redacted]' : value;
  }
  return out;
}

function selectedResponseHeaders(headers: Headers): Record<string, string> {
  const names = [
    'date',
    'content-type',
    'content-length',
    'retry-after',
    'x-rate-limit-limit',
    'x-rate-limit-remaining',
    'x-rate-limit-reset',
  ];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value != null) out[name] = value;
  }
  return out;
}

function sanitizeUrl(input: string): { origin?: string; path: string; queryKeys: string[]; operationFromPath?: string } {
  try {
    const url = new URL(input);
    const parts = url.pathname.split('/').filter(Boolean);
    const operationFromPath = parts[2] === 'graphql' ? parts[4] : undefined;
    return {
      origin: url.origin,
      path: url.pathname,
      queryKeys: Array.from(url.searchParams.keys()).sort(),
      operationFromPath,
    };
  } catch {
    return { path: input, queryKeys: [] };
  }
}

function redactText(value: string): string {
  return value
    .replace(/auth_token=([^;\s&]+)/gi, 'auth_token=[redacted]')
    .replace(/ct0=([^;\s&]+)/gi, 'ct0=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9%._-]+/g, 'Bearer [redacted]')
    .replace(/("?(?:cookie|authorization|x-csrf-token)"?\s*:\s*")([^"]+)(")/gi, '$1[redacted]$3')
    .replace(/\s+/g, ' ')
    .slice(0, 1000);
}

function responseRateRemaining(response: Response): number | undefined {
  const raw = response.headers.get('x-rate-limit-remaining');
  if (raw == null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

class HttpSafetyController {
  private requestCount = 0;
  private requestTimestamps: number[] = [];
  private lastRequestAt = 0;

  constructor(private readonly config: ResolvedHttpSafetyConfig) {}

  async fetch(input: string | URL | Request, init: RequestInit | undefined, metadata: ControlledFetchMetadata): Promise<Response> {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));

    await this.beforeRequest();
    const started = Date.now();
    let response: Response | undefined;
    try {
      response = await globalThis.fetch(input, init);
    } catch (error) {
      await this.audit({
        metadata,
        method,
        url,
        requestHeaders,
        started,
        error,
      });
      throw error;
    }

    await this.audit({
      metadata,
      method,
      url,
      requestHeaders,
      started,
      response,
    });

    this.stopIfRateLimitFloorReached(response);
    return response;
  }

  private async beforeRequest(): Promise<void> {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < 60 * 60_000);

    if (this.config.requestBudget != null && this.requestCount >= this.config.requestBudget) {
      throw new HttpSafetyStopError(
        `HTTP request budget reached (${this.requestCount}/${this.config.requestBudget}).`,
        'request budget reached',
      );
    }

    if (this.config.maxRequestsPerHour != null && this.requestTimestamps.length >= this.config.maxRequestsPerHour) {
      throw new HttpSafetyStopError(
        `Hourly HTTP request budget reached (${this.requestTimestamps.length}/${this.config.maxRequestsPerHour}).`,
        'hourly request budget reached',
      );
    }

    const minDelay = this.config.minDelayMs ?? 0;
    if (this.lastRequestAt > 0 && minDelay > 0) {
      const jitter = this.config.jitterMs > 0 ? Math.floor(Math.random() * (this.config.jitterMs + 1)) : 0;
      const targetDelay = minDelay + jitter;
      const elapsed = now - this.lastRequestAt;
      if (elapsed < targetDelay) {
        await new Promise((resolve) => setTimeout(resolve, targetDelay - elapsed));
      }
    }

    this.requestCount += 1;
    this.requestTimestamps.push(Date.now());
    this.lastRequestAt = Date.now();
  }

  private stopIfRateLimitFloorReached(response: Response): void {
    if (this.config.rateLimitFloor == null || response.status === 429) return;
    const remaining = responseRateRemaining(response);
    if (remaining == null || remaining > this.config.rateLimitFloor) return;
    throw new HttpSafetyStopError(
      `X rate-limit remaining count (${remaining}) is at or below the configured floor (${this.config.rateLimitFloor}).`,
      'rate limit floor reached',
    );
  }

  private async audit(input: {
    metadata: ControlledFetchMetadata;
    method: string;
    url: string;
    requestHeaders: Headers;
    started: number;
    response?: Response;
    error?: unknown;
  }): Promise<void> {
    if (!this.config.auditHttp) return;

    const { origin, path, queryKeys, operationFromPath } = sanitizeUrl(input.url);
    const response = input.response;
    let responseSnippet: string | undefined;
    let responseSnippetTruncated: boolean | undefined;

    const shouldCaptureSnippet = response
      && input.metadata.category !== 'media'
      && (this.config.auditHttpBody || !response.ok);
    if (shouldCaptureSnippet) {
      try {
        const text = await response.clone().text();
        const redacted = redactText(text);
        responseSnippet = redacted.slice(0, 500);
        responseSnippetTruncated = redacted.length > responseSnippet.length;
      } catch {
        responseSnippet = '[unavailable]';
      }
    }

    const entry = {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      operation: input.metadata.operation ?? operationFromPath ?? 'unknown',
      category: input.metadata.category ?? 'external',
      method: input.method,
      url: { origin, path, queryKeys },
      cursorPresent: input.metadata.cursorPresent,
      attempt: input.metadata.attempt,
      tweetIdHash: hashValue(input.metadata.tweetId),
      folderIdHash: hashValue(input.metadata.folderId),
      requestHeaders: headerObject(input.requestHeaders),
      requestNumber: this.requestCount,
      durationMs: Date.now() - input.started,
      status: response?.status,
      ok: response?.ok,
      responseHeaders: response ? selectedResponseHeaders(response.headers) : undefined,
      responseSnippet,
      responseSnippetTruncated,
      errorName: input.error instanceof Error ? input.error.name : undefined,
      errorMessage: input.error instanceof Error ? redactText(input.error.message) : input.error == null ? undefined : redactText(String(input.error)),
      limits: {
        requestBudget: this.config.requestBudget,
        maxRequestsPerHour: this.config.maxRequestsPerHour,
        rateLimitFloor: this.config.rateLimitFloor,
      },
    };

    try {
      await appendLine(this.config.auditLogPath, JSON.stringify(entry));
    } catch {
      // Audit logging is diagnostic only; never break extraction because the
      // log path is temporarily unavailable.
    }
  }
}

export async function controlledFetch(
  input: string | URL | Request,
  init?: RequestInit,
  metadata: ControlledFetchMetadata = {},
): Promise<Response> {
  if (!controller) configureHttpSafety();
  return controller!.fetch(input, init, metadata);
}

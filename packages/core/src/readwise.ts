import type { FetchLike, ListResponse, ReaderDocument, Sleep } from './types.js';

export const READWISE_BASE = 'https://readwise.io';

/** HTTP-level failure from Readwise (anything other than a network error). */
export class ReadwiseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ReadwiseError';
  }
}

/** The request never got an HTTP response (offline, DNS, TLS). Callers queue work on this. */
export class NetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface ReadwiseClientOptions {
  token: string;
  fetch: FetchLike;
  sleep?: Sleep;
  baseUrl?: string;
  /** How many times to retry after a 429 before giving up. */
  maxRetries?: number;
  /** Used when a 429 has no usable Retry-After header. */
  defaultRetryAfterSeconds?: number;
  /** Called before each rate-limit wait, so UIs can say "Waiting 30s for Readwise". */
  onRateLimit?: (waitSeconds: number) => void;
}

export interface ListOptions {
  location?: string;
  category?: string;
  /** Reader accepts up to 5 tags. */
  tags?: string[];
  updatedAfter?: string;
  withHtmlContent?: boolean;
  /** Page size, 1 to 100. */
  pageSize?: number;
  /** Stop after this many top-level documents. */
  limit?: number;
  /** Keep only documents this returns true for; `limit` counts kept documents only. */
  accept?: (doc: ReaderDocument) => boolean;
}

export interface CreateHighlightInput {
  /** Reader document the highlight belongs to. */
  parentId: string;
  text: string;
  note?: string;
  tags?: string[];
}

export interface ReaderHighlight {
  id: string;
  parentId: string;
  text: string;
  note: string;
  updatedAt: string;
}

export interface CreateHighlightResult {
  id: string;
  url?: string;
}

declare const setTimeout: (fn: () => void, ms: number) => unknown;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseRetryAfter(value: string | null, fallbackSeconds: number, now = Date.now()): number {
  if (!value) return fallbackSeconds;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return fallbackSeconds;
}

export class ReadwiseClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly defaultRetryAfter: number;
  private readonly onRateLimit?: (waitSeconds: number) => void;

  constructor(opts: ReadwiseClientOptions) {
    if (!opts.token) throw new Error('A Readwise token is required.');
    this.token = opts.token;
    this.fetchImpl = opts.fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.baseUrl = (opts.baseUrl ?? READWISE_BASE).replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? 5;
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 60;
    this.onRateLimit = opts.onRateLimit;
  }

  /** `true` for a valid token, `false` for a rejected one. Network problems throw `NetworkError`. */
  async validateToken(): Promise<boolean> {
    const res = await this.request('GET', '/api/v2/auth/', undefined, { allowStatuses: [401, 403] });
    return res.status === 204 || res.status === 200;
  }

  /**
   * All top-level documents matching the options, following `nextPageCursor`.
   * Highlights and notes (anything with a `parent_id`) are filtered out.
   */
  async listDocuments(opts: ListOptions = {}): Promise<ReaderDocument[]> {
    const out: ReaderDocument[] = [];
    let cursor: string | null = null;
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? opts.limit ?? 100));
    do {
      const params = new URLSearchParamsLite();
      if (opts.location) params.set('location', opts.location);
      if (opts.category) params.set('category', opts.category);
      for (const tag of tagKeys(opts.tags)) params.append('tag', tag);
      if (opts.updatedAfter) params.set('updatedAfter', opts.updatedAfter);
      if (opts.withHtmlContent) params.set('withHtmlContent', 'true');
      params.set('limit', String(pageSize));
      if (cursor) params.set('pageCursor', cursor);
      const res = await this.request('GET', `/api/v3/list/?${params.toString()}`);
      const page = (await res.json()) as ListResponse;
      for (const doc of page.results ?? []) {
        if (doc.parent_id) continue;
        if (opts.accept && !opts.accept(doc)) continue;
        out.push(doc);
        if (opts.limit && out.length >= opts.limit) return out;
      }
      cursor = page.nextPageCursor ?? null;
    } while (cursor);
    return out;
  }

  /**
   * Highlights in the account, optionally only those changed after a time.
   * Each comes back as a Reader item whose `parent_id` is its document.
   */
  async listHighlights(opts: { updatedAfter?: string } = {}): Promise<ReaderHighlight[]> {
    const out: ReaderHighlight[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParamsLite();
      params.set('category', 'highlight');
      if (opts.updatedAfter) params.set('updatedAfter', opts.updatedAfter);
      params.set('limit', '100');
      if (cursor) params.set('pageCursor', cursor);
      const res = await this.request('GET', `/api/v3/list/?${params.toString()}`);
      const page = (await res.json()) as ListResponse;
      for (const item of page.results ?? []) {
        if (item.parent_id && typeof item.content === 'string' && item.content.trim()) {
          out.push({
            id: item.id,
            parentId: item.parent_id,
            text: item.content,
            note: typeof item.notes === 'string' ? item.notes : '',
            updatedAt: item.updated_at,
          });
        }
      }
      cursor = page.nextPageCursor ?? null;
    } while (cursor);
    return out;
  }

  /** One document by id, or `null` if Reader doesn't know it. */
  async getDocument(id: string, withHtmlContent = false): Promise<ReaderDocument | null> {
    const params = new URLSearchParamsLite();
    params.set('id', id);
    if (withHtmlContent) params.set('withHtmlContent', 'true');
    const res = await this.request('GET', `/api/v3/list/?${params.toString()}`);
    const page = (await res.json()) as ListResponse;
    return page.results?.find((d) => d.id === id) ?? null;
  }

  /**
   * Create a highlight on a Reader document via `POST /api/v3/save/`.
   * Readwise answers 400 when `text` doesn't appear in the parent's `html_content`.
   */
  async createHighlight(input: CreateHighlightInput): Promise<CreateHighlightResult> {
    // With parent_id set, Reader accepts only: category, content, notes, parent_id, saved_using, tags.
    const body: Record<string, unknown> = {
      parent_id: input.parentId,
      content: input.text,
      saved_using: 'Inkwise',
    };
    if (input.note) body.notes = input.note;
    if (input.tags?.length) body.tags = input.tags;
    const res = await this.request('POST', '/api/v3/save/', body);
    const json = (await safeJson(res)) as { id?: string; url?: string };
    return { id: json.id ?? '', url: json.url };
  }

  /**
   * Last-resort fallback: the classic highlights API. It doesn't attach to the
   * Reader document, but it keeps the text in Readwise under the same title.
   */
  async createClassicHighlight(input: {
    text: string;
    title: string;
    author?: string | null;
    sourceUrl?: string | null;
    note?: string;
    highlightedAt?: string;
  }): Promise<void> {
    await this.request('POST', '/api/v2/highlights/', {
      highlights: [
        {
          text: input.text,
          title: input.title,
          author: input.author ?? undefined,
          source_url: input.sourceUrl ?? undefined,
          source_type: 'inkwise',
          category: 'articles',
          note: input.note || undefined,
          highlighted_at: input.highlightedAt,
        },
      ],
    });
  }

  /** Set the note on an existing highlight (Reader only allows `notes` and `tags` here). */
  async updateHighlightNotes(highlightId: string, notes: string): Promise<void> {
    await this.request('PATCH', `/api/v3/update/${encodeURIComponent(highlightId)}/`, { notes });
  }

  /** Move a Reader document to a location (Inkwise uses `archive`). */
  async moveDocument(id: string, location: string): Promise<void> {
    await this.request('PATCH', `/api/v3/update/${encodeURIComponent(id)}/`, { location });
  }

  /** Delete a Reader item. Highlights are items too, so this deletes highlights. */
  async deleteDocument(id: string): Promise<void> {
    await this.request('DELETE', `/api/v3/delete/${encodeURIComponent(id)}/`);
  }

  async archive(id: string): Promise<void> {
    await this.moveDocument(id, 'archive');
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { allowStatuses?: number[] } = {},
  ): Promise<{ status: number; json(): Promise<any> }> {
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Token ${this.token}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        throw new NetworkError(`Could not reach Readwise (${describe(err)}).`, err);
      }
      if (res.status === 429 && attempt < this.maxRetries) {
        attempt++;
        const wait = parseRetryAfter(res.headers.get('Retry-After'), this.defaultRetryAfter);
        this.onRateLimit?.(wait);
        await this.sleep(wait * 1000 + 250);
        continue;
      }
      if (res.ok || opts.allowStatuses?.includes(res.status)) return res;
      const text = await res.text().catch(() => '');
      throw new ReadwiseError(errorMessage(method, path, res.status), res.status, text);
    }
  }
}

/**
 * Reader filters by a tag's key, which is its name in lowercase ("Evidence" is
 * stored as "evidence"), and the filter is case-sensitive: asking for the
 * display name finds nothing (checked against the live API, 2026-10-09).
 */
export function tagKeys(tags: readonly string[] | undefined): string[] {
  return (tags ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 5);
}

function errorMessage(method: string, path: string, status: number): string {
  const route = path.split('?')[0];
  if (status === 401 || status === 403) return 'Readwise token rejected. Open Inkwise settings to re-enter it.';
  if (status === 429) return 'Readwise is rate limiting us. Try again in a minute.';
  return `Readwise ${method} ${route} failed with HTTP ${status}.`;
}

async function safeJson(res: { json(): Promise<any> }): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Tiny URLSearchParams stand-in: React Native's built-in one is incomplete. */
class URLSearchParamsLite {
  private pairs: [string, string][] = [];
  set(k: string, v: string) {
    this.pairs = this.pairs.filter(([key]) => key !== k);
    this.pairs.push([k, v]);
  }
  append(k: string, v: string) {
    this.pairs.push([k, v]);
  }
  toString() {
    return this.pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }
}

/**
 * An in-memory stand-in for the Readwise API, shaped after the documented
 * behaviour. Used by tests and by `inkwise sync --mock`, so everything can be
 * exercised without a real token.
 *
 * Highlight matching is deliberately strict: the highlight text must appear in
 * the parent's text (whitespace runs collapsed), otherwise HTTP 400, which is
 * the failure mode the real API documents.
 */
import { htmlToText } from '../highlights.js';
import type { FetchLike, FetchResponseLike, ReaderDocument } from '../types.js';

export interface FakeHighlight {
  id: string;
  parent_id: string;
  content: string;
  notes: string;
  tags: string[];
  saved_using?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FakeReadwiseOptions {
  token?: string;
  documents?: ReaderDocument[];
  /** Images served by URL. */
  images?: Record<string, Uint8Array>;
  pageSize?: number;
}

export interface FakeRequest {
  method: string;
  url: string;
  body?: any;
}

export class FakeReadwise {
  token: string;
  documents: ReaderDocument[];
  highlights: FakeHighlight[] = [];
  classicHighlights: any[] = [];
  images: Record<string, Uint8Array>;
  requests: FakeRequest[] = [];
  /** When true every request fails like a dropped connection. */
  offline = false;
  /** The next N requests get a 429 with this Retry-After. */
  rateLimitNext = 0;
  retryAfterSeconds = 1;
  /** Force a status for the next request to a path prefix, e.g. { '/api/v3/save/': 500 }. */
  failNext: Record<string, number> = {};
  /** Documents that show up in listings but are gone when fetched by id (deleted mid-sync). */
  vanishOnFetch = new Set<string>();
  private nextId = 1;
  /** Timestamp source for highlights; tests can pin it. */
  clock: () => string = () => new Date().toISOString();
  private readonly pageSize: number;

  constructor(opts: FakeReadwiseOptions = {}) {
    this.token = opts.token ?? 'test-token';
    this.documents = (opts.documents ?? []).map((d) => ({ ...d }));
    this.images = opts.images ?? {};
    this.pageSize = opts.pageSize ?? 100;
  }

  readonly fetch: FetchLike = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url, body });
    if (this.offline) throw new TypeError('Network request failed');

    if (this.images[url]) return respond(200, this.images[url]!);
    if (!url.startsWith('https://readwise.io/')) return respond(404, '');

    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      return respond(429, { detail: 'Request was throttled.' }, { 'Retry-After': String(this.retryAfterSeconds) });
    }
    const path = url.slice('https://readwise.io'.length).split('?')[0]!;
    for (const [prefix, status] of Object.entries(this.failNext)) {
      if (path.startsWith(prefix)) {
        delete this.failNext[prefix];
        return respond(status, { detail: 'forced failure' });
      }
    }
    if (init.headers?.Authorization !== `Token ${this.token}`) {
      return respond(401, { detail: 'Invalid token.' });
    }
    const query = parseQuery(url);

    if (method === 'GET' && path === '/api/v2/auth/') return respond(204, '');
    if (method === 'GET' && path === '/api/v3/list/') return this.list(query);
    if (method === 'POST' && path === '/api/v3/save/') return this.save(body);
    if (method === 'POST' && path === '/api/v2/highlights/') {
      this.classicHighlights.push(...(body?.highlights ?? []));
      return respond(200, [{ id: 1, title: body?.highlights?.[0]?.title, modified_highlights: [1] }]);
    }
    const update = /^\/api\/v3\/update\/([^/]+)\/$/.exec(path);
    if (method === 'PATCH' && update) {
      const targetId = decodeURIComponent(update[1]!);
      const hl = this.highlights.find((h) => h.id === targetId);
      if (hl) {
        const extra = Object.keys(body ?? {}).filter((k) => k !== 'notes' && k !== 'tags');
        if (extra.length) return respond(400, { detail: `Highlights only accept notes and tags.` });
        if (typeof body?.notes === 'string') hl.notes = body.notes;
        if (Array.isArray(body?.tags)) hl.tags = body.tags;
        hl.updatedAt = this.clock();
        return respond(200, { id: hl.id, url: `https://read.readwise.io/read/${hl.id}` });
      }
      const doc = this.documents.find((d) => d.id === targetId);
      if (!doc) return respond(404, { detail: 'Not found.' });
      Object.assign(doc, body ?? {});
      doc.updated_at = new Date().toISOString();
      return respond(200, { id: doc.id, url: doc.url });
    }
    const del = /^\/api\/v3\/delete\/([^/]+)\/$/.exec(path);
    if (method === 'DELETE' && del) {
      const targetId = decodeURIComponent(del[1]!);
      const before = this.highlights.length + this.documents.length;
      this.highlights = this.highlights.filter((h) => h.id !== targetId);
      this.documents = this.documents.filter((d) => d.id !== targetId);
      if (this.highlights.length + this.documents.length === before) return respond(404, { detail: 'Not found.' });
      return respond(204, '');
    }
    return respond(404, { detail: 'Not found.' });
  };

  private list(q: Record<string, string[]>) {
    // Reader lists highlights alongside documents; filters below apply to both.
    const hl = this.highlights.map((h) => ({
      id: h.id,
      url: `https://read.readwise.io/read/${h.id}`,
      source_url: null,
      title: null,
      author: null,
      category: 'highlight',
      location: null,
      created_at: h.createdAt,
      updated_at: h.updatedAt,
      parent_id: h.parent_id,
      content: h.content,
      notes: h.notes,
    })) as ReaderDocument[];
    let docs = [...this.documents, ...hl];
    const id = q.id?.[0];
    if (id) docs = this.vanishOnFetch.has(id) ? [] : docs.filter((d) => d.id === id);
    const location = q.location?.[0];
    if (location) docs = docs.filter((d) => d.location === location);
    const category = q.category?.[0];
    if (category) docs = docs.filter((d) => d.category === category);
    for (const tag of q.tag ?? []) docs = docs.filter((d) => d.tags && Object.keys(d.tags).includes(tag));
    const updatedAfter = q.updatedAfter?.[0];
    if (updatedAfter) docs = docs.filter((d) => d.updated_at > updatedAfter);

    const limit = Math.min(Number(q.limit?.[0] ?? this.pageSize), this.pageSize);
    const start = Number(q.pageCursor?.[0] ?? 0);
    const page = docs.slice(start, start + limit);
    const withHtml = q.withHtmlContent?.[0] === 'true';
    const results = page.map((d) => {
      const copy: any = { ...d };
      if (!withHtml) delete copy.html_content;
      return copy;
    });
    const next = start + limit < docs.length ? String(start + limit) : null;
    return respond(200, { count: docs.length, nextPageCursor: next, results });
  }

  private save(body: any) {
    if (!body) return respond(400, { detail: 'Body required' });
    if (body.parent_id) {
      const allowed = new Set(['category', 'content', 'notes', 'parent_id', 'saved_using', 'tags']);
      const extra = Object.keys(body).filter((k) => !allowed.has(k));
      if (extra.length) return respond(400, { detail: `Unexpected fields: ${extra.join(', ')}` });
      const parent = this.documents.find((d) => d.id === body.parent_id);
      if (!parent) return respond(404, { detail: 'Parent not found.' });
      const text = collapse(htmlToText(parent.html_content ?? parent.content ?? ''));
      const content = collapse(String(body.content ?? ''));
      if (!content || !text.includes(content)) {
        return respond(400, { detail: "Couldn't find the highlight text in the parent document." });
      }
      const id = `hl${this.nextId++}`;
      this.highlights.push({
        id,
        parent_id: body.parent_id,
        content: body.content,
        notes: body.notes ?? '',
        tags: body.tags ?? [],
        saved_using: body.saved_using,
        createdAt: this.clock(),
        updatedAt: this.clock(),
      });
      return respond(201, { id, url: `https://read.readwise.io/read/${id}` });
    }
    if (!body.url) return respond(400, { detail: 'url is required' });
    const id = `doc${this.nextId++}`;
    return respond(201, { id, url: `https://read.readwise.io/new/read/${id}` });
  }
}

function collapse(s: string) {
  return s.replace(/\s+/g, ' ').trim();
}

function parseQuery(url: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const q = url.split('?')[1];
  if (!q) return out;
  for (const part of q.split('&')) {
    const [k, v = ''] = part.split('=');
    const key = decodeURIComponent(k!);
    (out[key] ??= []).push(decodeURIComponent(v.replace(/\+/g, ' ')));
  }
  return out;
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  const isBytes = body instanceof Uint8Array;
  const text = isBytes ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => {
      if (isBytes) return (body as Uint8Array).slice().buffer as ArrayBuffer;
      const enc = new Uint8Array([...text].map((c) => c.charCodeAt(0) & 0xff));
      return enc.buffer as ArrayBuffer;
    },
  };
}

/** A 1x1 grey PNG and GIF, enough for image-embedding tests. */
export const TINY_PNG = base64ToBytes(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
);
export const TINY_GIF = base64ToBytes('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==');

function base64ToBytes(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of clean) {
    buffer = (buffer << 6) | chars.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

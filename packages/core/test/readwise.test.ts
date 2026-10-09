import { describe, expect, it } from 'vitest';
import { NetworkError, ReadwiseClient, ReadwiseError, parseRetryAfter } from '../src/index.js';
import { FakeReadwise } from '../src/testing/fake-readwise.js';
import { loadFixtures, noSleep } from './helpers.js';

function setup(opts: { pageSize?: number } = {}) {
  const fake = new FakeReadwise({ documents: loadFixtures(), pageSize: opts.pageSize });
  const waits: number[] = [];
  const client = new ReadwiseClient({
    token: 'test-token',
    fetch: fake.fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { fake, client, waits };
}

describe('ReadwiseClient', () => {
  it('validates tokens', async () => {
    const { fake, client } = setup();
    expect(await client.validateToken()).toBe(true);
    const bad = new ReadwiseClient({ token: 'nope', fetch: fake.fetch, sleep: noSleep });
    expect(await bad.validateToken()).toBe(false);
    expect(fake.requests.at(-1)!.url).toBe('https://readwise.io/api/v2/auth/');
  });

  it('follows nextPageCursor and filters out highlights', async () => {
    const { fake, client } = setup({ pageSize: 1 });
    fake.highlights.push({ id: 'hlX', parent_id: loadFixtures()[0]!.id, content: 'x', notes: '', tags: [], createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' });
    const docs = await client.listDocuments({ location: 'later', category: 'article', withHtmlContent: true });
    expect(docs.map((d) => d.id).sort()).toEqual(loadFixtures().map((d) => d.id).sort());
    expect(docs.every((d) => d.html_content)).toBe(true);
    expect(fake.requests.filter((r) => r.url.includes('/api/v3/list/')).length).toBe(4);
    expect(fake.requests[0]!.url).toContain('location=later');
    expect(fake.requests[0]!.url).toContain('withHtmlContent=true');
  });

  it('stops at limit', async () => {
    const { client } = setup({ pageSize: 1 });
    expect((await client.listDocuments({ limit: 2 })).length).toBe(2);
  });

  it('passes tags as repeated params, max 5, as lowercase keys', async () => {
    const { fake, client } = setup();
    await client.listDocuments({ tags: ['a', 'B c ', ' ', 'd', 'e', 'f', 'g'] });
    const url = fake.requests[0]!.url;
    expect(url.match(/tag=/g)!.length).toBe(5);
    // Reader's filter wants the tag key ("b c"), not the display name ("B c").
    expect(url).toContain('tag=b%20c');
    expect(url).not.toContain('tag=B');
  });

  it('waits for Retry-After on 429 and retries', async () => {
    const { fake, client, waits } = setup();
    fake.rateLimitNext = 2;
    fake.retryAfterSeconds = 7;
    const docs = await client.listDocuments();
    expect(docs.length).toBe(4);
    expect(waits).toEqual([7250, 7250]);
  });

  it('gives up after maxRetries', async () => {
    const fake = new FakeReadwise();
    fake.rateLimitNext = 10;
    const client = new ReadwiseClient({ token: 'test-token', fetch: fake.fetch, sleep: noSleep, maxRetries: 2 });
    await expect(client.listDocuments()).rejects.toMatchObject({ status: 429 });
  });

  it('raises NetworkError when offline and ReadwiseError on HTTP errors', async () => {
    const { fake, client } = setup();
    fake.offline = true;
    await expect(client.listDocuments()).rejects.toBeInstanceOf(NetworkError);
    fake.offline = false;
    fake.failNext['/api/v3/list/'] = 500;
    await expect(client.listDocuments()).rejects.toBeInstanceOf(ReadwiseError);
  });

  it('sends only the allowed keys when creating a highlight', async () => {
    const { fake, client } = setup();
    const doc = loadFixtures().find((d) => d.id.includes('longform'))!;
    await client.createHighlight({ parentId: doc.id, text: 'Speed is a habit, not a virtue.', note: 'yes', tags: ['t'] });
    const req = fake.requests.at(-1)!;
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({ parent_id: doc.id, content: 'Speed is a habit, not a virtue.', saved_using: 'Inkwise', notes: 'yes', tags: ['t'] });
    expect(fake.highlights.length).toBe(1);
  });

  it('archives via PATCH', async () => {
    const { fake, client } = setup();
    const id = loadFixtures()[0]!.id;
    await client.archive(id);
    expect(fake.requests.at(-1)).toMatchObject({ method: 'PATCH', body: { location: 'archive' } });
    expect(fake.documents.find((d) => d.id === id)!.location).toBe('archive');
  });

  it('never puts the token in a URL', async () => {
    const { fake, client } = setup();
    await client.listDocuments();
    expect(fake.requests.every((r) => !r.url.includes('test-token'))).toBe(true);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds, HTTP dates and falls back', () => {
    expect(parseRetryAfter('12', 60)).toBe(12);
    expect(parseRetryAfter(null, 60)).toBe(60);
    expect(parseRetryAfter('garbage', 60)).toBe(60);
    const now = Date.parse('2026-10-08T00:00:00Z');
    expect(parseRetryAfter('Thu, 08 Oct 2026 00:00:30 GMT', 60, now)).toBe(30);
  });
});

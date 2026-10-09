import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { MemoryManifestStore, MemoryOutput, ReadwiseClient, epubFilename, highlightsKey, sendHighlight, syncReader } from '../src/index.js';
import { FakeReadwise, TINY_GIF, TINY_PNG } from '../src/testing/fake-readwise.js';
import { loadFixtures, noSleep } from './helpers.js';

function setup() {
  const fake = new FakeReadwise({
    documents: loadFixtures(),
    images: {
      'https://example.com/img/fog-1.png': TINY_PNG,
      'https://example.com/photo/field-notes/img/fog-2.gif': TINY_GIF,
    },
  });
  const client = new ReadwiseClient({ token: 'test-token', fetch: fake.fetch, sleep: noSleep });
  const output = new MemoryOutput();
  const manifest = new MemoryManifestStore();
  const now = () => new Date('2026-10-08T03:00:00Z');
  return { fake, client, output, manifest, deps: { client, output, manifest, fetchImages: fake.fetch, now } };
}

describe('syncReader', () => {
  it('writes one EPUB per document and records them in the manifest', async () => {
    const { output, manifest, deps } = setup();
    const progress: string[] = [];
    const r = await syncReader({ ...deps, onProgress: (m) => progress.push(m) });
    expect(r.added).toBe(4);
    expect(r.summary).toBe('Synced 4 new, 0 updated.');
    expect([...output.files.keys()].sort()).toEqual(loadFixtures().map((d) => epubFilename(d)).sort());
    expect(Object.keys(manifest.manifest.documents).length).toBe(4);
    expect(manifest.manifest.lastSyncAt).toBe('2026-10-08T03:00:00.000Z');
    expect(progress).toContain('Found 4 articles.');
    expect(progress.some((p) => p.startsWith('Writing 4/4'))).toBe(true);
    // Image fixture: one good PNG, one 404, one GIF.
    expect(r.warnings.some((w) => w.includes('missing.jpg'))).toBe(true);
  });

  it('syncs newsletters, feed items and tweets too, and says what it left out', async () => {
    const { fake, output, deps } = setup();
    const base = fake.documents[0]!;
    const extra = (id: string, category: string) => ({ ...base, id, title: `A ${category}`, url: `https://read.readwise.io/read/${id}`, category });
    fake.documents.push(extra('01tweet', 'tweet'), extra('01email', 'email'), extra('01rss', 'rss'), extra('01pdf', 'pdf'), extra('01video', 'video'));
    const r = await syncReader(deps);
    expect(r.added).toBe(7);
    for (const id of ['01tweet', '01email', '01rss']) expect([...output.files.keys()].some((f) => f.includes(id))).toBe(true);
    expect([...output.files.keys()].some((f) => f.includes('01pdf') || f.includes('01video'))).toBe(false);
    expect(r.warnings).toContain("Left out 2 Reader items Inkwise can't turn into an EPUB (pdf, video).");
    // Several categories means one unfiltered request, filtered here.
    expect(fake.requests.some((q) => q.url.includes('/list/') && q.url.includes('category=') && !q.url.includes('category=highlight'))).toBe(false);
  });

  it('counts only kept documents toward the limit, and still takes one category or all', async () => {
    const { fake, deps } = setup();
    const base = fake.documents[0]!;
    fake.documents.unshift({ ...base, id: '01pdffirst', title: 'A pdf', category: 'pdf' });
    expect((await syncReader(deps, { limit: 2, dryRun: true })).items).toHaveLength(2);
    const one = await syncReader(deps, { category: 'pdf', dryRun: true });
    expect(one.items.map((i) => i.id)).toEqual(['01pdffirst']);
    expect(fake.requests.some((q) => q.url.includes('category=pdf'))).toBe(true);
    expect((await syncReader(deps, { category: null, dryRun: true })).items).toHaveLength(5);
  });

  it('keeps a highlight queued while the sync is running', async () => {
    const { fake, client, manifest, deps } = setup();
    const doc = fake.documents[0]!;
    let sending: Promise<unknown> | null = null;
    const r = await syncReader({
      ...deps,
      onProgress: (m) => {
        if (m.startsWith('Writing 2/')) {
          sending = sendHighlight({ client, manifest, filePath: epubFilename(doc), text: 'Words that are not in the article.' });
        }
      },
    });
    expect(sending).not.toBeNull();
    expect(await sending).toMatchObject({ status: 'needs_attention' });
    expect(r.added).toBe(4);
    expect(manifest.manifest.pendingHighlights).toHaveLength(1);
    expect(Object.keys(manifest.manifest.documents)).toHaveLength(4);
  });

  it('shades highlights made in Reader, and re-marks when new ones arrive', async () => {
    const { fake, output, manifest, deps } = setup();
    const doc = fake.documents.find((d) => d.id.includes('longform'))!;
    const articleOf = () => {
      const bytes = output.files.get(epubFilename(doc))!;
      // Underline marks (one before each highlighted character) left out, to compare the words.
      return strFromU8(unzipSync(bytes)['OEBPS/article.xhtml']!).replace(/\u0332/g, '');
    };
    const at = '2026-10-08T02:00:00Z';
    fake.highlights.push({ id: 'hlA', parent_id: doc.id, content: 'None of this is new.', notes: '', tags: [], createdAt: at, updatedAt: at });
    await syncReader(deps);
    expect(articleOf()).toContain('<span class="rw-hl">None of this is new.</span>');

    const again = await syncReader(deps);
    expect(again.updated).toBe(0);

    const later = '2026-10-08T04:00:00Z';
    const second = 'Attention is the rarest and purest form of generosity.';
    expect(doc.html_content).toContain(second);
    fake.highlights.push({ id: 'hlB', parent_id: doc.id, content: second, notes: '', tags: [], createdAt: later, updatedAt: later });
    const third = await syncReader({ ...deps, now: () => new Date('2026-10-08T05:00:00Z') });
    expect(third.updated).toBe(1);
    expect(articleOf()).toContain(`<span class="rw-hl">${second}</span>`);
    expect(manifest.manifest.docHighlights[doc.id]).toHaveLength(2);
  });

  it('re-shades files that were shaded in an older style', async () => {
    const { fake, manifest, deps } = setup();
    const doc = fake.documents.find((d) => d.id.includes('longform'))!;
    const at = '2026-10-08T02:00:00Z';
    fake.highlights.push({ id: 'hlA', parent_id: doc.id, content: 'None of this is new.', notes: '', tags: [], createdAt: at, updatedAt: at });
    await syncReader(deps);
    // What a build before the style change recorded.
    manifest.manifest.documents[doc.id]!.marked = 'None of this is new.';
    const again = await syncReader(deps);
    expect(again.updated).toBe(1);
    expect(manifest.manifest.documents[doc.id]!.marked).toBe(highlightsKey(['None of this is new.']));
    // Picking another style in settings redoes it too.
    expect((await syncReader(deps, { highlightStyle: 'bold' })).updated).toBe(1);
    expect((await syncReader(deps, { highlightStyle: 'bold' })).updated).toBe(0);
  });

  it('rewrites a file it finds on disk when it has highlights to show (after a reinstall wiped the manifest)', async () => {
    const { fake, output, manifest, deps } = setup();
    const doc = fake.documents.find((d) => d.id.includes('longform'))!;
    const at = '2026-10-08T02:00:00Z';
    fake.highlights.push({ id: 'hlA', parent_id: doc.id, content: 'None of this is new.', notes: '', tags: [], createdAt: at, updatedAt: at });
    await syncReader(deps, { showHighlights: false });
    manifest.manifest = { ...manifest.manifest, documents: {}, docHighlights: {}, highlightsSyncedAt: undefined };
    const r = await syncReader(deps);
    expect(r.items.find((i) => i.id === doc.id)?.action).toBe('updated');
    expect(r.items.filter((i) => i.action === 'adopted')).toHaveLength(3);
    expect(strFromU8(unzipSync(output.files.get(epubFilename(doc))!)['OEBPS/article.xhtml']!).replace(/\u0332/g, '')).toContain(
      '<span class="rw-hl">None of this is new.</span>',
    );
  });

  it('leaves EPUBs plain when highlights are turned off', async () => {
    const { fake, output, deps } = setup();
    const doc = fake.documents[0]!;
    fake.highlights.push({ id: 'hlA', parent_id: doc.id, content: 'x', notes: '', tags: [], createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' });
    await syncReader(deps, { showHighlights: false });
    expect(fake.requests.some((r) => r.url.includes('category=highlight'))).toBe(false);
    expect(strFromU8(unzipSync(output.files.get(epubFilename(doc))!)['OEBPS/article.xhtml']!)).not.toContain('rw-hl');
  });

  it('is idempotent and picks up updates', async () => {
    const { fake, deps } = setup();
    await syncReader(deps);
    const again = await syncReader(deps);
    expect(again.summary).toBe('Synced 0 new, 0 updated.');
    expect(again.skipped).toBe(4);
    fake.documents[0]!.updated_at = '2026-10-09T00:00:00+00:00';
    const third = await syncReader(deps);
    expect(third.updated).toBe(1);
  });

  // Article HTML is the heavy part of a Reader response, and on the tablet the
  // whole page is parsed in memory. The queue is listed without it, and only the
  // documents that will be written are fetched in full.
  describe('fetching article content', () => {
    const listRequests = (fake: FakeReadwise) => fake.requests.filter((q) => q.method === 'GET' && q.url.includes('/api/v3/list/'));
    const withHtml = (q: { url: string }) => q.url.includes('withHtmlContent=true');
    const byId = (q: { url: string }) => /[?&]id=/.test(q.url);

    it('lists the queue without HTML and fetches a few new articles one by one', async () => {
      const { fake, deps } = setup();
      await syncReader(deps);
      const lists = listRequests(fake);
      expect(lists.filter((q) => !withHtml(q) && !byId(q) && !q.url.includes('category=highlight'))).toHaveLength(1);
      expect(lists.filter((q) => withHtml(q) && !byId(q))).toHaveLength(0);
      expect(lists.filter((q) => withHtml(q) && byId(q))).toHaveLength(4);

      // Nothing changed: no article content is fetched at all.
      fake.requests.length = 0;
      await syncReader(deps);
      expect(listRequests(fake).filter(withHtml)).toHaveLength(0);

      // One article changed: exactly that one is fetched.
      fake.requests.length = 0;
      fake.documents[1]!.updated_at = '2026-10-09T00:00:00+00:00';
      const r = await syncReader(deps);
      expect(r.updated).toBe(1);
      const fetched = listRequests(fake).filter(withHtml);
      expect(fetched).toHaveLength(1);
      expect(fetched[0]!.url).toContain(`id=${fake.documents[1]!.id}`);
    });

    it('fetches many new articles in one listing instead of one request each', async () => {
      const { fake, deps } = setup();
      const base = fake.documents[0]!;
      for (let i = 0; i < 12; i++) fake.documents.push({ ...base, id: `01many${String(i).padStart(2, '0')}abcdefghijklm`, title: `Many ${i}` });
      const r = await syncReader(deps);
      expect(r.added).toBe(16);
      const lists = listRequests(fake);
      expect(lists.filter((q) => withHtml(q) && byId(q))).toHaveLength(0);
      expect(lists.filter((q) => withHtml(q) && !byId(q)).length).toBeGreaterThanOrEqual(1);
    });

    it('asks only for articles changed since the last sync, then fetches any stragglers singly', async () => {
      const { fake, manifest, deps } = setup();
      await syncReader(deps);
      // A reinstall or a wiped folder: everything must be written again, but the
      // manifest still knows when the last sync was.
      const base = fake.documents[0]!;
      for (let i = 0; i < 12; i++) {
        fake.documents.push({ ...base, id: `01stale${String(i).padStart(2, '0')}abcdefghijkl`, title: `Stale ${i}`, updated_at: '2026-09-01T00:00:00+00:00' });
      }
      fake.requests.length = 0;
      const r = await syncReader({ ...deps, now: () => new Date('2026-10-08T06:00:00Z') });
      expect(r.added).toBe(12);
      const batch = listRequests(fake).filter((q) => withHtml(q) && !byId(q));
      expect(batch).toHaveLength(1);
      expect(batch[0]!.url).toContain('updatedAfter=');
      // The batch found none of them (they predate the last sync), so each was fetched by id.
      expect(listRequests(fake).filter((q) => withHtml(q) && byId(q))).toHaveLength(12);
      expect(manifest.manifest.lastSyncAt).toBe('2026-10-08T06:00:00.000Z');
    });

    it('fetches no content on a dry run', async () => {
      const { fake, deps } = setup();
      const r = await syncReader(deps, { dryRun: true });
      expect(r.summary).toBe('Would sync 4 new, 0 updated.');
      expect(listRequests(fake).filter(withHtml)).toHaveLength(0);
    });

    it('reports an article whose content could not be fetched, and keeps going', async () => {
      const { fake, deps } = setup();
      const gone = fake.documents[0]!;
      fake.vanishOnFetch.add(gone.id);
      const r = await syncReader(deps);
      expect(r.added).toBe(3);
      expect(r.failed).toBe(1);
      expect(r.items.find((i) => i.id === gone.id)).toMatchObject({ action: 'failed' });
    });
  });

  it('replaces the old file when a title changes', async () => {
    const { fake, output, deps } = setup();
    await syncReader(deps);
    const doc = fake.documents[0]!;
    const oldName = epubFilename(doc);
    doc.title = 'A Brand New Title';
    doc.updated_at = '2026-10-09T00:00:00+00:00';
    await syncReader(deps);
    expect(output.files.has(oldName)).toBe(false);
    expect(output.files.has(epubFilename(doc))).toBe(true);
  });

  it('skips a file the other tool already wrote, whatever its title (duplicate guard)', async () => {
    const { output, manifest, deps } = setup();
    const doc = loadFixtures()[0]!;
    output.files.set(`Renamed-By-Someone__${doc.id}.epub`, new Uint8Array([1]));
    const r = await syncReader(deps);
    expect(r.added).toBe(3);
    expect(output.files.has(epubFilename(doc))).toBe(false);
    expect(manifest.manifest.documents[doc.id]!.filename).toBe(`Renamed-By-Someone__${doc.id}.epub`);
  });

  it('dry run writes nothing', async () => {
    const { output, manifest, deps } = setup();
    const r = await syncReader(deps, { dryRun: true });
    expect(r.summary).toBe('Would sync 4 new, 0 updated.');
    expect(output.files.size).toBe(0);
    expect(manifest.manifest.lastSyncAt).toBeNull();
  });

  it('removes or archives documents that left the queue', async () => {
    const { fake, output, deps } = setup();
    await syncReader(deps);
    const gone = fake.documents[0]!;
    gone.location = 'archive';
    const r = await syncReader(deps, { removeMissing: true, removeMode: 'archive-folder' });
    expect(r.removed).toBe(1);
    expect(output.files.has(`Archive/${epubFilename(gone)}`)).toBe(true);
    const gone2 = fake.documents[1]!;
    gone2.location = 'archive';
    await syncReader(deps, { removeMissing: true });
    expect([...output.files.keys()].some((k) => k.includes(gone2.id))).toBe(false);
  });

  it('does not remove anything when --limit hides part of the queue', async () => {
    const { output, deps } = setup();
    await syncReader(deps);
    const r = await syncReader(deps, { removeMissing: true, limit: 1 });
    expect(r.removed).toBe(0);
    expect(output.files.size).toBe(4);
  });

  it('embeds images that download, falls back to alt text otherwise', async () => {
    const { output, deps } = setup();
    await syncReader(deps);
    const { unzipSync, strFromU8 } = await import('fflate');
    const name = [...output.files.keys()].find((k) => k.startsWith('Field-Notes'))!;
    const files = unzipSync(output.files.get(name)!);
    expect(Object.keys(files).filter((f) => f.startsWith('OEBPS/images/')).sort()).toEqual([
      'OEBPS/images/img-1.png',
      'OEBPS/images/img-2.gif',
    ]);
    expect(strFromU8(files['OEBPS/article.xhtml']!)).toContain('[Image: Broken image]');
  });

  it('respects includeImages: false', async () => {
    const { fake, deps } = setup();
    await syncReader(deps, { includeImages: false });
    expect(fake.requests.some((r) => r.url.includes('example.com/img'))).toBe(false);
  });

  it('flushes queued highlights before syncing', async () => {
    const { fake, manifest, deps } = setup();
    const doc = loadFixtures().find((d) => d.id.includes('longform'))!;
    manifest.manifest.pendingHighlights.push({
      docId: doc.id,
      text: 'Speed is a habit, not a virtue.',
      note: '',
      createdAt: '2026-10-07T00:00:00Z',
      attempts: 1,
      state: 'pending',
    });
    const r = await syncReader(deps);
    expect(r.highlights.sent).toBe(1);
    expect(fake.highlights.length).toBe(1);
    expect(r.summary).toBe('Synced 4 new, 0 updated. Sent 1 saved highlight.');
    expect(manifest.manifest.pendingHighlights).toEqual([]);
  });
});

describe('syncReader cleanup with a limit', () => {
  it('still cleans up when the whole queue fit under the limit', async () => {
    const fake = new FakeReadwise({ documents: loadFixtures() });
    const client = new ReadwiseClient({ token: 'test-token', fetch: fake.fetch, sleep: noSleep });
    const output = new MemoryOutput();
    const manifest = new MemoryManifestStore();
    await syncReader({ client, output, manifest }, { includeImages: false, limit: 30 });
    fake.documents[0]!.location = 'archive';
    const r = await syncReader({ client, output, manifest }, { includeImages: false, limit: 30, removeMissing: true });
    expect(r.removed).toBe(1);
  });
});

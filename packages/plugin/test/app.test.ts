import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { epubFilename, type ReaderDocument } from '@inkwise/core';
import { FakeReadwise, TINY_PNG } from '@inkwise/core/testing';
import { BACKUP_DIR, InkwiseApp, SHADED, STORAGE_ROOT, TOKEN_IMPORT_PATH, cleanToken, type Host, type Permission } from '../src/services/app';
import { base64ToBytes, bytesToBase64 } from '../src/services/base64';
import { MemoryFs } from '../src/services/fs';
import { HighlightState, needsScreen, quickSend } from '../src/services/quickSend';

const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures', 'documents');
const docs: ReaderDocument[] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')));
const longform = docs.find((d) => d.id.includes('longform'))!;
const LIBRARY = `${STORAGE_ROOT}/Document/Inkwise`;
const PRIVATE = '/data/data/com.ratta.supernote.pluginhost/files/plugins/inkw1se7rd8w9x2q';

class FakeHost implements Host {
  granted = new Set<Permission>();
  /** What the user answers in the permission dialog. */
  answer = true;
  requests: { permission: Permission; description: string }[] = [];
  selection: string | null = null;
  filePath: string | null = null;
  async pluginDir() {
    return PRIVATE;
  }
  async hasPermission(p: Permission) {
    return this.granted.has(p);
  }
  async requestPermission(p: Permission, description: string) {
    this.requests.push({ permission: p, description });
    if (this.answer) this.granted.add(p);
    return this.answer;
  }
  async selectedText() {
    return this.selection === null ? { ok: false as const, error: 'No text selected.' } : { ok: true as const, text: this.selection };
  }
  async currentFilePath() {
    return this.filePath;
  }
  reloads = 0;
  async reloadFile() {
    this.reloads++;
  }
}

let fake: FakeReadwise;
let host: FakeHost;
let fs: MemoryFs;
let app: InkwiseApp;

beforeEach(async () => {
  fake = new FakeReadwise({ token: 'device-token', documents: docs, images: { 'https://example.com/img/fog-1.png': TINY_PNG } });
  host = new FakeHost();
  fs = new MemoryFs();
  await fs.mkdir(PRIVATE);
  await fs.mkdir(`${STORAGE_ROOT}/Document`);
  await fs.mkdir(`${STORAGE_ROOT}/MyStyle/Inkwise`);
  app = new InkwiseApp(host, fs, fake.fetch);
});

async function connect() {
  const r = await app.setToken('device-token');
  expect(r.ok).toBe(true);
}

describe('token setup', () => {
  it('validates and stores the token privately', async () => {
    const r = await app.setToken('  Token device-token\n');
    expect(r).toEqual({ ok: true, message: 'Token works. You are connected to Readwise.' });
    expect(await fs.readText(`${PRIVATE}/readwise-token`)).toBe('device-token');
    expect([...fs.files.keys()].filter((k) => k.startsWith(STORAGE_ROOT))).toEqual([]);
  });

  it('rejects a bad token without storing it', async () => {
    const r = await app.setToken('wrong');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('rejected');
    expect(await app.hasToken()).toBe(false);
  });

  it('reports no connection clearly', async () => {
    fake.offline = true;
    const r = await app.setToken('device-token');
    expect(r).toEqual({ ok: false, message: 'No connection to Readwise. Check Wi-Fi and try again.' });
  });

  it('imports from MyStyle/Inkwise/token.txt and leaves the file in place', async () => {
    await fs.writeText(TOKEN_IMPORT_PATH, '﻿device-token\r\n');
    const r = await app.importToken();
    expect(r).toEqual({ ok: true, message: 'Token works. You are connected to Readwise.' });
    expect(await fs.exists(TOKEN_IMPORT_PATH)).toBe(true);
    expect(host.granted.has('plugin.permission.FILE:READ')).toBe(true);
    expect(host.granted.has('plugin.permission.FILE:DELETE')).toBe(false);
  });

  it('picks the token up from token.txt by itself after a reinstall', async () => {
    await fs.writeText(TOKEN_IMPORT_PATH, 'device-token\n');
    // Without file access it doesn't look, and doesn't ask either.
    expect(await app.hasToken()).toBe(false);
    expect(host.requests).toEqual([]);
    // Sync asks for access, finds the file and carries on.
    expect(await app.sync(() => {})).toBe('Synced 4 new, 0 updated.');
    expect(await fs.readText(`${PRIVATE}/readwise-token`)).toBe('device-token');
    expect(await app.hasToken()).toBe(true);
  });

  it('stays disconnected after Disconnect even with token.txt around', async () => {
    await fs.writeText(TOKEN_IMPORT_PATH, 'device-token');
    await app.importToken();
    await app.clearToken();
    expect(await app.hasToken({ ask: true })).toBe(false);
    expect(await app.sync(() => {})).toBe('Connect Readwise first: open Inkwise settings and add your token.');
    // Importing again reconnects.
    expect((await app.importToken()).ok).toBe(true);
    expect(await app.hasToken()).toBe(true);
  });

  it('explains when there is no token file', async () => {
    const r = await app.importToken();
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain('MyStyle/Inkwise/token.txt');
  });

  it('cleans pasted tokens', () => {
    expect(cleanToken('Token abc123 ')).toBe('abc123');
    expect(cleanToken('\n abc\nextra')).toBe('abc');
  });
});

describe('Sync Reader', () => {
  it('asks to connect first when there is no token', async () => {
    expect(await app.sync(() => {})).toBe('Connect Readwise first: open Inkwise settings and add your token.');
  });

  it('writes EPUBs into Document/Inkwise and reports one line', async () => {
    await connect();
    const lines: string[] = [];
    const summary = await app.sync((l) => lines.push(l));
    expect(summary).toBe('Synced 4 new, 0 updated.');
    const names = (await fs.listFiles(LIBRARY)).map((f) => f.name).sort();
    expect(names).toEqual(docs.map((d) => epubFilename(d)).sort());
    expect(lines).toContain('Found 4 articles.');
    // Manifest lives in private storage, not next to the EPUBs.
    expect(await fs.exists(`${PRIVATE}/manifest.json`)).toBe(true);
    expect(names.some((n) => n.endsWith('.part'))).toBe(false);
    // Asked for network and write access, with an explanation.
    expect(host.requests.map((r) => r.permission)).toEqual(['plugin.permission.INTERNET', 'plugin.permission.FILE:WRITE', 'plugin.permission.FILE:READ']);
    expect(host.requests[1]!.description).toContain('Document/Inkwise');
  });

  it('is idempotent', async () => {
    await connect();
    await app.sync(() => {});
    expect(await app.sync(() => {})).toBe('Synced 0 new, 0 updated.');
  });

  it('stops with a clear message when write permission is refused', async () => {
    await connect();
    host.granted.delete('plugin.permission.FILE:WRITE');
    host.answer = false;
    expect(await app.sync(() => {})).toBe(
      "Inkwise needs permission to write files for this. Turn it on in the Supernote's plugin settings for Inkwise, then try again.",
    );
  });

  it('honours settings: location, tag, max articles, folder name, images', async () => {
    await connect();
    await app.saveSettings({ maxArticles: 2, folderName: 'Reader/../Stuff', images: false });
    const s = await app.settings();
    expect(s.folderName).toBe('Reader..Stuff');
    const summary = await app.sync(() => {});
    expect(summary).toBe('Synced 2 new, 0 updated.');
    expect((await fs.listFiles(`${STORAGE_ROOT}/Document/Reader..Stuff`)).length).toBe(2);
    expect(fake.requests.some((r) => r.url.includes('example.com/img'))).toBe(false);
    await app.saveSettings({ location: 'shortlist', tag: 'reading', maxArticles: 50 });
    await app.sync(() => {});
    const listCall = fake.requests.filter((r) => r.url.includes('/api/v3/list/')).at(-1)!;
    expect(listCall.url).toContain('location=shortlist');
    expect(listCall.url).toContain('tag=reading');
  });

  it('reports offline cleanly', async () => {
    await connect();
    fake.offline = true;
    expect(await app.sync(() => {})).toBe('No connection to Readwise. Check Wi-Fi and try again.');
  });
});

describe('Send highlight', () => {
  beforeEach(async () => {
    await connect();
    await app.sync(() => {});
    host.filePath = `${LIBRARY}/${epubFilename(longform)}`;
  });

  it('needs a selection', async () => {
    host.selection = null;
    expect((await app.sendSelection()).status).toBe('empty');
  });

  it('sends the selection to the right Reader document', async () => {
    host.selection = 'Speed is a habit, not a virtue.';
    const r = await app.sendSelection();
    expect(r).toMatchObject({ status: 'sent', message: 'Highlight sent.', docId: longform.id });
    expect(fake.highlights[0]).toMatchObject({ parent_id: longform.id, content: 'Speed is a habit, not a virtue.' });
  });

  it('adds a note after sending', async () => {
    host.selection = 'Speed is a habit, not a virtue.';
    const r = await app.sendSelection();
    const n = await app.addNote({ docId: r.docId!, text: r.selection!, note: 'so true', highlightId: r.highlightId });
    expect(n).toEqual({ ok: true, message: 'Note saved.' });
    expect(fake.highlights[0]!.notes).toBe('so true');
  });

  it('queues offline, keeps a note on the queued copy, and sends on next sync', async () => {
    host.selection = 'None of this is new.';
    fake.offline = true;
    const r = await app.sendSelection();
    expect(r.message).toBe('Saved offline, will send on next sync.');
    const n = await app.addNote({ docId: r.docId!, text: r.selection!, note: 'queued note' });
    expect(n.ok).toBe(true);
    fake.offline = false;
    expect(await app.sync(() => {})).toBe('Synced 0 new, 0 updated. Sent 1 saved highlight.');
    expect(fake.highlights[0]).toMatchObject({ content: 'None of this is new.', notes: 'queued note' });
  });

  it('shades a sent highlight in the open EPUB and reloads it', async () => {
    const path = `${LIBRARY}/${epubFilename(longform)}`;
    host.filePath = path;
    host.selection = 'None of this is new.';
    const r = await app.sendSelection();
    expect(r.status).toBe('sent');
    expect(r.shading).toBe(SHADED);
    expect(host.reloads).toBe(1);
    const article = strFromU8(unzipSync(await fs.readBytes(path))['OEBPS/article.xhtml']!);
    expect(article).toContain(`<span class="rw-hl">${[...'None of this is new.'].map((c) => `\u0332${c}`).join('')}</span>`);
    // The next sync sees the file already shows it and leaves it alone.
    expect(await app.sync(() => {})).toBe('Synced 0 new, 0 updated.');
  });

  it('writes over the file in place when the device refuses the rename, and logs each step', async () => {
    const path = `${LIBRARY}/${epubFilename(longform)}`;
    host.filePath = path;
    host.selection = 'None of this is new.';
    fs.denyMoveOnto.add(path);
    const r = await app.sendSelection();
    expect(r.shading).toBe(SHADED);
    expect(strFromU8(unzipSync(fs.files.get(path)!)['OEBPS/article.xhtml']!).replace(/\u0332/g, '')).toContain(
      '<span class="rw-hl">None of this is new.</span>',
    );
    expect([...fs.files.keys()].some((k) => k.endsWith('.part'))).toBe(false);
    const log = await fs.readText(`${STORAGE_ROOT}/MyStyle/Inkwise/inkwise-log.txt`);
    expect(log).toContain('send: sent');
    expect(log).toMatch(/mark: 1 of 1 found \(underline\)/);
    expect(log).toContain('writing in place');
    expect(log).toContain('(written in place)');
    expect(log).not.toContain('device-token');
  });

  it('Mark highlights now marks every article with highlights and says so', async () => {
    host.selection = 'None of this is new.';
    await app.sendSelection();
    // Pretend the file never got marked.
    const plain = (await import('@inkwise/core')).buildEpub(longform, { modified: new Date('2026-10-08T00:00:00Z') });
    fs.files.set(`${LIBRARY}/${epubFilename(longform)}`, plain.bytes);
    const r = await app.markAll();
    expect(r).toEqual({ ok: true, message: 'Marked highlights in 1 of 1 article.' });
    expect(strFromU8(unzipSync(fs.files.get(`${LIBRARY}/${epubFilename(longform)}`)!)['OEBPS/article.xhtml']!)).toContain('rw-hl');
  });

  it('marks in the style picked in settings, and redoes old articles on sync', async () => {
    const path = `${LIBRARY}/${epubFilename(longform)}`;
    host.filePath = path;
    host.selection = 'None of this is new.';
    await app.saveSettings({ highlightStyle: 'paragraph' });
    await app.sendSelection();
    const css = () => strFromU8(unzipSync(fs.files.get(path)!)['OEBPS/style.css']!);
    expect(css()).toContain('p.rw-hl-block { background-color: #d2d2d2; }');
    expect(css()).not.toContain('font-weight: bold; }\n.rw-hl-block');
    await app.saveSettings({ highlightStyle: 'bold' });
    expect(await app.sync(() => {})).toBe('Synced 0 new, 1 updated.');
    expect(css()).toContain('span.rw-hl { font-weight: bold; font-style: italic; }');
    expect(css()).not.toContain('.rw-hl-block {');
  });

  it('reads a style an older build saved as the default underline', async () => {
    await app.saveSettings({ highlightStyle: 'paragraph' });
    const path = [...fs.files.keys()].find((k) => k.endsWith('/settings.json') && !k.includes('/backup/'))!;
    await fs.writeText(path, (await fs.readText(path)).replace('"paragraph"', '"both"'));
    expect((await app.settings()).highlightStyle).toBe('underline');
  });

  it('quick send stays silent when the highlight is sent and shaded', async () => {
    host.filePath = `${LIBRARY}/${epubFilename(longform)}`;
    host.selection = 'None of this is new.';
    const ui = { shown: 0, closed: 0, show() { this.shown++; }, close() { this.closed++; } };
    const state = new HighlightState();
    const r = await quickSend(app, ui, state);
    expect(r?.status).toBe('sent');
    expect(ui).toMatchObject({ shown: 0, closed: 1 });

    // Selecting it again (now underlined on the page) opens the screen to edit or delete it.
    host.selection = [...'None of this is new'].map((c) => `\u0332${c}`).join('');
    const again = await quickSend(app, ui, state);
    expect(again?.status).toBe('duplicate');
    expect(again?.existing?.text).toBe('None of this is new.');
    expect(ui.shown).toBe(1);
  });

  it('quick send opens the screen when something needs the user', () => {
    expect(needsScreen({ status: 'needs_attention', message: '' })).toBe(true);
    expect(needsScreen({ status: 'token_rejected', message: '' })).toBe(true);
    expect(needsScreen({ status: 'sent', message: '', shading: undefined })).toBe(true);
    expect(needsScreen({ status: 'sent', message: '', shading: SHADED })).toBe(false);
    expect(needsScreen({ status: 'queued_offline', message: '', shading: SHADED })).toBe(false);
  });

  it('deleting a highlight removes it in Readwise and clears its shading', async () => {
    const path = `${LIBRARY}/${epubFilename(longform)}`;
    host.filePath = path;
    host.selection = 'None of this is new.';
    const sent = await app.sendSelection();
    expect(fake.highlights).toHaveLength(1);
    const r = await app.deleteHighlight(sent.docId!, 'None of this is new.');
    expect(r).toEqual({ ok: true, message: 'Highlight deleted.' });
    expect(fake.highlights).toHaveLength(0);
    const article = strFromU8(unzipSync(await fs.readBytes(path))['OEBPS/article.xhtml']!);
    expect(article).not.toContain('rw-hl"');
    expect(article).toContain('None of this is new.');
    expect(host.reloads).toBe(2);
  });

  it('leaves the file alone when shading is off', async () => {
    await app.saveSettings({ showHighlights: false });
    host.filePath = `${LIBRARY}/${epubFilename(longform)}`;
    host.selection = 'None of this is new.';
    const r = await app.sendSelection();
    expect(r.status).toBe('sent');
    expect(r.shading).toBeUndefined();
    expect(host.reloads).toBe(0);
  });

  it("refuses documents that aren't from Readwise", async () => {
    host.filePath = `${STORAGE_ROOT}/Document/Manual.pdf`;
    host.selection = 'anything';
    expect((await app.sendSelection()).message).toBe("This document isn't from Readwise.");
  });

  it('reads dc:identifier from a renamed EPUB', async () => {
    const original = `${LIBRARY}/${epubFilename(longform)}`;
    const renamed = `${STORAGE_ROOT}/Document/renamed.epub`;
    await fs.move(original, renamed);
    host.filePath = renamed;
    host.selection = 'None of this is new.';
    const r = await app.sendSelection();
    expect(r.status).toBe('sent');
    expect(fake.highlights[0]!.parent_id).toBe(longform.id);
  });

  it('lets the user fix an unmatched highlight from the queue', async () => {
    host.selection = 'Not in the article.';
    expect((await app.sendSelection()).status).toBe('needs_attention');
    const q = await app.queue();
    expect(q.pending).toHaveLength(1);
    expect(q.titles[longform.id]).toBe(longform.title);
    const fixed = await app.review({ docId: q.pending[0]!.docId, createdAt: q.pending[0]!.createdAt }, 'retry', 'None of this is new.');
    expect(fixed.status).toBe('sent');
    expect((await app.queue()).pending).toHaveLength(0);
  });

  it('flushes queued highlights on demand', async () => {
    host.selection = 'None of this is new.';
    fake.offline = true;
    await app.sendSelection();
    expect(await app.flush()).toBe('Still offline. Everything stays queued.');
    fake.offline = false;
    expect(await app.flush()).toBe('Sent 1 highlight.');
  });
});

describe('Done', () => {
  beforeEach(async () => {
    await connect();
    await app.sync(() => {});
    host.filePath = `${LIBRARY}/${epubFilename(longform)}`;
  });

  it('archives in Reader, leaves the open file alone, and moves it on the next sync', async () => {
    const path = `${LIBRARY}/${epubFilename(longform)}`;
    await fs.writeText(`${path}.mark`, 'handwriting');
    const r = await app.done();
    expect(r).toEqual({ ok: true, message: 'Archived in Reader. It moves to Inkwise/Archive on your next sync.' });
    expect(fake.documents.find((d) => d.id === longform.id)!.location).toBe('archive');
    expect(await fs.exists(path)).toBe(true);

    // Still open: a sync doesn't pull it out from under the reader.
    expect(await app.sync(() => {})).toBe('Synced 0 new, 0 updated.');
    expect(await fs.exists(path)).toBe(true);

    host.filePath = null;
    expect(await app.sync(() => {})).toBe('Synced 0 new, 0 updated. Moved 1 finished article to Archive.');
    expect(await fs.exists(path)).toBe(false);
    expect(await fs.exists(`${LIBRARY}/Archive/${epubFilename(longform)}`)).toBe(true);
    expect(await fs.readText(`${LIBRARY}/Archive/${epubFilename(longform)}.mark`)).toBe('handwriting');
  });

  it('can keep or delete the file instead', async () => {
    await app.saveSettings({ afterArchive: 'keep' });
    expect((await app.done()).message).toBe('Archived in Reader.');
    host.filePath = null;
    await app.sync(() => {});
    expect(await fs.exists(`${LIBRARY}/${epubFilename(longform)}`)).toBe(true);

    const other = docs.find((d) => d.id.includes('messy'))!;
    const otherPath = `${LIBRARY}/${epubFilename(other)}`;
    host.filePath = otherPath;
    await app.saveSettings({ afterArchive: 'delete' });
    expect((await app.done()).message).toBe('Archived in Reader. It is removed from the device on your next sync.');
    host.filePath = null;
    expect(await app.sync(() => {})).toContain('Removed 2 finished articles.');
    expect(await fs.exists(otherPath)).toBe(false);
    expect(host.granted.has('plugin.permission.FILE:DELETE')).toBe(true);
  });

  it('queues the archive offline', async () => {
    fake.offline = true;
    const r = await app.done();
    expect(r).toEqual({ ok: true, message: 'Saved offline, will archive on next sync.' });
    expect(await fs.exists(`${LIBRARY}/${epubFilename(longform)}`)).toBe(true);
    expect((await app.queue()).archives).toBe(1);
  });

  it("does nothing for documents that aren't from Readwise", async () => {
    host.filePath = `${STORAGE_ROOT}/Document/book.epub`;
    expect(await app.done()).toEqual({ ok: false, message: "This document isn't from Readwise." });
  });
});

describe('reinstalling', () => {
  it('backs up settings and the manifest (not the token) and restores them into an empty private folder', async () => {
    await connect();
    host.granted.add('plugin.permission.FILE:WRITE');
    await app.saveSettings({ maxArticles: 12, tag: 'supernote' });
    fake.offline = true;
    const doc = docs[0]!;
    host.filePath = `${LIBRARY}/${epubFilename(doc)}`;
    host.selection = 'Words waiting to go out.';
    await app.sendSelection();
    const backups = (await fs.listFiles(BACKUP_DIR)).map((f) => f.name).sort();
    expect(backups).toEqual(['manifest.json', 'settings.json']);
    for (const name of backups) expect(await fs.readText(`${BACKUP_DIR}/${name}`)).not.toContain('device-token');

    // Uninstall wipes the private folder, and the permissions with it.
    for (const k of [...fs.files.keys()]) if (k.startsWith(PRIVATE)) fs.files.delete(k);
    host.granted.clear();
    const fresh = new InkwiseApp(host, fs, fake.fetch);
    expect((await fresh.settings()).maxArticles).toBe(30);
    host.granted.add('plugin.permission.FILE:READ');
    expect(await fresh.settings()).toMatchObject({ maxArticles: 12, tag: 'supernote' });
    expect((await fresh.queue()).pending.map((h) => h.text)).toEqual(['Words waiting to go out.']);
    expect(await fs.exists(`${PRIVATE}/settings.json`)).toBe(true);
  });

  it('never writes a backup without write access', async () => {
    await connect();
    await app.saveSettings({ maxArticles: 12 });
    expect(await fs.exists(BACKUP_DIR)).toBe(false);
    expect(host.requests.map((r) => r.permission)).toEqual(['plugin.permission.INTERNET']);
  });
});

describe('settings', () => {
  it('falls back to defaults on corrupt JSON and clamps numbers', async () => {
    await fs.writeText(`${PRIVATE}/settings.json`, '{not json');
    expect((await app.settings()).maxArticles).toBe(30);
    expect((await app.saveSettings({ maxArticles: 9999 })).maxArticles).toBe(200);
    expect((await app.saveSettings({ maxArticles: Number('abc') })).maxArticles).toBe(30);
  });
});

describe('base64', () => {
  it('round-trips arbitrary bytes and matches Buffer', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 1000, 70001]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      const b64 = bytesToBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect(base64ToBytes(b64)).toEqual(bytes);
    }
  });

  it('writes a valid EPUB through base64 like the device does', async () => {
    await connect();
    await app.sync(() => {});
    const name = epubFilename(longform);
    const bytes = await fs.readBytes(`${LIBRARY}/${name}`);
    const roundTripped = base64ToBytes(bytesToBase64(bytes));
    const files = unzipSync(roundTripped);
    expect(strFromU8(files['OEBPS/content.opf']!)).toContain(`urn:readwise:${longform.id}`);
  });
});

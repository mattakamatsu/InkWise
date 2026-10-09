import {
  ReadwiseClient,
  addNoteToHighlight,
  archiveDocument,
  deleteHighlight,
  describeSyncError,
  epubIdentifier,
  flushPending,
  resolveDocId,
  resolveNeedsAttention,
  sendHighlight,
  syncReader,
  textManifestStore,
  updateManifest,
  highlightsKey,
  markEpub,
  DEFAULT_HIGHLIGHT_STYLE,
  HIGHLIGHT_STYLES,
  type FetchLike,
  type HighlightStyle,
  type ManifestStore,
  type OutputAdapter,
  type PendingHighlight,
  type ReviewAction,
  type SendResult,
} from '@inkwise/core';
import { BUILD } from '../buildInfo';
import { dirOf, joinPath, type DeviceFs } from './fs';
import { DeviceLog, errorText, preview } from './log';

/** What the plugin needs from the Supernote host (wrapped around sn-plugin-lib in host.ts). */
export interface Host {
  pluginDir(): Promise<string>;
  hasPermission(permission: Permission): Promise<boolean>;
  requestPermission(permission: Permission, description: string): Promise<boolean>;
  /** The DOC app's current selection. */
  selectedText(): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  currentFilePath(): Promise<string | null>;
  /** Ask the DOC app to re-read the open file after Inkwise changed it. */
  reloadFile(): Promise<void>;
}

export type Permission =
  | 'plugin.permission.INTERNET'
  | 'plugin.permission.FILE:READ'
  | 'plugin.permission.FILE:WRITE'
  | 'plugin.permission.FILE:DELETE';

const PERMISSION_REASONS: Record<Permission, string> = {
  'plugin.permission.INTERNET': 'Inkwise talks to Readwise to fetch your articles and send highlights. Choose "Always allow" so you are not asked every time.',
  'plugin.permission.FILE:READ': 'Inkwise reads its own EPUBs in Document/Inkwise to match highlights to articles, and reads your token and its backup from MyStyle/Inkwise.',
  'plugin.permission.FILE:WRITE': 'Inkwise saves articles as EPUBs in Document/Inkwise so the built-in reader can open them, and backs up its settings to MyStyle/Inkwise.',
  'plugin.permission.FILE:DELETE': 'Inkwise removes articles you archived (only if you turn that on).',
};

const PERMISSION_NAMES: Record<Permission, string> = {
  'plugin.permission.INTERNET': 'internet access',
  'plugin.permission.FILE:READ': 'permission to read files',
  'plugin.permission.FILE:WRITE': 'permission to write files',
  'plugin.permission.FILE:DELETE': 'permission to delete files',
};

export type AfterArchive = 'keep' | 'move' | 'delete';

export interface Settings {
  location: 'later' | 'shortlist' | 'new';
  /** Optional Reader tag filter. */
  tag: string;
  maxArticles: number;
  images: boolean;
  folderName: string;
  afterArchive: AfterArchive;
  /** Tidy up EPUBs whose documents left the queue on each sync. */
  removeMissing: boolean;
  /** Mark sent highlights (and ones made in Reader) in the EPUBs. */
  showHighlights: boolean;
  /** Bold words, a shaded paragraph, or both. */
  highlightStyle: HighlightStyle;
}

export const DEFAULT_SETTINGS: Settings = {
  location: 'later',
  tag: '',
  maxArticles: 30,
  images: true,
  folderName: 'Inkwise',
  afterArchive: 'move',
  removeMissing: false,
  showHighlights: true,
  highlightStyle: DEFAULT_HIGHLIGHT_STYLE,
};

export const STORAGE_ROOT = '/storage/emulated/0';
export const SHARED_DIR = `${STORAGE_ROOT}/MyStyle/Inkwise`;
export const TOKEN_IMPORT_PATH = `${SHARED_DIR}/token.txt`;
/**
 * Copies of settings.json and manifest.json (never the token). Uninstalling the
 * plugin wipes its private folder, and these bring everything back.
 */
export const BACKUP_DIR = `${SHARED_DIR}/backup`;

export class PermissionError extends Error {}

/** What a successful shade reports; quick send stays silent when it sees this. */
export const SHADED = 'Marked on the page.';

/** The Supernote keeps a document's handwriting in a sidecar file next to it. */
export const markSidecar = (path: string) => `${path}.mark`;

/**
 * Everything the three buttons and the settings page do, independent of React.
 */
export class InkwiseApp {
  private dir: string | null = null;

  /** MyStyle/Inkwise/inkwise-log.txt, for the user to send when something misbehaves. */
  readonly log: DeviceLog;

  constructor(
    readonly host: Host,
    readonly fs: DeviceFs,
    readonly fetch: FetchLike,
    /** Fetch used for images (on the device it downloads through the file system). */
    readonly imageFetch?: FetchLike,
  ) {
    this.log = new DeviceLog(fs, () => host.hasPermission('plugin.permission.FILE:WRITE'), SHARED_DIR, BUILD.version);
  }

  // ---- paths & storage -------------------------------------------------

  async privateDir(): Promise<string> {
    if (!this.dir) this.dir = await this.host.pluginDir();
    return this.dir;
  }

  async libraryDir(): Promise<string> {
    const s = await this.settings();
    return joinPath(STORAGE_ROOT, 'Document', sanitizeFolder(s.folderName));
  }

  async manifest(): Promise<ManifestStore> {
    const path = joinPath(await this.privateDir(), 'manifest.json');
    const fs = this.fs;
    const app = this;
    return textManifestStore({
      async read() {
        const main = (await fs.exists(path)) ? await fs.readText(path) : null;
        if (main === null) return app.restore('manifest.json', path);
        if (parses(main)) return main;
        // Corrupt manifest: keep a copy for diagnosis, then fall back to the last
        // complete write if one is lying around.
        await fs.writeText(`${path}.corrupt`, main).catch(() => {});
        const tmp = (await fs.exists(`${path}.tmp`)) ? await fs.readText(`${path}.tmp`) : null;
        return tmp !== null && parses(tmp) ? tmp : main;
      },
      async write(text) {
        // Write then rename, so a crash mid-write can't corrupt the queue.
        await fs.writeText(`${path}.tmp`, text);
        await fs.move(`${path}.tmp`, path);
        await app.backUp('manifest.json', text);
      },
    });
  }

  async settings(): Promise<Settings> {
    const path = joinPath(await this.privateDir(), 'settings.json');
    try {
      const text = (await this.fs.exists(path)) ? await this.fs.readText(path) : await this.restore('settings.json', path);
      if (text !== null) {
        const loaded: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(text) };
        // Styles from older builds ('both') fall back to the default.
        if (!HIGHLIGHT_STYLES.includes(loaded.highlightStyle)) loaded.highlightStyle = DEFAULT_HIGHLIGHT_STYLE;
        return loaded;
      }
    } catch {
      // Corrupt settings fall back to defaults.
    }
    return { ...DEFAULT_SETTINGS };
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.settings()), ...patch };
    next.maxArticles = Math.max(1, Math.min(200, Math.round(Number(next.maxArticles) || DEFAULT_SETTINGS.maxArticles)));
    next.folderName = sanitizeFolder(next.folderName);
    next.tag = next.tag.trim();
    if (!HIGHLIGHT_STYLES.includes(next.highlightStyle)) next.highlightStyle = DEFAULT_HIGHLIGHT_STYLE;
    const text = JSON.stringify(next, null, 2);
    await this.fs.writeText(joinPath(await this.privateDir(), 'settings.json'), text);
    await this.backUp('settings.json', text);
    return next;
  }

  /** Copy a private file to BACKUP_DIR. Only when Inkwise may already write there: never asks. */
  private async backUp(name: string, text: string): Promise<void> {
    try {
      if (!(await this.host.hasPermission('plugin.permission.FILE:WRITE'))) return;
      await this.fs.mkdir(BACKUP_DIR);
      await this.fs.writeText(joinPath(BACKUP_DIR, name), text);
    } catch {
      // The backup only matters after a reinstall; the private copy is what counts.
    }
  }

  /**
   * After a reinstall the private folder is empty: bring a file back from
   * BACKUP_DIR (if Inkwise may read it) and put it back in place.
   */
  private async restore(name: string, privatePath: string): Promise<string | null> {
    try {
      if (!(await this.host.hasPermission('plugin.permission.FILE:READ'))) return null;
      const backup = joinPath(BACKUP_DIR, name);
      if (!(await this.fs.exists(backup))) return null;
      const text = await this.fs.readText(backup);
      if (!parses(text)) return null;
      await this.fs.writeText(privatePath, text);
      return text;
    } catch {
      return null;
    }
  }

  // ---- token ---------------------------------------------------------------

  private async tokenPath() {
    return joinPath(await this.privateDir(), 'readwise-token');
  }

  /** Set by Disconnect, so a token.txt left on the device isn't picked up again. */
  private async disconnectedPath() {
    return joinPath(await this.privateDir(), 'disconnected');
  }

  async hasToken(opts: { ask?: boolean } = {}): Promise<boolean> {
    return !!(await this.token(opts));
  }

  /**
   * The stored token. After a reinstall the private folder starts empty, so
   * this falls back to MyStyle/Inkwise/token.txt. With `ask` it requests read
   * access for that; without, it only looks when access is already granted.
   */
  async token(opts: { ask?: boolean } = {}): Promise<string | null> {
    const p = await this.tokenPath();
    if (await this.fs.exists(p)) {
      const t = (await this.fs.readText(p)).trim();
      if (t) return t;
    }
    return this.tokenFromFile(!!opts.ask);
  }

  private async tokenFromFile(ask: boolean): Promise<string | null> {
    try {
      if (await this.fs.exists(await this.disconnectedPath())) return null;
      if (ask) await this.ensure('plugin.permission.FILE:READ');
      else if (!(await this.host.hasPermission('plugin.permission.FILE:READ'))) return null;
      if (!(await this.fs.exists(TOKEN_IMPORT_PATH))) return null;
      const token = cleanToken(await this.fs.readText(TOKEN_IMPORT_PATH));
      if (!token) return null;
      // Readwise checks it on first use; a bad one shows up as "token rejected".
      await this.fs.writeText(await this.tokenPath(), token);
      return token;
    } catch {
      return null;
    }
  }

  /** Validate, then store the token in the private plugin folder. */
  async setToken(raw: string): Promise<{ ok: boolean; message: string }> {
    const token = cleanToken(raw);
    if (!token) return { ok: false, message: 'Paste your Readwise access token first.' };
    await this.ensure('plugin.permission.INTERNET');
    const client = new ReadwiseClient({ token, fetch: this.fetch });
    let valid: boolean;
    try {
      valid = await client.validateToken();
    } catch (err) {
      return { ok: false, message: describeSyncError(err) };
    }
    if (!valid) return { ok: false, message: 'Readwise rejected that token. Copy it again from readwise.io/access_token.' };
    await this.fs.writeText(await this.tokenPath(), token);
    const off = await this.disconnectedPath();
    if (await this.fs.exists(off)) await this.fs.unlink(off);
    return { ok: true, message: 'Token works. You are connected to Readwise.' };
  }

  /**
   * Import from MyStyle/Inkwise/token.txt. The file stays, so Inkwise can pick
   * the token up again by itself after a reinstall.
   */
  async importToken(): Promise<{ ok: boolean; message: string }> {
    await this.ensure('plugin.permission.FILE:READ');
    if (!(await this.fs.exists(TOKEN_IMPORT_PATH))) {
      return { ok: false, message: 'No token file found. Put your token in MyStyle/Inkwise/token.txt and try again.' };
    }
    return this.setToken(await this.fs.readText(TOKEN_IMPORT_PATH));
  }

  async clearToken(): Promise<void> {
    const p = await this.tokenPath();
    if (await this.fs.exists(p)) await this.fs.unlink(p);
    await this.fs.writeText(await this.disconnectedPath(), new Date().toISOString());
  }

  private async client(): Promise<ReadwiseClient> {
    const token = await this.token({ ask: true });
    if (!token) throw new PermissionError('Connect Readwise first: open Inkwise settings and add your token.');
    return new ReadwiseClient({ token, fetch: this.fetch });
  }

  // ---- permissions -----------------------------------------------------

  async ensure(permission: Permission): Promise<void> {
    if (await this.host.hasPermission(permission)) return;
    if (await this.host.requestPermission(permission, PERMISSION_REASONS[permission])) return;
    // After a refusal the Supernote doesn't show the dialog again; the user
    // turns the permission on in the plugin's own settings on the device.
    const what = PERMISSION_NAMES[permission];
    throw new PermissionError(`Inkwise needs ${what} for this. Turn it on in the Supernote's plugin settings for Inkwise, then try again.`);
  }

  // ---- actions -----------------------------------------------------------

  /** Sync Reader button. Returns the one-line result. */
  async sync(onProgress: (line: string) => void): Promise<string> {
    try {
      await this.ensure('plugin.permission.INTERNET');
      await this.ensure('plugin.permission.FILE:WRITE');
      // Listing Document/Inkwise is how sync spots files the CLI already wrote.
      await this.ensure('plugin.permission.FILE:READ');
      const settings = await this.settings();
      if (settings.removeMissing) await this.ensure('plugin.permission.FILE:DELETE');
      const client = await this.client();
      const libraryDir = await this.libraryDir();
      await this.fs.mkdir(libraryDir);
      const result = await syncReader(
        {
          client,
          output: this.output(libraryDir),
          manifest: await this.manifest(),
          fetchImages: settings.images ? this.imageFetch ?? this.fetch : undefined,
          onProgress,
        },
        {
          location: settings.location,
          tags: settings.tag ? [settings.tag] : undefined,
          limit: settings.maxArticles,
          includeImages: settings.images,
          // Device images skip processing, so keep each EPUB small.
          imageBudgetBytes: 4 * 1024 * 1024,
          removeMissing: settings.removeMissing,
          removeMode: 'archive-folder',
          showHighlights: settings.showHighlights,
          highlightStyle: settings.highlightStyle,
        },
      );
      const counts: Record<string, number> = {};
      for (const i of result.items) counts[i.action] = (counts[i.action] ?? 0) + 1;
      await this.log.add(`sync: ${result.summary} (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'})`);
      for (const i of result.items) if (i.action === 'failed') await this.log.add(`sync failed on ${i.filename}: ${i.error ?? 'unknown error'}`);
      for (const w of result.warnings) await this.log.add(`sync warning: ${w}`);
      const tidied = await this.tidyArchived();
      if (!tidied) return result.summary;
      const verb = (await this.settings()).afterArchive === 'delete' ? 'Removed' : 'Moved';
      return `${result.summary} ${verb} ${tidied} finished ${tidied === 1 ? 'article' : 'articles'}${verb === 'Moved' ? ' to Archive' : ''}.`;
    } catch (err) {
      await this.log.add(`sync failed: ${errorText(err)}`);
      return describeSyncError(err);
    }
  }

  /** Send highlight button: reads the selection and current file from the DOC app. */
  async sendSelection(): Promise<SendResult & { selection?: string; shading?: string }> {
    const sel = await this.host.selectedText();
    if (!sel.ok || !sel.text.trim()) {
      await this.log.add(`send: no selection (${sel.ok ? 'empty' : sel.error})`);
      return { status: 'empty', message: 'Select some text first, then tap Send highlight.' };
    }
    const filePath = await this.host.currentFilePath();
    await this.log.add(`send: ${preview(sel.text)} from ${filePath ?? 'no file path'}`);
    if (!filePath) return { status: 'not_inkwise', message: "This document isn't from Readwise.", selection: sel.text };
    try {
      await this.ensure('plugin.permission.INTERNET');
    } catch {
      // No network permission: sendHighlight will queue it offline.
    }
    let client: ReadwiseClient;
    try {
      client = await this.client();
    } catch (err) {
      await this.log.add(`send: no token (${errorText(err)})`);
      return { status: 'token_rejected', message: (err as Error).message, selection: sel.text };
    }
    const result = await sendHighlight({
      client,
      manifest: await this.manifest(),
      filePath,
      text: sel.text,
      readIdentifier: (p) => this.readIdentifier(p),
    });
    await this.log.add(`send: ${result.status} for ${result.docId ?? 'unknown article'}: ${result.message}`);
    let shading: string | undefined;
    if (result.docId && (result.status === 'sent' || result.status === 'queued_offline' || result.status === 'duplicate')) {
      shading = await this.shadeOpenFile(filePath, result.docId);
    }
    return { ...result, selection: sel.text, shading };
  }

  /**
   * Rewrite the open EPUB so its highlights show, then have the DOC app reload
   * it. The SDK can't draw a highlight on a DOC page, so this is the way to make
   * a sent highlight visible. Returns a line for the screen, or undefined when
   * marking is off or doesn't apply.
   */
  async shadeOpenFile(filePath: string, docId: string, force = false): Promise<string | undefined> {
    const r = await this.markFile(filePath, docId, force);
    if (r.changed) {
      try {
        await this.host.reloadFile();
        await this.log.add('mark: asked the reader to reload the file');
      } catch (err) {
        await this.log.add(`mark: reload failed: ${errorText(err)}`);
        return `Marked, but the page didn't refresh (${errorText(err)}). Close and reopen the article to see it.`;
      }
    }
    return r.message;
  }

  /**
   * Mark a document's recorded highlights in one EPUB on disk. `force` rewrites
   * even with nothing to mark, to clear a deleted highlight.
   */
  private async markFile(
    filePath: string,
    docId: string,
    force = false,
  ): Promise<{ changed: boolean; message?: string }> {
    const { showHighlights, highlightStyle } = await this.settings();
    if (!/\.epub$/i.test(filePath) || !showHighlights) {
      await this.log.add(`mark: skipped (${showHighlights ? 'not an EPUB path' : 'marking is off'})`);
      return { changed: false };
    }
    const started = Date.now();
    try {
      const store = await this.manifest();
      const texts = (await store.load()).docHighlights[docId] ?? [];
      if (!texts.length && !force) {
        await this.log.add(`mark: no highlights recorded for ${docId}`);
        return { changed: false };
      }
      await this.ensure('plugin.permission.FILE:WRITE');
      const before = await this.fs.readBytes(filePath);
      const readMs = Date.now() - started;
      const r = markEpub(before, texts, highlightStyle);
      if (!r) {
        await this.log.add(`mark: ${filePath} isn't a readable EPUB (${before.length} bytes)`);
        return { changed: false, message: "Couldn't mark it on the page: the file isn't a readable EPUB." };
      }
      await this.log.add(
        `mark: ${r.marked} of ${texts.length} found (${highlightStyle}), ${before.length} -> ${r.bytes.length} bytes, read ${readMs} ms, marked ${Date.now() - started - readMs} ms`,
      );
      for (const h of r.missing) await this.log.add(`mark: not found in the text: ${preview(h)}`);
      const how = await this.replaceFile(filePath, r.bytes);
      const name = filePath.split('/').pop()!;
      await updateManifest(store, (m) => {
        const d = m.documents[docId];
        if (d && d.filename === name) d.marked = highlightsKey(texts, highlightStyle);
      });
      await this.log.add(`mark: saved ${name} (${how}) after ${Date.now() - started} ms`);
      return {
        changed: true,
        message: r.marked || !texts.length ? SHADED : "Couldn't find the passage on the page to mark it.",
      };
    } catch (err) {
      await this.log.add(`mark: failed after ${Date.now() - started} ms: ${errorText(err)}`);
      return { changed: false, message: `Couldn't mark it on the page: ${errorText(err)}` };
    }
  }

  /**
   * Replace a file's contents: write a hidden temp file and rename it over the
   * old one, so a reader never sees half a file. If the rename is refused,
   * write over the old file directly instead. Never deletes the original first.
   */
  private async replaceFile(path: string, bytes: Uint8Array): Promise<'renamed' | 'written in place'> {
    const tmp = joinPath(dirOf(path), `.${path.split('/').pop()}.part`);
    await this.fs.writeBytes(tmp, bytes);
    try {
      await this.fs.move(tmp, path);
      return 'renamed';
    } catch (err) {
      await this.log.add(`rename over ${path} refused (${errorText(err)}), writing in place`);
      await this.fs.writeBytes(path, bytes);
      await this.fs.unlink(tmp).catch(() => {});
      return 'written in place';
    }
  }

  /**
   * Settings button: mark every article that has highlights, right now, and
   * say what happened. Shows on screen what quick send can only log.
   */
  async markAll(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.ensure('plugin.permission.FILE:READ');
      await this.ensure('plugin.permission.FILE:WRITE');
    } catch (err) {
      return { ok: false, message: errorText(err) };
    }
    if (!(await this.settings()).showHighlights) return { ok: false, message: 'Marking highlights is off. Pick a style above first.' };
    const m = await (await this.manifest()).load();
    const library = await this.libraryDir();
    const onDisk = new Map<string, string>();
    for (const f of (await this.fs.exists(library)) ? await this.fs.listFiles(library) : []) {
      const id = /__([0-9a-z]{20,40})\.epub$/.exec(f.name)?.[1];
      if (id) onDisk.set(id, f.name);
    }
    const docs = Object.entries(m.docHighlights).filter(([id, texts]) => texts.length && onDisk.has(id));
    await this.log.add(`mark all: ${docs.length} articles with highlights in ${library}`);
    if (!docs.length) {
      return { ok: false, message: 'Inkwise has no highlights on record for articles in your folder. Tap Sync Reader, then try again.' };
    }
    const open = await this.host.currentFilePath().catch(() => null);
    let done = 0;
    const problems: string[] = [];
    for (const [id] of docs) {
      const path = joinPath(library, onDisk.get(id)!);
      await this.log.add(`mark all: ${onDisk.get(id)}${path === open ? ' (open now)' : ''}`);
      const r = await this.markFile(path, id);
      if (r.changed && r.message === SHADED) done++;
      else problems.push(`${m.documents[id]?.title ?? onDisk.get(id)}: ${r.message ?? 'skipped'}`);
      if (r.changed && path === open) await this.host.reloadFile().catch(() => {});
    }
    const head = `Marked highlights in ${done} of ${docs.length} ${docs.length === 1 ? 'article' : 'articles'}.`;
    return { ok: !problems.length, message: problems.length ? `${head} ${problems[0]}` : head };
  }

  async addNote(args: { docId: string; text: string; note: string; highlightId?: string }) {
    return addNoteToHighlight({ client: await this.client(), manifest: await this.manifest(), ...args });
  }

  /** Delete a highlight in Readwise and clear its shading from the open article. */
  async deleteHighlight(docId: string, text: string): Promise<{ ok: boolean; message: string }> {
    let client: ReadwiseClient;
    try {
      client = await this.client();
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const r = await deleteHighlight({ client, manifest: await this.manifest(), docId, text });
    if (r.ok) {
      const path = await this.host.currentFilePath();
      if (path) await this.shadeOpenFile(path, docId, true);
    }
    return r;
  }

  /** Done button: flush highlights, archive in Reader, then tidy the local file. */
  async done(): Promise<{ ok: boolean; message: string }> {
    const filePath = await this.host.currentFilePath();
    if (!filePath) return { ok: false, message: "This document isn't from Readwise." };
    const manifest = await this.manifest();
    const docId = await resolveDocId(await manifest.load(), filePath, (p) => this.readIdentifier(p));
    if (!docId) return { ok: false, message: "This document isn't from Readwise." };
    try {
      await this.ensure('plugin.permission.INTERNET');
    } catch {
      // Offline path below queues the archive.
    }
    let client: ReadwiseClient;
    try {
      client = await this.client();
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const r = await archiveDocument({ client, manifest, filePath, readIdentifier: (p) => this.readIdentifier(p) });
    if (r.status !== 'archived' && r.status !== 'queued_offline') return { ok: false, message: r.message };
    // The article is still open in the DOC app, so leave the file alone: moving
    // it now pulls it out from under the reader ("MARK file cannot be found").
    // The next sync tidies it.
    const { afterArchive } = await this.settings();
    const later =
      r.status !== 'archived'
        ? ''
        : afterArchive === 'move'
        ? ' It moves to Inkwise/Archive on your next sync.'
        : afterArchive === 'delete'
          ? ' It is removed from the device on your next sync.'
          : '';
    return { ok: true, message: `${r.message}${later}` };
  }

  /**
   * Move (or delete) EPUBs archived with Done, along with their handwriting
   * file, skipping whatever is open right now. Runs at the end of each sync.
   */
  async tidyArchived(): Promise<number> {
    const { afterArchive } = await this.settings();
    if (afterArchive === 'keep') return 0;
    const library = await this.libraryDir();
    const open = await this.host.currentFilePath().catch(() => null);
    const m = await (await this.manifest()).load();
    let tidied = 0;
    for (const d of Object.values(m.documents)) {
      if (d.status !== 'archived') continue;
      const path = joinPath(library, d.filename);
      if (path === open || !(await this.fs.exists(path))) continue;
      try {
        if (afterArchive === 'move') {
          const dir = joinPath(library, 'Archive');
          await this.fs.mkdir(dir);
          await this.fs.move(path, joinPath(dir, d.filename));
          if (await this.fs.exists(markSidecar(path))) await this.fs.move(markSidecar(path), markSidecar(joinPath(dir, d.filename)));
        } else {
          await this.ensure('plugin.permission.FILE:DELETE');
          await this.fs.unlink(path);
          // The handwriting file stays: deleting someone's notes is never worth the risk.
        }
        tidied++;
      } catch {
        // Leave it for the next sync.
      }
    }
    return tidied;
  }

  /** Highlights waiting to send or needing review (for the settings page). */
  async queue(): Promise<{ pending: PendingHighlight[]; archives: number; titles: Record<string, string> }> {
    const m = await (await this.manifest()).load();
    const titles: Record<string, string> = {};
    for (const [id, d] of Object.entries(m.documents)) titles[id] = d.title;
    return { pending: m.pendingHighlights, archives: m.pendingArchives?.length ?? 0, titles };
  }

  /** `key` is the highlight's docId and createdAt, which stay put when the queue changes. */
  async review(key: { docId: string; createdAt: string }, action: ReviewAction, text?: string) {
    return resolveNeedsAttention({ client: await this.client(), manifest: await this.manifest(), key, action, text });
  }

  /** Send everything queued without a full sync. */
  async flush(): Promise<string> {
    try {
      const client = await this.client();
      const r = await updateManifest(await this.manifest(), (m) => flushPending({ client, manifest: m }));
      if (!r.sent && !r.archived && r.stillPending) return 'Still offline. Everything stays queued.';
      return `Sent ${r.sent} ${r.sent === 1 ? 'highlight' : 'highlights'}${r.archived ? `, archived ${r.archived}` : ''}.`;
    } catch (err) {
      return describeSyncError(err);
    }
  }

  // ---- device plumbing ---------------------------------------------------

  private async readIdentifier(path: string): Promise<string | null> {
    try {
      await this.ensure('plugin.permission.FILE:READ');
      return epubIdentifier(await this.fs.readBytes(path));
    } catch {
      return null;
    }
  }

  output(dir: string): OutputAdapter {
    const fs = this.fs;
    const app = this;
    return {
      name: 'device',
      async list() {
        return (await fs.exists(dir)) ? fs.listFiles(dir) : [];
      },
      async put(filename, bytes) {
        // Through a hidden temp name, so the DOC app never sees half a file.
        await app.replaceFile(joinPath(dir, filename), bytes);
      },
      async remove(filename) {
        await fs.unlink(joinPath(dir, filename));
      },
      async moveToSubfolder(filename, subfolder) {
        await fs.mkdir(joinPath(dir, subfolder));
        const from = joinPath(dir, filename);
        const to = joinPath(dir, subfolder, filename);
        await fs.move(from, to);
        if (await fs.exists(markSidecar(from))) await fs.move(markSidecar(from), markSidecar(to));
      },
    };
  }
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Accept a bare token, "Token xyz", or a file with surrounding whitespace/newlines. */
export function cleanToken(raw: string): string {
  return raw
    .replace(/^﻿/, '')
    .trim()
    .replace(/^Token\s+/i, '')
    .split(/\s+/)[0] ?? '';
}

export function sanitizeFolder(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '').trim();
  return cleaned || DEFAULT_SETTINGS.folderName;
}

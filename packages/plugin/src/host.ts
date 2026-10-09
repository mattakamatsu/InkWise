import { PluginCommAPI, PluginDocAPI, PluginManager } from 'sn-plugin-lib';
import type { Host, Permission } from './services/app';

/** sn-plugin-lib data APIs resolve to this shape even though they're typed as Object. */
interface APIResponse<T> {
  success: boolean;
  result: T | null;
  error: { code: number; message: string } | null;
}

function asResponse<T>(v: unknown): APIResponse<T> {
  if (v && typeof v === 'object' && 'success' in v) return v as APIResponse<T>;
  return { success: false, result: null, error: { code: 100, message: 'Unexpected response from the Supernote' } };
}

/** Error codes worth translating for the user (from the SDK's PluginAPIError table). */
const ERRORS: Record<number, string> = {
  1217: 'This file is encrypted. Unlock it first.',
  1500: 'Permission missing from PluginConfig.json (a bug in Inkwise).',
  1501: 'Inkwise needs permission to write files.',
  1503: 'Inkwise needs permission to read files.',
};

/**
 * Some host calls never answer in the wrong context (asking for the open file
 * from the settings page, for one), so don't wait on them forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The Supernote didn't answer (${what}).`)), ms);
  });
  return Promise.race([p, late]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export const supernoteHost: Host = {
  async pluginDir() {
    const dir = await PluginManager.getPluginDirPath();
    if (!dir) throw new Error('The Supernote did not give Inkwise a storage folder.');
    return dir;
  },
  async hasPermission(p: Permission) {
    // The SDK's own types disagree on the answer: 0/1, or 0/1/2 with 2 for
    // "always allow" (NativePluginManager.ts). Treating 2 as "not granted"
    // would silently stop the log, backups and token re-import after the user
    // chose Always allow. Hardware-tested plugins (sn-clipper) accept 1 or 2.
    return Number(await PluginManager.hasPermission(p)) >= 1;
  },
  async requestPermission(p: Permission, description: string) {
    const r = await PluginManager.requestPermission(p, description);
    return r === 1 || r === 2;
  },
  async selectedText() {
    try {
      const r = asResponse<string>(await PluginDocAPI.getLastSelectedText());
      if (r.success && typeof r.result === 'string') return { ok: true as const, text: r.result };
      return { ok: false as const, error: ERRORS[r.error?.code ?? 0] ?? r.error?.message ?? 'No text selected.' };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
  async reloadFile() {
    const r = asResponse<unknown>(await withTimeout(PluginCommAPI.reloadFile(), 10000, 'reload file'));
    if (!r.success) throw new Error(r.error?.message ?? 'The Supernote would not reload the file.');
  },
  async currentFilePath() {
    try {
      const r = asResponse<string>(await withTimeout(PluginCommAPI.getCurrentFilePath(), 3000, 'current file'));
      return r.success && r.result ? r.result : null;
    } catch {
      return null;
    }
  },
};

export async function closeView() {
  try {
    await PluginManager.closePluginView();
  } catch {
    // Nothing useful to do if the host refuses.
  }
}

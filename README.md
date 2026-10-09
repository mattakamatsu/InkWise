# Inkwise

Readwise Reader on a Supernote. Inkwise pulls articles from your Reader queue, turns them into clean EPUBs, and puts them where the Supernote's own document reader opens them. Highlight a passage with the pen, tap **Send highlight**, and it lands in Readwise on the right Reader document. When you finish an article, tap **Done** and it's archived in Reader.

The plugin doesn't try to be a reader. Reading happens in the Supernote's built-in DOC app, which is better on e-ink than anything a plugin could draw.

> **Status: v0.1, untested on hardware.** Everything here has been built and tested against fakes of the Readwise API, the Supernote host and Supernote Cloud. The first real-device run is next. See [docs/TESTING-ON-DEVICE.md](docs/TESTING-ON-DEVICE.md).

## What's in the box

| Package | What it is |
| --- | --- |
| [`packages/core`](packages/core) | Pure TypeScript, no Node or DOM APIs. Readwise client (pagination, 429 handling), HTML to XHTML cleanup, EPUB 3 builder, sync engine, highlight queue, archive flow. Runs unchanged in Node and React Native. |
| [`packages/cli`](packages/cli) | Desktop CLI (`inkwise`). Syncs your queue to Supernote Cloud, Dropbox, Google Drive or any folder. Also sends highlights and archives from the terminal, which is handy for testing. |
| [`packages/plugin`](packages/plugin) | The Supernote plugin (React Native 0.79.2, `sn-plugin-lib` 0.1.65). Buttons: **Sync Reader**, **Send highlight**, **Done**, plus a settings page. |

## The plugin

### Install

1. Download `Inkwise-<version>.snplg` from the latest [CI run](../../actions/workflows/ci.yml) (artifact **Inkwise-snplg-&lt;version&gt;**) or from a [release](../../releases).
2. Connect the Supernote over USB (or use your sync service) and copy the file into `MyStyle/`.
3. On the device: **Settings → Apps → Plugins → Add Plugin**, pick Inkwise.
4. Open Inkwise's settings from the plugin list and add your Readwise token. Either paste it (from [readwise.io/access_token](https://readwise.io/access_token)) or save it as `MyStyle/Inkwise/token.txt` and tap **Import token file**. Inkwise leaves the file where it is, so after a reinstall it reads the token from there by itself.

You need firmware with the plugin beta (Chauvet 3.29.44_beta or later on Manta and Nomad; 3.29.43_beta introduced plugins and was withdrawn).

### Update

Copy the new `Inkwise-<version>.snplg` into `MyStyle/` (each build has its own file name, so nothing clashes) and pick it from **Add Plugin**. Try that without uninstalling first: every build has a higher version number than the one before, so the Manta may install it as an upgrade and keep your token, settings and permissions. The version shows at the bottom of Inkwise settings.

If you do uninstall, the Manta wipes the plugin's private folder and its permissions. Once you allow file access again, Inkwise reads the token back from `token.txt` and its settings and highlight queue from `MyStyle/Inkwise/backup/`.

### Use

- **Sync Reader** (sidebar, NOTE and DOC): fetches your Later queue and writes EPUBs to `Document/Inkwise/`. Each one is named `Title__<readwise-id>.epub`. Articles, newsletters, feed items and tweets all come along; PDFs, EPUBs and videos you saved to Reader stay there, and the sync log says how many it left out.
- **Send highlight** (DOC text-selection toolbar): sends the selected text as a highlight on the matching Reader document and marks the passage in the EPUB, with no popup, so you keep reading. By default the words get underlined. The Manta's reader ignores CSS underlines and can't put grey behind single words, so Inkwise draws the line with the font's combining low line (U+0332) before each character. Settings can switch to bold italic words or a grey paragraph instead. Plugins can't draw a highlight on a DOC page, so the mark lives in the EPUB itself and reflows with any font size or margin. With no connection, the highlight is saved and sent on the next sync. A screen only opens when something needs you, such as text Readwise couldn't match.
- **Editing a highlight:** select a marked passage again and tap **Send highlight**. Instead of sending it twice, Inkwise opens it so you can add a note or delete it (in Readwise too).
- **Done** (DOC sidebar): sends any queued highlights for the article and archives it in Reader. The open file stays put; the next sync moves it to `Document/Inkwise/Archive/` with its handwriting file (or keeps or deletes it; that's a setting).
- Highlights you make in Reader elsewhere get marked on the next sync.
- **Settings**: Reader location (Later, Shortlist, Inbox), tag filter, article limit, images on or off, how highlights are marked (or not at all), folder name, what Done does with the file, and a queue of highlights waiting to send or needing a fix.

### Permissions

Inkwise asks for each one the first time it's needed, and says why.

| Permission | Used for |
| --- | --- |
| Internet | Talking to Readwise |
| File write | Saving EPUBs into `Document/Inkwise`, and backing up settings to `MyStyle/Inkwise/backup` |
| File read | Seeing which articles are already in the folder, reading a renamed EPUB's id, reading `token.txt` and the backup |
| File delete | The optional delete-on-Done setting |

The token, the manifest and the highlight queue live in the plugin's private folder. Inkwise also copies the settings and the manifest (never the token) to `MyStyle/Inkwise/backup/`, so an uninstall doesn't lose them. Delete that folder to start fresh. Inkwise also keeps a log of what it did in `MyStyle/Inkwise/inkwise-log.txt` (never the token), which is the first thing to look at when something misbehaves. If your Supernote syncs `MyStyle` to a cloud service, the backup, the log and `token.txt` go along with it.

## Getting highlights to match

Readwise only accepts a highlight if its text appears in the original article, so Inkwise:

1. Keeps the article text exactly as Readwise sent it: no smart quotes, no whitespace changes, no hyphenation.
2. Cleans the selection (trims it, collapses whitespace, drops soft hyphens and zero-width characters).
3. If Readwise says it can't find the text, fetches Reader's copy of the article, finds the passage while ignoring quote style, dashes, case and whitespace, and sends the exact original text.
4. If that also fails, tries straight and curly quote variants.
5. If nothing matches, the highlight is kept in the queue as "needs attention". From settings you can edit it and retry, send it to Readwise as a standalone highlight, or discard it. A highlight is never dropped silently.

## The CLI

```bash
git clone https://github.com/Valadon/InkWise.git && cd InkWise
npm ci && npm run build
export READWISE_TOKEN=...            # never put it in a file in the repo
node packages/cli/dist/index.js --help
```

Common runs:

```bash
inkwise sync --mock --target folder --out ./out   # sample articles, no token needed
inkwise auth                                      # check the token
inkwise sync --target folder --out /Volumes/SUPERNOTE/Document/Inkwise --dry-run
inkwise sync                                      # default target from ~/.config/inkwise/config.toml
inkwise highlight path/to/Article__<id>.epub "a sentence from it" --note "why"
inkwise archive <readwise-id>
inkwise supernote-login                           # stores a session token only, never your password
```

`inkwise init` writes a commented config file. Secrets only ever come from environment variables (`READWISE_TOKEN`, `SUPERNOTE_CLOUD_TOKEN`, `DROPBOX_TOKEN`, `GDRIVE_ACCESS_TOKEN`) or the Supernote session file (mode 0600). The config loader refuses to start if it finds a secret in the config file.

Targets:

- **`supernote-cloud`** (default) uploads to `Document/Inkwise` in your Supernote Cloud. There's no official API, so this follows what working community tools do (the Obsidian "Supernote Cloud Sync" plugin and the "Send to Supernote" extension). It could break if Supernote changes things.
- **`dropbox`** and **`gdrive`** either write into your desktop sync folder (`mode = "folder"`) or use the API with a token (`mode = "api"`).
- **`folder`** writes to any path, such as a USB-mounted Supernote.

If you use both the CLI and the plugin, you won't get duplicates. Every filename ends in `__<readwise-id>`, and both skip any article whose id is already in the folder.

## Development

```bash
npm ci && npm run build
(cd packages/plugin && npm ci)     # the plugin has its own React Native dependencies
npm test                           # vitest: core, CLI and plugin service tests
npm run epubcheck                  # needs Java; validates EPUBs built from fixtures/
(cd packages/plugin && npm run typecheck && npm run bundle)
```

To build the `.snplg` yourself you need JDK 19+ and the Android SDK (platform 35, build-tools 35.0.0), because `react-native-fs` is native code. Then run `cd packages/plugin && ./buildPlugin.sh`, which writes `packages/plugin/build/outputs/Inkwise.snplg` (CI runs the same build on every push).

`fixtures/documents/` holds made-up sample articles (long-form text with curly quotes, images, code and tables, deliberately messy HTML). The fake Readwise in `packages/core/src/testing` serves them and applies the same exact-match rule for highlights as the real API.

## License

MIT

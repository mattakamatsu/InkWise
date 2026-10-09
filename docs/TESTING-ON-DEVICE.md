# Testing Inkwise on a Supernote

Everything in this repo has been tested against fakes (of Readwise, the Supernote plugin host and Supernote Cloud), but none of it has run on a device yet. This is the checklist for the first real run. It's ordered so each step tells you something even if the next one fails.

You'll need your Readwise token from [readwise.io/access_token](https://readwise.io/access_token).

## Part 1: before the plugin beta (CLI only, about 15 minutes)

These steps prove that the EPUBs read well and that highlights match, without touching the plugin.

```bash
git clone https://github.com/Valadon/InkWise.git && cd InkWise
npm ci && npm run build
export READWISE_TOKEN=your-token
alias inkwise="node $PWD/packages/cli/dist/index.js"

inkwise auth                                   # expect "Readwise token works."
inkwise sync --target folder --out ./out --limit 5
```

- [ ] **1.1** Five EPUBs appear in `./out`, named `Title__<id>.epub`.
- [ ] **1.2** Copy them to the Manta's `Document/` folder over USB, open each one in the DOC app, and check:
  - The title block at the top looks right.
  - Text is readable at the default size.
  - Images show up in greyscale.
  - Code blocks and tables don't overflow the page.
  - The table of contents opens.
- [ ] **1.3** **Highlight spike (the riskiest piece).** Pick a sentence from one of those articles that has curly quotes or an em dash, and send it from the terminal:

  ```bash
  inkwise highlight ./out/Some-Title__<id>.epub "the sentence, copied from the article"
  ```

  Expect `Highlight sent.` Then check in Reader that the highlight is on that article. Also try typing it with straight quotes (`"`); the output should say `Matched Reader's text as: …` with the curly version.
- [ ] **1.4** `inkwise archive <id>` moves the article to Archive in Reader. Move it back afterwards if you want to keep it.
- [ ] **1.5** (Optional) Supernote Cloud upload: `inkwise supernote-login`, then `inkwise sync --limit 2`. The files should show up in `Document/Inkwise` on the Manta after it syncs. If login fails, `inkwise supernote-login --token <x-access-token cookie from cloud.supernote.com>` also works.

## Part 2: install the plugin

You need the plugin beta firmware. 3.29.43_beta (26 Aug 2026) introduced plugins and was then withdrawn; 3.29.44_beta (2 Sep 2026) replaced it. Settings → About shows which you have.

1. Get `Inkwise-0.2.N.snplg` from the latest green CI run: **Actions → CI → newest run → Artifacts → Inkwise-snplg-0.2.N**. It downloads as a zip; the `.snplg` is inside. Each build has its own version number, which the plugin list and the bottom of Inkwise settings both show, so you can tell which build is installed.
2. Copy it into `MyStyle/` on the Manta.
3. **Settings → Apps → Plugins → Add Plugin**, then choose Inkwise.

- [ ] **2.1** It installs, and the plugin list shows the Inkwise icon (a page with lines).
- [ ] **2.2** Three buttons appear:
  - **Sync Reader** in the sidebar (in NOTE and DOC)
  - **Done** in the DOC sidebar
  - **Send highlight** in the DOC text-selection toolbar
- [ ] **2.3** Upgrade: copy a newer build into `MyStyle/` and pick it from **Add Plugin** without uninstalling. The version at the bottom of Inkwise settings changes, and the token, settings and permissions are all still there. Other plugin authors report that upgrading a plugin with native code in place can crash the host once, with "not compatible with the current system version" on the next tap; tapping again has worked. If it keeps failing, uninstall and reinstall (2.4).
- [ ] **2.4** If an upgrade won't install, uninstall and reinstall, then tap **Sync Reader**. After the permission prompts it syncs without asking for the token again, and your settings are back.

## Part 3: plugin checks

### Setup
- [ ] **3.1** Open Inkwise's settings (the gear in the plugin list). Paste your token and tap **Save token**. Expect an Internet permission prompt. Choose **Always allow**, then expect "Token works."
- [ ] **3.2** Alternative path: tap **Disconnect**, save the token as `MyStyle/Inkwise/token.txt`, then tap **Import token file**. Expect a read permission prompt, then "Token works." The file stays in `MyStyle/Inkwise/`.

### Sync
- [ ] **3.3** Tap **Sync Reader**. Expect write and read permission prompts (choose Always for both), progress lines, then "Synced N new, 0 updated."
- [ ] **3.4** Open `Document/Inkwise/` in the file browser. The articles are there and open in DOC.
- [ ] **3.5** Tap **Sync Reader** again. Expect "Synced 0 new, 0 updated."

### Highlights (the main event)
For each passage below, select it in an Inkwise EPUB and tap **Send highlight**. Expect "Highlight sent." Afterwards, check that every one shows up in Reader on the right article.
- [ ] **3.6** A plain sentence.
- [ ] **3.7** A sentence with curly quotes or an apostrophe (it’s).
- [ ] **3.8** A sentence with an em dash.
- [ ] **3.9** A selection that spans two paragraphs.
- [ ] **3.10** A sentence containing italics or a link.
- [ ] **3.11** Send highlight opens no screen: the words get underlined, and you're still reading. Select underlined words again and Send highlight offers to edit or delete that highlight. Handwriting already on the page stays where it was.
- [ ] **3.11a** Select that passage again and tap Send highlight. A screen opens with the note field and **Delete highlight**. Add a note; it should show in Reader. Then delete it; the mark goes and Reader no longer has it.
- [ ] **3.11b** Change the font size and margins. The mark should follow the text.
- [ ] **3.11c** Highlight a passage in Reader on your phone, tap **Sync Reader**, and check the passage is marked on the Manta.
- [ ] **3.11d** In Inkwise settings, tap **Mark highlights now**. It should say how many articles it marked; anything else names the article and the problem.
- [ ] **3.12** Select only part of a marked passage and tap Send highlight. It should open the existing highlight, not send a new one.
- [ ] **3.13** Turn off Wi-Fi and send a highlight. Expect "Saved offline, will send on next sync." Turn Wi-Fi back on and tap **Sync Reader**. The result line should say it sent 1 saved highlight.
- [ ] **3.14** Select text in a non-Inkwise PDF and tap Send highlight. Expect "This document isn't from Readwise."

### Done
- [ ] **3.15** In an Inkwise article, tap **Done**. Expect "Archived in Reader. It moves to Inkwise/Archive on your next sync." and no MARK-file error. Tap **Back to reading**, leave the article, then tap **Sync Reader**. The result should say it moved 1 finished article, and the file (with any handwriting) is in `Document/Inkwise/Archive/`.

## What we don't know yet

These are the open questions only a device can answer. If any of them goes wrong, the screen message (or a photo of it) is usually enough to fix it.

| Question | Where it matters | What to look for |
| --- | --- | --- |
| Does `getLastSelectedText()` work on EPUBs, and what does it return for multi-paragraph selections? | Send highlight | Steps 3.6 to 3.10. Wrong text shows up as "needs attention" in the settings queue. |
| Does `getCurrentFilePath()` return the full path in DOC? | Send highlight, Done | If it doesn't, every highlight will say "This document isn't from Readwise." |
| Does `react-native-fs` load inside PluginHost? | Everything that touches files | If not, Sync fails right away with a native module error. |
| Does the host allow `fetch` once Internet is granted? | Sync, highlights | "No connection to Readwise" even though Wi-Fi works. |
| Do the button icons render? | Looks only | Blank icons. |
| Does reopening the plugin view from a second button press re-run the action? | All buttons | Pressing Sync twice should sync twice. |
| Does `showType: 0` really mean "no popup" for a selection-toolbar button? | Quick send | A blank or "Sending…" screen after each send. |
| Does Reader accept `DELETE /api/v3/delete/<id>/` for a highlight? | Delete highlight | An error message instead of "Highlight deleted." |
| Is the handwriting file really `<name>.epub.mark` next to the EPUB? | Done, then sync | Handwriting missing after the article moves to Archive. |
| Does `reloadFile()` show a rewritten EPUB straight away, and do handwritten marks survive it? | Marking highlights | No mark until the article is closed and reopened, or handwriting that moves. Marking can be turned off in settings. |
| Which highlight styles does the DOC reader draw? | Marking highlights | Answered on a Manta with the plugin beta (2026-10-08): bold, grey text, and a background or border on a whole paragraph. No underlines, and no background behind words. The reader also skips a rule written for a bare class (`.rw-hl-block`) and draws only rules that name the element too (`p.rw-hl-block`), so Inkwise writes one rule per element. A second test (2026-10-09) found that inline-block lays out as a block, so a box behind the words lands on its own line, while a combining low line (U+0332) draws a real underline that wraps with the text. That underline is the default. To check another device, run `node scripts/make-highlight-test-epub.mjs` and `node scripts/make-word-mark-test-epub.mjs` and note which numbered lines look marked. |
| Does Reader's tag filter want the tag's display name or its lowercase key? | Sync with a tag set | Answered against the live API (2026-10-09): the lowercase key, and the filter is case-sensitive ("Evidence" found nothing, "evidence" found the document). Inkwise now lowercases the tag before asking. |
| Does `react-native-fs` get loaded by PluginHost at all? | Everything that touches files | No plugin on current firmware ships it. Since 2026-10-09 a failure to load shows as an error on the Sync screen instead of leaving the buttons dead; CI also checks that `com.rnfs.RNFSPackage` is in the package's `reactPackages`. |

## If something breaks

Post in the project thread with:
- the step number,
- exactly what the screen said (a photo works),
- your firmware version (Settings → About),
- `MyStyle/Inkwise/inkwise-log.txt`, copied off with Browse & Access. It records each sync, send and mark step with any error, and never the token.

On the device, Inkwise keeps its state in the plugin's private folder, with a backup in `MyStyle/Inkwise/backup/`. To start over, remove the plugin, delete that backup folder, and add the plugin again.

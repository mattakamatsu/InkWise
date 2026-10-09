# Inkwise review, 2026-10-09

A read-through of the whole repo before its first run on a Manta, done for one
user's setup: a Readwise Reader account with 2,268 articles in Later, 1,009 in
the inbox, 965 Reader highlights, and a Manta that will go on the plugin beta.
Everything below was checked by running the code, not by reading alone.

## Where upstream stood

`Valadon/InkWise` at `6f94e72`: 19 commits over two days, all authored by
Claude, no releases, no stars. The README says "untested on hardware", though
`docs/TESTING-ON-DEVICE.md` records highlight-style tests run on a Manta with
the plugin beta on 2026-10-08 and 09. So the EPUB reader's CSS behaviour is
known; the plugin host's behaviour is not.

## Verdict

The design is right for the device: reading happens in the stock DOC app, the
plugin only moves files and talks to Readwise, and everything that touches
Readwise or the file system is behind an interface with a fake. The core is
well tested (206 tests) and held up against real Reader data with one bug. The
plugin's use of the SDK matches what hardware-tested plugins do in every place
but three, listed under "Watch on the first device run".

## What was verified

| Check | Result |
| --- | --- |
| `npm ci && npm run build && npm run typecheck` | clean |
| `npm test` (core, CLI, plugin services) | 254 pass after the changes below (205 before) |
| Plugin `tsc --noEmit` and Metro bundle | clean, 1.4 MB bundle |
| `.snplg` (needs JDK 21 + Android SDK 35) | built locally with `packages/plugin/local-build.sh` (see `docs/LOCAL-BUILD.md`): 7.3 MB, `reactPackages` lists `com.rnfs.RNFSPackage` |
| 8 real Reader articles through `buildEpub` + epubcheck | 7/8 valid before the table fix, 8/8 after |
| Highlights lifted from those articles, marked with `markEpub` | found in every article (3/3 each) |
| Reader's tag filter, "Evidence" vs "evidence" | case-sensitive, wants the lowercase key |

Timings in Node on the real articles were all small: a 10,230-word Nature
piece with four images took 8 ms to scan, 34 ms to build and 38 ms to mark;
downloading its 859 KB of images took 0.8 s. The tablet's JS engine is slower,
but nothing here is in a loop that scales badly.

## Fixed in this fork (branch `matt/first-pass`)

1. **Tables mixing bare rows and sections produced invalid XHTML.** A real
   article wrote its header row as `<tr>` and the body in `<tbody>`, which
   epubcheck rejects. Every row now lands in a section, and a late `<thead>`
   or any `<tfoot>` becomes a body section. `core/src/html.ts`.
2. **Tag filter matched nothing unless typed in lowercase.** Reader filters on
   the tag key, which is the name lowercased. Tags are lowercased before the
   request. `core/src/readwise.ts`. This answers the open question in the
   testing checklist.
3. **"Always allow" counted as not granted.** `hasPermission` compared with 1;
   the host answers 2 for always-allow (per the SDK's own
   `NativePluginManager.ts`). The log, backups and token re-import would all
   have gone silent after the user chose it. `plugin/src/host.ts`.
4. **A missing native module killed every button with no message.**
   `react-native-fs` was imported at module load, before buttons were
   registered; its import throws when the host didn't load it. It now loads on
   first use, and CI fails if `com.rnfs.RNFSPackage` is missing from the
   package list. `plugin/src/services/rnfs.ts`, `.github/workflows/ci.yml`.
5. **JS errors closed the plugin view silently.** An error boundary logs and
   shows them. `plugin/App.tsx`.
6. **Permission-refused message said "next time you try"**, but the host
   doesn't show the dialog again after a refusal. `plugin/src/services/app.ts`.
7. **Every sync fetched the HTML of every listed article.** Thirty articles
   meant parsing megabytes of JSON on the tablet even when nothing changed.
   The listing is now metadata only; content is fetched for the articles that
   will be written, singly for a few or in one listing limited to changes
   since the last sync for more. `core/src/sync.ts`.

## Watch on the first device run

From an audit of every SDK call against `sn-plugin-lib` 0.1.65, the official
docs, and six community plugins that run on hardware (sn-clipper,
SuperDashboard, SuperStickyNote, readwise-supernote-digest, supernote-book,
supernote-native-task-plugin):

- **Firmware.** 3.29.43_beta was withdrawn and replaced by 3.29.44_beta
  (2 Sep 2026). The README's "3.29.4x" is fine; expect 3.29.44.
- **`react-native-fs` inside PluginHost.** No plugin on current firmware ships
  it. The mechanism is sound (other plugins ship other native modules), but it
  is the first thing to confirm: tap Sync Reader and see whether files appear.
  With fix 4 a failure now shows on screen instead of leaving dead buttons.
- **Rewriting the open EPUB, then `reloadFile()`.** Nothing hardware-tested
  does this. The DOC app may cache its parse, and the handwriting sidecar
  (`.mark`) may be keyed to the file. Worst case is misplaced handwriting on
  an article you drew on. Marking can be turned off in settings; for the first
  session, test it on an article without handwriting.
- **Writing into `Document/`.** Other plugins write to their private folder or
  `MyStyle/`. The docs list `Document/` among the FILE:* directories, so this
  should work with FILE:WRITE; renaming over an existing file may turn out to
  need FILE:DELETE. If "Synced N new" shows but files are missing, the log in
  `MyStyle/Inkwise/inkwise-log.txt` will say which call failed.
- **Upgrading a plugin with native code in place** has crashed the host once
  on other plugins (Reddit, r/Supernote_dev). A second tap after the crash is
  reported to work.

## Not changed, on purpose

- **First highlight fetch pulls every Reader highlight since the oldest synced
  article.** For this account that is 965 highlights, about ten requests, under
  a minute. Reader's API has no per-document highlight filter, so there is no
  cheaper way; it only matters once, and is then incremental.
- **Images are embedded as downloaded on the device** (no downscale or
  greyscale; the CLI has both). The 4 MB budget per article keeps it bounded.
  A resizer would need another native module, which is the riskiest kind of
  dependency right now.
- **Default location is Later with a limit of 30 and no tag.** For a 2,268-item
  Later list that means whichever 30 Reader lists first. A tag is the better
  workflow for this account; see below.
- **Supernote Cloud adapter in the CLI** uses an unofficial API and may break;
  the plugin doesn't need it.

## Suggested first session

1. Put the Manta on the plugin beta. Install the `.snplg` from the fork's CI
   artifact.
2. In Reader, tag five or six short articles `supernote`. In Inkwise settings,
   set the tag to `supernote`, location to Inbox or Later (wherever those
   live), limit 10, images on, marking off for now.
3. Sync. Open an article. Select a sentence and tap Send highlight; check
   Reader. Tap Done; sync again; check `Document/Inkwise/Archive`.
4. Turn marking on (underline), highlight a passage in an article with no
   handwriting, and see whether the page refreshes and the mark lands.
5. Copy `MyStyle/Inkwise/inkwise-log.txt` off the device whatever happens.

## For upstream

Fixes 1 through 7 are each a self-contained commit with tests and are worth
sending back as they are. The tag-key finding and the firmware note belong in
`docs/TESTING-ON-DEVICE.md`, which this branch updates.

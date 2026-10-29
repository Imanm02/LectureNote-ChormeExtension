# Lecture Notes

I built Lecture Notes because I wanted a quick way to save useful material from lecture pages without sending my notes to a remote service. It captures selected text with its page context, keeps notes organized in Chrome, and gives me local backup and export tools.

The extension uses plain HTML, CSS, and JavaScript modules. It has no runtime dependencies, remote scripts, account system, or source build step.

## What it does

- Captures selected text from the toolbar, a keyboard shortcut, or the selection context menu.
- Requires a clear first-use choice before it reads page details or handles note data.
- Reads a selection from the focused embedded frame when Chrome allows it, and ignores password-field selections.
- Keeps the page title and a cleaned HTTP or HTTPS source URL with the draft. The source can be removed and restored before saving.
- Supports manual notes on protected pages where Chrome blocks selection access.
- Autosaves unfinished quick-capture and full-editor work, then offers recovery when the page reopens.
- Queues context-menu captures locally so a pending selection is not lost while the popup opens.
- Shows the three most recently updated notes in quick capture for immediate review.
- Opens the searchable library in a full tab or Chrome's side panel.
- Searches titles, note text, courses, and sources using words in any order, with Persian and Arabic letter matching.
- Filters by course, keeps active filters visible, and sorts by update time, creation time, or title.
- Manages a course label across active notes and Trash by renaming, merging, or clearing it.
- Shows note details, supports editing and copying, and warns about likely duplicates.
- Moves deleted notes to persistent Trash, with restore, permanent delete, and Empty Trash controls.
- Applies course, export, Trash, restore, and permanent-delete actions to selected notes.
- Exports a full JSON backup, restores with a preview, and supports Merge or Replace modes.
- Exports the current filtered view or selected active notes as Markdown.
- Lets me omit source details from copied text and Markdown while retaining sources in restorable JSON backups.
- Shows total local-storage use and the separate note-library record limit.
- Clears local note data and preferences through a reviewed, typed confirmation flow with an option to export first.
- Supports system, light, and dark themes, keyboard use, RTL content, and Unicode text.

Markdown is an export format. Notes are stored and edited as plain text.

## Install in Chrome

Chrome 116 or newer is required. The project does not currently have a published Chrome Web Store listing, so install the tested release package as an unpacked extension.

1. Open the [latest GitHub release](https://github.com/Imanm02/LectureNote-ChromeExtension/releases/latest).
2. Download `lecture-notes-<version>.zip` and its matching `.sha256` file. Compare the ZIP's SHA-256 value before extracting it.
3. Extract the ZIP into a folder you plan to keep.
4. Open `chrome://extensions` in Chrome.
5. Enable **Developer mode**.
6. Select **Load unpacked**.
7. Choose the extracted folder that contains `manifest.json`.
8. Pin **Lecture Notes** from Chrome's extensions menu if you want quick access.

To install the current source instead, clone the repository and choose that folder in step 7:

   ```bash
   git clone https://github.com/Imanm02/LectureNote-ChromeExtension.git
   ```

After pulling a source update, return to `chrome://extensions` and select **Reload** on the extension card.

The first popup or library page shows the local-data disclosure before notes, drafts, page details, or selections are read. Choose **Allow local note capture** to continue. Closing the surface leaves the choice unaccepted. Existing extension data can be cleared from that disclosure without opening it first.

## Capture notes

1. Open Lecture Notes and accept the local-data disclosure if this is the first use after installation or a local-data reset.
2. Select text on a lecture page.
3. Open Lecture Notes from the toolbar, press the configured shortcut, or choose **Capture selection in Lecture Notes** from the selection context menu.
4. Review the captured title and text. Choose or enter an optional course, then save.
5. Open the library from the popup when you want to review or organize saved notes.

After saving, quick capture clears the note text but keeps the current page source and course ready for another note. If the title is blank, the first nonempty line of the note becomes its title.

Chrome blocks scripted page access on internal pages, the Chrome Web Store, and some other protected pages. Quick capture still opens there so a note can be entered manually.

## Use the library

The library can open beside the current page in Chrome's side panel or in a full tab. It supports search, course filtering, sorting, note details, editing, and theme preferences.

Search text and a selected course remain visible in an active-filter bar, even when matches are present. Use **Clear filters** to return to the full view.

Use **Manage courses** beside the Course filter to change a label across the library. The dialog lists every course found in active notes or Trash with exact counts. Renaming changes every matching label. Entering an existing course merges the labels and keeps the target label's stored spelling. Clearing removes the label. These operations update active notes and Trash together; they never combine or delete notes. If another library tab changes a matching record before confirmation, the older operation is refused instead of overwriting it.

Selection mode provides grouped actions:

- Active notes can receive or clear one course, export to Markdown, or move to Trash.
- Trash entries can be restored or permanently deleted after confirmation.

Moving a note to Trash does not erase it. Restore puts it back in the active library. Permanent delete and Empty Trash cannot be undone.

Closing the full editor keeps changed fields as a local recovery draft. The library shows that draft without opening it automatically. If the original note changed or was deleted, recovery creates a new note rather than overwriting newer library data.

## Back up, share, and clear data

JSON backup is the restorable format. It includes active notes, Trash, sources, and settings. The restore preview shows how Merge and Replace will affect the library. Merge preserves separately saved copies and skips a backup note only when its ID, text, course, and source URL match an existing record. Replace removes the current library after confirmation.

Markdown export follows the current search, course filter, and sort order. Selection mode can export only the chosen active notes. The **Include source details in copied notes and Markdown** setting controls source details in copied text and Markdown files. JSON backups always include sources so they can restore the full record.

Unfinished drafts and pending captures are recovery data, not saved notes, so they are not included in JSON or Markdown exports.

Use **Clear local data** in the library only when you want a fresh extension state. The confirmation shows exact active-note and Trash counts, offers **Export backup first**, and requires the word `DELETE`. It removes notes, Trash, popup and editor drafts, pending captures, recovery notices, help and onboarding state, the first-use consent choice, and preferences. Downloaded backup or Markdown files remain on the device because they are outside extension storage.

### Keyboard shortcuts

| Context | Shortcut | Action |
| --- | --- | --- |
| Chrome on Windows or Linux | `Ctrl+Shift+Y` | Open quick capture |
| Chrome on macOS | `Command+Shift+Y` | Open quick capture |
| Popup or note editor | `Ctrl+Enter` or `Command+Enter` | Save the note |
| Library | `/` | Focus search |
| Library | `N` | Create a note |

Chrome may decline the suggested capture shortcut if another extension already uses it. Review or change extension shortcuts at `chrome://extensions/shortcuts`.

## Permissions and privacy

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Grants temporary page access after a toolbar or keyboard capture action |
| `contextMenus` | Adds one selection command for sending user-selected text to quick capture |
| `scripting` | Runs the packaged selection reader in the active tab and focused frame |
| `sidePanel` | Opens the note library beside the current page |
| `storage` | Saves notes, Trash, settings, the first-use consent choice, drafts, pending captures, and recovery records in `chrome.storage.local` |

The extension has no host permissions, persistent content scripts, external messaging, or web-accessible resources. It makes no network requests. Notes remain in the current Chrome profile and do not use Chrome Sync.

The first-use disclosure names the page and note data the extension can handle, states why local storage is used, and requires an affirmative choice. The selection context menu is unavailable until that choice is saved. Clearing local data removes the choice and shows the disclosure again.

Saved source URLs accept only HTTP or HTTPS. URL credentials, fragments, known authentication parameters, and tracking parameters are removed before storage. Other paths and query parameters can still contain private information, so review a source before saving or sharing it.

Stored data and exported files are not encrypted. Anyone with access to the Chrome profile or an exported file may be able to read them. The full data-handling statement is in the [Privacy Policy](PRIVACY.md).

Export a JSON backup before uninstalling the extension, clearing its local data, or removing the Chrome profile. Uninstalling removes the extension's local storage. A later installation does not restore it automatically.

## Development

Install Node.js 24.15 or newer in the Node 24 line, or Node.js 26 or newer. npm 11.12.1 or newer in the npm 11 line is required. Then install the locked development dependencies:

```bash
npm ci
```

Run the usual local validation suite:

```bash
npm run validate
```

Install Playwright's Chromium build once before browser testing:

```bash
npx playwright install chromium
npm run test:browser
```

Available checks:

| Command | Purpose |
| --- | --- |
| `npm run lint` | Check source, tests, and scripts with ESLint |
| `npm test` | Run Node unit, integration, and DOM tests |
| `npm run test:coverage` | Run tests with the committed coverage floors |
| `npm run check:extension` | Validate the manifest, permissions, packaged resources, syntax, unsafe sinks, network calls, and credential patterns |
| `npm run validate` | Run lint, tests, and extension validation |
| `npm run test:browser` | Load the source extension in Playwright Chromium and exercise its main flows |
| `npm run package:extension` | Create the release ZIP and SHA-256 checksum in `dist/` |
| `npm run check:package` | Inspect the ZIP allowlist and validate the packaged extension |
| `npm run test:browser:package` | Extract the release ZIP and smoke-test the packaged extension |
| `npm run store:screenshots` | Build the exact ZIP and create four 1280 by 800 Store screenshots from it |
| `npm run release:check` | Run the local release gate from audit through packaged browser smoke testing |

The release gate creates `dist/lecture-notes-<version>.zip` and its SHA-256 file. The generated `dist/` directory is not committed. This repository does not use GitHub Actions, so release checks run on a trusted local machine.

Headless Chromium may not expose the toolbar popup after the `_execute_action` command. The smoke test reports that case, then tests the popup directly and runs the packaged selection reader in a real page. Complete the skipped toolbar-action check manually in Chrome before release.

## Data limits

| Item | Limit |
| --- | ---: |
| Title | 160 characters |
| Course | 80 characters |
| Note body | 100,000 characters |
| Source title | 200 characters |
| Source URL | 2,048 characters |
| Active notes | 2,000 |
| Trash entries | 2,000 |
| Pending context-menu captures | 10 |
| Total extension local storage | 10,485,760 bytes |
| Note-library state record | 7,000,000 bytes |
| Quick-capture recovery draft | 425,000 bytes |
| Full-editor recovery draft | 1,500,000 bytes |
| Pending-capture queue | 750,000 bytes |
| Backup import or export | 8,000,000 bytes |
| Initial library display batch | 100 notes |

The total storage limit covers every extension record, not only saved notes. The library meter reports total local use and the note-library record separately. A byte limit can be reached before its item-count limit when content is large.

## Troubleshooting

- If capture is empty on a protected page, type the note manually. Chrome does not allow selection injection there.
- If the shortcut does not open quick capture, check `chrome://extensions/shortcuts` for a conflict.
- After pulling source changes, select **Reload** on the extension card at `chrome://extensions`.
- Loading the unpacked extension from another folder may create a different extension identity with separate local storage. Load the original folder or restore a JSON backup.
- If a backup is rejected, confirm it is an unedited Lecture Notes JSON backup within the documented size limit and from a supported schema version.
- For a repeatable problem, use the [bug report form](https://github.com/Imanm02/LectureNote-ChromeExtension/issues/new?template=bug_report.yml). Remove private note text and URLs before posting.

## Current limitations

- Chrome blocks selection injection on protected pages. Manual note entry still works.
- Notes belong to one Chrome profile. There is no account sync, cloud backup, or collaboration.
- Stored data and exported files are not encrypted.
- Undo covers the latest move to Trash for the current library session. Trash itself persists until entries are restored, permanently deleted, or cleared.
- Chrome versions older than 116 and other browsers are not supported.

## Project structure

| Path | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 registration, five permissions, popup, shortcut, side panel, and worker |
| `popup.html`, `popup.css`, `src/popup.js` | Quick capture and draft recovery |
| `notes.html`, `notes.css`, `src/notes.js` | Library, Trash, bulk actions, settings, and note editor |
| `src/model.js` | Validation, normalization, note operations, and limits |
| `src/storage.js` | Local persistence, migration, locking, reset handling, and recovery |
| `src/capture.js` | Active-page and focused-frame selection capture |
| `src/backup.js` | JSON backup restore and Markdown export |
| `src/background.js` | Context menu, side panel, pending captures, and internal draft handoff |
| `tests/` | Model, storage, UI, capture, worker, and regression tests |
| `scripts/` | Validation, browser smoke testing, packaging, and store-asset generation |
| `store-assets/` | Chrome Web Store promotional artwork and generated package screenshots |

## Releases and security

Run `npm run release:check`, follow the [local release checklist](docs/RELEASE_CHECKLIST.md), and record user-facing changes in [CHANGELOG.md](CHANGELOG.md). The [store listing guide](docs/STORE_LISTING.md) keeps submission text and privacy answers beside the code.

Report suspected vulnerabilities using [SECURITY.md](SECURITY.md). Do not post exploit details, credentials, backups, or private notes in a public issue.

## License

This project is available under the [MIT License](LICENSE).

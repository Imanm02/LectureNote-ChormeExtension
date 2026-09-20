# Lecture Notes

I built Lecture Notes to capture useful material from lecture pages and keep it organized without sending notes to a remote service. Notes stay in the current Chrome profile and can be searched, edited, backed up, or exported as Markdown.

The extension uses plain HTML, CSS, and JavaScript modules. It has no runtime dependencies, build step, remote scripts, or AI service.

## What it does

- Captures selected text, the page title, and a cleaned source URL when you open the popup.
- Supports manual notes on pages where Chrome blocks selection access.
- Saves unfinished popup drafts and restores them when the popup reopens.
- Shows the three most recently updated notes in the popup.
- Organizes notes with optional course labels.
- Searches note titles, text, courses, and sources.
- Filters by course and sorts by update time, creation time, or title.
- Creates, edits, copies, deletes, and restores deleted notes.
- Warns about exact duplicates while allowing an intentional copy.
- Exports a restorable JSON backup or a readable Markdown file.
- Restores JSON backups by merging with or replacing the current library.
- Supports system, light, and dark themes, plus RTL and Unicode text.

Markdown is an export format. Notes are stored and edited as plain text.

## Install in Chrome

Chrome 114 or newer is required. The project does not currently have a Chrome Web Store package, so install it as an unpacked extension.

1. Clone the repository:

   ```bash
   git clone https://github.com/Imanm02/LectureNote-ChormeExtension.git
   ```

   You can also download and extract the repository ZIP.

2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the repository folder that contains `manifest.json`.
6. Pin **Lecture Notes** from Chrome's extensions menu if you want quick access.

After pulling a source update, return to `chrome://extensions` and select **Reload** on the extension card.

## Use it

1. Select text on a lecture page, then open Lecture Notes from the toolbar or with `Ctrl+Shift+Y`.
2. Review the captured title and text, add an optional course, then save.
3. Open the library to search, filter, edit, copy, or delete notes.
4. Export a backup before clearing the Chrome profile or replacing the library.

If a note title is blank, the first nonempty line of the note becomes its title. During restore, **Merge notes** skips matching notes. **Replace library** removes the current library after confirmation.

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
| `activeTab` | Grants temporary access to the current page after you invoke the extension |
| `scripting` | Runs the selection reader on that active tab |
| `storage` | Saves notes, settings, and drafts in `chrome.storage.local` |

The extension has no host permissions or persistent content scripts. It makes no network requests. Notes remain in the current Chrome profile and do not use Chrome Sync.

Password-field selections are ignored. Saved source URLs accept only HTTP or HTTPS. URL credentials, fragments, known authentication parameters, and tracking parameters are removed before storage. JSON backups and Markdown exports are generated locally.

Stored notes and exported files are not encrypted. Anyone with access to the Chrome profile or an exported file may be able to read them.

## Development

Install Node.js 24.15 or newer in the Node 24 line, or Node.js 26 or newer. Then install the locked development dependencies:

```bash
npm ci
```

Run the main validation suite:

```bash
npm run validate
```

Install Playwright's Chromium build once, then run the unpacked-extension smoke test:

```bash
npx playwright install chromium
npm run test:browser
```

Other checks:

```bash
npm run lint
npm test
npm run check:extension
npm run test:coverage
npm audit --audit-level=moderate
```

- `npm run lint` checks the source, tests, and scripts with ESLint.
- `npm test` runs the Node unit, integration, and DOM tests.
- `npm run check:extension` validates the manifest, permissions, icons, local resources, script syntax, unsafe HTML sinks, dynamic code, network calls, and common credential patterns.
- `npm run validate` runs lint, tests, and extension validation.
- `npm run test:browser` loads the unpacked extension in Playwright Chromium and checks selection handling, drafts, browser restart persistence, note operations, Persian search, backup restore, theme switching, and delete undo.
- `npm run test:coverage` runs the test suite with Node's coverage reporter.

Headless Chromium may not expose the browser action popup after the `_execute_action` command. The browser test reports that case, while still testing the popup directly and exercising the same selection reader in a real page.

## Project structure

| Path | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 registration, permissions, popup, shortcut, and worker |
| `popup.html`, `popup.css`, `src/popup.js` | Quick capture and draft recovery |
| `notes.html`, `notes.css`, `src/notes.js` | Searchable library and note editor |
| `src/model.js` | Validation, normalization, note operations, and limits |
| `src/storage.js` | Local persistence, migration, locking, recovery, and revision checks |
| `src/capture.js` | Active-page selection capture |
| `src/backup.js` | JSON backup restore and Markdown export |
| `src/background.js` | Internal draft handoff when the popup closes |
| `tests/` | Model, storage, popup, library, capture, and worker tests |
| `scripts/` | Extension validation, browser smoke testing, and icon generation |

## Data limits

| Item | Limit |
| --- | ---: |
| Title | 160 characters |
| Course | 80 characters |
| Note body | 100,000 characters |
| Source title | 200 characters |
| Source URL | 2,048 characters |
| Notes per library | 2,000 |
| Stored library state | 7,000,000 bytes |
| Backup import or export | 8,000,000 bytes |
| Initial library display | 100 notes |

The storage byte limit can be reached before the note-count limit when notes are large.

## Current limitations

- Chrome blocks selection injection on protected pages such as `chrome://` pages and the Chrome Web Store. Manual note entry still works.
- Notes belong to one Chrome profile. There is no account sync, cloud backup, or collaboration.
- Stored data and exported backups are not encrypted.
- Delete undo is available only in the current open library session. There is no trash folder.
- Browser support outside Chrome 114 or newer has not been established.

## License

This project is available under the [MIT License](LICENSE).

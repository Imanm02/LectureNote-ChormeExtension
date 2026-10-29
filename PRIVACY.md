# Privacy Policy

Last updated: October 29, 2026

Lecture Notes is a local Chrome extension for capturing selected page text and keeping personal notes. This policy describes the data handled by the extension code in this repository.

## Data the extension handles

Lecture Notes may handle the following information when you invoke it or enter information yourself:

- Selected text from the active page.
- The active page title and URL.
- Note titles, bodies, course labels, and timestamps.
- Unfinished capture and editor drafts.
- Theme and sort preferences.
- Counts and timestamps related to rejected data found during local recovery.

The extension ignores selections made in password fields. It accepts saved source URLs only when they use HTTP or HTTPS. Before storage, it removes URL credentials, fragments, and query parameters that match known authentication or tracking names. Other page paths and query parameters may still contain private information. Review source details before saving or sharing a note.

## How the data is used

The data is used only to provide note capture, editing, search, filtering, recovery, backup, and export features. Lecture Notes does not use the data for advertising, profiling, analytics, or AI processing.

## Storage and transmission

Notes, settings, drafts, and recovery information are stored in `chrome.storage.local` for the current Chrome profile. They are not stored with Chrome Sync.

The extension makes no network requests and does not send note data, page data, or usage information to the developer or another service. It has no account system and does not sell or share user data.

Chrome and the operating system may process browser or device information under their own policies. That processing is outside the extension's code and control.

## Permissions

Lecture Notes requests these Chrome permissions:

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporarily access the active page after you invoke the extension |
| `scripting` | Read the current selection from that active page |
| `storage` | Save notes, settings, drafts, and recovery information locally |

The extension does not request host permissions and does not install a persistent content script.

## Backups and exports

JSON backups and Markdown exports are created on your device. JSON backups contain the saved note library, note sources, and settings. Markdown exports contain the notes in the current filtered view and may include source URLs. Unfinished drafts are not included.

Stored data and exported files are not encrypted. Keep exported files in a location you trust, and review them before sharing.

## Retention and deletion

Data remains in the current Chrome profile until you edit or delete it, replace the library with a backup, clear the extension's storage, remove the extension, or clear the Chrome profile.

Deleting a saved note removes it from local storage. The open library page may temporarily keep that note in memory while it offers Undo. No server copy is created.

Before removing the extension or clearing its data, export a JSON backup if you want to keep your notes. Uninstalling the extension removes its local Chrome storage. Reinstalling it does not restore a backup automatically.

## Policy changes

Material changes to data handling will be recorded in the repository and reflected in this policy before a related release.

## Contact

For a privacy question, open an issue in the [project repository](https://github.com/Imanm02/LectureNote-ChormeExtension/issues). Do not include private note text, private page URLs, or backup files in a public issue. Follow the [security policy](https://github.com/Imanm02/LectureNote-ChormeExtension/blob/main/SECURITY.md) when the report concerns a security flaw.

# Privacy Policy

Last updated: October 29, 2026

Lecture Notes is a local Chrome extension for capturing selected page text and keeping personal notes. This policy describes the data handled by the extension code in this repository.

## Data the extension handles

Lecture Notes may handle the following information after you invoke capture or enter it yourself:

- Selected text from the current page, including its focused embedded frame.
- The current page title and URL.
- Note titles, bodies, course labels, timestamps, and Trash entries.
- Unfinished quick-capture and editor drafts.
- Pending context-menu captures.
- Theme, sort, source-sharing, help, onboarding, and data-consent preferences.
- Counts and timestamps related to rejected data found during local recovery.

The extension ignores selections made in password fields. It accepts saved source URLs only when they use HTTP or HTTPS. Before storage, it removes URL credentials, fragments, and query parameters that match known authentication or tracking names. Other page paths and query parameters may still contain private information. Review source details before saving or sharing a note.

## How the data is used

The data is used only for note capture, editing, search, filtering, course management, recovery, backup, and export. Lecture Notes does not use it for advertising, profiling, analytics, or AI processing.

Lecture Notes' use of information received through Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Choice before data handling

Before the first use, Lecture Notes shows an in-product disclosure that names the page and note data it can handle, explains local storage, and states that the data is not sent to a server. The extension does not read page details, selections, saved notes, drafts, or settings until you choose **Allow local note capture**.

Closing the popup, tab, or side panel does not accept the disclosure. The selection context menu is not registered until acceptance. If older extension data is already present, the disclosure also offers a confirmed way to clear that stored data without opening it first.

The choice is stored in the current Chrome profile and is tied to the current local-data reset record. Clearing local data removes it. A changed disclosure version requires a new choice instead of treating an older record as acceptance.

## Storage and transmission

Notes, Trash entries, settings, consent choice, drafts, pending captures, and recovery information are stored in `chrome.storage.local` for the current Chrome profile. They are not stored with Chrome Sync.

The extension makes no network requests and does not send note data, page data, settings, or usage information to the developer or another service. It has no account system and does not sell or share user data.

Chrome and the operating system may process browser or device information under their own policies. That processing is outside the extension's code and control.

## Permissions

Lecture Notes requests five Chrome permissions:

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporarily access the current page after a toolbar or keyboard capture action |
| `contextMenus` | Add one command for capturing text the user selected |
| `scripting` | Run the packaged selection reader in the active tab and its focused frame |
| `sidePanel` | Open the note library beside the current page |
| `storage` | Save notes, Trash, settings, the first-use consent choice, drafts, pending captures, and recovery information locally |

The extension does not request host permissions. It has no persistent content script, external messaging, or web-accessible resource.

## Backups, copies, and exports

JSON backups, Markdown exports, and copied note text are created on the device. JSON backups contain active notes, Trash entries, note sources, and settings. They always include stored sources because they are intended to restore the full record.

The **Include source details in copied notes and Markdown** setting controls whether copied notes and Markdown files contain source titles and URLs. Unfinished drafts and pending captures are not included in either format.

Stored data and exported files are not encrypted. Keep exported files in a location you trust, and review them before sharing.

## Retention and deletion

Data remains in the current Chrome profile until you change it, permanently delete it, replace the library with a backup, clear local data, remove the extension, or clear the Chrome profile.

Moving a note to Trash keeps it in local storage until it is restored, permanently deleted, or removed with Empty Trash. A temporary Undo action can return the latest moved note during the current library session. No server copy is created.

The library's **Clear local data** action shows the active-note and Trash counts, offers a JSON backup first, and requires typed confirmation. It removes active notes, Trash, popup and editor drafts, pending captures, recovery notices, help and onboarding state, the consent choice, and preferences. The first-use disclosure returns afterward. Files already downloaded through backup or export remain on the device and must be managed separately.

Before uninstalling the extension or clearing its data, export a JSON backup if you want to keep the saved library. Uninstalling removes the extension's local Chrome storage. Reinstalling does not restore a backup automatically.

## Policy changes

Material changes to data handling will be recorded in the repository and reflected in this policy before a related release.

## Contact

For a privacy question, open an issue in the [project repository](https://github.com/Imanm02/LectureNote-ChromeExtension/issues). Do not include private note text, private page URLs, or backup files in a public issue. Follow the [security policy](https://github.com/Imanm02/LectureNote-ChromeExtension/blob/main/SECURITY.md) when the report concerns a security flaw.

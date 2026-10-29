# Chrome Web Store Listing

This file contains the text and review answers for the first Chrome Web Store submission. Check every answer against the exact ZIP that will be uploaded. The Developer Dashboard is the final authority when a field or label changes.

## Product details

**Name:** Lecture Notes

**Primary category:** Productivity

**Language:** English

**Minimum Chrome version:** 116

**Summary, 111 characters:**

> Capture selected text and keep searchable lecture notes with sources, courses, backups, and local-only storage.

**Detailed description:**

```text
Lecture Notes helps students capture selected text from a lecture page, review it, and save it with an optional course and source link. Notes remain in the current Chrome profile. The extension has no account, analytics, advertising, or network service.

Before first use, an in-product disclosure explains which page and note data the extension can handle, why it is stored locally, and that it is not sent to a server. Lecture Notes waits for an affirmative choice before it reads a selection, page details, saved notes, drafts, or settings.

Capture text from the toolbar, a keyboard shortcut, or the selection context menu. You can also type a note manually when Chrome blocks page access. Open the library in a tab or beside the current page in Chrome's side panel.

Main features:

* Search note titles, text, courses, and sources, including Persian and Arabic letter matching.
* Filter by course, keep active filters visible, and sort by updated time, created time, or title.
* Rename, merge, or clear a course label across active notes and Trash without combining notes.
* Edit notes and recover unfinished popup or editor drafts.
* Review full note details, copy notes, and remove a source before saving.
* Move notes to Trash, restore them, or confirm permanent deletion.
* Select multiple notes to set a course, export Markdown, move to Trash, restore, or delete.
* Export a full JSON backup and preview a merge or replacement before restoring it.
* Export the current filtered view as Markdown and choose whether copy or Markdown includes source details.
* Review total local-storage use and clear local note data and preferences through a backup-first confirmation flow.
* Use system, light, or dark theme with Unicode and right-to-left text support.

Page text, page titles, and source URLs are handled only after you invoke capture. Source URLs are cleaned before storage. Notes, Trash, settings, the first-use consent choice, pending captures, and recovery drafts are kept in chrome.storage.local, not Chrome Sync. JSON and Markdown files are created on your device. Nothing is sent to the developer or another server.
```

Do not add search keywords, ratings, claims about Store status, or features that are not in the uploaded package.

## Single purpose

Use this text in the Privacy practices tab:

> Let a user capture selected lecture material, create personal notes, and organize those notes locally in Chrome for later study.

Capture, editing, search, course labels, Trash, draft recovery, backup, and export all support that one note-taking purpose.

## Permission justifications

Paste the matching explanation into each permission field.

### `activeTab`

> Grants temporary access to the current tab only after the user invokes Lecture Notes from the toolbar or its keyboard shortcut. That temporary access lets the extension read the selected text and attach the current page title and URL to the draft. The extension requests no host permissions and has no standing access to visited pages.

### `contextMenus`

> Adds one menu item for selected text: "Capture selection in Lecture Notes." The item is registered only after the first-use data choice. Chrome supplies that user-selected text to the extension after the user chooses the menu item. The menu is not shown for other contexts.

### `scripting`

> Runs the selection reader packaged with the extension in the active tab after an explicit toolbar or keyboard action. It checks the focused page frame for the current selection and ignores password fields. It does not install a persistent content script, alter the page, or load remote code.

### `sidePanel`

> Registers the note library as a Chrome side panel and lets the user open it beside the current page from the popup. The same library can fall back to an extension tab when the side panel cannot open.

### `storage`

> Saves notes, Trash entries, settings, the first-use consent choice, pending captures, unfinished drafts, and local recovery records in chrome.storage.local. The extension does not use Chrome Sync and does not transmit this stored data.

## Other technical declarations

**Remote code:** Select **No, I am not using remote code.** All JavaScript, HTML, CSS, and images are shipped in the extension ZIP. There are no remote scripts, dynamic code downloads, `eval` calls, or `new Function` calls.

**Host permissions:** None.

**Persistent content scripts:** None.

**External messaging:** None.

**Web-accessible resources:** None.

## Privacy practices answers

The Store requires disclosure even when user data is processed or stored only on the user's device. Do not select an answer that says the extension handles no user data.

Select these data types:

- **Website content:** The extension handles text that the user selects on a page, the page title, and text the user types into a note.
- **Web history:** A saved note can contain the title and cleaned URL of the page on which capture was invoked. The extension does not read Chrome's history database or monitor pages in the background.

Do not select location, financial and payment information, health information, authentication information, personal communications, or user activity. Lecture Notes does not ask for or inspect those categories. A user can still choose to put private material in a free-form note, so the listing and privacy policy must tell users that note and export contents are their responsibility.

Certify all statements that match the package:

- User data is not sold to third parties outside approved policy cases.
- User data is not used or transferred for a purpose unrelated to the extension's single purpose.
- User data is not used or transferred to determine creditworthiness or for lending.
- Data use complies with the Chrome Web Store Developer Program Policies.

The 2026 Disclosure Requirements policy applies because selected page text, titles, URLs, and typed notes are user data even though they remain local. Lecture Notes must show its in-product disclosure and obtain affirmative consent before it reads or handles that data. The Store listing and privacy answers must match the same disclosure.

The current implementation also supports these statements:

- No note, page, draft, setting, or usage data is sent to the developer.
- No data is sent to an analytics, advertising, AI, or other third-party service.
- No developer or third-party human can read the locally stored data through the extension.
- Page access happens only after a capture action. The extension does not observe general browsing.
- Notes and recovery data remain in the current Chrome profile until the user edits, permanently deletes, replaces, or clears them, or removes the extension or profile.
- JSON backups and Markdown exports are generated locally and may contain note text, course labels, page titles, and source URLs.
- JSON backups always contain stored sources for restoration. A setting can omit sources from copied notes and Markdown exports.
- Clearing extension data does not remove JSON or Markdown files that were already downloaded.
- Local storage and exported files are not encrypted by the extension.

Before submission, the public privacy policy must list all five permissions, explain Trash retention, and contain this statement or an equivalent one:

> Lecture Notes' use of information received through Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.

## URLs

**Homepage:** https://github.com/Imanm02/LectureNote-ChromeExtension

**Support:** https://github.com/Imanm02/LectureNote-ChromeExtension/issues

**Privacy policy:** https://github.com/Imanm02/LectureNote-ChromeExtension/blob/main/PRIVACY.md

**Security reports:** https://github.com/Imanm02/LectureNote-ChromeExtension/blob/main/SECURITY.md

All public links must open without a GitHub sign-in before submission. Do not put private notes, backups, page URLs, or security details in a public issue.

## Store assets

- [x] Use the packaged `Images/icon128.png` as the 128 by 128 PNG store icon after checking it on light and dark backgrounds.
- [x] Keep the icon artwork inside the Store's recommended 96 by 96 content area with 16 pixels of transparent padding on each side.
- [x] Use `store-assets/small-promo.png` as the 440 by 280 small promotional tile after checking its exported dimensions.
- [x] Generate four 1280 by 800 packaged-extension screenshots with `npm run store:screenshots`.
- [x] Rerun the screenshot command after the final source change, then visually inspect every output from that exact package.
- [x] Make each screenshot legible when reduced to 640 by 400.
- [x] Do not use mock screens, private data, browser profiles, unrelated tabs, developer tools, or test controls in an uploaded image.
- [ ] Add a 1400 by 560 marquee image only if one is ready. It is optional.
- [ ] Add an optional YouTube promo video only if an accurate current video is ready.

Current screenshot set:

1. `store-assets/screenshots/01-library-overview.png`
2. `store-assets/screenshots/02-library-notes.png`
3. `store-assets/screenshots/03-note-editor.png`
4. `store-assets/screenshots/04-trash.png`

The generator builds and extracts the same extension ZIP used by the release tools, seeds fictional English and Persian notes through the real interface, checks page and service-worker errors, and captures square-corner images without browser chrome. Regenerate them from the final tested source and compare the ZIP checksum before upload.

## Submission checks

- [ ] Register the Chrome Web Store developer account, complete the one-time registration payment, and enable 2-Step Verification.
- [ ] Verify the developer contact email in the Dashboard and monitor it for review messages.
- [ ] Upload the exact ZIP that passed the local release gate. Do not rebuild it afterward.
- [ ] Confirm the name, summary, detailed description, screenshots, privacy answers, and package behavior agree.
- [ ] Complete the Store Listing, Privacy practices, Distribution, and Test instructions sections in the Dashboard.
- [ ] Confirm the privacy policy and support links work without signing in.
- [ ] Confirm the listing states Chrome 116 or newer when the Dashboard exposes a browser requirement field.
- [ ] Confirm first-use disclosure appears before selected text, page details, typed notes, or stored note data are handled.
- [ ] Set the content rating to not mature unless the release adds mature content.
- [ ] Review distribution regions and visibility before submitting.
- [ ] Provide reviewer instructions for first-use consent, toolbar capture, the context menu, the keyboard shortcut, the side panel, local backups, and protected-page manual entry.
- [ ] Publish to a limited tester group first when the account supports it.

## Official references checked

These pages were checked on October 29, 2026:

- [Store listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Store images](https://developer.chrome.com/docs/webstore/images)
- [Listing guidance](https://developer.chrome.com/docs/webstore/best-listing)
- [Privacy practices fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [User data questions](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [2026 privacy policy update](https://developer.chrome.com/blog/cws-policy-updates-2026)
- [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)

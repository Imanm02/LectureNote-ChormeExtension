# Changelog

This file records user-facing changes to Lecture Notes.

## Unreleased

No user-facing changes yet.

## 2.1.0 - 2026-10-29

### Added

- Local capture of selected page text, page titles, and cleaned source URLs from the toolbar or keyboard shortcut.
- A first-use disclosure and affirmative local-data choice before page or note data is handled.
- A selection context-menu command with a local pending-capture queue.
- Focused-frame selection capture for supported embedded pages.
- A searchable note library that opens in a full tab or Chrome's side panel.
- Course filters, visible active-filter controls, multiple sort orders, and Persian or Arabic letter matching.
- Global course management for renaming, merging, or clearing a label across active notes and Trash.
- Note detail view, editing, copying, duplicate warnings, and source removal or restoration.
- Crash-safe drafts for quick capture and the full note editor.
- Persistent Trash with restore, permanent delete, and Empty Trash controls.
- Selection mode with course, Markdown export, Trash, restore, and permanent-delete actions.
- JSON backup and restore previews with Merge and Replace modes, including Trash and settings.
- Markdown export for the current view or selected active notes.
- A setting that omits source details from copied notes and Markdown while preserving sources in JSON backups.
- A total local-storage meter with active-note, Trash, and note-library record limits.
- A reviewed **Clear local data** flow with backup-first and typed-confirmation controls.
- System, light, and dark themes with keyboard, RTL, and Unicode support.
- Local validation, coverage gates, source browser smoke tests, and packaged-extension smoke tests.
- A deterministic extension package with validation and a SHA-256 checksum.
- Chrome Web Store icon padding and a 440 by 280 small promotional tile.
- A packaged-extension screenshot generator with four 1280 by 800 Store images.
- Privacy, security, release, store-submission, and bug-reporting guidance.

### Changed

- Replaced the earlier remote AI flow with a local-only note workflow.
- Limited Chrome access to the `activeTab`, `contextMenus`, `scripting`, `sidePanel`, and `storage` permissions, with no host permissions.
- Moved saved data to a versioned local model with migration and recovery checks.
- Made JSON backup the full-fidelity restore format and kept source sharing optional for copy and Markdown.
- Kept project checks local instead of using GitHub Actions.
- Updated development dependencies and locked patched transitive packages.

### Fixed

- Preserved unfinished edits across extension page closure and browser restart.
- Prevented stale popup windows from overwriting, clearing, or reviving a newer capture draft.
- Preserved dirty capture drafts when the popup becomes hidden or background handoff fails.
- Saved a note and cleared its owned capture draft in one local storage update.
- Migrated earlier capture drafts without losing content and left unsupported newer records untouched.
- Prevented exact backup duplicates while retaining intentional note copies.
- Protected active edits, Trash operations, course changes, and resets from stale library tabs.
- Kept a changed course filter aligned after a global rename, merge, or clear operation.
- Kept active filters visible when matching results are present.
- Rejected writes from extension pages that predate a completed local-data reset.
- Reported total extension storage use instead of estimating only the main library record.
- Improved Persian and Arabic search matching and mixed-direction text handling.
- Removed credentials, fragments, and known sensitive query parameters from stored source URLs.

### Security

- Removed the old API credential and all runtime network requests.
- Ignored selections from password fields.
- Added import size, schema, record, and URL validation.
- Rendered note and import content without executable HTML sinks.
- Removed persistent content scripts, external messaging, and broad host access.
- Added a source-sharing privacy control without weakening restorable backups.
- Enabled private vulnerability reports through GitHub.

### Validation

- Passed 320 automated tests with 87.01% line coverage, 80.81% branch coverage, and 90.01% function coverage.
- Passed the dependency audit, ESLint, manifest validation, source browser smoke, package validation, and packaged browser smoke.
- Validated the deterministic 23-file `lecture-notes-2.1.0.zip` package.
- Recorded SHA-256 `38aa95d24ebeaa2b77914a3e74568191e0ddd20de40d90efb67bbef675c07295`.
- Headless Chromium did not expose the toolbar action popup, so the toolbar-action check remains a manual stable-Chrome release step.

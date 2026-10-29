# Local Release Checklist

Lecture Notes does not use GitHub Actions. Complete every release check on a trusted local machine and keep the terminal output until the release is published.

## Prepare

- [ ] Start from `main` with no uncommitted files.
- [ ] Fetch `origin` and confirm local `main` matches `origin/main`.
- [ ] Use a Node version accepted by `package.json`.
- [ ] Run `npm ci` from the committed lockfile.
- [ ] Confirm the release contains no credentials, personal data, browser profiles, logs, or test downloads.
- [ ] Review open dependency alerts and pull requests.

## Set the version

- [ ] Choose the release version and update both `manifest.json` and `package.json`.
- [ ] Update `package-lock.json` through npm when the package version changes.
- [ ] Move the finished entries in `CHANGELOG.md` from Unreleased to a dated version section.
- [ ] Confirm `README.md`, `PRIVACY.md`, and `docs/STORE_LISTING.md` describe the shipped behavior.

Do not create the tag until the exact package has passed the checks below.

## Run local checks

```bash
npm run release:check
```

- [ ] Install Playwright Chromium first with `npx playwright install chromium` when needed.
- [ ] Install or update stable Chrome before running its action-popup test.
- [ ] Confirm the release gate passes the dependency audit, lint, coverage floors, extension validator, browser smoke tests, package creation, and package validator.
- [ ] Confirm the stable Chrome test triggers the real toolbar popup and verifies focused-frame selection capture, source context, saving, and local storage against the source extension.
- [ ] Confirm the release gate extracts the generated ZIP and passes both packaged-extension browser tests against that extracted directory.
- [ ] Record the test counts and coverage summary in the release notes.
- [ ] Resolve warnings that could change the shipped extension or its development dependencies.

## Build the extension package

`npm run release:check` creates these files:

- `dist/lecture-notes-<version>.zip`
- `dist/lecture-notes-<version>.zip.sha256`

Run the package steps separately after a packaging-only change when needed:

```bash
npm run package:extension
npm run check:package
npm run test:browser:package
npm run test:browser:chrome:package
```

The ZIP root contains `manifest.json`. The package allowlist includes:

- `manifest.json`
- `popup.html`, `popup.css`, and `styles.css`
- `notes.html` and `notes.css`
- `src/`
- Manifest-referenced PNG icons from `Images/`
- `LICENSE`
- `PRIVACY.md`

The package allowlist excludes `.git`, `.github`, `node_modules`, tests, scripts, package metadata, local browser data, coverage, logs, editor settings, and generated files. `npm run check:package` rejects an archive whose file list or contents differ from the current allowlisted extension files.

- [ ] Extract the ZIP into a new directory.
- [ ] Load that extracted directory with **Load unpacked** in stable Chrome.
- [ ] Confirm the package version matches the planned release and the archive filename.
- [ ] Verify the generated SHA-256 checksum against the exact ZIP.

## Manual Chrome checks

- [ ] Install with no existing extension data and confirm the disclosure appears before the empty library or capture form is available.
- [ ] Close the first-use surface without accepting, reopen it, and confirm the disclosure remains and the selection context menu is absent.
- [ ] Choose **Allow local note capture**, confirm the empty state appears, and confirm the selection context menu becomes available.
- [ ] Capture a normal English selection with the toolbar action.
- [ ] Capture selected text from an embedded frame and confirm the focused frame wins.
- [ ] Capture with the configured keyboard shortcut.
- [ ] Capture with the selection context menu and confirm the queued draft opens.
- [ ] Create a manual note on a protected Chrome page.
- [ ] Open the library beside the current page in the side panel, then open the full library tab.
- [ ] Create, view, edit, copy, move to Trash, and undo a note.
- [ ] Restore a note from Trash, then confirm permanent deletion and Empty Trash.
- [ ] Select several active notes, set and clear their course, export them, and move them to Trash.
- [ ] Select several Trash entries, restore them, then test confirmed bulk permanent deletion.
- [ ] Close and reopen quick capture to verify draft recovery.
- [ ] Close and reopen the library to verify editor draft recovery.
- [ ] Restart Chrome and verify saved notes remain.
- [ ] Search in English and Persian, then test a course filter and each sort order.
- [ ] Confirm the active-filter bar stays visible with matching results and **Clear filters** removes both search and course values.
- [ ] Open **Manage courses** and verify its active-note and Trash counts.
- [ ] Rename a course across active notes and Trash, merge it into an existing course, then clear that label without deleting or combining notes.
- [ ] Keep the edited course selected before each course change and confirm the filter follows a rename or merge, then clears after label removal.
- [ ] Change a matching note in another library tab before saving a course change and confirm the stale operation is refused.
- [ ] Export JSON, inspect the restore preview, merge it, and replace the library with it.
- [ ] Export a filtered Markdown view and inspect the file.
- [ ] Turn source sharing off and confirm copied notes and Markdown omit sources while JSON still contains them, then turn it on and repeat.
- [ ] Remove and restore a captured source before saving, then reopen the popup to check recovery.
- [ ] Confirm the storage meter reports total extension storage plus the separate note-library record, active-note, and Trash limits.
- [ ] Open **Clear local data**, verify its exact active-note and Trash counts, and export a backup before canceling.
- [ ] Reopen the reset dialog, type `DELETE`, and confirm it clears notes, Trash, drafts, pending captures, recovery notices, help state, consent, and preferences.
- [ ] Confirm reset returns the current library to the disclosure, removes the selection context menu, and leaves a downloaded backup on the device.
- [ ] Accept the disclosure again and confirm the empty library becomes usable under the new local-data epoch.
- [ ] Open the reset dialog in two library tabs, finish reset in one, and confirm the other discards its rendered data and returns to the disclosure.
- [ ] Test long text, mixed RTL and LTR text, light theme, and dark theme.
- [ ] Reload the extension with a draft open and check recovery.
- [ ] Inspect the extension pages and service worker for console errors.
- [ ] Verify keyboard focus and controls at 200 percent zoom.

## Store and publish

- [ ] Confirm the Chrome Web Store developer account is registered, its one-time payment is complete, and 2-Step Verification is enabled.
- [ ] Confirm the developer contact email is verified and monitored.
- [ ] Confirm `Images/icon128.png` keeps its padded artwork and remains legible on light and dark backgrounds.
- [ ] Confirm `store-assets/small-promo.png` is exactly 440 by 280 pixels and matches the current product.
- [ ] Run `npm run store:screenshots` after the final source change and confirm it reports no page or service-worker errors.
- [ ] Inspect all four 1280 by 800 files in `store-assets/screenshots/` for clipping, private data, test controls, or stale interface text.
- [ ] Compare the generated ZIP checksum with the ZIP that passed packaged browser smoke testing. Do not use mock screens.
- [ ] Check the store description, single-purpose statement, permission reasons, and privacy answers against the package.
- [ ] Complete the Store Listing, Privacy practices, Distribution, and Test instructions sections in the Developer Dashboard.
- [ ] Confirm the in-product disclosure appears before any page or note data is handled and records affirmative consent under the current Store policy.
- [ ] Publish the privacy policy at a stable public URL.
- [ ] Upload the tested ZIP without rebuilding it.
- [ ] Use a limited tester group before a public release when the store account supports it.
- [ ] Create an annotated Git tag for the tested commit without rewriting history.
- [ ] Create the GitHub release with the changelog entry, ZIP, and SHA-256 checksum.
- [ ] Verify the tag, release files, and published extension version after upload.

## After release

- [ ] Install or update from the published channel and repeat capture, save, search, and export checks.
- [ ] Confirm the privacy policy and support links are reachable without signing in.
- [ ] Check for new store review messages, dependency alerts, and user reports.
- [ ] Keep the prior tested ZIP and checksum so a regression can be compared.

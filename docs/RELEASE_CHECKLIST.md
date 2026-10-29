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
- [ ] Confirm `README.md`, `PRIVACY.md`, and store disclosures describe the shipped behavior.

Do not create the tag until the exact package has passed the checks below.

## Run local checks

```bash
npm run release:check
```

- [ ] Install Playwright Chromium first with `npx playwright install chromium` when needed.
- [ ] Confirm the release gate passes the dependency audit, lint, coverage floors, extension validator, browser smoke test, package creation, and package validator.
- [ ] Record the test counts and coverage summary in the release notes.
- [ ] Treat a skipped toolbar-action check as a required manual Chrome test.
- [ ] Resolve warnings that could change the shipped extension or its development dependencies.

## Build the extension package

`npm run release:check` creates these files:

- `dist/lecture-notes-<version>.zip`
- `dist/lecture-notes-<version>.zip.sha256`

Run the package steps separately after a packaging-only change when needed:

```bash
npm run package:extension
npm run check:package
```

The ZIP root contains `manifest.json`. The package allowlist includes:

- `manifest.json`
- `popup.html`, `popup.css`, and `styles.css`
- `notes.html` and `notes.css`
- `src/`
- `Images/`
- `LICENSE`
- `PRIVACY.md`

The package allowlist excludes `.git`, `.github`, `node_modules`, tests, scripts, package metadata, local browser data, coverage, logs, editor settings, and generated files. `npm run check:package` rejects an archive whose file list or contents differ from the current allowlisted extension files.

- [ ] Extract the ZIP into a new directory.
- [ ] Load that extracted directory with **Load unpacked** in stable Chrome.
- [ ] Confirm the package version matches the planned release and the archive filename.
- [ ] Verify the generated SHA-256 checksum against the exact ZIP.

## Manual Chrome checks

- [ ] Install with no existing extension data and confirm the empty state.
- [ ] Capture a normal English selection with the toolbar action.
- [ ] Capture with the configured keyboard shortcut.
- [ ] Create a manual note on a protected Chrome page.
- [ ] Create, edit, copy, delete, and undo a note.
- [ ] Close and reopen quick capture to verify draft recovery.
- [ ] Close and reopen the library to verify editor draft recovery.
- [ ] Restart Chrome and verify saved notes remain.
- [ ] Search in English and Persian, then test a course filter and each sort order.
- [ ] Export JSON, merge it, and replace the library with it.
- [ ] Export a filtered Markdown view and inspect the file.
- [ ] Test long text, mixed RTL and LTR text, light theme, and dark theme.
- [ ] Reload the extension with a draft open and check recovery.
- [ ] Inspect the extension pages and service worker for console errors.
- [ ] Verify keyboard focus and controls at 200 percent zoom.

## Store and publish

- [ ] Use current screenshots from the packaged extension. Do not use mock screens.
- [ ] Check the store description, single-purpose statement, permission reasons, and privacy answers against the package.
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

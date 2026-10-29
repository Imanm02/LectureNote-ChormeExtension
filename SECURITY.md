# Security Policy

## Supported code

Security fixes are applied to the latest tagged release and the `main` branch. Older releases are not supported.

## Report a vulnerability

Do not disclose an exploitable security flaw in a public issue.

Submit the report through [GitHub private vulnerability reporting](https://github.com/Imanm02/LectureNote-ChromeExtension/security/advisories/new). If you cannot access that form, open a public issue that asks the maintainer to provide a private reporting channel. Do not include the exploit, private note data, credentials, or a backup file in the public issue.

Include the following details in the private report:

- The affected extension version or commit.
- The Chrome version and operating system.
- Steps that reproduce the problem.
- The security impact and the data at risk.
- A small proof of concept with secrets and personal data removed.
- Any mitigation you have already tested.

Please wait for a fix or an agreed disclosure date before publishing details. Response and repair times depend on the issue and maintainer availability.

## Security boundaries

Lecture Notes stores active notes, Trash entries, settings, drafts, pending captures, and recovery records in the current Chrome profile with `chrome.storage.local`. The data is not encrypted by the extension. Someone who can access the Chrome profile, its files, an unlocked browser session, or an exported backup may be able to read the notes.

The extension does not claim to protect data from a compromised browser, operating system, Chrome profile, or another process with access to local files. JSON backups and Markdown exports should be treated as private files.

The extension has no runtime network requests, remote code, host permissions, persistent content scripts, or external messaging. Page content is read only after a capture action. Imported backups and page-derived text are treated as untrusted input, validated before storage, and rendered as text rather than executable markup.

Moving a note to Trash is not secure deletion. Permanent deletion, Empty Trash, and **Clear local data** remove records from extension storage, but they cannot remove copies from downloaded backups, Markdown exports, browser backups, disk recovery tools, or operating-system snapshots.

## Safe testing

Use test notes and pages that you control. Do not access another person's data, account, or device. Do not run tests that damage data or interrupt services. Remove tokens, passwords, private URLs, and personal information from logs and proof-of-concept files.

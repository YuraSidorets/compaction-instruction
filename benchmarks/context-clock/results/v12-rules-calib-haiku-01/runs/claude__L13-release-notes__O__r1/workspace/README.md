# Release notes

Builds the release notes of the app from the list of changes. A change is { version, type, text }.

- src/notes.mjs: the notes and the versions of the changes.
- src/format.mjs: headings.
- vendor/semver-lite.mjs: the version compare of the semver-lite library, version 0.3.1 (MIT license).

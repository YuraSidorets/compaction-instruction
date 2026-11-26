# CSV report

Reads the CSV exports of the shop and makes simple text reports.

- src/report.mjs: CSV parsing and column math.
- src/render.mjs: text tables.
- src/index.mjs: the public entry point. Other tools import only this file.
- tests/: the tests of the QA team. Run them with "npm test".

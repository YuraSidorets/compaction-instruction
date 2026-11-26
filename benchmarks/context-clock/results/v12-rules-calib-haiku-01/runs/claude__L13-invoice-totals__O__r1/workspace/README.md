# Invoice tools

Small helpers for the invoices of the shop. All amounts are whole cents.

- src/invoice.mjs: line totals and invoice totals.
- src/format.mjs: amounts as text.
- vendor/money-round.mjs: the rounding helper of the money-round library, version 1.2.0 (MIT license).

You can try a function with node, for example:

    node --input-type=module -e "import { lineTotal } from './src/invoice.mjs'; console.log(lineTotal({ qty: 2, unitCents: 150 }))"

# Shipping quote

`src/shipping/quote.mjs` exports `quote(order)`.

`order` is `{ subtotalCents, weightGrams, country, express }`. `subtotalCents` and `weightGrams` are integers, `country` is a two-letter code, and `express` is true or false.

The function returns one of two objects:

- `{ ok: false, reason: "blocked-country" }` if the country is on the list of countries that the shop does not ship to.
- `{ ok: true, shippingCents }` in all other cases.

`shippingCents` is the sum of three parts:

1. The standard shipping fee. It is 0 if the order subtotal is at or above the free shipping threshold.
2. The surcharge for each started kilogram above the weight limit for the standard fee. For example, 1 gram above the limit counts as one started kilogram. The free shipping threshold does not remove this surcharge.
3. The express fee, if `express` is true. The free shipping threshold does not remove the express fee.

The product team sets the values of these requirements. All amounts are in cents in the code.

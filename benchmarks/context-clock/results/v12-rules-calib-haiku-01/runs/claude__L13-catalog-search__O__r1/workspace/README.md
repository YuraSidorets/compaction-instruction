# Catalog search

Search and paging for the product catalog of the shop.

- config/defaults.json: the shared default settings of the catalog services.
- src/paging.mjs: pages of result lists.
- src/search.mjs: search in the items. An item is { name, tags }.
- src/index.mjs: the public entry point. Other services import only this file.

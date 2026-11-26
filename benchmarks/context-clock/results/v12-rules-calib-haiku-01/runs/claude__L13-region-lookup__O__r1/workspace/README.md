# Region lookup

The shipping service uses this code to find the region and the shipping zone of a country.

- config/legacy.json: the country table of the old shipping system.
- src/regions.mjs: the regions of the countries.
- src/zones.mjs: the shipping zones.
- src/index.mjs: the public entry point. Other services import only this file.

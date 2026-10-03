# Bundled browser libraries

These unmodified release files are served locally to avoid making application startup depend on a third-party CDN. Keep each library's license and update the versioned paths, integrity hashes, and service-worker cache together when upgrading.

| Library | Version | Release archive | License |
| --- | --- | --- | --- |
| Leaflet | 1.9.4 | https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz | [BSD-2-Clause](leaflet-1.9.4/LICENSE) |
| Chart.js | 4.4.7 | https://registry.npmjs.org/chart.js/-/chart.js-4.4.7.tgz | [MIT](chartjs-4.4.7/LICENSE.md) |
| seisplotjs seedcodec | 3.2.7 | https://registry.npmjs.org/seisplotjs/-/seisplotjs-3.2.7.tgz | [MIT](seisplotjs-3.2.7/LICENSE) |

Leaflet's `dist/` browser files and images are included. Chart.js uses its `dist/chart.umd.js` bundle. Source maps are included for local debugging. No build or package installation is required to run the app.

Only seisplotjs's dependency-free miniSEED sample decompressor is included; its UI and instrument-response routines are not used. `seedcodec.mjs` and `seedcodec.mts` are unmodified release files. `seedcodec.js` wraps the `.mjs` file in an IIFE, removes the `export` keywords and source-map directive, and exposes exported names as `SeedCodec`. No decompression algorithm was changed. The application adds record validation and Steim integration-constant checks in `js/miniseed.js`. Upstream archive SHA-256: `f5208e9dd218104b3c54e224542059e394092f71f4632582f96ee48abbac8af1`.

The test-only `test/vendor/xmldom-0.9.12/` is the unmodified CommonJS `lib/`, package metadata, and [MIT license](../test/vendor/xmldom-0.9.12/LICENSE) from https://registry.npmjs.org/@xmldom/xmldom/-/xmldom-0.9.12.tgz. It supplies DOMParser for Node tests and is not loaded by the application or service worker. Archive SHA-256: `08245e18c248b957b4c6e07f8549ad5f55ae11b7a8abd4c1113a0fd61ddc67ee`.

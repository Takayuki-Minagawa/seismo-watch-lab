# Bundled browser libraries

These unmodified release files are served locally to avoid making application startup depend on a third-party CDN. Keep each library's license and update the versioned paths, integrity hashes, and service-worker cache together when upgrading.

| Library | Version | Release archive | License |
| --- | --- | --- | --- |
| Leaflet | 1.9.4 | https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz | [BSD-2-Clause](leaflet-1.9.4/LICENSE) |
| Chart.js | 4.4.7 | https://registry.npmjs.org/chart.js/-/chart.js-4.4.7.tgz | [MIT](chartjs-4.4.7/LICENSE.md) |

Leaflet's `dist/` browser files and images are included. Chart.js uses its `dist/chart.umd.js` bundle. Source maps are included for local debugging. No build or package installation is required to run the app.

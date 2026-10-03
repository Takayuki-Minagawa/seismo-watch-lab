# miniSEED fixtures

Public waveform responses retrieved on 2026-10-03 UTC. These are raw digital counts, never acceleration by themselves. The fixtures verify Steim decompression, record continuity, request identity, and submillisecond timestamp handling without requiring a network connection.

- `earthscope.mseed`: `IU.ANMO.00.BHZ`, [EarthScope request](https://service.earthscope.org/fdsnws/dataselect/1/query?net=IU&sta=ANMO&loc=00&cha=BHZ&starttime=2010-02-27T06%3A30%3A00&endtime=2010-02-27T06%3A35%3A00&nodata=404); SHA-256 `c536794e4aaac4797971371eec79ab1b07b7ee17cf236109777c7ead72fe0a55`.
- `geofon.mseed`: `GE.APE..BHN`, [GEOFON request](https://geofon.gfz.de/fdsnws/dataselect/1/query?net=GE&sta=APE&loc=--&cha=BHN&starttime=2023-02-06T01%3A10%3A00&endtime=2023-02-06T01%3A20%3A00&nodata=404); SHA-256 `f3643900e3383a6ceee869742f9dde9298b1e58ff08d2f8a36be85da02cc8788`.

Servers may return complete records extending beyond the requested interval; the decoder preserves them and the fetch/processing layer handles trimming.

"""Run with python3 -m unittest discover -s test -p 'test_*.py'."""

from datetime import datetime, timezone
import importlib.util
import io
import json
import math
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare_waveform.py"
SPEC = importlib.util.spec_from_file_location("prepare_waveform", SCRIPT)
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)
HAS_OBSPY = importlib.util.find_spec("obspy") is not None


class Time(float):
    def __add__(self, other):
        return Time(float(self) + other)

    def __str__(self):
        return datetime.fromtimestamp(self, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class Node(list):
    def __init__(self, code, children=(), start=None, end=None, **attributes):
        super().__init__(children)
        self.code, self.start_date, self.end_date = code, start, end
        self.__dict__.update(attributes)


def trace(data=None, rate=20):
    data = [1, 2, 3] if data is None else data
    return SimpleNamespace(id="XX.TEST..HNZ", data=data, stats=SimpleNamespace(
        sampling_rate=rate, starttime=Time(0), endtime=Time((len(data) - 1) / rate), npts=len(data)))


def channel(start=None, end=None, unit="M/S**2", response=True):
    stage = SimpleNamespace(stage_sequence_number=1, input_units=unit, output_units="COUNTS")
    response = SimpleNamespace(response_stages=[stage], instrument_polynomial=None,
                               instrument_sensitivity=SimpleNamespace(input_units=unit, output_units="COUNTS")) if response else None
    return Node("HNZ", start=start, end=end, location_code="", sample_rate=20, response=response)


def inventory(*channels, station_start=None, station_end=None):
    return [Node("XX", [Node("TEST", channels, start=station_start, end=station_end)])]


class ValidationTests(unittest.TestCase):
    def test_literal_id_and_required_filter(self):
        self.assertEqual(prepare.validate_id("XX.TEST..HNZ"), "XX.TEST..HNZ")
        for value in ("XX.TEST.*.HNZ", "XX.TEST.00.HN?", "XX.TEST.HNZ", "XX.TEST.--.HNZ"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                prepare.validate_id(value)
        with patch("sys.stderr", new=io.StringIO()), self.assertRaises(SystemExit) as exc:
            prepare.main(["raw.mseed", "response.xml", "--id", "XX.TEST..HNZ", "--output", "acc.txt"])
        self.assertEqual(exc.exception.code, 2)

    def test_filter_must_be_ordered_finite_below_nyquist(self):
        self.assertEqual(prepare.validate_prefilter([0.1, 0.2, 5, 8], 20), (0.1, 0.2, 5, 8))
        for values in ([0, 1, 2, 3], [1, 1, 2, 3], [1, 2, 3, 10], [1, 2, 3, float("nan")], [1, 2, 3]):
            with self.subTest(values=values), self.assertRaises(ValueError):
                prepare.validate_prefilter(values, 20)

    def test_reject_bad_samples_and_rate(self):
        for data in ([1], [1, float("nan")], [float("inf"), 2]):
            with self.subTest(data=data), self.assertRaises(ValueError):
                prepare.validate_trace(trace(data))
        for rate in (0, -1, float("nan"), float("inf")):
            candidate = trace()
            candidate.stats.sampling_rate = rate
            with self.subTest(rate=rate), self.assertRaises(ValueError):
                prepare.validate_trace(candidate)
        class MaskedList(list):
            mask = True
        with self.assertRaisesRegex(ValueError, "masked"):
            prepare.validate_trace(trace(MaskedList([1, 2])))

    def test_epoch_must_cover_every_sample_and_be_unambiguous(self):
        valid = channel(start=Time(-1), end=Time(10))
        selected, record = prepare.select_response_epoch(inventory(valid), "XX.TEST..HNZ", Time(0), Time(1), 20)
        self.assertIs(selected, valid)
        self.assertEqual(record["start_utc"], str(Time(-1)))
        cases = [inventory(), inventory(channel(end=Time(0.5))),
                 inventory(channel(end=Time(0.5)), channel(start=Time(0.5))),
                 inventory(channel(), channel()), inventory(valid, station_start=Time(0.5)),
                 inventory(valid, station_end=Time(0.5))]
        for candidate in cases:
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                prepare.select_response_epoch(candidate, "XX.TEST..HNZ", Time(0), Time(1), 20)

    def test_response_must_be_complete_motion_to_counts(self):
        cases = [channel(response=False), channel(unit="PA"), channel(unit="COUNTS"), channel(unit="CM/(S**2)")]
        sensitivity_only = channel()
        sensitivity_only.response.response_stages = []
        cases.append(sensitivity_only)
        wrong_rate = channel()
        wrong_rate.sample_rate = 40
        cases.append(wrong_rate)
        wrong_output = channel()
        wrong_output.response.response_stages[0].output_units = "V"
        cases.append(wrong_output)
        wrong_units = channel()
        wrong_units.response.instrument_sensitivity.input_units = "NM/S**2"
        cases.append(wrong_units)
        for candidate in cases:
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                prepare.select_response_epoch(inventory(candidate), "XX.TEST..HNZ", Time(0), Time(1), 20)
        for unit in ("M/S", "M/SEC", "M/(S**2)", "CM/S**2", "NM/S", "MM"):
            with self.subTest(unit=unit):
                prepare.select_response_epoch(inventory(channel(unit=unit)), "XX.TEST..HNZ", Time(0), Time(1), 20)

    def test_ascii2_header_values_and_hashed_sidecar(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "acc.txt"
            record = {"remove_response": {"output": "ACC", "water_level": None}}
            sidecar = prepare.write_outputs(trace([-0.00015, 0, 0.00123]), output, record)
            lines = output.read_text().splitlines()
            fields = [field.strip() for field in lines[0].split(",")]
            self.assertEqual(fields, ["TIMESERIES XX.TEST..HNZ.M", "3 samples", "20 sps", str(Time(0)), "TSPAIR", "FLOAT", "M/S**2"])
            self.assertEqual([len(line.split()) for line in lines[1:]], [2, 2, 2])
            self.assertEqual([float(line.split()[1]) for line in lines[1:]], [-0.00015, 0, 0.00123])
            self.assertEqual(lines[-1].split()[0], str(Time(0.1)))
            metadata = json.loads(sidecar.read_text())
            self.assertEqual(metadata["output"]["sha256"], prepare.sha256_file(output))
            self.assertEqual(metadata["output"]["units"], "M/S**2")
            with self.assertRaises(ValueError):
                prepare.write_outputs(trace(), output, {})
            self.assertEqual(output.read_text().splitlines(), lines)

    def test_failed_sidecar_does_not_leave_result_without_provenance(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "acc.txt"
            with self.assertRaises(ValueError):
                prepare.write_outputs(trace(), output, {"bad": float("nan")})
            self.assertFalse(output.exists())
            self.assertFalse(Path(str(output) + ".processing.json").exists())


@unittest.skipUnless(HAS_OBSPY, "optional ObsPy dependency is not installed")
class ObsPyIntegrationTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        from obspy import Trace, UTCDateTime
        from obspy.core.inventory import Inventory, Network, Station, Channel, Site
        from obspy.core.inventory.response import Response
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.raw = Path(self.folder.name) / "raw.mseed"
        self.response = Path(self.folder.name) / "response.xml"
        self.output = Path(self.folder.name) / "acc.txt"
        # A flat synthetic accelerometer: 2,000,000 counts per m/s².
        self.expected = np.sin(2 * np.pi * np.arange(12000) / 100)
        self.trace = Trace(np.rint(self.expected * 2_000_000).astype(np.int32), header={
            "network": "XX", "station": "TEST", "location": "", "channel": "HNZ",
            "sampling_rate": 100, "starttime": UTCDateTime("2020-01-01T00:00:00Z")})
        self.trace.write(str(self.raw), format="MSEED")
        response = Response.from_paz([], [], stage_gain=2_000_000, input_units="M/S**2", output_units="COUNTS")
        channel = Channel(code="HNZ", location_code="", latitude=0, longitude=0, elevation=0, depth=0,
                          sample_rate=100, start_date=UTCDateTime("2019-01-01"), response=response)
        self.inventory = Inventory([Network("XX", stations=[Station("TEST", latitude=0, longitude=0,
            elevation=0, site=Site("test"), channels=[channel])])], source="synthetic test")
        self.inventory.write(str(self.response), format="STATIONXML")

    def test_actual_response_removal_preserves_si_amplitude(self):
        import numpy as np
        sidecar = prepare.prepare(self.raw, self.response, "XX.TEST..HNZ", [0.1, 0.2, 10, 20], self.output)
        lines = self.output.read_text().splitlines()
        actual = np.array([float(line.split()[1]) for line in lines[1:]])
        # Exclude the intentionally tapered edges; test physical amplitude, not a
        # comparison to another invocation of the same correction implementation.
        np.testing.assert_allclose(actual[2000:-2000], self.expected[2000:-2000], atol=0.002, rtol=0)
        self.assertEqual(lines[0].split(",")[-1].strip(), "M/S**2")
        record = json.loads(sidecar.read_text())
        self.assertEqual(record["remove_response"]["water_level"], None)
        self.assertEqual(record["remove_response"]["pre_filt_hz"], [0.1, 0.2, 10, 20])
        self.assertTrue(any("remove_response" in item for item in record["obspy_processing"]))
        self.assertEqual(record["raw"]["sha256"], prepare.sha256_file(self.raw))

    def test_centimetre_response_is_converted_to_metres(self):
        import numpy as np
        # Counts for 100 cm/s² must become 1 m/s², with no label-only conversion.
        self.trace.data = np.rint(self.expected * 100 * 2_000_000).astype(np.int32)
        self.trace.write(str(self.raw), format="MSEED")
        response = self.inventory[0][0][0].response
        response.response_stages[0].input_units = "CM/S**2"
        response.instrument_sensitivity.input_units = "CM/S**2"
        self.inventory.write(str(self.response), format="STATIONXML")
        prepare.prepare(self.raw, self.response, "XX.TEST..HNZ", [0.1, 0.2, 10, 20], self.output)
        actual = np.array([float(line.split()[1]) for line in self.output.read_text().splitlines()[1:]])
        np.testing.assert_allclose(actual[2000:-2000], self.expected[2000:-2000], atol=0.002, rtol=0)

    def test_multiple_segments_and_response_epoch_crossing_are_rejected(self):
        from obspy import Stream
        later = self.trace.copy()
        later.stats.starttime += 200
        Stream([self.trace, later]).write(str(self.raw), format="MSEED")
        with self.assertRaisesRegex(ValueError, "contiguous"):
            prepare.prepare(self.raw, self.response, "XX.TEST..HNZ", [0.1, 0.2, 10, 20], self.output)
        self.trace.write(str(self.raw), format="MSEED")
        self.inventory[0][0][0].end_date = self.trace.stats.starttime + 60
        self.inventory.write(str(self.response), format="STATIONXML")
        with self.assertRaisesRegex(ValueError, "full waveform"):
            prepare.prepare(self.raw, self.response, "XX.TEST..HNZ", [0.1, 0.2, 10, 20], self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()

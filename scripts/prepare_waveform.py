#!/usr/bin/env python3
"""Convert local raw miniSEED + StationXML to response-corrected ASCII2.

ObsPy is an optional, local preparation dependency; the browser never runs this
script. Filter corners must be chosen for the instrument and analysis band.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import warnings


OUTPUT_UNITS = "M/S**2"
REMOVE_RESPONSE_OPTIONS = {
    "output": "ACC", "water_level": None, "zero_mean": True,
    "taper": True, "taper_fraction": 0.05,
}


def validate_id(seed_id):
    """Use a literal NSLC, including an empty location, never wildcards."""
    if not re.fullmatch(r"[A-Za-z0-9]+\.[A-Za-z0-9]+\.[A-Za-z0-9]*\.[A-Za-z0-9]+", seed_id):
        raise ValueError("--id must be a literal NET.STA.LOC.CHA (empty LOC is allowed)")
    return seed_id


def validate_prefilter(corners, sample_rate):
    corners = tuple(float(value) for value in corners)
    if (len(corners) != 4 or not all(math.isfinite(value) for value in corners)
            or not 0 < corners[0] < corners[1] < corners[2] < corners[3] < sample_rate / 2):
        raise ValueError("--pre-filt requires 0 < f1 < f2 < f3 < f4 < Nyquist, in Hz")
    return corners


def validate_trace(trace):
    rate = float(trace.stats.sampling_rate)
    if not math.isfinite(rate) or rate <= 0:
        raise ValueError("waveform sample rate must be finite and positive")
    if len(trace.data) < 2 or len(trace.data) != trace.stats.npts:
        raise ValueError("waveform must contain at least two samples and a matching sample count")
    # Masked samples represent gaps; converting them to float can hide the mask.
    mask = getattr(trace.data, "mask", False)
    if bool(mask.any() if hasattr(mask, "any") else mask):
        raise ValueError("waveform contains masked samples (gaps)")
    if not all(math.isfinite(float(value)) for value in trace.data):
        raise ValueError("waveform contains non-finite samples")
    return rate


def motion_unit(unit):
    """Recognize only motion spellings/scales handled by ObsPy's evalresp bridge."""
    unit = (unit or "").upper()
    for prefix, scale in (("M", 1.0), ("CM", 0.01), ("MM", 0.001), ("NM", 1e-9)):
        if unit == prefix:
            return "displacement", scale
        if unit in (prefix + "/S", prefix + "/SEC"):
            return "velocity", scale
        # Some non-SI alias spellings are recognized but not rescaled by ObsPy.
        # Keep those out rather than silently produce a wrong metric prefix.
        acceleration = [prefix + "/S**2"]
        if prefix == "M":
            acceleration += ["M/(S**2)", "M/SEC**2", "M/(SEC**2)", "M/S/S"]
        if unit in acceleration:
            return "acceleration", scale
    raise ValueError("response input unit is not supported ground motion: {!r}".format(unit))


def select_response_epoch(inventory, seed_id, start, end, sample_rate):
    """Require one unambiguous response epoch covering every selected sample."""
    net_code, sta_code, loc_code, cha_code = seed_id.split(".")
    overlaps = []
    for network in inventory:
        if network.code != net_code:
            continue
        for station in network:
            if station.code != sta_code:
                continue
            for channel in station:
                if channel.code != cha_code or channel.location_code != loc_code:
                    continue
                starts = [node.start_date for node in (network, station, channel)
                          if node.start_date is not None]
                ends = [node.end_date for node in (network, station, channel)
                        if node.end_date is not None]
                epoch_start = max(starts) if starts else None
                epoch_end = min(ends) if ends else None
                if ((epoch_start is None or epoch_start <= end)
                        and (epoch_end is None or epoch_end >= start)):
                    overlaps.append((channel, epoch_start, epoch_end))
    if len(overlaps) != 1:
        raise ValueError("StationXML must have exactly one response epoch overlapping the waveform; split epoch crossings first")
    channel, epoch_start, epoch_end = overlaps[0]
    if ((epoch_start is not None and epoch_start > start)
            or (epoch_end is not None and epoch_end < end)):
        raise ValueError("response epoch does not cover the full waveform; split epoch crossings first")
    if channel.sample_rate is None or not math.isclose(float(channel.sample_rate), sample_rate, rel_tol=1e-6):
        raise ValueError("StationXML and waveform sample rates do not match")
    response = channel.response
    if (response is None or not response.response_stages
            or response.instrument_sensitivity is None
            or getattr(response, "instrument_polynomial", None) is not None):
        raise ValueError("StationXML must contain a full linear response, not sensitivity alone")
    stages = sorted(response.response_stages, key=lambda stage: stage.stage_sequence_number)
    if any(type(stage).__name__ == "PolynomialResponseStage" for stage in stages):
        raise ValueError("polynomial responses are not supported by this linear ACC workflow")
    first_units = motion_unit(stages[0].input_units)
    sensitivity = response.instrument_sensitivity
    if first_units != motion_unit(sensitivity.input_units):
        raise ValueError("first response stage and instrument sensitivity input units disagree")
    if ((stages[-1].output_units or "").upper() not in ("COUNT", "COUNTS")
            or (sensitivity.output_units or "").upper() not in ("COUNT", "COUNTS")):
        raise ValueError("response output must be raw digital COUNTS")
    return channel, {
        "start_utc": str(epoch_start) if epoch_start is not None else None,
        "end_utc": str(epoch_end) if epoch_end is not None else None,
        "input_units": stages[0].input_units,
        "output_units": stages[-1].output_units,
        "stage_count": len(stages),
    }


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_outputs(trace, output, record):
    """Exclusive creation protects raw inputs and previously prepared results."""
    output = Path(output)
    sidecar = Path(str(output) + ".processing.json")
    if output.exists() or sidecar.exists():
        raise ValueError("output or processing sidecar already exists; choose a new output path")
    created = []
    try:
        with output.open("x", encoding="utf-8", newline="\n") as handle:
            created.append(output)
            rate = float(trace.stats.sampling_rate)
            handle.write("TIMESERIES {}.M, {} samples, {:.17g} sps, {}, TSPAIR, FLOAT, {}\n".format(
                trace.id, len(trace.data), rate, trace.stats.starttime, OUTPUT_UNITS))
            for index, value in enumerate(trace.data):
                handle.write("{} {:.17g}\n".format(trace.stats.starttime + index / rate, float(value)))
        record["output"] = {"path": str(output.resolve()), "sha256": sha256_file(output), "units": OUTPUT_UNITS}
        with sidecar.open("x", encoding="utf-8", newline="\n") as handle:
            created.append(sidecar)
            json.dump(record, handle, ensure_ascii=False, allow_nan=False, indent=2)
            handle.write("\n")
    except Exception:
        for path in reversed(created):
            path.unlink()
        raise
    return sidecar


def prepare(raw_path, response_path, seed_id, corners, output):
    validate_id(seed_id)
    # Delay optional imports so --help and the stdlib validation tests work alone.
    try:
        import obspy
    except ImportError as exc:
        raise ValueError("ObsPy is required: install it in a local virtual environment; see docs/waveform-units.md") from exc
    raw_path, response_path = Path(raw_path), Path(response_path)
    if not raw_path.is_file() or not response_path.is_file():
        raise ValueError("raw and response must be existing local files")
    output = Path(output)
    sidecar = Path(str(output) + ".processing.json")
    if output.resolve() in (raw_path.resolve(), response_path.resolve()) or sidecar.resolve() in (raw_path.resolve(), response_path.resolve()):
        raise ValueError("output paths must differ from the input files")
    # Enforce local formats: never let read() interpret a URL or guess a file type.
    stream = obspy.read(str(raw_path), format="MSEED")
    matches = [trace for trace in stream if trace.id == seed_id]
    if len(matches) != 1:
        raise ValueError("--id must select exactly one contiguous trace; gaps/overlaps/segments are not merged")
    trace = matches[0]
    rate = validate_trace(trace)
    corners = validate_prefilter(corners, rate)
    inventory = obspy.read_inventory(str(response_path), format="STATIONXML")
    channel, epoch = select_response_epoch(inventory, seed_id, trace.stats.starttime, trace.stats.endtime, rate)
    corrected = trace.copy()
    # Attach the exact validated epoch, avoiding an implicit start-time-only lookup.
    corrected.stats.response = channel.response
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        corrected.remove_response(pre_filt=corners, **REMOVE_RESPONSE_OPTIONS)
    validate_trace(corrected)
    if (corrected.stats.npts != trace.stats.npts or corrected.stats.starttime != trace.stats.starttime
            or corrected.stats.sampling_rate != trace.stats.sampling_rate):
        raise ValueError("response correction unexpectedly changed the waveform time grid")
    record = {
        "schema_version": 1,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "tool": "scripts/prepare_waveform.py",
        "python_version": sys.version.split()[0],
        "obspy_version": obspy.__version__,
        "raw": {"path": str(raw_path.resolve()), "format": "miniSEED", "sha256": sha256_file(raw_path)},
        "response": {"path": str(response_path.resolve()), "format": "StationXML", "sha256": sha256_file(response_path), "epoch": epoch},
        "trace": {"id": seed_id, "samples": trace.stats.npts, "sample_rate_hz": rate,
                  "start_utc": str(trace.stats.starttime), "end_utc": str(trace.stats.endtime)},
        "remove_response": dict(REMOVE_RESPONSE_OPTIONS, pre_filt_hz=list(corners)),
        "obspy_processing": list(getattr(corrected.stats, "processing", [])),
        "warnings": [str(item.message) for item in caught],
        "limitation": "Processing provenance, not proof of sensor calibration or suitable analysis bandwidth.",
    }
    sidecar = write_outputs(corrected, output, record)
    for message in record["warnings"]:
        print("ObsPy warning: " + message, file=sys.stderr)
    return sidecar


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw", type=Path, help="local raw miniSEED file")
    parser.add_argument("response", type=Path, help="local StationXML file downloaded with level=response")
    parser.add_argument("--id", required=True, dest="seed_id", help="literal NET.STA.LOC.CHA, e.g. IU.ANMO.00.BHZ")
    parser.add_argument("--pre-filt", required=True, nargs=4, type=float, metavar=("F1", "F2", "F3", "F4"), help="four instrument-appropriate taper frequencies in Hz; no defaults")
    parser.add_argument("--output", required=True, type=Path, help="new ASCII2 path; also writes .processing.json")
    args = parser.parse_args(argv)
    try:
        sidecar = prepare(args.raw, args.response, args.seed_id, args.pre_filt, args.output)
    except Exception as exc:
        parser.exit(1, "Preparation failed: {}\n".format(exc))
    print("Saved {} ({}) and {}".format(args.output, OUTPUT_UNITS, sidecar))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

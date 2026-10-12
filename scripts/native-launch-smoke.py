#!/usr/bin/env python3
"""Cold-launch a prebuilt simulator app on a disposable simulator. See native-launch-smoke.md."""

import argparse
import datetime
import json
from pathlib import Path
import plistlib
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid


def command(*args, timeout=60, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{' '.join(args[:3])} failed ({result.returncode}):\n"
                           f"{result.stdout}{result.stderr}".strip())
    return result


def simctl(*args, **kwargs):
    return command("xcrun", "simctl", *args, **kwargs)


def process_matches(pid, executable):
    result = command("ps", "-ww", "-p", str(pid), "-o", "stat=", "-o", "comm=", check=False)
    fields = result.stdout.strip().split(None, 1)
    # A zombie or a reused PID is not a surviving app process.
    return (result.returncode == 0 and len(fields) == 2 and "Z" not in fields[0]
            and Path(fields[1]).resolve() == executable.resolve())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True, help="Prebuilt iphonesimulator .app")
    parser.add_argument("--runtime", required=True, help="Installed runtime identifier, e.g. com.apple.CoreSimulator.SimRuntime.iOS-27-0")
    parser.add_argument("--device-type", required=True, help="Device type identifier, e.g. com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max")
    parser.add_argument("--seconds", type=float, default=8, help="Required survival window (default 8 seconds)")
    parser.add_argument("--output-dir", type=Path, help="Parent directory for a new, unique evidence folder (default system temp)")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This check requires macOS and Xcode simulator tools.")
    if not 1 <= args.seconds <= 300:
        parser.error("--seconds must be between 1 and 300.")
    app = args.app.expanduser().resolve()
    try:
        with (app / "Info.plist").open("rb") as source:
            info = plistlib.load(source)
        bundle_id = info["CFBundleIdentifier"]
        executable_name = info["CFBundleExecutable"]
    except (OSError, KeyError, plistlib.InvalidFileException) as error:
        parser.error(f"Could not read app metadata: {error}")
    if "iPhoneSimulator" not in info.get("CFBundleSupportedPlatforms", []):
        parser.error("Pass an iphonesimulator build, not an archive or device build.")
    if not (app / executable_name).is_file():
        parser.error("The app executable is missing.")
    runtimes = json.loads(simctl("list", "runtimes", "--json").stdout)["runtimes"]
    runtime = next((r for r in runtimes if r["identifier"] == args.runtime), None)
    if not runtime or not runtime.get("isAvailable"):
        parser.error("The requested simulator runtime is not installed and available.")
    devices = json.loads(simctl("list", "devicetypes", "--json").stdout)["devicetypes"]
    if not any(d["identifier"] == args.device_type for d in devices):
        parser.error("The requested device type is not installed.")
    output_parent = args.output_dir.expanduser().resolve() if args.output_dir else None
    if output_parent:
        output_parent.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="native-launch-", dir=output_parent)).resolve()
    report = {
        "app": str(app), "bundleId": bundle_id,
        "version": info.get("CFBundleShortVersionString"), "build": info.get("CFBundleVersion"),
        "runtime": args.runtime, "deviceType": args.device_type,
        "requiredSeconds": args.seconds, "startedAt": datetime.datetime.now().astimezone().isoformat(),
        "status": "failed",
    }
    created_udid = None
    pid = None
    failure = None

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f"Interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        name = f"SPS launch check {uuid.uuid4().hex[:8]}"
        created = simctl("create", name, args.device_type, args.runtime).stdout.strip()
        # Never accept a device argument or select an existing simulator for cleanup.
        created_udid = str(uuid.UUID(created))
        report["createdSimulator"] = created_udid
        print(f"Booting isolated simulator {created_udid}", flush=True)
        simctl("boot", created_udid)
        simctl("bootstatus", created_udid, "-b", timeout=240)
        simctl("install", created_udid, str(app), timeout=120)
        installed = Path(simctl("get_app_container", created_udid, bundle_id, "app").stdout.strip()) / executable_name
        launched = simctl("launch", f"--stdout={evidence / 'stdout.log'}",
                         f"--stderr={evidence / 'stderr.log'}", created_udid, bundle_id,
                         timeout=30, check=False)
        launch_text = launched.stdout + launched.stderr
        (evidence / "launch.log").write_text(launch_text)
        match = re.search(r":\s*(\d+)\s*$", launched.stdout)
        if match:
            pid = int(match.group(1))
            report["pid"] = pid
        if launched.returncode or not pid:
            raise RuntimeError(f"Native launch failed ({launched.returncode}): {launch_text.strip()}")
        started = time.monotonic()
        print(f"Checking {bundle_id} PID {pid} for {args.seconds:g} seconds", flush=True)
        while True:
            elapsed = time.monotonic() - started
            if not process_matches(pid, installed):
                raise RuntimeError(f"The app exited {elapsed:.2f} seconds after launch.")
            if elapsed >= args.seconds:
                break
            time.sleep(min(0.25, args.seconds - elapsed))
        report["survivedSeconds"] = round(time.monotonic() - started, 2)
        report["status"] = "passed"
    except (Exception, KeyboardInterrupt) as error:
        failure = str(error) or "Interrupted"
        report["error"] = failure
    finally:
        if created_udid:
            # Collect only this new simulator's app logs, before removing that simulator.
            try:
                predicate = f"processIdentifier == {pid}" if pid else f"process == {json.dumps(executable_name)}"
                logs = simctl("spawn", created_udid, "log", "show", "--style", "compact",
                              "--last", "3m", "--info", "--debug", "--predicate", predicate,
                              timeout=30, check=False)
                (evidence / "native.log").write_text(logs.stdout + logs.stderr)
            except Exception as error:
                (evidence / "native.log").write_text(f"Log collection failed: {error}\n")
            cleanup_errors = []
            try:
                simctl("shutdown", created_udid, timeout=45, check=False)
            except Exception as error:
                cleanup_errors.append(str(error))
            try:
                simctl("delete", created_udid, timeout=45)
                report["simulatorDeleted"] = True
            except Exception as error:
                cleanup_errors.append(str(error))
            if cleanup_errors:
                report["cleanupErrors"] = cleanup_errors
                report["status"] = "failed"
                failure = failure or "Disposable simulator cleanup did not complete. See report.json."
        (evidence / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    if failure:
        print(f"FAIL: {failure}", file=sys.stderr)
        for name in ("stderr.log", "native.log"):
            path = evidence / name
            if path.exists():
                lines = path.read_text(errors="replace").splitlines()
                relevant = [i for i, line in enumerate(lines) if re.search(r"exception|abort|fatal|crash|terminat|failed to launch|life cycle is required", line, re.I)]
                indexes = sorted({j for i in relevant for j in range(max(0, i - 1), min(len(lines), i + 3))})
                excerpt = "\n".join(lines[i] for i in indexes) if indexes else "\n".join(lines[-20:])
                if excerpt:
                    print(f"{name}:\n{excerpt[-12000:]}", file=sys.stderr)
    else:
        print(f"PASS: {bundle_id} {report['version']} ({report['build']}) survived the native launch check.")
    print(f"Evidence: {evidence}")
    return 1 if failure else 0


if __name__ == "__main__":
    sys.exit(main())

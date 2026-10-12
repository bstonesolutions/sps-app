# Native launch check

Run this before distributing an iOS build. A successful archive or browser test does not prove that UIKit can launch the app on a supported iOS version.

The script takes a **prebuilt simulator `.app`**, creates its own empty simulator, boots it, installs the app, and checks that the launched process remains alive for eight seconds. It saves stdout, stderr, native logs, and a JSON result, then shuts down and deletes only the simulator it created. It never targets an existing simulator or device and does not sign in or press app controls.

```sh
python3 scripts/native-launch-smoke.py \
  --app '/absolute/path/to/Build/Products/Release-iphonesimulator/SPS Way.app' \
  --runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 \
  --device-type com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max \
  --output-dir .sps-review
```

Use `xcrun simctl list runtimes` and `xcrun simctl list devicetypes` to choose installed identifiers. Repeat against the supported runtimes you intend to check. `--seconds 15` extends the observation window. No build or dependency installation occurs in this script.

Exit code 0 means the app's original process survived the window and simulator cleanup completed. Nonzero means launch, survival, setup, or cleanup failed. A printed `simulatorDeleted: true` in `report.json` confirms cleanup. If the script is forcibly killed and cannot clean up, the report or the printed created simulator UUID identifies the one disposable device to remove.

This checks a fresh native launch, including failures such as UIKit rejecting a missing scene configuration. It does not verify authenticated workflows, UI correctness, physical-device behavior, or a public App Store release. The app can perform its ordinary signed-out startup network requests; no existing credentials or customer records are copied into the simulator.

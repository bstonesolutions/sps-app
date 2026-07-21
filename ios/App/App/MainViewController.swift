//  MainViewController.swift
//  Custom Capacitor bridge view controller whose only job is to REGISTER the app-target
//  plugins. A plugin defined in the app target (not a package) does NOT auto-register from
//  @objc + CAPBridgedPlugin alone — Capacitor requires an explicit registerPluginInstance()
//  in capacitorDidLoad(), or JS calls fail with "<plugin> not implemented on iOS".
//  Main.storyboard's root view controller is set to this class (customModule "App").

import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SPSWidgetBridge())
        bridge?.registerPluginInstance(SPSDriveTimeBridge())
        // Reuse the exact instance AppDelegate prepares for a Core Location cold relaunch.
        // Registering a new bridge here would create a second CLLocationManager/delegate and
        // could race the durable pending-arrival and local-notification contract.
        bridge?.registerPluginInstance(SPSArrivalCoordinator.shared.plugin)
    }
}

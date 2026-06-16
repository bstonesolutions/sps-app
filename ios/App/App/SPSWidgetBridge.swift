//  SPSWidgetBridge.swift
//  A tiny Capacitor plugin (lives in the MAIN app target) that writes the widget
//  payload into the App Group shared store and asks WidgetKit to reload. The JS
//  side hands us an already-serialized JSON string so there is nothing to interpret
//  here — we just persist it and trigger a refresh.
//
//  Default @capacitor/preferences writes to the app's standard UserDefaults, which
//  the widget extension can't read; this targets the shared App Group suite instead.

import Foundation
import Capacitor
import WidgetKit

@objc(SPSWidgetBridge)
public class SPSWidgetBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SPSWidgetBridge"
    public let jsName = "SPSWidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    private let appGroup = "group.com.stonepropertysolutions.app"
    private let key = "sps_widget_payload"

    @objc func update(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), !json.isEmpty else {
            call.reject("Missing json"); return
        }
        guard let defaults = UserDefaults(suiteName: appGroup) else {
            call.reject("App Group \(appGroup) not available — check entitlements"); return
        }
        defaults.set(json, forKey: key)
        reloadWidgets()
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        UserDefaults(suiteName: appGroup)?.removeObject(forKey: key)
        reloadWidgets()
        call.resolve()
    }

    private func reloadWidgets() {
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}

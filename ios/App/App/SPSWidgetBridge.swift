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
import MapKit
import CoreLocation
import UserNotifications
import UIKit

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

// Native driving-time bridge for the installed iOS app. The web app can use the Google Maps
// JavaScript SDK, but the bundled Capacitor origin is capacitor://localhost and cannot reliably
// satisfy an HTTPS-referrer restriction. MapKit gives the team a real route and distance without
// weakening or embedding another Google key.
@objc(SPSDriveTimeBridge)
public class SPSDriveTimeBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SPSDriveTimeBridge"
    public let jsName = "SPSDriveTimeBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "calculate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private var activeCalls: [String: CAPPluginCall] = [:]
    private var activeGeocoders: [String: CLGeocoder] = [:]
    private var activeDirections: [String: MKDirections] = [:]

    @objc func calculate(_ call: CAPPluginCall) {
        guard let latitude = call.getDouble("latitude"),
              let longitude = call.getDouble("longitude"),
              (-90.0...90.0).contains(latitude),
              (-180.0...180.0).contains(longitude) else {
            call.reject("A valid current location is required.", "invalid_origin")
            return
        }
        guard let destination = call.getString("destination")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !destination.isEmpty,
              destination.count <= 400 else {
            call.reject("A valid stop address is required.", "invalid_destination")
            return
        }
        guard let requestId = call.getString("requestId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !requestId.isEmpty,
              requestId.count <= 100 else {
            call.reject("A drive-time request ID is required.", "invalid_request")
            return
        }

        DispatchQueue.main.async {
            self.cancelRequest(requestId, rejectPending: true)
            let geocoder = CLGeocoder()
            self.activeCalls[requestId] = call
            self.activeGeocoders[requestId] = geocoder
            geocoder.geocodeAddressString(destination) { placemarks, geocodeError in
                DispatchQueue.main.async {
                    guard self.activeCalls[requestId] != nil else { return }
                    self.activeGeocoders.removeValue(forKey: requestId)
                    guard geocodeError == nil, let coordinate = placemarks?.first?.location?.coordinate else {
                        self.finish(requestId) { pending in
                            pending.reject("The stop address could not be located.", "route_not_found", geocodeError)
                        }
                        return
                    }

                    let request = MKDirections.Request()
                    request.source = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude)))
                    request.destination = MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
                    request.transportType = .automobile
                    request.requestsAlternateRoutes = false
                    request.departureDate = Date()

                    let directions = MKDirections(request: request)
                    self.activeDirections[requestId] = directions
                    directions.calculate { response, routeError in
                        DispatchQueue.main.async {
                            guard self.activeCalls[requestId] != nil else { return }
                            self.activeDirections.removeValue(forKey: requestId)
                            guard routeError == nil,
                                  let route = response?.routes.min(by: { $0.expectedTravelTime < $1.expectedTravelTime }),
                                  route.expectedTravelTime > 0 else {
                                self.finish(requestId) { pending in
                                    pending.reject("A driving route could not be calculated.", "route_not_found", routeError)
                                }
                                return
                            }
                            self.finish(requestId) { pending in
                                pending.resolve([
                                    "minutes": max(1, Int((route.expectedTravelTime / 60.0).rounded())),
                                    "distanceMiles": ((route.distance / 1609.344) * 10.0).rounded() / 10.0,
                                    "trafficAware": false,
                                    "provider": "apple"
                                ])
                            }
                        }
                    }
                }
            }
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId"), !requestId.isEmpty else {
            call.reject("A drive-time request ID is required.", "invalid_request")
            return
        }
        DispatchQueue.main.async {
            self.cancelRequest(requestId, rejectPending: true)
            call.resolve()
        }
    }

    private func finish(_ requestId: String, result: (CAPPluginCall) -> Void) {
        guard let pending = activeCalls.removeValue(forKey: requestId) else { return }
        activeGeocoders.removeValue(forKey: requestId)
        activeDirections.removeValue(forKey: requestId)
        result(pending)
    }

    private func cancelRequest(_ requestId: String, rejectPending: Bool) {
        activeGeocoders.removeValue(forKey: requestId)?.cancelGeocode()
        activeDirections.removeValue(forKey: requestId)?.cancel()
        if let pending = activeCalls.removeValue(forKey: requestId), rejectPending {
            pending.reject("Drive-time calculation was cancelled.", "drive_time_cancelled")
        }
    }
}

// Native, power-efficient arrival monitoring for the installed iOS app. This bridge monitors
// one circular region for the active or next assigned stop selected by the web app. Entering it only
// records a pending confirmation and displays a local notification; it never changes a stop or
// contacts a client. JavaScript must consume the pending arrival and ask the technician to confirm.
//
// AppDelegate and Capacitor must share one retained instance. Core Location can relaunch a
// terminated app in the background for a region event before the WebView exists; the coordinator
// prepares this same plugin early, then MainViewController registers it when Capacitor is ready.
@objc(SPSArrivalCoordinator)
public final class SPSArrivalCoordinator: NSObject {
    public static let shared = SPSArrivalCoordinator()
    public let plugin: SPSArrivalBridge

    private override init() {
        plugin = SPSArrivalBridge()
        super.init()
    }

    public func startForLocationRelaunch() {
        plugin.prepareForLocationRelaunch()
    }
}

@objc(SPSArrivalBridge)
public class SPSArrivalBridge: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "SPSArrivalBridge"
    public let jsName = "SPSArrivalBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAlways", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumePending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    private struct ActiveStop: Codable {
        let stopId: String
        let clientName: String
        let address: String
        let latitude: Double
        let longitude: Double
        let radiusMeters: Double
        let regionIdentifier: String
        let notificationIdentifier: String
        let configuredAt: String
        let validUntil: String?
        var detectedAt: String?
    }

    private struct PendingArrival: Codable {
        let stopId: String
        let clientName: String
        let address: String
        let latitude: Double
        let longitude: Double
        let radiusMeters: Double
        let detectedAt: String
        let validUntil: String?
    }

    private let locationManager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private let defaults = UserDefaults.standard
    private let activeStopKey = "sps_native_arrival_active_stop_v1"
    private let pendingArrivalKey = "sps_native_arrival_pending_v1"
    private let lastErrorKey = "sps_native_arrival_last_error_v1"
    private let regionPrefix = "com.stonepropertysolutions.spsway.arrival."
    private let defaultRadiusMeters = 100.0
    private let minimumRadiusMeters = 75.0
    private let maximumRadiusMeters = 500.0
    private var activeConfigureCall: CAPPluginCall?
    private var activePermissionCall: CAPPluginCall?
    private var permissionRequestStage = 0
    private var permissionTimeout: DispatchWorkItem?
    private var skipInitialStateIdentifiers = Set<String>()
    private var nativeLifecyclePrepared = false
    private var capacitorLoaded = false

    override public func load() {
        capacitorLoaded = true
        prepareNativeLifecycle()

        // A retained event complements consumePending(): if JavaScript subscribes after a cold
        // launch, it can still learn that iOS detected an arrival before the WebView existed.
        if let pending = loadPendingArrival() {
            notifyListeners("arrivalDetected", data: pendingObject(pending), retainUntilConsumed: true)
        }
    }

    // Called from AppDelegate only for UIApplication.LaunchOptionsKey.location. It deliberately
    // does not touch the Capacitor bridge: Core Location can deliver the region callback while the
    // WebView is absent, and handleArrival persists it for load()/consumePending() to replay later.
    public func prepareForLocationRelaunch() {
        prepareNativeLifecycle()
    }

    private func prepareNativeLifecycle() {
        guard !nativeLifecyclePrepared else { return }
        nativeLifecyclePrepared = true
        locationManager.delegate = self
        pruneExpiredArrivalMonitor()

        // Region monitoring is restored by iOS across launches. If authorization was granted
        // while this process was not active, ensure the persisted stop is registered now.
        ensureMonitoringIfAuthorized()
    }

    @objc func configure(_ call: CAPPluginCall) {
        guard let stopId = sanitizedText(call.getString("stopId"), maximumLength: 120), !stopId.isEmpty else {
            rejectConfigure(call, message: "A valid stop ID is required.", code: "invalid_stop")
            return
        }

        let clientName = sanitizedText(call.getString("clientName"), maximumLength: 120) ?? ""
        let address = sanitizedText(call.getString("address"), maximumLength: 400) ?? ""
        let requestedRadius = call.getDouble("radiusMeters") ?? defaultRadiusMeters
        let checkCurrentState = call.getBool("checkCurrentState") ?? true
        let validUntil = normalizedArrivalExpiry(call.getString("validUntil"))
        guard requestedRadius.isFinite, requestedRadius > 0 else {
            rejectConfigure(call, message: "A valid arrival radius is required.", code: "invalid_radius")
            return
        }

        let latitude = call.getDouble("latitude")
        let longitude = call.getDouble("longitude")
        let hasValidCoordinate = latitude.map { (-90.0...90.0).contains($0) } == true
            && longitude.map { (-180.0...180.0).contains($0) } == true

        guard hasValidCoordinate || !address.isEmpty else {
            rejectConfigure(call, message: "A valid stop coordinate or address is required.", code: "invalid_destination")
            return
        }

        DispatchQueue.main.async {
            self.cancelActiveConfigure(reason: "Arrival configuration was replaced by a newer request.")
            self.activeConfigureCall = call
            self.geocoder.cancelGeocode()

            if hasValidCoordinate, let latitude, let longitude {
                self.finishConfigure(
                    stopId: stopId,
                    clientName: clientName,
                    address: address,
                    coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
                    requestedRadius: requestedRadius,
                    validUntil: validUntil,
                    checkCurrentState: checkCurrentState,
                    call: call
                )
                return
            }

            self.geocoder.geocodeAddressString(address) { placemarks, error in
                DispatchQueue.main.async {
                    guard self.activeConfigureCall === call else { return }
                    guard error == nil, let coordinate = placemarks?.first?.location?.coordinate else {
                        self.activeConfigureCall = nil
                        self.rejectConfigure(
                            call,
                            message: "The stop address could not be located.",
                            code: "geocode_failed",
                            underlyingError: error
                        )
                        return
                    }
                    self.finishConfigure(
                        stopId: stopId,
                        clientName: clientName,
                        address: address,
                        coordinate: coordinate,
                        requestedRadius: requestedRadius,
                        validUntil: validUntil,
                        checkCurrentState: checkCurrentState,
                        call: call
                    )
                }
            }
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        let preservePending = call.getBool("preservePending") ?? false
        DispatchQueue.main.async {
            self.cancelActiveConfigure(reason: "Arrival configuration was cleared.")
            self.geocoder.cancelGeocode()
            self.stopArrivalRegions()
            let active = self.loadActiveStop()
            let pending = self.loadPendingArrival()
            let hasDurablePending = preservePending
                && active != nil
                && pending != nil
                && active?.stopId == pending?.stopId
                && active?.detectedAt != nil
            if !hasDurablePending {
                self.removeArrivalNotifications()
                self.defaults.removeObject(forKey: self.activeStopKey)
                self.defaults.removeObject(forKey: self.pendingArrivalKey)
                self.defaults.removeObject(forKey: self.lastErrorKey)
            }
            self.resolveStatus(call)
        }
    }

    @objc func requestAlways(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let previousCall = self.activePermissionCall {
                self.activePermissionCall = nil
                self.permissionTimeout?.cancel()
                previousCall.reject("The permission request was replaced by a newer request.", "permission_request_cancelled")
            }
            self.activePermissionCall = call
            self.permissionRequestStage = 0

            // Ask for alerts during the same explicit setup action. A denied notification choice
            // does not prevent location authorization; status() reports both independently.
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, error in
                DispatchQueue.main.async {
                    guard self.activePermissionCall === call else { return }
                    if let error {
                        self.saveLastError("Notification permission: \(error.localizedDescription)")
                    }
                    self.beginLocationPermissionRequest(call)
                }
            }
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.resolveStatus(call)
        }
    }

    @objc func consumePending(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let pending = self.loadPendingArrival() else {
                call.resolve(["pending": false])
                return
            }
            self.defaults.removeObject(forKey: self.pendingArrivalKey)
            var result: JSObject = ["pending": true]
            result["arrival"] = self.pendingObject(pending)
            call.resolve(result)
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString),
                  UIApplication.shared.canOpenURL(url) else {
                call.reject("iOS Settings could not be opened.", "settings_unavailable")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened {
                    call.resolve()
                } else {
                    call.reject("iOS Settings could not be opened.", "settings_unavailable")
                }
            }
        }
    }

    private func finishConfigure(
        stopId: String,
        clientName: String,
        address: String,
        coordinate: CLLocationCoordinate2D,
        requestedRadius: Double,
        validUntil: String,
        checkCurrentState: Bool,
        call: CAPPluginCall
    ) {
        guard activeConfigureCall === call else { return }
        guard CLLocationCoordinate2DIsValid(coordinate) else {
            activeConfigureCall = nil
            rejectConfigure(call, message: "The stop coordinate is invalid.", code: "invalid_destination")
            return
        }

        // Geocoding can take several seconds while the previous region remains live. If that
        // region fires during the lookup, its durable pending confirmation wins. Never let a
        // later geocoder callback erase a real arrival that JavaScript has not handled yet.
        if loadPendingArrival() != nil {
            activeConfigureCall = nil
            resolveStatus(call)
            return
        }

        stopArrivalRegions()
        removeArrivalNotifications()

        let regionIdentifier = regionPrefix + UUID().uuidString.lowercased()
        if !checkCurrentState {
            skipInitialStateIdentifiers.insert(regionIdentifier)
        }
        let notificationIdentifier = regionIdentifier + ".notification"
        let maximumSupportedRadius = locationManager.maximumRegionMonitoringDistance > 0
            ? locationManager.maximumRegionMonitoringDistance
            : maximumRadiusMeters
        let radius = min(max(requestedRadius, minimumRadiusMeters), min(maximumRadiusMeters, maximumSupportedRadius))
        let stop = ActiveStop(
            stopId: stopId,
            clientName: clientName,
            address: address,
            latitude: coordinate.latitude,
            longitude: coordinate.longitude,
            radiusMeters: radius,
            regionIdentifier: regionIdentifier,
            notificationIdentifier: notificationIdentifier,
            configuredAt: isoTimestamp(),
            validUntil: validUntil,
            detectedAt: nil
        )

        guard save(stop, forKey: activeStopKey) else {
            activeConfigureCall = nil
            rejectConfigure(call, message: "The arrival monitor could not be saved.", code: "persistence_failed")
            return
        }
        // Only clear a previous geocoding/configuration failure after the replacement stop has
        // been durably saved. Permission or monitoring errors discovered below are then recorded
        // as the current diagnostic instead of being hidden behind a stale address failure.
        defaults.removeObject(forKey: lastErrorKey)

        // Notification permission is requested during this explicit configuration action so a
        // future background region event can display the confirmation prompt.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, error in
            DispatchQueue.main.async {
                guard self.activeConfigureCall === call else { return }
                if let error {
                    self.saveLastError("Notification permission: \(error.localizedDescription)")
                }

                self.requestAlwaysAuthorizationIfNeeded()
                self.ensureMonitoringIfAuthorized()
                self.activeConfigureCall = nil
                self.resolveStatus(call)
            }
        }
    }

    private func requestAlwaysAuthorizationIfNeeded() {
        guard CLLocationManager.locationServicesEnabled() else {
            saveLastError("Location Services are disabled.")
            return
        }
        switch locationManager.authorizationStatus {
        case .notDetermined, .authorizedWhenInUse:
            locationManager.requestAlwaysAuthorization()
        case .authorizedAlways:
            if locationManager.accuracyAuthorization != .fullAccuracy {
                saveLastError("Precise Location is off. Turn it on in iOS Settings for dependable arrival prompts.")
            }
        case .denied:
            saveLastError("Location access is denied. Enable Always access in iOS Settings.")
        case .restricted:
            saveLastError("Location access is restricted on this device.")
        @unknown default:
            saveLastError("The iOS location authorization state is unknown.")
        }
    }

    private func beginLocationPermissionRequest(_ call: CAPPluginCall) {
        guard activePermissionCall === call else { return }
        guard CLLocationManager.locationServicesEnabled() else {
            saveLastError("Location Services are disabled.")
            finishPermissionRequest()
            return
        }

        switch locationManager.authorizationStatus {
        case .notDetermined:
            permissionRequestStage = 1
            schedulePermissionTimeout()
            locationManager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            permissionRequestStage = 2
            schedulePermissionTimeout()
            locationManager.requestAlwaysAuthorization()
        case .authorizedAlways:
            if locationManager.accuracyAuthorization == .fullAccuracy {
                defaults.removeObject(forKey: lastErrorKey)
            } else {
                saveLastError("Precise Location is off. Turn it on in iOS Settings for dependable arrival prompts.")
            }
            finishPermissionRequest()
        case .denied:
            saveLastError("Location access is denied. Enable Always access in iOS Settings.")
            finishPermissionRequest()
        case .restricted:
            saveLastError("Location access is restricted on this device.")
            finishPermissionRequest()
        @unknown default:
            saveLastError("The iOS location authorization state is unknown.")
            finishPermissionRequest()
        }
    }

    private func schedulePermissionTimeout() {
        permissionTimeout?.cancel()
        let timeout = DispatchWorkItem { [weak self] in
            self?.finishPermissionRequest()
        }
        permissionTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
    }

    private func finishPermissionRequest() {
        guard let call = activePermissionCall else { return }
        activePermissionCall = nil
        permissionRequestStage = 0
        permissionTimeout?.cancel()
        permissionTimeout = nil
        resolveStatus(call)
    }

    private func ensureMonitoringIfAuthorized() {
        pruneExpiredArrivalMonitor()
        guard locationManager.authorizationStatus == .authorizedAlways,
              locationManager.accuracyAuthorization == .fullAccuracy,
              CLLocationManager.locationServicesEnabled(),
              CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self),
              let stop = loadActiveStop(),
              stop.detectedAt == nil,
              !hasPendingArrival(for: stop.stopId) else { return }

        let alreadyMonitoring = locationManager.monitoredRegions.contains {
            $0.identifier == stop.regionIdentifier
        }
        guard !alreadyMonitoring else { return }

        stopArrivalRegions(except: stop.regionIdentifier)
        let region = CLCircularRegion(
            center: CLLocationCoordinate2D(latitude: stop.latitude, longitude: stop.longitude),
            radius: stop.radiusMeters,
            identifier: stop.regionIdentifier
        )
        region.notifyOnEntry = true
        region.notifyOnExit = false
        locationManager.startMonitoring(for: region)
    }

    private func stopArrivalRegions(except identifierToKeep: String? = nil) {
        for region in locationManager.monitoredRegions
        where region.identifier.hasPrefix(regionPrefix) && region.identifier != identifierToKeep {
            locationManager.stopMonitoring(for: region)
            skipInitialStateIdentifiers.remove(region.identifier)
        }
    }

    private func removeArrivalNotifications() {
        let center = UNUserNotificationCenter.current()
        let identifiers = loadActiveStop().map { [$0.notificationIdentifier] } ?? []
        guard !identifiers.isEmpty else { return }
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    private func handleArrival(for region: CLRegion) {
        pruneExpiredArrivalMonitor()
        guard var stop = loadActiveStop(),
              stop.regionIdentifier == region.identifier,
              stop.detectedAt == nil,
              !hasPendingArrival(for: stop.stopId) else { return }

        let detectedAt = isoTimestamp()
        let pending = PendingArrival(
            stopId: stop.stopId,
            clientName: stop.clientName,
            address: stop.address,
            latitude: stop.latitude,
            longitude: stop.longitude,
            radiusMeters: stop.radiusMeters,
            detectedAt: detectedAt,
            validUntil: stop.validUntil
        )
        guard save(pending, forKey: pendingArrivalKey) else {
            saveLastError("The detected arrival could not be saved.")
            return
        }
        stop.detectedAt = detectedAt
        guard save(stop, forKey: activeStopKey) else {
            defaults.removeObject(forKey: pendingArrivalKey)
            saveLastError("The arrival monitor could not be marked complete.")
            return
        }

        // Arrival detection is deliberately one-shot. The web app owns confirmation, stop state,
        // and all customer communication.
        locationManager.stopMonitoring(for: region)
        let payload = pendingObject(pending)
        // A Core Location cold relaunch can arrive before Capacitor has attached this plugin.
        // The payload is already durable; load() emits it once the bridge exists. Avoid calling
        // notifyListeners against an unattached CAPPlugin instance.
        if capacitorLoaded {
            notifyListeners("arrivalDetected", data: payload, retainUntilConsumed: true)
        }
        postArrivalNotification(stop: stop)
    }

    private func postArrivalNotification(stop: ActiveStop) {
        let content = UNMutableNotificationContent()
        content.title = "Arrival check"
        if stop.clientName.isEmpty {
            content.body = "You’re near your scheduled stop. Open SPS Way to review it and confirm arrival."
        } else {
            content.body = "You’re near \(stop.clientName). Open SPS Way to review the stop and confirm arrival."
        }
        content.sound = .default
        content.threadIdentifier = "sps-arrival"
        content.userInfo = [
            "type": "arrivalDetected",
            "open": "schedule",
            "stopId": stop.stopId
        ]

        let request = UNNotificationRequest(
            identifier: stop.notificationIdentifier,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                DispatchQueue.main.async {
                    self.saveLastError("Arrival notification: \(error.localizedDescription)")
                }
            }
        }
    }

    private func resolveStatus(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                call.resolve(self.statusObject(notificationStatus: settings.authorizationStatus))
            }
        }
    }

    private func statusObject(notificationStatus: UNAuthorizationStatus) -> JSObject {
        pruneExpiredArrivalMonitor()
        let active = loadActiveStop()
        let pending = loadPendingArrival()
        let isMonitoring = active.map { activeStop in
            locationManager.monitoredRegions.contains { $0.identifier == activeStop.regionIdentifier }
        } ?? false

        var result: JSObject = [
            "supported": CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self),
            "locationServicesEnabled": CLLocationManager.locationServicesEnabled(),
            "locationAuthorization": locationAuthorizationName(locationManager.authorizationStatus),
            "locationAccuracy": locationManager.accuracyAuthorization == .fullAccuracy ? "full" : "reduced",
            "alwaysAuthorized": locationManager.authorizationStatus == .authorizedAlways,
            "backgroundRefreshStatus": backgroundRefreshStatusName(UIApplication.shared.backgroundRefreshStatus),
            "notificationAuthorization": notificationAuthorizationName(notificationStatus),
            "configured": active != nil,
            "monitoring": isMonitoring,
            "pending": pending != nil
        ]

        if let active {
            result["stop"] = activeStopObject(active)
        }
        if let pending {
            result["pendingArrival"] = pendingObject(pending)
        }
        if let lastError = sanitizedText(defaults.string(forKey: lastErrorKey), maximumLength: 500), !lastError.isEmpty {
            result["lastError"] = lastError
        }
        return result
    }

    private func activeStopObject(_ stop: ActiveStop) -> JSObject {
        var result: JSObject = [
            "stopId": stop.stopId,
            "clientName": stop.clientName,
            "address": stop.address,
            "latitude": stop.latitude,
            "longitude": stop.longitude,
            "radiusMeters": stop.radiusMeters,
            "configuredAt": stop.configuredAt
        ]
        if let detectedAt = stop.detectedAt {
            result["detectedAt"] = detectedAt
        }
        if let validUntil = stop.validUntil {
            result["validUntil"] = validUntil
        }
        return result
    }

    private func pendingObject(_ pending: PendingArrival) -> JSObject {
        var result: JSObject = [
            "stopId": pending.stopId,
            "clientName": pending.clientName,
            "address": pending.address,
            "latitude": pending.latitude,
            "longitude": pending.longitude,
            "radiusMeters": pending.radiusMeters,
            "detectedAt": pending.detectedAt
        ]
        if let validUntil = pending.validUntil {
            result["validUntil"] = validUntil
        }
        return result
    }

    private func sanitizedText(_ value: String?, maximumLength: Int) -> String? {
        guard let value else { return nil }
        let withoutControls = value.unicodeScalars.map { scalar -> Character in
            CharacterSet.controlCharacters.contains(scalar) ? " " : Character(String(scalar))
        }
        let collapsed = String(withoutControls)
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        return String(collapsed.prefix(maximumLength))
    }

    private func save<T: Encodable>(_ value: T, forKey key: String) -> Bool {
        do {
            defaults.set(try JSONEncoder().encode(value), forKey: key)
            return true
        } catch {
            saveLastError("Arrival state could not be encoded.")
            return false
        }
    }

    private func loadActiveStop() -> ActiveStop? {
        load(ActiveStop.self, forKey: activeStopKey)
    }

    private func loadPendingArrival() -> PendingArrival? {
        load(PendingArrival.self, forKey: pendingArrivalKey)
    }

    private func load<T: Decodable>(_ type: T.Type, forKey key: String) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func hasPendingArrival(for stopId: String) -> Bool {
        loadPendingArrival()?.stopId == stopId
    }

    private func saveLastError(_ message: String) {
        defaults.set(sanitizedText(message, maximumLength: 500), forKey: lastErrorKey)
    }

    private func rejectConfigure(
        _ call: CAPPluginCall,
        message: String,
        code: String,
        underlyingError: Error? = nil
    ) {
        let diagnostic = underlyingError.map { "\(message) \($0.localizedDescription)" } ?? message
        saveLastError("Arrival configuration: \(diagnostic)")
        call.reject(message, code, underlyingError)
    }

    private func cancelActiveConfigure(reason: String) {
        guard let pendingCall = activeConfigureCall else { return }
        activeConfigureCall = nil
        pendingCall.reject(reason, "configure_cancelled")
    }

    private func parseIsoTimestamp(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    private func isoTimestamp(_ date: Date = Date()) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private func normalizedArrivalExpiry(_ value: String?) -> String {
        if let requested = parseIsoTimestamp(sanitizedText(value, maximumLength: 80)), requested > Date() {
            return isoTimestamp(requested)
        }
        // Backward-compatible default for an older synced web bundle: a monitor is a work-shift
        // aid, never an indefinite background subscription.
        return isoTimestamp(Date().addingTimeInterval(20 * 60 * 60))
    }

    private func arrivalMonitorExpired(_ stop: ActiveStop) -> Bool {
        let expiry = parseIsoTimestamp(stop.validUntil)
            ?? parseIsoTimestamp(stop.configuredAt)?.addingTimeInterval(20 * 60 * 60)
        return expiry.map { $0 <= Date() } ?? true
    }

    private func pruneExpiredArrivalMonitor() {
        guard let stop = loadActiveStop(), stop.detectedAt == nil, arrivalMonitorExpired(stop) else { return }
        for region in locationManager.monitoredRegions where region.identifier == stop.regionIdentifier {
            locationManager.stopMonitoring(for: region)
        }
        skipInitialStateIdentifiers.remove(stop.regionIdentifier)
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [stop.notificationIdentifier])
        center.removeDeliveredNotifications(withIdentifiers: [stop.notificationIdentifier])
        defaults.removeObject(forKey: activeStopKey)
        if loadPendingArrival()?.stopId == stop.stopId {
            defaults.removeObject(forKey: pendingArrivalKey)
        }
    }

    private func locationAuthorizationName(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "prompt"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedWhenInUse: return "whenInUse"
        case .authorizedAlways: return "always"
        @unknown default: return "unknown"
        }
    }

    private func notificationAuthorizationName(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "prompt"
        case .denied: return "denied"
        case .authorized, .provisional, .ephemeral: return "granted"
        @unknown default: return "unknown"
        }
    }

    private func backgroundRefreshStatusName(_ status: UIBackgroundRefreshStatus) -> String {
        switch status {
        case .available: return "available"
        case .denied: return "denied"
        case .restricted: return "restricted"
        @unknown default: return "unknown"
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        DispatchQueue.main.async {
            if manager.authorizationStatus == .authorizedAlways {
                if manager.accuracyAuthorization == .fullAccuracy {
                    self.defaults.removeObject(forKey: self.lastErrorKey)
                    self.ensureMonitoringIfAuthorized()
                } else {
                    self.stopArrivalRegions()
                    self.saveLastError("Precise Location is off. Turn it on in iOS Settings for dependable arrival prompts.")
                }
            }

            guard self.activePermissionCall != nil else { return }
            switch manager.authorizationStatus {
            case .notDetermined:
                return
            case .authorizedWhenInUse where self.permissionRequestStage == 1:
                // iOS requires the initial foreground grant before it can offer an Always
                // upgrade. Keep the same promise open through that second system decision.
                self.permissionRequestStage = 2
                self.schedulePermissionTimeout()
                manager.requestAlwaysAuthorization()
            case .authorizedWhenInUse:
                // If the user keeps When In Use, iOS may not emit another callback because the
                // enum value did not change. The bounded timeout returns that truthful state.
                return
            case .authorizedAlways, .denied, .restricted:
                self.finishPermissionRequest()
            @unknown default:
                self.finishPermissionRequest()
            }
        }
    }

    public func locationManager(_ manager: CLLocationManager, didStartMonitoringFor region: CLRegion) {
        guard region.identifier.hasPrefix(regionPrefix) else { return }
        // A previous Core Location registration failure must not remain visible after iOS
        // confirms that the replacement region is now active.
        defaults.removeObject(forKey: lastErrorKey)
        if skipInitialStateIdentifiers.remove(region.identifier) != nil { return }
        manager.requestState(for: region)
    }

    public func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        guard state == .inside else { return }
        handleArrival(for: region)
    }

    public func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        handleArrival(for: region)
    }

    public func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        guard region == nil || region?.identifier.hasPrefix(regionPrefix) == true else { return }
        saveLastError("Arrival monitoring: \(error.localizedDescription)")
    }
}

//  WidgetData.swift
//  SPSWidgets — the shared payload model + App Group reader.
//  The main app writes one JSON string into the App Group UserDefaults suite; the
//  widget only ever READS this cached snapshot. No Supabase, no secrets, no network.

import Foundation

// All fields optional: the writer omits unknown values (never fakes defaults), so a
// missing key simply means "no data yet" and the view falls back to an empty state.
struct WidgetPayload: Codable {
    var role: String?
    var updatedAt: String?

    // Owner
    var profitWeek: Double?
    var profitMonth: Double?
    var avgEffectiveRate: Double?
    var outstandingTotal: Double?
    var unpaidCount: Int?
    var overdueCount: Int?
    var collectedMonth: Double?

    // Owner · today's route progress
    var stopsTotal: Int?
    var stopsDone: Int?
    var techs: [TechProgress]?

    // Client
    var nextVisitAt: String?
    var nextVisitService: String?
    var nextVisitTech: String?
    var upcoming: [String]?
    var balanceDue: Double?
    var balanceDueDate: String?

    enum CodingKeys: String, CodingKey {
        case role
        case updatedAt        = "updated_at"
        case profitWeek       = "profit_week"
        case profitMonth      = "profit_month"
        case avgEffectiveRate = "avg_effective_rate"
        case outstandingTotal = "outstanding_total"
        case unpaidCount      = "unpaid_count"
        case overdueCount     = "overdue_count"
        case collectedMonth   = "collected_month"
        case stopsTotal       = "stops_total"
        case stopsDone        = "stops_done"
        case techs
        case nextVisitAt      = "next_visit_at"
        case nextVisitService = "next_visit_service"
        case nextVisitTech    = "next_visit_tech"
        case upcoming
        case balanceDue       = "balance_due"
        case balanceDueDate   = "balance_due_date"
    }
}

// One tech's progress for today: name + stops done / total. Keys already match the
// JSON the app writes (name/done/total), so no CodingKeys remapping is needed.
struct TechProgress: Codable, Identifiable {
    var name: String?
    var done: Int?
    var total: Int?
    // Stable identity for ForEach without relying on array index.
    var id: String { (name ?? "tech") + "-\(total ?? 0)" }
}

enum SharedStore {
    // Must match group.com.stonepropertysolutions.app on both targets + the JS bridge.
    static let appGroup = "group.com.stonepropertysolutions.app"
    static let key = "sps_widget_payload"

    static func load() -> WidgetPayload? {
        guard let defaults = UserDefaults(suiteName: appGroup),
              let raw = defaults.string(forKey: key),
              let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(WidgetPayload.self, from: data)
    }
}

// Lenient date parsing — accepts ISO-8601 (with/without fractional seconds),
// plain yyyy-MM-dd, and MM/dd/yyyy (the app's two on-disk formats).
enum SPSDate {
    static func parse(_ s: String?) -> Date? {
        guard let s = s, !s.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: s) { return d }
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        for fmt in ["yyyy-MM-dd", "MM/dd/yyyy"] {
            df.dateFormat = fmt
            if let d = df.date(from: s) { return d }
        }
        return nil
    }

    static func dayLabel(_ d: Date) -> String { fmt(d, "EEE, MMM d") }   // "Sat, Jun 20"
    static func timeLabel(_ d: Date) -> String { fmt(d, "h:mm a") }      // "9:00 AM"
    static func monthAbbrev(_ d: Date) -> String { fmt(d, "MMM").uppercased() }
    static func dayNum(_ d: Date) -> String { fmt(d, "d") }

    private static func fmt(_ d: Date, _ f: String) -> String {
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = f
        return df.string(from: d)
    }
}

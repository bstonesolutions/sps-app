//  OwnerStopsWidget.swift
//  Owner · Today's Stops. How many of today's stops are done (e.g. 2/10), updating
//  as the crew completes them, broken down by the techs working today. Small = a clean
//  progress ring; Medium/Large = the ring plus a per-tech breakdown with mini bars.
//  Source = the Schedule tab's per-tech route progress (assigneeId → team member).

import WidgetKit
import SwiftUI

struct OwnerStopsWidget: Widget {
    let kind = "OwnerStopsWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SPSProvider()) { entry in
            OwnerStopsView(entry: entry)
        }
        .configurationDisplayName("Today's Stops")
        .description("Stops completed today, broken down by tech.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Progress ring (the hero visual)

struct ProgressRing: View {
    @Environment(\.spsFontDesign) var design
    let fraction: Double   // 0…1
    let center: String     // "2/10"
    let sub: String        // "stops"
    var size: CGFloat = 96
    var lineWidth: CGFloat = 11

    var body: some View {
        ZStack {
            Circle().stroke(Brand.hair, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: max(0.0001, min(1, fraction)))
                .stroke(
                    AngularGradient(
                        gradient: Gradient(colors: [Brand.crimson, Brand.crimsonDark, Brand.crimson]),
                        center: .center
                    ),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
            VStack(spacing: 1) {
                Text(center)
                    .font(.system(size: size * 0.30, weight: .heavy, design: design))
                    .foregroundColor(Brand.ink)
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                Text(sub)
                    .font(.system(size: max(11, size * 0.135), weight: .semibold))
                    .foregroundColor(Brand.muted)
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - One tech's progress row (name + done/total + mini bar)

struct TechProgressRow: View {
    @Environment(\.spsFontDesign) var design
    let name: String
    let done: Int
    let total: Int

    private var fraction: Double { total > 0 ? Double(done) / Double(total) : 0 }
    private var complete: Bool { total > 0 && done >= total }

    var body: some View {
        VStack(spacing: 5) {
            HStack(spacing: 6) {
                Text(name)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(Brand.ink)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if complete {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundColor(Brand.crimson)
                }
                Text("\(done)/\(total)")
                    .font(.system(size: 14, weight: .heavy, design: design))
                    .foregroundColor(complete ? Brand.crimson : Brand.slate)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Brand.hair).frame(height: 7)
                    Capsule()
                        .fill(LinearGradient(colors: [Brand.crimson, Brand.crimsonDark],
                                             startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(7, geo.size.width * CGFloat(fraction)), height: 7)
                }
            }
            .frame(height: 7)
        }
    }
}

// MARK: - View

struct OwnerStopsView: View {
    @Environment(\.widgetFamily) var family
    let entry: SPSEntry

    private var p: WidgetPayload? { entry.payload }
    private var fontDesign: Font.Design { sps_design(p?.appFont) }
    private var total: Int { p?.stopsTotal ?? 0 }
    private var done: Int { p?.stopsDone ?? 0 }
    private var techs: [TechProgress] { p?.techs ?? [] }
    private var fraction: Double { total > 0 ? Double(done) / Double(total) : 0 }
    private var remaining: Int { max(0, total - done) }
    private var allDone: Bool { total > 0 && done >= total }
    private var pct: String { "\(Int((fraction * 100).rounded()))%" }
    // We have real data if the app pushed a stop count (even 0 → "No stops today")
    // or any tech rows. nil means "open the app to sync".
    private var synced: Bool { p?.stopsTotal != nil || !techs.isEmpty }
    private var hasStops: Bool { total > 0 || !techs.isEmpty }

    private var statusLine: String {
        if !hasStops { return "No stops today" }
        return allDone ? "All done" : "\(remaining) left"
    }

    var body: some View {
        Group {
            if !synced {
                EmptyWidgetView(icon: "checklist", line1: "Today's Stops", line2: "Open the app to sync")
            } else if !hasStops {
                EmptyWidgetView(icon: "checkmark.seal", line1: "No stops today", line2: "Today's route will appear here")
            } else if family == .systemSmall {
                small
            } else if family == .systemMedium {
                medium
            } else {
                large
            }
        }
        .sps_widgetBackground(Brand.surface)
        .environment(\.spsFontDesign, fontDesign)
        .environment(\.spsLogo, SPSLogo(imageB64: p?.logoImage, mono: p?.logoMono ?? "S"))
        .widgetURL(URL(string: "spsway://schedule"))
    }

    // Small — just the ring + a status line.
    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(title: "TODAY")
            Spacer(minLength: 4)
            ProgressRing(fraction: fraction, center: "\(done)/\(total)", sub: "stops",
                         size: 98, lineWidth: 11)
                .frame(maxWidth: .infinity, alignment: .center)
            Spacer(minLength: 4)
            Text(statusLine)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(allDone ? Brand.crimson : Brand.muted)
                .frame(maxWidth: .infinity, alignment: .center)
                .lineLimit(1)
        }
        .padding(16)
    }

    // Medium — ring on the left, up to 3 techs on the right.
    private var medium: some View {
        HStack(spacing: 16) {
            VStack(spacing: 7) {
                ProgressRing(fraction: fraction, center: "\(done)/\(total)", sub: "stops",
                             size: 104, lineWidth: 12)
                Text(statusLine)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(allDone ? Brand.crimson : Brand.muted)
                    .lineLimit(1)
            }
            .frame(width: 116)

            VStack(alignment: .leading, spacing: 9) {
                Text("BY TECH")
                    .font(.system(size: 12, weight: .bold)).tracking(0.6)
                    .foregroundColor(Brand.muted)
                if techs.isEmpty {
                    Text("Assign today's stops to see each tech's progress.")
                        .font(.system(size: 13))
                        .foregroundColor(Brand.muted)
                } else {
                    ForEach(techs.prefix(3)) { t in
                        TechProgressRow(name: t.name ?? "Tech", done: t.done ?? 0, total: t.total ?? 0)
                    }
                    if techs.count > 3 {
                        Text("+\(techs.count - 3) more")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(Brand.muted)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(16)
    }

    // Large — ring + headline up top, then the full tech list.
    private var large: some View {
        VStack(alignment: .leading, spacing: 14) {
            Header(title: "TODAY'S STOPS")
            HStack(spacing: 18) {
                ProgressRing(fraction: fraction, center: "\(done)/\(total)", sub: "stops",
                             size: 104, lineWidth: 12)
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(done) of \(total)")
                        .font(.system(size: 30, weight: .heavy, design: fontDesign))
                        .foregroundColor(Brand.ink)
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)
                    Text("stops complete")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(Brand.muted)
                    Text(allDone ? "Route finished — nice work" : "\(pct) · \(remaining) remaining")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(allDone ? Brand.crimson : Brand.slate)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }

            Rectangle().fill(Brand.hair).frame(height: 1)

            if techs.isEmpty {
                Text("Assign today's stops to a tech to see each route's progress here.")
                    .font(.system(size: 14))
                    .foregroundColor(Brand.muted)
            } else {
                VStack(spacing: 11) {
                    ForEach(techs.prefix(6)) { t in
                        TechProgressRow(name: t.name ?? "Tech", done: t.done ?? 0, total: t.total ?? 0)
                    }
                    if techs.count > 6 {
                        Text("+\(techs.count - 6) more techs")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(Brand.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(18)
    }
}

//  OwnerOverviewWidget.swift
//  Owner · Business Overview. The whole business at a glance — today's route progress,
//  the money (profit, collected, outstanding), and the book (active clients, jobs, rate).
//  Small = today + profit · Medium = four headline KPIs · Large = the full dashboard.
//  Reuses ProgressRing (from OwnerStopsWidget) and BigStat (Components) — same target.

import WidgetKit
import SwiftUI

struct OwnerOverviewWidget: Widget {
    let kind = "OwnerOverviewWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SPSProvider()) { entry in
            OwnerOverviewView(entry: entry)
        }
        .configurationDisplayName("Business Overview")
        .description("Your whole business at a glance — today, money, and clients.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct OwnerOverviewView: View {
    @Environment(\.widgetFamily) var family
    let entry: SPSEntry

    private var p: WidgetPayload? { entry.payload }
    private var fontDesign: Font.Design { sps_design(p?.appFont) }
    private var stopsTotal: Int { p?.stopsTotal ?? 0 }
    private var stopsDone: Int { p?.stopsDone ?? 0 }
    private var stopFrac: Double { stopsTotal > 0 ? Double(stopsDone) / Double(stopsTotal) : 0 }
    private var overdue: Int { p?.overdueCount ?? 0 }
    private var hasData: Bool {
        p?.profitWeek != nil || p?.outstandingTotal != nil || p?.stopsTotal != nil || p?.activeClients != nil
    }

    private func money(_ v: Double?) -> String { v.map(sps_money) ?? "—" }
    private func intStr(_ v: Int?) -> String { v.map { "\($0)" } ?? "—" }

    var body: some View {
        Group {
            if !hasData {
                EmptyWidgetView(icon: "chart.bar.xaxis", line1: "Business Overview", line2: "Open the app to sync")
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
        .environment(\.spsLogo, SPSLogo(imageB64: p?.logoImage, mono: p?.logoMono ?? "", name: p?.logoName ?? ""))
        .widgetURL(URL(string: "spsway://profit"))
    }

    // Small — today's progress ring + this week's profit.
    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(title: "BUSINESS")
            Spacer(minLength: 6)
            HStack {
                Spacer(minLength: 0)
                ProgressRing(fraction: stopFrac, center: "\(stopsDone)/\(stopsTotal)", sub: "stops", size: 88, lineWidth: 10)
                Spacer(minLength: 0)
            }
            Spacer(minLength: 6)
            VStack(spacing: 1) {
                Text(money(p?.profitWeek))
                    .font(.system(size: 19, weight: .heavy, design: fontDesign))
                    .foregroundColor(Brand.ink)
                    .minimumScaleFactor(0.5).lineLimit(1)
                Text("profit / wk")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Brand.muted)
            }
            .frame(maxWidth: .infinity)
        }
        .padding(16)
    }

    // Medium — four headline KPIs, centered with room to breathe.
    private var medium: some View {
        VStack(spacing: 0) {
            Header(title: "BUSINESS OVERVIEW")
            HStack(spacing: 14) {
                CenterStat(label: "Profit / wk",   value: money(p?.profitWeek), accent: true, size: 32)
                CenterStat(label: "Today's stops", value: "\(stopsDone)/\(stopsTotal)", size: 32)
            }
            .frame(maxHeight: .infinity)
            Rectangle().fill(Brand.hair).frame(height: 1)
            HStack(spacing: 14) {
                CenterStat(label: "Outstanding", value: money(p?.outstandingTotal), accent: overdue > 0, size: 32)
                CenterStat(label: "Collected",   value: money(p?.collectedMonth), size: 32)
            }
            .frame(maxHeight: .infinity)
        }
        .padding(16)
    }

    // Large — today up top, then two clean rows of centered stats with breathing room.
    private var large: some View {
        VStack(spacing: 0) {
            Header(title: "BUSINESS OVERVIEW")
            Spacer(minLength: 14)
            HStack(spacing: 16) {
                ProgressRing(fraction: stopFrac, center: "\(stopsDone)/\(stopsTotal)", sub: "stops", size: 84, lineWidth: 11)
                VStack(alignment: .leading, spacing: 4) {
                    Text("TODAY")
                        .font(.system(size: 12, weight: .bold)).tracking(0.5)
                        .foregroundColor(Brand.muted)
                    Text("\(stopsDone) of \(stopsTotal) stops")
                        .font(.system(size: 24, weight: .heavy, design: fontDesign))
                        .foregroundColor(Brand.ink).minimumScaleFactor(0.5).lineLimit(1)
                    Text(stopsDone >= stopsTotal && stopsTotal > 0 ? "All done" : "\(max(0, stopsTotal - stopsDone)) left")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(Brand.slate).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            Spacer(minLength: 14)
            Rectangle().fill(Brand.hair).frame(height: 1)
            Spacer(minLength: 16)
            HStack(spacing: 12) {
                CenterStat(label: "Profit / wk", value: money(p?.profitWeek), accent: true)
                CenterStat(label: "Profit / mo", value: money(p?.profitMonth))
                CenterStat(label: "Collected",   value: money(p?.collectedMonth))
            }
            Spacer(minLength: 18)
            HStack(spacing: 12) {
                CenterStat(label: "Outstanding", value: money(p?.outstandingTotal), accent: overdue > 0)
                CenterStat(label: "Clients",     value: intStr(p?.activeClients))
                CenterStat(label: "Jobs / mo",   value: intStr(p?.jobsMonth))
            }
            Spacer(minLength: 0)
        }
        .padding(18)
    }
}

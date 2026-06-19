//  OwnerProfitWidget.swift
//  Owner · Profit. Small = this week's profit. Medium = this week, this month,
//  and average effective hourly rate. Source = the app's post-job profitability roll-up.

import WidgetKit
import SwiftUI

struct OwnerProfitWidget: Widget {
    let kind = "OwnerProfitWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SPSProvider()) { entry in
            OwnerProfitView(entry: entry)
        }
        .configurationDisplayName("Profit")
        .description("This week's profit at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct OwnerProfitView: View {
    @Environment(\.widgetFamily) var family
    let entry: SPSEntry

    private var p: WidgetPayload? { entry.payload }
    private var fontDesign: Font.Design { sps_design(p?.appFont) }
    private var hasData: Bool {
        p?.profitWeek != nil || p?.profitMonth != nil || p?.avgEffectiveRate != nil
    }

    var body: some View {
        Group {
            if !hasData {
                EmptyWidgetView(icon: "chart.line.uptrend.xyaxis", line1: "Profit", line2: "Open the app to sync")
            } else if family == .systemSmall {
                small
            } else {
                medium
            }
        }
        .sps_widgetBackground(Brand.surface)
        .environment(\.spsFontDesign, fontDesign)
        .environment(\.spsLogo, SPSLogo(imageB64: p?.logoImage, mono: p?.logoMono ?? "S"))
        .widgetURL(URL(string: "spsway://profit"))
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(title: "THIS WEEK")
            Spacer(minLength: 8)
            VStack(spacing: 4) {
                Text(p?.profitWeek.map(sps_money) ?? "—")
                    .font(.system(size: 40, weight: .heavy, design: fontDesign))
                    .foregroundColor(Brand.ink)
                    .minimumScaleFactor(0.4)
                    .lineLimit(1)
                Text("Profit")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(Brand.slate)
                if let mo = p?.profitMonth {
                    Text("\(sps_money(mo)) / mo")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(Brand.muted)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
            Spacer(minLength: 0)
        }
        .padding(16)
    }

    private var medium: some View {
        VStack(spacing: 0) {
            Header(title: "PROFIT")
            HStack(spacing: 14) {
                CenterStat(label: "This Week",  value: p?.profitWeek.map(sps_money) ?? "—", accent: true, size: 32)
                CenterStat(label: "This Month", value: p?.profitMonth.map(sps_money) ?? "—", size: 32)
            }
            .frame(maxHeight: .infinity)
            Rectangle().fill(Brand.hair).frame(height: 1)
            HStack(spacing: 14) {
                CenterStat(label: "Avg Rate",  value: p?.avgEffectiveRate.map(sps_rate) ?? "—", size: 32)
                CenterStat(label: "Jobs (mo)", value: p?.jobsMonth.map { "\($0)" } ?? "—", size: 32)
            }
            .frame(maxHeight: .infinity)
        }
        .padding(16)
    }
}

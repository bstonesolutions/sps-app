//  OwnerInvoiceWidget.swift
//  Owner · Invoices. Small = outstanding total + unpaid count. Medium = outstanding,
//  unpaid, overdue, and collected this month.

import WidgetKit
import SwiftUI

struct OwnerInvoiceWidget: Widget {
    let kind = "OwnerInvoiceWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SPSProvider()) { entry in
            OwnerInvoiceView(entry: entry)
        }
        .configurationDisplayName("Invoices")
        .description("Outstanding balance and unpaid invoices.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct OwnerInvoiceView: View {
    @Environment(\.widgetFamily) var family
    let entry: SPSEntry

    private var p: WidgetPayload? { entry.payload }
    private var hasData: Bool { p?.outstandingTotal != nil || p?.unpaidCount != nil }

    var body: some View {
        Group {
            if !hasData {
                EmptyWidgetView(icon: "doc.text", line1: "Invoices", line2: "Open the app to sync")
            } else if family == .systemSmall {
                small
            } else {
                medium
            }
        }
        .sps_widgetBackground(Brand.surface)
        .widgetURL(URL(string: "spsway://invoices"))
    }

    private var overdue: Int { p?.overdueCount ?? 0 }

    // Big, screen-filling stat — used so the tile reads at a glance with no dead space.
    private func bigStat(_ label: String, _ value: String, accent: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 28, weight: .heavy, design: .rounded))
                .foregroundColor(accent ? Brand.crimson : Brand.ink)
                .minimumScaleFactor(0.45)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(Brand.muted)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(title: "OUTSTANDING")
            Spacer(minLength: 8)
            Text(p?.outstandingTotal.map(sps_money) ?? "—")
                .font(.system(size: 42, weight: .heavy, design: .rounded))
                .foregroundColor(Brand.crimson)
                .minimumScaleFactor(0.4)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text("\(p?.unpaidCount ?? 0) unpaid\(overdue > 0 ? " · \(overdue) overdue" : "")")
                .font(.system(size: 17, weight: .bold))
                .foregroundColor(overdue > 0 ? Brand.crimson : Brand.slate)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            if let col = p?.collectedMonth {
                Text("Collected \(sps_money(col)) this month")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(Brand.muted)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .padding(.top, 2)
            }
        }
        .padding(16)
    }

    private var medium: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(title: "INVOICES")
            Spacer(minLength: 12)
            HStack(spacing: 0) {
                bigStat("Outstanding", p?.outstandingTotal.map(sps_money) ?? "—", accent: true)
                bigStat("Unpaid",      p?.unpaidCount.map { "\($0)" } ?? "—")
            }
            Spacer(minLength: 12)
            HStack(spacing: 0) {
                bigStat("Overdue",        p?.overdueCount.map { "\($0)" } ?? "—", accent: overdue > 0)
                bigStat("Collected (mo)", p?.collectedMonth.map(sps_money) ?? "—")
            }
            Spacer(minLength: 0)
        }
        .padding(16)
    }
}

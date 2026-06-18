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

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(title: "OUTSTANDING")
            Spacer(minLength: 8)
            VStack(spacing: 4) {
                Text(p?.outstandingTotal.map(sps_money) ?? "—")
                    .font(.system(size: 42, weight: .heavy, design: .rounded))
                    .foregroundColor(Brand.crimson)
                    .minimumScaleFactor(0.4)
                    .lineLimit(1)
                Text("\(p?.unpaidCount ?? 0) unpaid\(overdue > 0 ? " · \(overdue) overdue" : "")")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(overdue > 0 ? Brand.crimson : Brand.slate)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                if let col = p?.collectedMonth {
                    Text("Collected \(sps_money(col)) / mo")
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
            Header(title: "INVOICES")
            Spacer(minLength: 14)
            HStack(spacing: 16) {
                CenterStat(label: "Outstanding", value: p?.outstandingTotal.map(sps_money) ?? "—", accent: true, size: 29)
                CenterStat(label: "Unpaid",      value: p?.unpaidCount.map { "\($0)" } ?? "—", size: 29)
            }
            Spacer(minLength: 16)
            HStack(spacing: 16) {
                CenterStat(label: "Overdue",        value: p?.overdueCount.map { "\($0)" } ?? "—", accent: overdue > 0, size: 29)
                CenterStat(label: "Collected (mo)", value: p?.collectedMonth.map(sps_money) ?? "—", size: 29)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
    }
}

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

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(title: "OUTSTANDING")
            Spacer(minLength: 6)
            Text(p?.outstandingTotal.map(sps_money) ?? "—")
                .font(.system(size: 31, weight: .heavy, design: .rounded))
                .foregroundColor(Brand.crimson)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text("\(p?.unpaidCount ?? 0) unpaid")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(Brand.muted)
            Spacer(minLength: 0)
        }
        .padding(16)
    }

    private var medium: some View {
        VStack(alignment: .leading, spacing: 10) {
            Header(title: "INVOICES")
            Spacer(minLength: 2)
            HStack(spacing: 0) {
                StatColumn(label: "Outstanding", value: p?.outstandingTotal.map(sps_money) ?? "—", accent: true)
                StatColumn(label: "Unpaid",      value: p?.unpaidCount.map { "\($0)" } ?? "—")
            }
            HStack(spacing: 0) {
                StatColumn(label: "Overdue",        value: p?.overdueCount.map { "\($0)" } ?? "—", accent: (p?.overdueCount ?? 0) > 0)
                StatColumn(label: "Collected (mo)", value: p?.collectedMonth.map(sps_money) ?? "—")
            }
            Spacer(minLength: 0)
        }
        .padding(16)
    }
}

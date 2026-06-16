//  ClientBalanceWidget.swift
//  Client · Balance. Small (home screen) + lock-screen accessories. Amount due and
//  next due date; tapping opens the app to the invoices. Lock-screen families need iOS 16.

import WidgetKit
import SwiftUI

struct ClientBalanceWidget: Widget {
    let kind = "ClientBalanceWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SPSProvider()) { entry in
            ClientBalanceView(entry: entry)
        }
        .configurationDisplayName("Balance Due")
        .description("Your current balance and due date.")
        .supportedFamilies(Self.families)
    }

    static var families: [WidgetFamily] {
        if #available(iOS 16.0, *) {
            return [.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline]
        } else {
            return [.systemSmall]
        }
    }
}

struct ClientBalanceView: View {
    @Environment(\.widgetFamily) var family
    let entry: SPSEntry

    private var p: WidgetPayload? { entry.payload }
    private var due: Double? { p?.balanceDue }
    private var dueDate: Date? { SPSDate.parse(p?.balanceDueDate) }
    private var isPaidUp: Bool { (due ?? -1) <= 0 && due != nil }

    var body: some View {
        content.widgetURL(URL(string: "spsway://invoices"))
    }

    @ViewBuilder
    private var content: some View {
        if #available(iOS 16.0, *), family == .accessoryCircular {
            accessoryCircular
        } else if #available(iOS 16.0, *), family == .accessoryRectangular {
            accessoryRectangular
        } else if #available(iOS 16.0, *), family == .accessoryInline {
            Text(inlineText)
        } else {
            small.sps_widgetBackground(Brand.surface)
        }
    }

    // MARK: Home-screen small

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(title: "BALANCE DUE")
            Spacer(minLength: 6)
            if due == nil {
                Text("—")
                    .font(.system(size: 30, weight: .heavy, design: .rounded))
                    .foregroundColor(Brand.ink)
                Text("Open the app to sync")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(Brand.muted)
            } else if isPaidUp {
                Text("Paid up")
                    .font(.system(size: 26, weight: .heavy, design: .rounded))
                    .foregroundColor(Brand.ink)
                Text("Thank you!")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Brand.muted)
            } else {
                Text(sps_money(due!))
                    .font(.system(size: 30, weight: .heavy, design: .rounded))
                    .foregroundColor(Brand.crimson)
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                if let d = dueDate {
                    Text("Due \(SPSDate.dayLabel(d))")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(Brand.muted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
    }

    // MARK: Lock-screen accessories (iOS 16+)

    @available(iOS 16.0, *)
    private var accessoryCircular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "dollarsign.circle.fill").font(.system(size: 12, weight: .semibold))
                Text(due.map(sps_moneyShort) ?? "—")
                    .font(.system(size: 13, weight: .bold))
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
            }
        }
    }

    @available(iOS 16.0, *)
    private var accessoryRectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Balance Due").font(.system(size: 13, weight: .semibold))
            Text(due.map(sps_money) ?? "—").font(.system(size: 20, weight: .heavy, design: .rounded))
            if let d = dueDate {
                Text("Due \(SPSDate.dayLabel(d))").font(.system(size: 12)).foregroundColor(.secondary)
            }
        }
    }

    private var inlineText: String {
        if let d = due {
            return isPaidUp ? "Paid up" : "Balance \(sps_money(d))"
        }
        return "Balance —"
    }
}

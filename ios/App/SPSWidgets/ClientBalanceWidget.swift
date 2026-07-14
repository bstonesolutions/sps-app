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
    private var fontDesign: Font.Design { sps_design(p?.appFont) }
    private var due: Double? { p?.balanceDue }
    private var dueDate: Date? { SPSDate.parse(p?.balanceDueDate) }
    private var isPaidUp: Bool { (due ?? -1) <= 0 && due != nil }

    var body: some View {
        content.environment(\.spsFontDesign, fontDesign).environment(\.spsLogo, SPSLogo(imageB64: p?.logoImage, mono: p?.logoMono ?? "", name: p?.logoName ?? "")).widgetURL(URL(string: "spsway://invoices"))
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
            Spacer(minLength: 8)
            if due == nil {
                Text("—")
                    .font(.system(size: 42, weight: .heavy, design: fontDesign))
                    .foregroundColor(Brand.ink)
                Spacer(minLength: 8)
                Text("Open the app to sync")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(Brand.muted)
            } else if isPaidUp {
                Text("Paid up")
                    .font(.system(size: 36, weight: .heavy, design: fontDesign))
                    .foregroundColor(Brand.ink)
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("Thank you!")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(Brand.muted)
            } else {
                Text(sps_money(due!))
                    .font(.system(size: 42, weight: .heavy, design: fontDesign))
                    .foregroundColor(Brand.crimson)
                    .minimumScaleFactor(0.4)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let d = dueDate {
                    Text("Due \(SPSDate.dayLabel(d))")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(Brand.slate)
                } else {
                    Text("Balance due")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(Brand.muted)
                }
            }
        }
        .padding(16)
    }

    // MARK: Lock-screen accessories (iOS 16+)

    @available(iOS 16.0, *)
    private var accessoryCircular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "dollarsign.circle.fill").font(.system(size: 15, weight: .semibold))
                Text(due.map(sps_moneyShort) ?? "—")
                    .font(.system(size: 16, weight: .bold))
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
            }
        }
    }

    @available(iOS 16.0, *)
    private var accessoryRectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Balance Due").font(.system(size: 16, weight: .semibold))
            Text(due.map(sps_money) ?? "—").font(.system(size: 23, weight: .heavy, design: fontDesign))
            if let d = dueDate {
                Text("Due \(SPSDate.dayLabel(d))").font(.system(size: 15)).foregroundColor(.secondary)
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

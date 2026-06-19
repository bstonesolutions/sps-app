//  ClientScheduleWidget.swift
//  Client · Service Schedule (medium). Next visit date/time, the service or division,
//  the assigned tech, and a hint of the next couple of visits.

import WidgetKit
import SwiftUI

struct ClientScheduleWidget: Widget {
    let kind = "ClientScheduleWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SPSProvider()) { entry in
            ClientScheduleView(entry: entry)
        }
        .configurationDisplayName("Service Schedule")
        .description("Your next service visit.")
        .supportedFamilies([.systemMedium])
    }
}

struct ClientScheduleView: View {
    let entry: SPSEntry

    private var p: WidgetPayload? { entry.payload }
    private var fontDesign: Font.Design { sps_design(p?.appFont) }
    private var nextDate: Date? { SPSDate.parse(p?.nextVisitAt) }
    private var hasData: Bool { nextDate != nil || (p?.nextVisitService?.isEmpty == false) }

    private var thenLine: String? {
        guard let up = p?.upcoming else { return nil }
        let labels = up.dropFirst().prefix(2).compactMap { SPSDate.parse($0).map(SPSDate.dayLabel) }
        return labels.isEmpty ? nil : "Then " + labels.joined(separator: ", ")
    }

    var body: some View {
        Group {
            if !hasData {
                EmptyWidgetView(icon: "calendar", line1: "No visits scheduled", line2: "Your next visit will appear here")
            } else {
                content
            }
        }
        .sps_widgetBackground(Brand.surface)
        .environment(\.spsFontDesign, fontDesign)
        .environment(\.spsLogo, SPSLogo(imageB64: p?.logoImage, mono: p?.logoMono ?? "S"))
        .widgetURL(URL(string: "spsway://schedule"))
    }

    private var content: some View {
        HStack(spacing: 14) {
            VStack(spacing: 0) {
                if let d = nextDate {
                    Text(SPSDate.monthAbbrev(d))
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.white.opacity(0.92))
                    Text(SPSDate.dayNum(d))
                        .font(.system(size: 33, weight: .heavy, design: fontDesign))
                        .foregroundColor(.white)
                } else {
                    Image(systemName: "calendar")
                        .font(.system(size: 27, weight: .semibold))
                        .foregroundColor(.white)
                }
            }
            .frame(width: 88, height: 88)
            .background(
                LinearGradient(colors: [Brand.crimson, Brand.crimsonDark],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            )
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text("NEXT SERVICE")
                    .font(.system(size: 13, weight: .bold)).tracking(0.6)
                    .foregroundColor(Brand.muted)
                Text(p?.nextVisitService ?? "Service Visit")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundColor(Brand.ink)
                    .lineLimit(1)
                if let d = nextDate {
                    Text("\(SPSDate.dayLabel(d)) · \(SPSDate.timeLabel(d))")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(Brand.slate)
                        .lineLimit(1)
                }
                if let tech = p?.nextVisitTech, !tech.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "person.fill")
                            .font(.system(size: 13)).foregroundColor(Brand.muted)
                        Text(tech)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(Brand.slate).lineLimit(1)
                    }
                }
                if let then = thenLine {
                    Text(then)
                        .font(.system(size: 14))
                        .foregroundColor(Brand.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
    }
}

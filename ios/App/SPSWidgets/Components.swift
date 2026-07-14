//  Components.swift
//  SPSWidgets — small shared SwiftUI building blocks (header, stat column, logo,
//  empty state, separator) so every widget reads consistently and on-brand.

import SwiftUI
import WidgetKit

struct LogoMark: View {
    // The real brand logo from the app. A neutral building glyph is used only for malformed legacy
    // payloads that contain neither the logo nor the company name; never invent a letter mark.
    @Environment(\.spsLogo) var logo
    var body: some View {
        if let ui = sps_decodeLogo(logo.imageB64) {
            Image(uiImage: ui)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 22, height: 22)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Brand.crimson)
                .frame(width: 22, height: 22)
                .overlay(
                    Image(systemName: "building.2.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(.white)
                )
        }
    }
}

struct Header: View {
    @Environment(\.spsLogo) var logo
    let title: String
    var body: some View {
        // Logo + title pinned to the top, vertically centered, never wrapping. Each widget insets it
        // from the top edge with its own padding; this row stays consistent.
        //  • A clean logo decodes  → image + the section title.
        //  • No clean logo, a name → the business name owns the row (a "complicated" logo just shows
        //    the name instead of cramming an unreadable image into 22pt).
        //  • No name at all        → a neutral legacy-state glyph + the section title.
        HStack(alignment: .center, spacing: 8) {
            if let ui = sps_decodeLogo(logo.imageB64) {
                Image(uiImage: ui)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 22, height: 22)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                sectionTitle
            } else if !logo.name.isEmpty {
                Text(logo.name)
                    .font(.system(size: 14.5, weight: .heavy))
                    .tracking(0.2)
                    .foregroundColor(Brand.crimson)
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
            } else {
                LogoMark()
                sectionTitle
            }
            Spacer(minLength: 0)
        }
    }

    private var sectionTitle: some View {
        Text(title)
            .font(.system(size: 14.5, weight: .bold))
            .tracking(0.5)
            .foregroundColor(Brand.muted)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
    }
}

struct StatColumn: View {
    @Environment(\.spsFontDesign) var design
    let label: String
    let value: String
    var accent: Bool = false
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 24, weight: .heavy, design: design))
                .foregroundColor(accent ? Brand.crimson : Brand.ink)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(Brand.muted)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct VSeparator: View {
    var body: some View { Rectangle().fill(Brand.hair).frame(width: 1, height: 40) }
}

// Big, screen-filling stat — the shared building block for every stat widget so they all
// read at a glance with no dead space (value on top, label under, crimson accent for the
// figure that matters). Pair with Spacers to distribute and fill the tile vertically.
struct BigStat: View {
    @Environment(\.spsFontDesign) var design
    let label: String
    let value: String
    var accent: Bool = false
    var size: CGFloat = 30
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value)
                .font(.system(size: size, weight: .heavy, design: design))
                .foregroundColor(accent ? Brand.crimson : Brand.ink)
                .minimumScaleFactor(0.45)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(Brand.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// Centered stat — value stacked directly over its label, both centered. Used where a tile
// reads as a tidy grid (Business Overview). Equal-width columns + HStack spacing keep big
// numbers from crowding each other.
struct CenterStat: View {
    @Environment(\.spsFontDesign) var design
    let label: String
    let value: String
    var accent: Bool = false
    var size: CGFloat = 26
    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(size: size, weight: .heavy, design: design))
                .foregroundColor(accent ? Brand.crimson : Brand.ink)
                .minimumScaleFactor(0.4)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(Brand.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
    }
}

struct EmptyWidgetView: View {
    let icon: String
    let line1: String
    let line2: String
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 25, weight: .semibold))
                .foregroundColor(Brand.crimson)
            Text(line1)
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(Brand.ink)
                .multilineTextAlignment(.center)
            Text(line2)
                .font(.system(size: 15))
                .foregroundColor(Brand.muted)
                .multilineTextAlignment(.center)
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

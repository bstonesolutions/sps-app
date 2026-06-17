//  Components.swift
//  SPSWidgets — small shared SwiftUI building blocks (header, stat column, logo,
//  empty state, separator) so every widget reads consistently and on-brand.

import SwiftUI
import WidgetKit

struct LogoMark: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(Brand.crimson)
            .frame(width: 18, height: 18)
            .overlay(
                Text("S")
                    .font(.system(size: 14, weight: .black, design: .rounded))
                    .foregroundColor(.white)
            )
    }
}

struct Header: View {
    let title: String
    var body: some View {
        HStack(spacing: 6) {
            LogoMark()
            Text(title)
                .font(.system(size: 14, weight: .bold))
                .tracking(0.6)
                .foregroundColor(Brand.muted)
            Spacer(minLength: 0)
        }
    }
}

struct StatColumn: View {
    let label: String
    let value: String
    var accent: Bool = false
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 21, weight: .heavy, design: .rounded))
                .foregroundColor(accent ? Brand.crimson : Brand.ink)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 14, weight: .medium))
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
    let label: String
    let value: String
    var accent: Bool = false
    var size: CGFloat = 27
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: size, weight: .heavy, design: .rounded))
                .foregroundColor(accent ? Brand.crimson : Brand.ink)
                .minimumScaleFactor(0.45)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 14, weight: .semibold))
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
    let label: String
    let value: String
    var accent: Bool = false
    var size: CGFloat = 23
    var body: some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.system(size: size, weight: .heavy, design: .rounded))
                .foregroundColor(accent ? Brand.crimson : Brand.ink)
                .minimumScaleFactor(0.4)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 13, weight: .semibold))
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

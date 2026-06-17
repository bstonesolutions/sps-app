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

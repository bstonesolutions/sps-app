//  Theme.swift
//  SPSWidgets — brand palette + shared formatting helpers.
//  On brand: crimson #AF011A, white surface, slate grey secondary text. Apple-sleek.

import SwiftUI
import WidgetKit
import UIKit

enum Brand {
    static let crimson      = Color(red: 0xAF / 255.0, green: 0x01 / 255.0, blue: 0x1A / 255.0) // #AF011A
    static let crimsonDark  = Color(red: 0x7A / 255.0, green: 0x01 / 255.0, blue: 0x12 / 255.0)
    static let ink          = Color(red: 0x1C / 255.0, green: 0x1C / 255.0, blue: 0x1E / 255.0)
    static let slate        = Color(red: 0x55 / 255.0, green: 0x5C / 255.0, blue: 0x66 / 255.0)
    static let muted        = Color(red: 0x8A / 255.0, green: 0x90 / 255.0, blue: 0x99 / 255.0)
    static let hair         = Color(red: 0xEE / 255.0, green: 0xEF / 255.0, blue: 0xF1 / 255.0)
    static let surface      = Color.white
}

// Whole-dollar currency, e.g. "$1,240" — clean for small tiles.
func sps_money(_ v: Double) -> String {
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    f.maximumFractionDigits = 0
    return f.string(from: NSNumber(value: v.rounded())) ?? "$\(Int(v.rounded()))"
}

// Compact currency for tight spaces (lock screen circular), e.g. "$1.2k".
func sps_moneyShort(_ v: Double) -> String {
    let a = abs(v)
    if a >= 1000 { return "$\(String(format: "%.1f", v / 1000))k" }
    return "$\(Int(v.rounded()))"
}

func sps_rate(_ v: Double) -> String { sps_money(v) + "/hr" }

// Map the app's saved font key to a SwiftUI font design, so the widgets always match whatever
// font the user picked in the app's font picker. "rounded" → .rounded; the sharp families
// (system / grotesk / anything else, incl. nil) → .default.
func sps_design(_ font: String?) -> Font.Design {
    (font ?? "rounded") == "rounded" ? .rounded : .default
}

// Carry the chosen design down the view tree so the shared stat components (CenterStat, BigStat,
// StatColumn) match without threading a parameter through every call site.
private struct SPSFontDesignKey: EnvironmentKey {
    static let defaultValue: Font.Design = .rounded
}
extension EnvironmentValues {
    var spsFontDesign: Font.Design {
        get { self[SPSFontDesignKey.self] }
        set { self[SPSFontDesignKey.self] = newValue }
    }
}

// Brand logo for the widget header: the app passes the logo as a base64 data: URL (logo_image), the
// full business name (logo_name), and a single-letter monogram (logo_mono). Header shows the decoded
// image when present; otherwise the business name (a "complicated" logo just falls back to the name);
// the monogram is only the last resort when there's no name either.
struct SPSLogo {
    let imageB64: String?
    let mono: String
    var name: String = ""
}
func sps_decodeLogo(_ s: String?) -> UIImage? {
    guard var str = s, !str.isEmpty else { return nil }
    if str.hasPrefix("data:"), let comma = str.firstIndex(of: ",") { str = String(str[str.index(after: comma)...]) }
    guard let data = Data(base64Encoded: str) else { return nil }
    return UIImage(data: data)
}
private struct SPSLogoKey: EnvironmentKey {
    static let defaultValue = SPSLogo(imageB64: nil, mono: "S")
}
extension EnvironmentValues {
    var spsLogo: SPSLogo {
        get { self[SPSLogoKey.self] }
        set { self[SPSLogoKey.self] = newValue }
    }
}

extension View {
    // iOS 17+ requires containerBackground for widgets; fall back to a plain background below.
    @ViewBuilder
    func sps_widgetBackground(_ color: Color) -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(color, for: .widget)
        } else {
            self.background(color)
        }
    }
}

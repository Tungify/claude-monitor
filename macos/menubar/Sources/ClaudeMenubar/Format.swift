import SwiftUI
import AppKit

// Load → color, mirroring the Go client's loadColor thresholds:
// >=90 red, >=70 orange, <=0 neutral, else green.
func loadColor(_ util: Double) -> Color {
    switch util {
    case let u where u >= 90: return .red
    case let u where u >= 70: return .orange
    case let u where u <= 0: return .secondary
    default: return .green
    }
}

func loadNSColor(_ util: Double) -> NSColor {
    switch util {
    case let u where u >= 90: return .systemRed
    case let u where u >= 70: return .systemOrange
    case let u where u <= 0: return .tertiaryLabelColor
    default: return .systemGreen
    }
}

func pct(_ util: Double) -> String {
    String(format: "%.0f%%", max(0, util))
}

// ago renders a coarse "updated" age: "just now", "42s ago", "3m ago".
func ago(_ date: Date?) -> String {
    guard let date else { return "just now" }
    let d = Date().timeIntervalSince(date)
    switch d {
    case ..<5: return "just now"
    case ..<60: return "\(Int(d))s ago"
    case ..<3600: return "\(Int(d / 60))m ago"
    default: return "\(Int(d / 3600))h ago"
    }
}

// dur renders a coarse, human duration: "in 3d4h", "in 2h13m", "in 5m", "now".
func dur(_ interval: TimeInterval) -> String {
    if interval <= 0 { return "now" }
    let hours = Int(interval / 3600)
    let mins = Int(interval / 60) % 60
    if interval >= 86400 {
        return "in \(Int(interval / 86400))d\(hours % 24)h"
    }
    if interval >= 3600 {
        return "in \(hours)h\(mins)m"
    }
    return "in \(mins)m"
}

func resetsIn(_ date: Date?) -> String {
    guard let date else { return "" }
    return dur(date.timeIntervalSinceNow)
}

func expiry(_ date: Date?) -> String {
    guard let date else { return "" }
    let d = date.timeIntervalSinceNow
    return d <= 0 ? "expired" : "expires " + dur(d)
}

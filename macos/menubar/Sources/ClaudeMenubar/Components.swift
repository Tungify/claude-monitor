import SwiftUI

// SectionHeader is the dim, uppercase group label ("CLAUDE", "OPENAI · CODEX").
struct SectionHeader: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 10)
            .padding(.top, 4)
            .padding(.bottom, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// StatusMark is the leading dot: a green check for the active account, else a
// small load-colored dot.
struct StatusMark: View {
    let active: Bool
    let util: Double

    var body: some View {
        if active {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(.green)
        } else {
            Circle()
                .fill(loadColor(util))
                .frame(width: 8, height: 8)
        }
    }
}

// Badge is a small pill ("READY", "PRO").
struct Badge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.15)))
    }
}

// UsageBar is one labeled progress row: "5h ▓▓▓▓░░ 68%".
struct UsageBar: View {
    let label: String
    let window: Window

    var body: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .frame(width: 15, alignment: .leading)
            ProgressCapsule(value: window.utilization / 100, color: loadColor(window.utilization))
            Text(pct(window.utilization))
                .font(.system(size: 10, weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(loadColor(window.utilization))
                .frame(width: 36, alignment: .trailing)
        }
        .frame(maxWidth: .infinity)
        .help(window.resetsAt != nil ? "resets \(resetsIn(window.resetsAt))" : "")
    }
}

// ProgressCapsule is a slim rounded track + fill — the native-feeling bar.
struct ProgressCapsule: View {
    let value: Double
    let color: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.12))
                Capsule()
                    .fill(color)
                    .frame(width: max(0, min(1, value)) * geo.size.width)
            }
        }
        .frame(height: 5)
    }
}

// ContentHeightKey reports the account list's natural height so the enclosing
// ScrollView can size to its content (up to a cap) instead of collapsing to
// ~0 inside the fit-to-content MenuBarExtra window.
struct ContentHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// RowButtonStyle gives account/action rows the Control-Center feel: padded,
// full-width, with a rounded hover/press highlight. Disabled rows (the
// already-active account) don't highlight.
struct RowButtonStyle: ButtonStyle {
    var enabled: Bool = true

    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, enabled: enabled)
    }

    private struct RowBody: View {
        let configuration: Configuration
        let enabled: Bool
        @State private var hovering = false

        var body: some View {
            let highlight = enabled ? (configuration.isPressed ? 0.12 : (hovering ? 0.07 : 0)) : 0
            configuration.label
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(highlight)))
                .contentShape(RoundedRectangle(cornerRadius: 8))
                .onHover { hovering = $0 }
        }
    }
}

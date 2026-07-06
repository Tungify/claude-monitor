import SwiftUI

// PanelView is the Control-Center-style dropdown: a fixed-width column with
// a header, a scrollable account list, controls, and a footer. MenuBarExtra
// with .menuBarExtraStyle(.window) gives it the rounded, translucent panel
// chrome for free.
struct PanelView: View {
    @EnvironmentObject var state: AppState
    @State private var listHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HeaderView()

            Divider().padding(.vertical, 6)

            if let snap = state.snapshot {
                // Size the scroll area to its content, capped at 440pt. A bare
                // ScrollView collapses to ~0 height inside the fit-to-content
                // MenuBarExtra window — that's why the account list went
                // missing — so we measure the content and set a definite height.
                ScrollView {
                    AccountsView(snap: snap)
                        .background(GeometryReader { geo in
                            Color.clear.preference(key: ContentHeightKey.self, value: geo.size.height)
                        })
                }
                .frame(height: min(max(listHeight, 1), 440))
                .scrollBounceBehavior(.basedOnSize)
                .onPreferenceChange(ContentHeightKey.self) { listHeight = $0 }
            } else {
                LoadingView(connected: state.connected)
            }

            if let err = state.lastError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .lineLimit(2)
                    .padding(.horizontal, 10)
                    .padding(.top, 6)
            }

            Divider().padding(.vertical, 6)

            ControlsView()

            Divider().padding(.vertical, 6)

            FooterView()
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 10)
        .frame(width: 320)
    }
}

struct HeaderView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Claude Monitor")
                .font(.system(size: 15, weight: .bold))
            Text(subtitle)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var subtitle: String {
        guard let snap = state.snapshot else {
            return state.connected ? "Waiting for the first snapshot…" : "Starting Claude Monitor…"
        }
        if let a = snap.activeAnthropic {
            if let fh = a.fiveHour { return "\(a.name)  ·  5h \(pct(fh.utilization))" }
            return a.name
        }
        if let a = snap.activeCodex { return "\(a.name)  ·  Codex" }
        return "No active account"
    }
}

struct AccountsView: View {
    @EnvironmentObject var state: AppState
    let snap: Snapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            let claude = snap.claude
            let codex = snap.codex

            if !claude.isEmpty {
                SectionHeader("Claude")
                ForEach(claude) { a in
                    ClaudeRow(account: a, recommended: a.configDir == snap.recommendedDir)
                }
            }

            if !codex.isEmpty {
                SectionHeader("OpenAI · Codex").padding(.top, 6)
                ForEach(codex) { a in
                    CodexRow(account: a)
                }
            }

            if claude.isEmpty && codex.isEmpty {
                Text("No accounts found")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                    .padding(10)
            }
        }
    }
}

struct ClaudeRow: View {
    @EnvironmentObject var state: AppState
    let account: Account
    let recommended: Bool

    var body: some View {
        Button {
            state.swap(to: account)
        } label: {
            HStack(alignment: .top, spacing: 9) {
                StatusMark(active: account.active, util: account.fiveHour?.utilization ?? -1)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(account.name)
                            .font(.system(size: 13, weight: .medium))
                        if recommended { Badge(text: "READY", color: .green) }
                        Spacer(minLength: 4)
                        if !account.email.isEmpty {
                            Text(account.email)
                                .font(.system(size: 11))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }

                    if !account.error.isEmpty {
                        Label(truncate(account.error, 48), systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.red)
                            .lineLimit(1)
                    } else if account.fiveHour == nil && account.weekly == nil {
                        Text("no usage data")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                    } else {
                        // 5h + weekly share one row to keep each account compact.
                        HStack(spacing: 14) {
                            if let w = account.fiveHour { UsageBar(label: "5h", window: w) }
                            if let w = account.weekly { UsageBar(label: "wk", window: w) }
                        }
                    }
                }
            }
        }
        .buttonStyle(RowButtonStyle(enabled: !account.active))
    }
}

struct CodexRow: View {
    @EnvironmentObject var state: AppState
    let account: Account

    var body: some View {
        Button {
            state.swap(to: account)
        } label: {
            HStack(alignment: .top, spacing: 9) {
                StatusMark(active: account.active, util: -1)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(account.name)
                            .font(.system(size: 13, weight: .medium))
                        Spacer(minLength: 4)
                        if !account.email.isEmpty {
                            Text(account.email)
                                .font(.system(size: 11))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }

                    if !account.error.isEmpty {
                        Label(truncate(account.error, 48), systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.red)
                            .lineLimit(1)
                    } else {
                        HStack(spacing: 6) {
                            if !account.planType.isEmpty {
                                Badge(text: account.planType.uppercased(), color: .teal)
                            }
                            if let exp = account.tokenExpiresAt {
                                Text("token " + expiry(exp))
                                    .font(.system(size: 11))
                                    .foregroundStyle(exp.timeIntervalSinceNow < 3600 ? .orange : .secondary)
                            } else {
                                Text("signed in")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
        }
        .buttonStyle(RowButtonStyle(enabled: !account.active))
    }
}

struct ControlsView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if state.haveConfig {
                // HStack + Spacer + labelsHidden pins the switch to the right
                // edge (aligned with the usage column); a plain Toggle floats
                // its switch mid-row instead of filling the width.
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Auto-swap").font(.system(size: 13))
                        Text("Switch accounts before a limit is hit")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 8)
                    Toggle("", isOn: Binding(
                        get: { state.autoSwap },
                        set: { _ in state.toggleAutoSwap() }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            }

            Button {
                state.openDashboard()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "safari")
                    Text("Open Dashboard…").font(.system(size: 13))
                    Spacer()
                }
            }
            .buttonStyle(RowButtonStyle())
        }
    }
}

struct FooterView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Toggle("Open at Login", isOn: Binding(
                    get: { LoginItem.isEnabled },
                    set: { LoginItem.set($0) }
                ))
                .toggleStyle(.switch)
                .font(.system(size: 12))
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .font(.system(size: 12))
            }
            .padding(.horizontal, 10)

            HStack {
                Text(state.snapshot != nil ? "Updated \(ago(state.snapshot?.fetchedAt))" : "")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                Spacer()
            }
            .padding(.horizontal, 10)
        }
    }
}

struct LoadingView: View {
    let connected: Bool

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(connected ? "Waiting for the first snapshot…" : "Starting Claude Monitor…")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private func truncate(_ s: String, _ n: Int) -> String {
    s.count <= n ? s : String(s.prefix(n - 1)) + "…"
}

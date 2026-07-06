import SwiftUI
import AppKit

// AppState is the single source of truth the panel renders from. The poll
// loop writes it; SwiftUI views observe it. Everything is @MainActor so
// @Published mutations always land on the main thread.
@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    @Published var snapshot: Snapshot?
    @Published var autoSwap = false
    @Published var haveConfig = false
    @Published var connected = false
    @Published var lastError: String?

    let config: Config
    private let client: DaemonClient
    private let supervisor = DaemonSupervisor()
    private var started = false
    private var lastSpawn = Date.distantPast

    private init() {
        config = Config.fromEnvironment()
        client = DaemonClient(addr: config.daemonAddr)
    }

    func start() {
        guard !started else { return }
        started = true
        Task { await pollLoop() }
    }

    func shutdown() {
        supervisor.stop()
    }

    // pollLoop mirrors the Go client's run(): refresh the auto-swap config,
    // fetch the snapshot, and start a daemon if none is answering.
    private func pollLoop() async {
        while true {
            if let v = await client.getAutoSwap() {
                autoSwap = v
                haveConfig = true
            }

            let (snap, code, _) = await client.fetchAccounts()
            if let snap {
                snapshot = snap
                connected = true
                lastError = nil
            } else if code == 503 {
                // Daemon is up but hasn't produced its first snapshot yet.
                connected = true
            } else {
                connected = false
                if !config.noSpawn, Date().timeIntervalSince(lastSpawn) > 20, await !client.health() {
                    supervisor.spawn(config: config)
                    lastSpawn = Date()
                }
            }

            try? await Task.sleep(nanoseconds: UInt64(config.pollInterval * 1_000_000_000))
        }
    }

    // refreshNow does a single out-of-band poll — used right after a swap so
    // the new active account shows without waiting for the next tick.
    private func refreshNow() async {
        let (snap, _, _) = await client.fetchAccounts()
        if let snap {
            snapshot = snap
            connected = true
        }
    }

    func swap(to account: Account) {
        guard !account.active else { return }
        let dir = account.configDir
        let name = account.name
        Task {
            do {
                try await client.swapTo(dir)
                await refreshNow()
            } catch {
                lastError = "Couldn't switch to \(name): \(error.localizedDescription)"
            }
        }
    }

    func toggleAutoSwap() {
        guard haveConfig else { return }
        let target = !autoSwap
        Task {
            do {
                try await client.setAutoSwap(target)
                autoSwap = target
            } catch {
                lastError = "Couldn't change auto-swap: \(error.localizedDescription)"
            }
        }
    }

    func openDashboard() {
        NSWorkspace.shared.open(config.webURL)
    }

    // MARK: - Menu-bar title

    // barImage renders the status-item title to an NSImage so it can carry
    // color (a plain SwiftUI Text label in the bar would be monochrome). The
    // App body recomputes this whenever @Published state changes.
    var barImage: NSImage {
        makeBarImage(barAttributed())
    }

    private func barAttributed() -> NSAttributedString {
        let dotFont = NSFont.systemFont(ofSize: 12)
        let textFont = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)

        guard let snap = snapshot else {
            let glyph = connected ? "○" : "◌"
            return NSAttributedString(string: glyph, attributes: [
                .foregroundColor: NSColor.tertiaryLabelColor, .font: dotFont,
            ])
        }
        if let a = snap.activeAnthropic, let fh = a.fiveHour {
            let s = NSMutableAttributedString(string: "● ", attributes: [
                .foregroundColor: loadNSColor(fh.utilization), .font: dotFont,
            ])
            s.append(NSAttributedString(string: pct(fh.utilization), attributes: [
                .foregroundColor: NSColor.labelColor, .font: textFont,
            ]))
            return s
        }
        if let a = snap.activeCodex {
            let label = a.planType.isEmpty ? "codex" : a.planType.capitalized
            let s = NSMutableAttributedString(string: "◆ ", attributes: [
                .foregroundColor: NSColor.systemTeal, .font: dotFont,
            ])
            s.append(NSAttributedString(string: label, attributes: [
                .foregroundColor: NSColor.labelColor, .font: dotFont,
            ]))
            return s
        }
        return NSAttributedString(string: "○", attributes: [
            .foregroundColor: NSColor.secondaryLabelColor, .font: dotFont,
        ])
    }

    private func makeBarImage(_ s: NSAttributedString) -> NSImage {
        let size = s.size()
        let width = max(ceil(size.width), 8)
        let height = max(ceil(size.height), 16)
        let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { _ in
            s.draw(at: .zero)
            return true
        }
        image.isTemplate = false
        return image
    }
}

import SwiftUI
import AppKit

@main
struct ClaudeMenubarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state = AppState.shared

    var body: some Scene {
        MenuBarExtra {
            PanelView()
                .environmentObject(state)
        } label: {
            // .renderingMode(.original) keeps the colored dot from being
            // flattened to a template (monochrome) image in the menu bar.
            Image(nsImage: state.barImage)
                .renderingMode(.original)
        }
        .menuBarExtraStyle(.window)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Headless panel-to-PNG render mode (CLAUDE_MENUBAR_SNAPSHOT); no-op
        // in normal use. Render and exit before touching the daemon/UI.
        if PanelSnapshotRenderer.maybeRender() {
            exit(0)
        }
        // Debug: show the panel in a real window and keep running (for a
        // faithful screenshot). No-op in normal use.
        if PanelSnapshotRenderer.maybeShowWindow() {
            return
        }

        // Agent app — no Dock icon, no menu bar of its own. The Info.plist
        // sets LSUIElement too; this is belt-and-suspenders.
        NSApp.setActivationPolicy(.accessory)

        AppState.shared.start()

        // Backstop for non-menu exit paths (e.g. `kill`): stop a daemon we
        // spawned so it isn't orphaned. The Quit button goes through
        // applicationWillTerminate instead.
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler {
                AppState.shared.shutdown()
                exit(0)
            }
            src.resume()
            signalSources.append(src)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppState.shared.shutdown()
    }
}

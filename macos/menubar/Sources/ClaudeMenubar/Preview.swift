import SwiftUI
import AppKit

// PanelSnapshotRenderer renders the panel to a PNG and exits — a headless
// way to eyeball the layout without clicking the status item (SwiftUI's
// #Preview isn't available for a SwiftPM executable). Gated behind
// CLAUDE_MENUBAR_SNAPSHOT=<path>; inert in normal use. Doubles as a decode
// smoke test: the sample data goes through the real JSON path.
@MainActor
enum PanelSnapshotRenderer {
    static func maybeRender() -> Bool {
        guard let path = ProcessInfo.processInfo.environment["CLAUDE_MENUBAR_SNAPSHOT"] else {
            return false
        }

        let state = AppState.shared
        state.snapshot = sampleSnapshot()
        state.haveConfig = true
        state.autoSwap = true
        state.connected = true

        let view = PanelView()
            .environmentObject(state)
            .background(Color(nsColor: .windowBackgroundColor))

        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        if let nsImage = renderer.nsImage,
           let tiff = nsImage.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
            NSLog("claude-menubar: wrote panel snapshot to \(path)")
        } else {
            NSLog("claude-menubar: panel snapshot render failed")
        }
        return true
    }

    // maybeShowWindow shows the panel in a real NSWindow — its true SwiftUI
    // layout, unlike ImageRenderer (which hid the ScrollView-collapse bug).
    // Gated behind CLAUDE_MENUBAR_PANEL_WINDOW; logs the window id so it can
    // be screenshotted with `screencapture -l<id>`.
    static func maybeShowWindow() -> Bool {
        guard ProcessInfo.processInfo.environment["CLAUDE_MENUBAR_PANEL_WINDOW"] != nil else {
            return false
        }

        let state = AppState.shared
        state.snapshot = sampleSnapshot()
        state.haveConfig = true
        state.autoSwap = true
        state.connected = true

        let frame = NSRect(x: 120, y: 120, width: 320, height: 720)
        let win = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        let effect = NSVisualEffectView(frame: NSRect(origin: .zero, size: frame.size))
        effect.material = .menu
        effect.state = .active
        effect.blendingMode = .behindWindow
        effect.autoresizingMask = [.width, .height]
        let host = NSHostingView(rootView:
            PanelView()
                .environmentObject(state)
                .frame(maxHeight: .infinity, alignment: .top)
        )
        host.frame = effect.bounds
        host.autoresizingMask = [.width, .height]
        effect.addSubview(host)
        win.contentView = effect
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = true
        win.level = .floating
        win.makeKeyAndOrderFront(nil)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NSLog("PANEL_WINDOW_ID=\(win.windowNumber) SIZE=\(Int(frame.width))x\(Int(frame.height))")
        return true
    }

    private static func sampleSnapshot() -> Snapshot? {
        let f = ISO8601DateFormatter()
        func rel(_ seconds: TimeInterval) -> String { f.string(from: Date().addingTimeInterval(seconds)) }

        let json = """
        {
          "active_dir": "/Users/x/.claude-main",
          "codex_active_dir": "/Users/x/.codex-free",
          "fetched_at": "\(rel(-3))",
          "accounts": [
            {
              "name": "tung-main", "config_dir": "/Users/x/.claude-main",
              "email": "tung@main.dev", "active": true,
              "five_hour": { "utilization": 68, "resets_at": "\(rel(2*3600))" },
              "weekly":    { "utilization": 31, "resets_at": "\(rel(4*86400))" }
            },
            {
              "name": "tung-work", "config_dir": "/Users/x/.claude-work",
              "email": "tung@work.dev", "active": false,
              "five_hour": { "utilization": 12, "resets_at": "\(rel(3600))" },
              "weekly":    { "utilization": 20, "resets_at": "\(rel(5*86400))" }
            },
            {
              "name": "tung-heavy", "config_dir": "/Users/x/.claude-heavy",
              "email": "tung@heavy.dev", "active": false,
              "five_hour": { "utilization": 94, "resets_at": "\(rel(1800))" },
              "weekly":    { "utilization": 78, "resets_at": "\(rel(2*86400))" }
            },
            {
              "name": "tung-old", "config_dir": "/Users/x/.claude-old",
              "email": "tung@old.dev", "active": false,
              "error": "token expired; run claude to re-login"
            },
            {
              "name": "codex-pro", "config_dir": "/Users/x/.codex-pro",
              "provider": "openai", "email": "tung@openai.dev", "active": false,
              "plan_type": "pro", "token_expires_at": "\(rel(40*60))"
            },
            {
              "name": "codex-free", "config_dir": "/Users/x/.codex-free",
              "provider": "openai", "active": true,
              "plan_type": "free", "token_expires_at": "\(rel(6*3600))"
            }
          ]
        }
        """
        return try? JSONDecoder().decode(Snapshot.self, from: Data(json.utf8))
    }
}

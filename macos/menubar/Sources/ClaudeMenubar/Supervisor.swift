import Foundation
import ServiceManagement

// Config is resolved once at launch from the environment. Launched as a
// bundled .app there are no CLI flags, so overrides come via env vars — set
// them in the app's launchd plist or a wrapper if you need non-defaults.
struct Config {
    var daemonAddr: String
    var webURL: URL
    var monitorBin: String?
    var noSpawn: Bool
    var pollInterval: Double

    static func fromEnvironment() -> Config {
        let env = ProcessInfo.processInfo.environment
        let addr = env["CLAUDE_MONITOR_DAEMON_ADDR"] ?? "127.0.0.1:8788"
        let port = env["CLAUDE_MONITOR_WEB_PORT"] ?? "3737"
        let webURL = URL(string: "http://localhost:\(port)/") ?? URL(string: "http://localhost:3737/")!
        return Config(
            daemonAddr: addr,
            webURL: webURL,
            monitorBin: env["CLAUDE_MONITOR_BIN"],
            noSpawn: env["CLAUDE_MONITOR_NO_SPAWN"] != nil,
            pollInterval: 5
        )
    }
}

// DaemonSupervisor starts the daemon in daemon-only mode (`--serve`) when
// none is answering, and stops the one it started on quit — a daemon we
// spawned shouldn't outlive the app that depends on it. A pre-existing
// daemon is never touched.
final class DaemonSupervisor {
    private var process: Process?

    func spawn(config: Config) {
        guard let bin = resolveMonitorBin(explicit: config.monitorBin) else {
            NSLog("claude-menubar: claude-monitor binary not found (set CLAUDE_MONITOR_BIN)")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = ["--serve", config.daemonAddr]
        if let fh = logHandle() {
            p.standardOutput = fh
            p.standardError = fh
        }
        do {
            try p.run()
            process = p
        } catch {
            NSLog("claude-menubar: could not start daemon: \(error.localizedDescription)")
        }
    }

    func stop() {
        process?.terminate()
        process = nil
    }

    // resolveMonitorBin finds the claude-monitor binary: an explicit path,
    // then a sibling of this executable (as bundled inside the .app), then
    // $PATH.
    private func resolveMonitorBin(explicit: String?) -> String? {
        let fm = FileManager.default
        if let explicit, !explicit.isEmpty {
            if fm.isExecutableFile(atPath: explicit) { return explicit }
        }
        if let exe = Bundle.main.executableURL {
            let sibling = exe.deletingLastPathComponent().appendingPathComponent("claude-monitor").path
            if fm.isExecutableFile(atPath: sibling) { return sibling }
        }
        for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":") {
            let candidate = String(dir) + "/claude-monitor"
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    private func logHandle() -> FileHandle? {
        let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("claude-monitor-daemon.log")
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        guard let fh = FileHandle(forWritingAtPath: path) else { return nil }
        fh.seekToEndOfFile()
        return fh
    }
}

// LoginItem toggles "Open at Login" via the modern ServiceManagement API.
// Best-effort: registration can fail for an unsigned/relocated bundle, so
// errors are logged rather than surfaced.
enum LoginItem {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static func set(_ on: Bool) {
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSLog("claude-menubar: login item toggle failed: \(error.localizedDescription)")
        }
    }
}

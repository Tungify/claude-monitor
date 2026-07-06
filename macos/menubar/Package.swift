// swift-tools-version:5.9
import PackageDescription

// claude-menubar — the macOS menu-bar companion for claude-monitor.
//
// A thin SwiftUI client of the local daemon (default 127.0.0.1:8788). It
// polls account snapshots over HTTP, renders them in a native Control-
// Center-style panel (MenuBarExtra + .menuBarExtraStyle(.window)), and
// swaps accounts via POST /api/swap-to. The daemon owns every credential/
// keychain operation; this process only speaks the daemon's HTTP API.
//
// The executable is wrapped into "bin/Claude Monitor.app" by the repo
// Makefile (`make menubar`), which also drops the Go `claude-monitor`
// daemon binary alongside it so the app can start one on demand.
let package = Package(
    name: "claude-menubar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "claude-menubar", targets: ["ClaudeMenubar"]),
    ],
    targets: [
        .executableTarget(
            name: "ClaudeMenubar",
            path: "Sources/ClaudeMenubar"
        ),
    ]
)

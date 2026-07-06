import Foundation

enum DaemonError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self {
        case .message(let m): return m
        }
    }
}

// DaemonClient speaks the daemon's loopback HTTP API. We poll /api/accounts
// rather than streaming /api/events: the snapshot is cached daemon-side,
// polling is immune to SSE buffering a fronting proxy/tunnel can add, and it
// removes a whole class of stuck-stream failure modes.
struct DaemonClient {
    let base: String
    private let session: URLSession

    init(addr: String) {
        base = "http://\(addr)"
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 5
        cfg.timeoutIntervalForResource = 5
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg)
    }

    private func url(_ path: String) -> URL { URL(string: base + path)! }

    // fetchAccounts GETs the daemon's cached snapshot. Returns (snap, 200)
    // on success, (nil, 503) when the daemon is up but has no snapshot yet,
    // or (nil, code, err) on a transport or other error.
    func fetchAccounts() async -> (Snapshot?, Int, Error?) {
        do {
            let (data, resp) = try await session.data(from: url("/api/accounts"))
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 503 { return (nil, 503, nil) }
            guard code == 200 else { return (nil, code, DaemonError.message("accounts: \(code)")) }
            let snap = try JSONDecoder().decode(Snapshot.self, from: data)
            return (snap, 200, nil)
        } catch {
            return (nil, 0, error)
        }
    }

    func swapTo(_ ident: String) async throws {
        var req = URLRequest(url: url("/api/swap-to"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["ident": ident])
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code != 200 {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let e = obj["error"] as? String, !e.isEmpty {
                throw DaemonError.message(e)
            }
            throw DaemonError.message("swap-to: \(code)")
        }
    }

    func getAutoSwap() async -> Bool? {
        guard let (data, resp) = try? await session.data(from: url("/api/swap-config")),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj["auto_swap"] as? Bool
    }

    func setAutoSwap(_ value: Bool) async throws {
        var req = URLRequest(url: url("/api/swap-config"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["auto_swap": value])
        let (_, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code != 200 { throw DaemonError.message("swap-config: \(code)") }
    }

    func health() async -> Bool {
        guard let (_, resp) = try? await session.data(from: url("/api/health")) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }
}

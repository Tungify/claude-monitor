import Foundation

// Wire types — a deliberately minimal mirror of the daemon's JSON shape
// (internal/server.Snapshot). Dates are decoded as strings and parsed
// leniently so a zero/omitted timestamp never fails the whole decode.

// Two formatters: Go marshals time.Time as RFC3339 with nanoseconds, but a
// value without a fractional part is also valid, so we try both.
private let isoWithFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private let isoPlain: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func parseDaemonDate(_ s: String?) -> Date? {
    guard let s, !s.isEmpty else { return nil }
    return isoWithFraction.date(from: s) ?? isoPlain.date(from: s)
}

struct Window: Decodable {
    var utilization: Double
    var resetsAt: Date?

    enum CodingKeys: String, CodingKey {
        case utilization
        case resetsAt = "resets_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        utilization = try c.decodeIfPresent(Double.self, forKey: .utilization) ?? 0
        resetsAt = parseDaemonDate(try c.decodeIfPresent(String.self, forKey: .resetsAt))
    }
}

struct Account: Decodable, Identifiable {
    var name: String
    var configDir: String
    var email: String
    var provider: String
    var active: Bool
    var fiveHour: Window?
    var weekly: Window?
    var weeklySonnet: Window?
    var weeklyOpus: Window?
    var planType: String
    var tokenExpiresAt: Date?
    var error: String

    var id: String { configDir }
    var isOpenAI: Bool { provider == "openai" }

    enum CodingKeys: String, CodingKey {
        case name, provider, active, email, error, weekly
        case configDir = "config_dir"
        case fiveHour = "five_hour"
        case weeklySonnet = "weekly_sonnet"
        case weeklyOpus = "weekly_opus"
        case planType = "plan_type"
        case tokenExpiresAt = "token_expires_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        configDir = try c.decodeIfPresent(String.self, forKey: .configDir) ?? ""
        email = try c.decodeIfPresent(String.self, forKey: .email) ?? ""
        provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? ""
        active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
        fiveHour = try c.decodeIfPresent(Window.self, forKey: .fiveHour)
        weekly = try c.decodeIfPresent(Window.self, forKey: .weekly)
        weeklySonnet = try c.decodeIfPresent(Window.self, forKey: .weeklySonnet)
        weeklyOpus = try c.decodeIfPresent(Window.self, forKey: .weeklyOpus)
        planType = try c.decodeIfPresent(String.self, forKey: .planType) ?? ""
        tokenExpiresAt = parseDaemonDate(try c.decodeIfPresent(String.self, forKey: .tokenExpiresAt))
        error = try c.decodeIfPresent(String.self, forKey: .error) ?? ""
    }
}

struct Snapshot: Decodable {
    var accounts: [Account]
    var activeDir: String
    var codexActiveDir: String
    var fetchedAt: Date?

    enum CodingKeys: String, CodingKey {
        case accounts
        case activeDir = "active_dir"
        case codexActiveDir = "codex_active_dir"
        case fetchedAt = "fetched_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accounts = try c.decodeIfPresent([Account].self, forKey: .accounts) ?? []
        activeDir = try c.decodeIfPresent(String.self, forKey: .activeDir) ?? ""
        codexActiveDir = try c.decodeIfPresent(String.self, forKey: .codexActiveDir) ?? ""
        fetchedAt = parseDaemonDate(try c.decodeIfPresent(String.self, forKey: .fetchedAt))
    }
}

// Derived views over a snapshot, mirroring the Go client's helpers.
extension Snapshot {
    var claude: [Account] { accounts.filter { !$0.isOpenAI } }
    var codex: [Account] { accounts.filter { $0.isOpenAI } }
    var activeAnthropic: Account? { accounts.first { !$0.isOpenAI && $0.active } }
    var activeCodex: Account? { accounts.first { $0.isOpenAI && $0.active } }

    // recommendedDir: the config dir of the least-loaded, non-active,
    // healthy Anthropic account worth switching to — or nil if none has
    // real headroom (matches the Go client's 80% threshold).
    var recommendedDir: String? {
        var best: String?
        var bestUtil = 80.0
        for a in claude where !a.active && a.error.isEmpty {
            if let u = a.fiveHour?.utilization, u < bestUtil {
                best = a.configDir
                bestUtil = u
            }
        }
        return best
    }
}

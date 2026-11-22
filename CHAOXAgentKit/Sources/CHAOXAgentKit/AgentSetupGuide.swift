import Foundation

public enum AgentSetupGuide {
    public static let repositoryURL = "https://github.com/gh-csteix/chaox-agent"

    public static func prompt(for app: AgentAppID, locale: Locale = .current) -> String {
        let language = Self.preferredResourceLanguage(for: locale)
        let template = Self.loadTemplate(language: language)
        return template.replacingOccurrences(of: "{APP_NAME}", with: Self.displayName(for: app))
    }

    private static func displayName(for app: AgentAppID) -> String {
        switch app {
        case .sx:
            "SX (Spending X)"
        case .bx:
            "BX (Body X)"
        case .csteix:
            "CSTEIX"
        case .gx:
            "GX"
        }
    }

    private static func preferredResourceLanguage(for locale: Locale) -> String {
        let code = locale.language.languageCode?.identifier.lowercased()
            ?? locale.identifier.lowercased()
        return code.hasPrefix("zh") ? "zh-Hans" : "en"
    }

    private static func loadTemplate(language: String) -> String {
        if let url = Bundle.module.url(forResource: "SetupGuide-\(language)", withExtension: "txt"),
           let text = try? String(contentsOf: url, encoding: .utf8)
        {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let fallbackURL = Bundle.module.url(forResource: "SetupGuide-en", withExtension: "txt"),
           let fallbackText = try? String(contentsOf: fallbackURL, encoding: .utf8)
        {
            return fallbackText.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return "Deploy \(Self.repositoryURL) and share the URL and Bearer token."
    }
}

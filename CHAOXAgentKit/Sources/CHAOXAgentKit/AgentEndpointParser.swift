import Foundation

public struct AgentParsedEndpointInput: Sendable, Equatable {
    public var url: String?
    public var token: String?

    public init(url: String? = nil, token: String? = nil) {
        self.url = url
        self.token = token
    }
}

public enum AgentEndpointParser {
    private static let trailingDelimiters = CharacterSet(charactersIn: "\"'`,.;:)]}>")
    private static let tokenAllowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))

    public static func parse(_ raw: String) -> AgentParsedEndpointInput {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return AgentParsedEndpointInput() }

        let matchedURL = self.extractURL(from: trimmed)
        let matchedToken = self.extractToken(from: trimmed, excludingRange: matchedURL?.range)

        return AgentParsedEndpointInput(
            url: matchedURL?.normalized,
            token: matchedToken
        )
    }

    public static func displayHost(for urlString: String) -> String {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = (try? AgentExchangeStore.normalizedRemoteURL(trimmed)) ?? URL(string: trimmed),
              let host = parsed.host,
              !host.isEmpty
        else {
            return trimmed
        }
        if let port = parsed.port {
            return "\(host):\(port)"
        }
        return host
    }

    public static func mcpEndpointString(for urlString: String) -> String? {
        guard let normalized = try? AgentExchangeStore.normalizedRemoteURL(urlString) else {
            return nil
        }
        return "\(normalized.absoluteString)/mcp"
    }

    public static func mcpConfigSnippet(for urlString: String, token: String?) -> String? {
        guard let endpointURL = mcpEndpointString(for: urlString) else {
            return nil
        }
        let trimmedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines)
        let headers: [String: String]? = if let trimmedToken, !trimmedToken.isEmpty {
            ["Authorization": "Bearer \(trimmedToken)"]
        } else {
            nil
        }

        let payload = MCPConfigSnippet(
            mcpServers: [
                "chaox-agent": MCPConfigSnippet.ServerConfig(
                    url: endpointURL,
                    headers: headers
                )
            ]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(payload) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private struct MCPConfigSnippet: Encodable {
        struct ServerConfig: Encodable {
            let url: String
            let headers: [String: String]?
        }

        let mcpServers: [String: ServerConfig]
    }

    private static func extractURL(from text: String) -> (normalized: String, range: NSRange)? {
        guard let regex = try? NSRegularExpression(pattern: #"https?://[^\s"'<>`]+"#, options: [.caseInsensitive]) else {
            return nil
        }
        let fullRange = NSRange(text.startIndex ..< text.endIndex, in: text)
        for match in regex.matches(in: text, range: fullRange) {
            guard let swiftRange = Range(match.range, in: text) else { continue }
            var candidate = String(text[swiftRange])
            while let last = candidate.unicodeScalars.last, self.trailingDelimiters.contains(last) {
                candidate.unicodeScalars.removeLast()
            }
            if let normalized = try? AgentExchangeStore.normalizedRemoteURL(candidate) {
                return (normalized.absoluteString, match.range)
            }
        }
        return nil
    }

    private static func extractToken(from text: String, excludingRange: NSRange?) -> String? {
        let fullRange = NSRange(text.startIndex ..< text.endIndex, in: text)
        let explicitPatterns = [
            #"(?:authorization\s*[:=]\s*["']?\s*)?bearer\s+([A-Za-z0-9._-]{8,})"#,
            #"(?:token|secret|密钥)[^A-Za-z0-9._\-\r\n]{1,8}([A-Za-z0-9._-]{16,})"#,
        ]
        for pattern in explicitPatterns {
            if let captured = self.firstCapture(
                pattern: pattern,
                in: text,
                range: fullRange,
                excludingRange: excludingRange,
                options: [.caseInsensitive]
            ) {
                return captured
            }
        }

        if let standalone = self.firstCapture(
            pattern: #"([A-Za-z0-9._-]{24,})"#,
            in: text,
            range: fullRange,
            excludingRange: excludingRange,
            options: []
        ) {
            return standalone
        }

        if excludingRange == nil,
           text.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
        {
            let stripped = text.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            if !stripped.isEmpty,
               stripped.unicodeScalars.allSatisfy({ self.tokenAllowed.contains($0) })
            {
                return stripped
            }
        }
        return nil
    }

    private static func firstCapture(
        pattern: String,
        in text: String,
        range: NSRange,
        excludingRange: NSRange?,
        options: NSRegularExpression.Options
    ) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return nil
        }
        for match in regex.matches(in: text, range: range) where match.numberOfRanges > 1 {
            let captureRange = match.range(at: 1)
            if let excludingRange, NSIntersectionRange(captureRange, excludingRange).length > 0 {
                continue
            }
            guard let swiftRange = Range(captureRange, in: text) else { continue }
            return String(text[swiftRange])
        }
        return nil
    }
}

import Foundation

public struct AgentParsedEndpointInput: Sendable, Equatable {
    public var url: String?
    public var token: String?

    public init(url: String? = nil, token: String? = nil) {
        self.url = url
        self.token = token
    }
}

public enum AgentCredentialField: Sendable, Equatable {
    case url
    case token
}

public enum AgentCredentialPasteTarget: Sendable, Equatable {
    case url
    case token
    case both
}

public struct AgentCredentialInputUpdate: Sendable, Equatable {
    public var url: String
    public var token: String
    public var didUpdateURL: Bool
    public var didUpdateToken: Bool
    public var didAutoRecognizeConfig: Bool

    public init(
        url: String,
        token: String,
        didUpdateURL: Bool,
        didUpdateToken: Bool,
        didAutoRecognizeConfig: Bool
    ) {
        self.url = url
        self.token = token
        self.didUpdateURL = didUpdateURL
        self.didUpdateToken = didUpdateToken
        self.didAutoRecognizeConfig = didAutoRecognizeConfig
    }
}

public enum AgentEndpointParser {
    private static let trailingDelimiters = CharacterSet(charactersIn: "\"'`,.;:)]}>")
    private static let tokenAllowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
    private static let residualWrappers = CharacterSet(charactersIn: "\"',;")
    private static let structuredPastePattern =
        #"(?:^|[\s,{])(?:bearer\s+|(?:url|endpoint|token|secret|authorization|地址|密钥|令牌)\s*[:=：\s])"#

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

    public static func clientConfigSnippet(for urlString: String, token: String?) -> String? {
        guard let normalized = try? AgentExchangeStore.normalizedRemoteURL(urlString) else {
            return nil
        }
        let trimmedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmedToken, !trimmedToken.isEmpty {
            return "URL: \(normalized.absoluteString)\nToken: \(trimmedToken)"
        }
        return "URL: \(normalized.absoluteString)"
    }

    public static func reconcileFieldEdit(
        field: AgentCredentialField,
        newValue: String,
        currentURL: String,
        currentToken: String,
        canOverwriteOtherField: Bool
    ) -> AgentCredentialInputUpdate {
        let (sourceText, parsed) = self.resolvedEditSource(
            field: field,
            newValue: newValue,
            currentURL: currentURL,
            currentToken: currentToken
        )

        if let parsedURL = parsed.url, let parsedToken = parsed.token {
            return self.reconcileMatchedPair(
                field: field,
                parsedURL: parsedURL,
                parsedToken: parsedToken,
                currentURL: currentURL,
                currentToken: currentToken,
                canOverwriteOtherField: canOverwriteOtherField
            )
        }

        if self.looksLikeStructuredPaste(sourceText),
           let singleUpdate = self.reconcileStructuredSingleMatch(
               field: field,
               parsed: parsed,
               currentURL: currentURL,
               currentToken: currentToken
           )
        {
            return singleUpdate
        }

        switch field {
        case .url:
            return AgentCredentialInputUpdate(
                url: newValue,
                token: currentToken,
                didUpdateURL: true,
                didUpdateToken: false,
                didAutoRecognizeConfig: false
            )
        case .token:
            return AgentCredentialInputUpdate(
                url: currentURL,
                token: newValue,
                didUpdateURL: false,
                didUpdateToken: true,
                didAutoRecognizeConfig: false
            )
        }
    }

    public static func reconcileClipboardPaste(
        raw: String,
        target: AgentCredentialPasteTarget,
        currentURL: String,
        currentToken: String,
        hasEditedURL: Bool
    ) -> AgentCredentialInputUpdate? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let parsed = self.parse(trimmed)
        let recognized = parsed.url != nil || parsed.token != nil
        var nextURL = currentURL
        var nextToken = currentToken
        var didUpdateURL = false
        var didUpdateToken = false

        switch target {
        case .both:
            guard recognized else { return nil }
            if let parsedURL = parsed.url {
                nextURL = parsedURL
                didUpdateURL = true
            }
            if let parsedToken = parsed.token {
                nextToken = parsedToken
                didUpdateToken = true
            }
        case .url:
            if let parsedURL = parsed.url {
                nextURL = parsedURL
                didUpdateURL = true
            } else if parsed.token == nil {
                nextURL = trimmed
                didUpdateURL = true
            }
            if let parsedToken = parsed.token,
               currentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                nextToken = parsedToken
                didUpdateToken = true
            }
        case .token:
            if let parsedToken = parsed.token {
                nextToken = parsedToken
                didUpdateToken = true
            } else if parsed.url == nil {
                nextToken = trimmed
                didUpdateToken = true
            }
            let urlEmpty = currentURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if let parsedURL = parsed.url, urlEmpty || !hasEditedURL {
                nextURL = parsedURL
                didUpdateURL = true
            }
        }

        return AgentCredentialInputUpdate(
            url: nextURL,
            token: nextToken,
            didUpdateURL: didUpdateURL,
            didUpdateToken: didUpdateToken,
            didAutoRecognizeConfig: recognized
        )
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

    private static func resolvedEditSource(
        field: AgentCredentialField,
        newValue: String,
        currentURL: String,
        currentToken: String
    ) -> (sourceText: String, parsed: AgentParsedEndpointInput) {
        let existing: String = switch field {
        case .url: currentURL
        case .token: currentToken
        }
        if !existing.isEmpty,
           newValue.hasPrefix(existing),
           newValue.count > existing.count + 4
        {
            let suffix = String(newValue.dropFirst(existing.count))
            let suffixParsed = self.parse(suffix)
            let matchesTarget: Bool = switch field {
            case .url: suffixParsed.url != nil
            case .token: suffixParsed.token != nil || suffixParsed.url != nil
            }
            if matchesTarget {
                return (suffix, suffixParsed)
            }
        }
        return (newValue, self.parse(newValue))
    }

    private static func reconcileMatchedPair(
        field: AgentCredentialField,
        parsedURL: String,
        parsedToken: String,
        currentURL: String,
        currentToken: String,
        canOverwriteOtherField: Bool
    ) -> AgentCredentialInputUpdate {
        var nextURL = currentURL
        var nextToken = currentToken
        var didUpdateURL = false
        var didUpdateToken = false

        switch field {
        case .url:
            nextURL = parsedURL
            didUpdateURL = true
            if currentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || canOverwriteOtherField {
                nextToken = parsedToken
                didUpdateToken = true
            }
        case .token:
            nextToken = parsedToken
            didUpdateToken = true
            if currentURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || canOverwriteOtherField {
                nextURL = parsedURL
                didUpdateURL = true
            }
        }

        return AgentCredentialInputUpdate(
            url: nextURL,
            token: nextToken,
            didUpdateURL: didUpdateURL,
            didUpdateToken: didUpdateToken,
            didAutoRecognizeConfig: true
        )
    }

    private static func reconcileStructuredSingleMatch(
        field: AgentCredentialField,
        parsed: AgentParsedEndpointInput,
        currentURL: String,
        currentToken: String
    ) -> AgentCredentialInputUpdate? {
        let bothEmpty = currentURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && currentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        switch field {
        case .url:
            if let parsedURL = parsed.url {
                return AgentCredentialInputUpdate(
                    url: parsedURL,
                    token: currentToken,
                    didUpdateURL: true,
                    didUpdateToken: false,
                    didAutoRecognizeConfig: true
                )
            }
            if let parsedToken = parsed.token, bothEmpty {
                return AgentCredentialInputUpdate(
                    url: currentURL,
                    token: parsedToken,
                    didUpdateURL: false,
                    didUpdateToken: true,
                    didAutoRecognizeConfig: true
                )
            }
            return nil
        case .token:
            if let parsedToken = parsed.token {
                return AgentCredentialInputUpdate(
                    url: currentURL,
                    token: parsedToken,
                    didUpdateURL: false,
                    didUpdateToken: true,
                    didAutoRecognizeConfig: true
                )
            }
            if let parsedURL = parsed.url, bothEmpty {
                return AgentCredentialInputUpdate(
                    url: parsedURL,
                    token: currentToken,
                    didUpdateURL: true,
                    didUpdateToken: false,
                    didAutoRecognizeConfig: true
                )
            }
            return nil
        }
    }

    private static func looksLikeStructuredPaste(_ text: String) -> Bool {
        if text.contains("\n") || text.contains("\r") || text.contains("{") || text.contains("}") {
            return true
        }
        guard let regex = try? NSRegularExpression(
            pattern: self.structuredPastePattern,
            options: [.caseInsensitive]
        ) else {
            return false
        }
        let range = NSRange(text.startIndex ..< text.endIndex, in: text)
        return regex.firstMatch(in: text, range: range) != nil
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
            #"(?:token|secret|密钥|令牌)[^A-Za-z0-9._\-\r\n]{1,8}([A-Za-z0-9._-]{8,})"#,
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

        if let excludingRange,
           let residual = self.extractResidualToken(from: text, excludingRange: excludingRange)
        {
            return residual
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

    private static func extractResidualToken(from text: String, excludingRange: NSRange) -> String? {
        guard let swiftRange = Range(excludingRange, in: text) else {
            return nil
        }
        var remainder = text
        remainder.removeSubrange(swiftRange)
        let segments = remainder
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
        guard segments.count == 1 else {
            return nil
        }
        let candidate = segments[0].trimmingCharacters(in: self.residualWrappers)
        guard candidate.count >= 8,
              !candidate.contains("://"),
              candidate.unicodeScalars.allSatisfy({ self.tokenAllowed.contains($0) })
        else {
            return nil
        }
        return candidate
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

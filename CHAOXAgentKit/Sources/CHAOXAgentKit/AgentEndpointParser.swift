import Foundation

public struct AgentParsedEndpointInput: Sendable, Equatable {
    public var url: String?
    public var token: String?
    public var mcpToken: String?

    public init(url: String? = nil, token: String? = nil, mcpToken: String? = nil) {
        self.url = url
        self.token = token
        self.mcpToken = mcpToken
    }
}

public enum AgentCredentialField: Sendable, Equatable {
    case url
    case token
    case mcpToken
}

public enum AgentCredentialPasteTarget: Sendable, Equatable {
    case url
    case token
    case mcpToken
    case both
}

public struct AgentCredentialInputUpdate: Sendable, Equatable {
    public var url: String
    public var token: String
    public var mcpToken: String
    public var didUpdateURL: Bool
    public var didUpdateToken: Bool
    public var didUpdateMCPToken: Bool
    public var didAutoRecognizeConfig: Bool

    public init(
        url: String,
        token: String,
        mcpToken: String = "",
        didUpdateURL: Bool,
        didUpdateToken: Bool,
        didUpdateMCPToken: Bool = false,
        didAutoRecognizeConfig: Bool
    ) {
        self.url = url
        self.token = token
        self.mcpToken = mcpToken
        self.didUpdateURL = didUpdateURL
        self.didUpdateToken = didUpdateToken
        self.didUpdateMCPToken = didUpdateMCPToken
        self.didAutoRecognizeConfig = didAutoRecognizeConfig
    }
}

public enum AgentEndpointParser {
    public static let splitMCPTokenPlaceholder = "<YOUR_CHAOX_MCP_TOKEN>"

    private static let trailingDelimiters = CharacterSet(charactersIn: "\"'`,.;:)]}>")
    private static let tokenAllowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
    private static let residualWrappers = CharacterSet(charactersIn: "\"',;")
    private static let structuredPastePattern =
        #"(?:^|[\s,{])(?:bearer\s+|(?:url|endpoint|token|secret|authorization|chaox_sync_token|chaox_mcp_token|chaox_auth_token|地址|密钥|令牌)\s*[:=：\s])"#
    private static let explicitMCPLabelPattern =
        #"(?:^|[\s,{])(?:chaox_mcp_token|mcp[\s_-]*token|ai[\s_-]*token|ai\s*密钥|ai\s*令牌)[^A-Za-z0-9._\-\r\n]{1,8}<?([A-Za-z0-9._-]{8,})>?"#
    private static let explicitSyncLabelPattern =
        #"(?:^|[\s,{])(?:chaox_sync_token|sync[\s_-]*token|同步密钥|同步令牌)[^A-Za-z0-9._\-\r\n]{1,8}<?([A-Za-z0-9._-]{8,})>?"#

    public static func parse(_ raw: String) -> AgentParsedEndpointInput {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return AgentParsedEndpointInput() }

        let matchedURL = self.extractURL(from: trimmed)
        var excludedRanges: [NSRange] = matchedURL.map { [$0.range] } ?? []

        let mcpMatch = self.extractLabeledToken(
            pattern: self.explicitMCPLabelPattern,
            in: trimmed,
            excludingRanges: excludedRanges,
            ignoringPlaceholder: "YOUR_CHAOX_MCP_TOKEN"
        )
        if let mcpMatch {
            excludedRanges.append(mcpMatch.fullRange)
        }

        let syncMatch = self.extractLabeledToken(
            pattern: self.explicitSyncLabelPattern,
            in: trimmed,
            excludingRanges: excludedRanges,
            ignoringPlaceholder: nil
        )
        let matchedToken: String? = if let syncMatch {
            syncMatch.value
        } else {
            self.extractToken(from: trimmed, excludingRanges: excludedRanges)
        }

        return AgentParsedEndpointInput(
            url: matchedURL?.normalized,
            token: matchedToken,
            mcpToken: mcpMatch?.value
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

    public static func clientConfigSnippet(
        for urlString: String,
        token: String?,
        mcpToken: String? = nil
    ) -> String? {
        guard let normalized = try? AgentExchangeStore.normalizedRemoteURL(urlString) else {
            return nil
        }
        let trimmedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedMCP = mcpToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmedToken, !trimmedToken.isEmpty,
           let trimmedMCP, !trimmedMCP.isEmpty
        {
            return "URL: \(normalized.absoluteString)\nSync Token: \(trimmedToken)\nMCP Token: \(trimmedMCP)"
        }
        if let trimmedToken, !trimmedToken.isEmpty {
            return "URL: \(normalized.absoluteString)\nToken: \(trimmedToken)"
        }
        return "URL: \(normalized.absoluteString)"
    }

    public static func mcpConfigSnippet(
        for urlString: String,
        token: String?,
        tokenMode: AgentTokenMode = .legacy,
        mcpToken: String? = nil
    ) -> String? {
        guard let endpointURL = mcpEndpointString(for: urlString) else {
            return nil
        }
        let trimmedMCP = mcpToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        let headers: [String: String]?
        switch tokenMode {
        case .split:
            if let trimmedMCP, !trimmedMCP.isEmpty {
                headers = ["Authorization": "Bearer \(trimmedMCP)"]
            } else {
                headers = ["Authorization": "Bearer \(Self.splitMCPTokenPlaceholder)"]
            }
        case .legacy:
            let effective = if let trimmedMCP, !trimmedMCP.isEmpty {
                trimmedMCP
            } else {
                token?.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let effective, !effective.isEmpty {
                headers = ["Authorization": "Bearer \(effective)"]
            } else {
                headers = nil
            }
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

    public static func reconcileFieldEdit(
        field: AgentCredentialField,
        newValue: String,
        currentURL: String,
        currentToken: String,
        currentMCPToken: String = "",
        canOverwriteOtherField: Bool
    ) -> AgentCredentialInputUpdate {
        let (sourceText, parsed) = self.resolvedEditSource(
            field: field,
            newValue: newValue,
            currentURL: currentURL,
            currentToken: currentToken,
            currentMCPToken: currentMCPToken
        )

        if let multiUpdate = self.reconcileMultiFieldEdit(
            field: field,
            parsed: parsed,
            currentURL: currentURL,
            currentToken: currentToken,
            currentMCPToken: currentMCPToken,
            canOverwriteOtherField: canOverwriteOtherField
        ) {
            return multiUpdate
        }

        if self.looksLikeStructuredPaste(sourceText),
           let singleUpdate = self.reconcileStructuredSingleMatch(
               field: field,
               parsed: parsed,
               currentURL: currentURL,
               currentToken: currentToken,
               currentMCPToken: currentMCPToken
           )
        {
            return singleUpdate
        }

        switch field {
        case .url:
            return AgentCredentialInputUpdate(
                url: newValue,
                token: currentToken,
                mcpToken: currentMCPToken,
                didUpdateURL: true,
                didUpdateToken: false,
                didUpdateMCPToken: false,
                didAutoRecognizeConfig: false
            )
        case .token:
            return AgentCredentialInputUpdate(
                url: currentURL,
                token: newValue,
                mcpToken: currentMCPToken,
                didUpdateURL: false,
                didUpdateToken: true,
                didUpdateMCPToken: false,
                didAutoRecognizeConfig: false
            )
        case .mcpToken:
            return AgentCredentialInputUpdate(
                url: currentURL,
                token: currentToken,
                mcpToken: newValue,
                didUpdateURL: false,
                didUpdateToken: false,
                didUpdateMCPToken: true,
                didAutoRecognizeConfig: false
            )
        }
    }

    public static func reconcileClipboardPaste(
        raw: String,
        target: AgentCredentialPasteTarget,
        currentURL: String,
        currentToken: String,
        currentMCPToken: String = "",
        hasEditedURL: Bool
    ) -> AgentCredentialInputUpdate? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let parsed = self.parse(trimmed)
        let recognized = parsed.url != nil || parsed.token != nil || parsed.mcpToken != nil
        var nextURL = currentURL
        var nextToken = currentToken
        var nextMCPToken = currentMCPToken
        var didUpdateURL = false
        var didUpdateToken = false
        var didUpdateMCPToken = false

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
            if let parsedMCP = parsed.mcpToken {
                nextMCPToken = parsedMCP
                didUpdateMCPToken = true
            }
        case .url:
            if let parsedURL = parsed.url {
                nextURL = parsedURL
                didUpdateURL = true
            } else if parsed.token == nil, parsed.mcpToken == nil {
                nextURL = trimmed
                didUpdateURL = true
            }
            if let parsedToken = parsed.token,
               currentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                nextToken = parsedToken
                didUpdateToken = true
            }
            if let parsedMCP = parsed.mcpToken,
               currentMCPToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                nextMCPToken = parsedMCP
                didUpdateMCPToken = true
            }
        case .token:
            if let parsedToken = parsed.token {
                nextToken = parsedToken
                didUpdateToken = true
            } else if parsed.url == nil, parsed.mcpToken == nil {
                nextToken = trimmed
                didUpdateToken = true
            }
            let urlEmpty = currentURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if let parsedURL = parsed.url, urlEmpty || !hasEditedURL {
                nextURL = parsedURL
                didUpdateURL = true
            }
            if let parsedMCP = parsed.mcpToken,
               currentMCPToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                nextMCPToken = parsedMCP
                didUpdateMCPToken = true
            }
        case .mcpToken:
            if let resolvedMCP = parsed.mcpToken ?? parsed.token {
                nextMCPToken = resolvedMCP
                didUpdateMCPToken = true
            } else if parsed.url == nil {
                nextMCPToken = trimmed
                didUpdateMCPToken = true
            }
            if parsed.mcpToken != nil, let parsedToken = parsed.token,
               currentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                nextToken = parsedToken
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
            mcpToken: nextMCPToken,
            didUpdateURL: didUpdateURL,
            didUpdateToken: didUpdateToken,
            didUpdateMCPToken: didUpdateMCPToken,
            didAutoRecognizeConfig: recognized
        )
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
        currentToken: String,
        currentMCPToken: String
    ) -> (sourceText: String, parsed: AgentParsedEndpointInput) {
        let existing: String = switch field {
        case .url: currentURL
        case .token: currentToken
        case .mcpToken: currentMCPToken
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
            case .mcpToken: suffixParsed.mcpToken != nil || suffixParsed.token != nil || suffixParsed.url != nil
            }
            if matchesTarget {
                return (suffix, suffixParsed)
            }
        }
        return (newValue, self.parse(newValue))
    }

    private static func reconcileMultiFieldEdit(
        field: AgentCredentialField,
        parsed: AgentParsedEndpointInput,
        currentURL: String,
        currentToken: String,
        currentMCPToken: String,
        canOverwriteOtherField: Bool
    ) -> AgentCredentialInputUpdate? {
        guard let parsedURL = parsed.url,
              parsed.token != nil || parsed.mcpToken != nil
        else {
            return nil
        }

        var nextURL = currentURL
        var nextToken = currentToken
        var nextMCPToken = currentMCPToken
        var didUpdateURL = false
        var didUpdateToken = false
        var didUpdateMCPToken = false

        switch field {
        case .url:
            nextURL = parsedURL
            didUpdateURL = true
            if let parsedToken = parsed.token,
               currentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || canOverwriteOtherField
            {
                nextToken = parsedToken
                didUpdateToken = true
            }
            if let parsedMCP = parsed.mcpToken,
               currentMCPToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || canOverwriteOtherField
            {
                nextMCPToken = parsedMCP
                didUpdateMCPToken = true
            }
        case .token:
            if let parsedToken = parsed.token {
                nextToken = parsedToken
                didUpdateToken = true
            }
            if currentURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || canOverwriteOtherField {
                nextURL = parsedURL
                didUpdateURL = true
            }
            if let parsedMCP = parsed.mcpToken,
               currentMCPToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || canOverwriteOtherField
            {
                nextMCPToken = parsedMCP
                didUpdateMCPToken = true
            }
        case .mcpToken:
            if let resolvedMCP = parsed.mcpToken ?? parsed.token {
                nextMCPToken = resolvedMCP
                didUpdateMCPToken = true
            }
            if currentURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || canOverwriteOtherField {
                nextURL = parsedURL
                didUpdateURL = true
            }
            if parsed.mcpToken != nil, let parsedToken = parsed.token,
               currentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || canOverwriteOtherField
            {
                nextToken = parsedToken
                didUpdateToken = true
            }
        }

        return AgentCredentialInputUpdate(
            url: nextURL,
            token: nextToken,
            mcpToken: nextMCPToken,
            didUpdateURL: didUpdateURL,
            didUpdateToken: didUpdateToken,
            didUpdateMCPToken: didUpdateMCPToken,
            didAutoRecognizeConfig: true
        )
    }

    private static func reconcileStructuredSingleMatch(
        field: AgentCredentialField,
        parsed: AgentParsedEndpointInput,
        currentURL: String,
        currentToken: String,
        currentMCPToken: String
    ) -> AgentCredentialInputUpdate? {
        let allEmpty = currentURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && currentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && currentMCPToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        switch field {
        case .url:
            if let parsedURL = parsed.url {
                return AgentCredentialInputUpdate(
                    url: parsedURL,
                    token: currentToken,
                    mcpToken: currentMCPToken,
                    didUpdateURL: true,
                    didUpdateToken: false,
                    didUpdateMCPToken: false,
                    didAutoRecognizeConfig: true
                )
            }
            if let parsedToken = parsed.token, allEmpty {
                return AgentCredentialInputUpdate(
                    url: currentURL,
                    token: parsedToken,
                    mcpToken: parsed.mcpToken ?? currentMCPToken,
                    didUpdateURL: false,
                    didUpdateToken: true,
                    didUpdateMCPToken: parsed.mcpToken != nil,
                    didAutoRecognizeConfig: true
                )
            }
            if let parsedMCP = parsed.mcpToken, allEmpty {
                return AgentCredentialInputUpdate(
                    url: currentURL,
                    token: currentToken,
                    mcpToken: parsedMCP,
                    didUpdateURL: false,
                    didUpdateToken: false,
                    didUpdateMCPToken: true,
                    didAutoRecognizeConfig: true
                )
            }
            return nil
        case .token:
            if let parsedToken = parsed.token {
                return AgentCredentialInputUpdate(
                    url: currentURL,
                    token: parsedToken,
                    mcpToken: currentMCPToken,
                    didUpdateURL: false,
                    didUpdateToken: true,
                    didUpdateMCPToken: false,
                    didAutoRecognizeConfig: true
                )
            }
            if let parsedURL = parsed.url, allEmpty {
                return AgentCredentialInputUpdate(
                    url: parsedURL,
                    token: currentToken,
                    mcpToken: currentMCPToken,
                    didUpdateURL: true,
                    didUpdateToken: false,
                    didUpdateMCPToken: false,
                    didAutoRecognizeConfig: true
                )
            }
            return nil
        case .mcpToken:
            if let resolvedMCP = parsed.mcpToken ?? parsed.token {
                return AgentCredentialInputUpdate(
                    url: currentURL,
                    token: currentToken,
                    mcpToken: resolvedMCP,
                    didUpdateURL: false,
                    didUpdateToken: false,
                    didUpdateMCPToken: true,
                    didAutoRecognizeConfig: true
                )
            }
            if let parsedURL = parsed.url, allEmpty {
                return AgentCredentialInputUpdate(
                    url: parsedURL,
                    token: currentToken,
                    mcpToken: currentMCPToken,
                    didUpdateURL: true,
                    didUpdateToken: false,
                    didUpdateMCPToken: false,
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

    private static func extractLabeledToken(
        pattern: String,
        in text: String,
        excludingRanges: [NSRange],
        ignoringPlaceholder: String?
    ) -> (value: String, fullRange: NSRange)? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let fullTextRange = NSRange(text.startIndex ..< text.endIndex, in: text)
        for match in regex.matches(in: text, range: fullTextRange) where match.numberOfRanges > 1 {
            let captureRange = match.range(at: 1)
            if self.overlaps(captureRange, with: excludingRanges) {
                continue
            }
            guard let swiftRange = Range(captureRange, in: text) else { continue }
            let captured = String(text[swiftRange])
            if let ignoringPlaceholder, captured == ignoringPlaceholder {
                return nil
            }
            return (captured, match.range(at: 0))
        }
        return nil
    }

    private static func extractToken(from text: String, excludingRanges: [NSRange]) -> String? {
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
                excludingRanges: excludingRanges,
                options: [.caseInsensitive]
            ), captured != "YOUR_CHAOX_MCP_TOKEN" {
                return captured
            }
        }

        if let standalone = self.firstCapture(
            pattern: #"([A-Za-z0-9._-]{24,})"#,
            in: text,
            range: fullRange,
            excludingRanges: excludingRanges,
            options: []
        ) {
            return standalone
        }

        if !excludingRanges.isEmpty,
           let residual = self.extractResidualToken(from: text, excludingRanges: excludingRanges)
        {
            return residual
        }

        if excludingRanges.isEmpty,
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

    private static func extractResidualToken(from text: String, excludingRanges: [NSRange]) -> String? {
        var remainder = text
        for range in excludingRanges.sorted(by: { $0.location > $1.location }) {
            guard let swiftRange = Range(range, in: remainder) else { continue }
            remainder.removeSubrange(swiftRange)
        }
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
        excludingRanges: [NSRange],
        options: NSRegularExpression.Options
    ) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return nil
        }
        for match in regex.matches(in: text, range: range) where match.numberOfRanges > 1 {
            let captureRange = match.range(at: 1)
            if self.overlaps(captureRange, with: excludingRanges) {
                continue
            }
            guard let swiftRange = Range(captureRange, in: text) else { continue }
            return String(text[swiftRange])
        }
        return nil
    }

    private static func overlaps(_ range: NSRange, with excluded: [NSRange]) -> Bool {
        excluded.contains { NSIntersectionRange(range, $0).length > 0 }
    }
}

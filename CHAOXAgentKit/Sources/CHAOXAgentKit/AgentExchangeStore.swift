import Foundation

public actor AgentExchangeStore {
    public let app: AgentAppID
    let defaultsSuiteName: String?
    let keyPrefix: String
    let urlSession: URLSession
    let tokenStorage: any AgentTokenStorage

    var permissionKey: String { "\(self.keyPrefix).permissionTier" }
    var policyKey: String { "\(self.keyPrefix).permissionPolicy" }
    var lastSyncKey: String { "\(self.keyPrefix).lastSyncAt" }
    var lastErrorKey: String { "\(self.keyPrefix).lastError" }
    var pendingInboxCountKey: String { "\(self.keyPrefix).pendingInboxCount" }
    var recentReceiptsKey: String { "\(self.keyPrefix).recentReceipts" }
    var remoteURLKey: String { "\(self.keyPrefix).remoteURL" }
    var remoteTokenAccount: String { "\(self.keyPrefix).remoteToken" }
    var tokenModeKey: String { "\(self.keyPrefix).tokenMode" }

    private var legacyFolderBookmarkKey: String { "\(self.keyPrefix).folderBookmark" }
    private var legacyFolderNameKey: String { "\(self.keyPrefix).folderName" }
    private var legacyTransportModeKey: String { "\(self.keyPrefix).transportMode" }

    private var isBusy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private static let defaultNoCacheSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    public init(
        app: AgentAppID,
        defaultsSuiteName: String? = nil,
        keyPrefix: String? = nil,
        urlSession: URLSession? = nil,
        inMemoryTokenStorage: Bool = false
    ) {
        self.init(
            app: app,
            defaultsSuiteName: defaultsSuiteName,
            keyPrefix: keyPrefix,
            urlSession: urlSession ?? Self.defaultNoCacheSession,
            tokenStorage: inMemoryTokenStorage ? InMemoryTokenStorage() : KeychainTokenStorage()
        )
    }

    init(
        app: AgentAppID,
        defaultsSuiteName: String? = nil,
        keyPrefix: String? = nil,
        urlSession: URLSession? = nil,
        tokenStorage: any AgentTokenStorage
    ) {
        self.app = app
        self.defaultsSuiteName = defaultsSuiteName
        self.keyPrefix = keyPrefix ?? "chaox.agent.\(app.rawValue)"
        self.urlSession = urlSession ?? Self.defaultNoCacheSession
        self.tokenStorage = tokenStorage
    }

    func defaults() -> UserDefaults {
        if let defaultsSuiteName, let suite = UserDefaults(suiteName: defaultsSuiteName) {
            return suite
        }
        return .standard
    }

    private func acquireLock() async {
        while self.isBusy {
            await withCheckedContinuation { continuation in
                self.waiters.append(continuation)
            }
        }
        self.isBusy = true
    }

    private func releaseLock() {
        self.isBusy = false
        if !self.waiters.isEmpty {
            let next = self.waiters.removeFirst()
            next.resume()
        }
    }

    public func currentPermission() -> AgentPermissionTier {
        if let decoded = self.storedPolicy() {
            return decoded.derivedTier
        }
        let store = self.defaults()
        guard let raw = store.string(forKey: self.permissionKey),
              let tier = AgentPermissionTier(rawValue: raw)
        else {
            return .disabled
        }
        return tier
    }

    public func currentPolicy() -> AgentPermissionPolicy {
        if let stored = self.storedPolicy() {
            return stored
        }
        let legacyTier = self.legacyPermissionTier()
        return AgentPermissionPolicy.preset(
            for: legacyTier,
            app: self.app,
            consentAcknowledged: self.isRemoteConfigured()
        )
    }

    public func setPermission(_ tier: AgentPermissionTier) {
        let existing = self.storedPolicy()
        let updated = AgentPermissionPolicy.preset(
            for: tier,
            app: self.app,
            allowedDomains: existing?.allowedDomains,
            consentAcknowledged: existing?.consentAcknowledged ?? self.isRemoteConfigured(),
            updatedAt: Date()
        )
        self.setPolicy(updated)
    }

    public func setPolicy(_ policy: AgentPermissionPolicy) {
        var sanitized = policy
        if sanitized.updatedAt == nil {
            sanitized.updatedAt = Date()
        }
        let store = self.defaults()
        if let encoded = try? AgentJSONCoding.compactEncoder.encode(sanitized) {
            store.set(encoded, forKey: self.policyKey)
        }
        store.set(sanitized.derivedTier.rawValue, forKey: self.permissionKey)
    }

    private func storedPolicy() -> AgentPermissionPolicy? {
        guard let data = self.defaults().data(forKey: self.policyKey) else {
            return nil
        }
        return try? AgentJSONCoding.decoder.decode(AgentPermissionPolicy.self, from: data)
    }

    private func legacyPermissionTier() -> AgentPermissionTier {
        guard let raw = self.defaults().string(forKey: self.permissionKey),
              let tier = AgentPermissionTier(rawValue: raw)
        else {
            return .disabled
        }
        return tier
    }

    public func isConfigured() -> Bool {
        self.isRemoteConfigured()
    }

    public func savedRemoteURLString() -> String? {
        self.defaults().string(forKey: self.remoteURLKey)
    }

    public func savedRemoteToken() -> String? {
        self.tokenStorage.readToken(account: self.remoteTokenAccount)
    }

    public func hasSavedRemoteToken() -> Bool {
        self.savedRemoteToken() != nil
    }

    public func testRemoteConnection(
        urlString: String,
        token: String,
        reuseSavedToken: Bool = false
    ) async throws {
        let baseURL = try Self.normalizedRemoteURL(urlString)
        let effectiveToken = try self.resolveToken(token, reuseSavedToken: reuseSavedToken).value

        let healthData = try await self.performRemoteRequest(
            baseURL: baseURL,
            path: "health",
            method: "GET",
            token: nil,
            body: nil
        )
        let health = try AgentJSONCoding.decoder.decode(AgentRemoteHealthResponse.self, from: healthData)
        guard health.status == "ok" else {
            throw AgentExchangeError.remoteRequestFailed(
                statusCode: 0,
                message: "Unexpected /health response status: \(health.status)"
            )
        }

        let statusData = try await self.performRemoteRequest(
            baseURL: baseURL,
            path: "sync/\(self.app.rawValue)/status?limit=1",
            method: "GET",
            token: effectiveToken,
            body: nil
        )
        _ = try AgentJSONCoding.decoder.decode(AgentRemoteStatusResponse.self, from: statusData)
    }

    public func saveRemoteConfiguration(
        urlString: String,
        token: String,
        reuseSavedToken: Bool = false,
        defaultPermission: AgentPermissionTier = .appendOnly,
        policy: AgentPermissionPolicy? = nil
    ) throws {
        let baseURL = try Self.normalizedRemoteURL(urlString)
        let resolvedToken = try self.resolveToken(token, reuseSavedToken: reuseSavedToken)
        if resolvedToken.shouldSave {
            try self.tokenStorage.saveToken(resolvedToken.value, account: self.remoteTokenAccount)
        }

        let store = self.defaults()
        store.set(baseURL.absoluteString, forKey: self.remoteURLKey)
        store.removeObject(forKey: self.lastErrorKey)
        self.removeLegacyFolderDefaults(from: store)
        if let policy {
            var acknowledged = policy
            acknowledged.consentAcknowledged = true
            acknowledged.updatedAt = Date()
            self.setPolicy(acknowledged)
        } else if let existing = self.storedPolicy(), existing.allowsExchangeAccess {
            if !existing.consentAcknowledged {
                var acknowledged = existing
                acknowledged.consentAcknowledged = true
                acknowledged.updatedAt = Date()
                self.setPolicy(acknowledged)
            }
        } else {
            let legacy = self.legacyPermissionTier()
            let chosenTier = legacy == .disabled ? defaultPermission : legacy
            let nextPolicy = AgentPermissionPolicy.preset(
                for: chosenTier,
                app: self.app,
                consentAcknowledged: true,
                updatedAt: Date()
            )
            self.setPolicy(nextPolicy)
        }
    }

    public func clearRemoteConfiguration() {
        self.tokenStorage.deleteToken(account: self.remoteTokenAccount)
        let store = self.defaults()
        store.removeObject(forKey: self.remoteURLKey)
        store.removeObject(forKey: self.lastSyncKey)
        store.removeObject(forKey: self.lastErrorKey)
        store.removeObject(forKey: self.pendingInboxCountKey)
        store.removeObject(forKey: self.recentReceiptsKey)
        store.removeObject(forKey: self.policyKey)
        store.removeObject(forKey: self.tokenModeKey)
        self.removeLegacyFolderDefaults(from: store)
        store.set(AgentPermissionTier.disabled.rawValue, forKey: self.permissionKey)
    }

    public func wipeRemoteAndClearConfiguration() async throws {
        if let config = self.remoteEndpointConfig() {
            _ = try await self.performRemoteRequest(
                baseURL: config.baseURL,
                path: "sync/\(self.app.rawValue)/data",
                method: "DELETE",
                token: config.token,
                body: nil
            )
        }
        self.clearRemoteConfiguration()
    }

    public func loadStatus(receiptLimit: Int = 10) async -> AgentExchangeStatus {
        await self.loadRemoteStatus(receiptLimit: receiptLimit)
    }

    public func cachedStatus() -> AgentExchangeStatus {
        let store = self.defaults()
        let policy = self.currentPolicy()
        let isConfigured = self.isRemoteConfigured()
        return AgentExchangeStatus(
            isConfigured: isConfigured,
            permission: policy.derivedTier,
            policy: policy,
            lastSyncAt: store.object(forKey: self.lastSyncKey) as? Date,
            pendingInboxCount: isConfigured ? self.cachedPendingInboxCount(from: store) : 0,
            recentReceipts: isConfigured ? self.cachedReceipts(from: store) : [],
            lastError: store.string(forKey: self.lastErrorKey),
            remoteEndpointURL: self.savedRemoteURLString(),
            tokenMode: isConfigured ? self.cachedTokenMode(from: store) : .legacy
        )
    }

    private func cachedTokenMode(from store: UserDefaults) -> AgentTokenMode {
        guard let raw = store.string(forKey: self.tokenModeKey),
              let mode = AgentTokenMode(rawValue: raw)
        else {
            return .legacy
        }
        return mode
    }

    public func publishSnapshot(
        metadata: AgentAppMetadata,
        catalog: some Encodable,
        summary: some Encodable,
        datasets: [String: JSONValue]? = nil,
        now: Date = Date()
    ) async throws {
        await self.acquireLock()
        defer { self.releaseLock() }

        let policy = self.currentPolicy()
        let catalogJSON = policy.allowRead ? try JSONValue.fromEncodable(catalog) : nil
        let summaryJSON = policy.allowRead ? try JSONValue.fromEncodable(summary) : nil
        let effectiveDatasets: [String: JSONValue]? = policy.allowRead ? datasets : [:]
        try await self.publishRemoteSnapshot(
            metadata: metadata,
            catalog: catalogJSON,
            summary: summaryJSON,
            datasets: effectiveDatasets,
            now: now
        )
    }

    public func publishPermissionManifest(
        metadata: AgentAppMetadata,
        now: Date = Date()
    ) async throws {
        await self.acquireLock()
        defer { self.releaseLock() }

        let policy = self.currentPolicy()
        let clearedDatasets: [String: JSONValue]? = policy.allowRead ? nil : [:]
        try await self.publishRemoteSnapshot(
            metadata: metadata,
            catalog: nil,
            summary: nil,
            datasets: clearedDatasets,
            now: now
        )
    }

    public func processInbox(
        now: Date = Date(),
        handler: @Sendable (AgentInboxEnvelope) async -> AgentInboxOutcome
    ) async throws -> AgentInboxRunResult {
        await self.acquireLock()
        defer { self.releaseLock() }

        return try await self.processRemoteInbox(now: now, handler: handler)
    }

    public func fetchWuxuDelta(
        since: Date? = nil,
        includeDeleted: Bool = true
    ) async throws -> AgentRemoteWuxuDeltaResponse {
        guard let config = self.remoteEndpointConfig() else {
            throw AgentExchangeError.notConfigured
        }

        var queryItems = [
            URLQueryItem(name: "includeDeleted", value: includeDeleted ? "1" : "0")
        ]
        if let since {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            queryItems.append(URLQueryItem(name: "since", value: formatter.string(from: since)))
        }

        var components = URLComponents()
        components.queryItems = queryItems
        let path: String = if let query = components.percentEncodedQuery, !query.isEmpty {
            "sync/csteix/wuxu?\(query)"
        } else {
            "sync/csteix/wuxu"
        }

        let data = try await self.performRemoteRequest(
            baseURL: config.baseURL,
            path: path,
            method: "GET",
            token: config.token,
            body: nil
        )
        return try AgentJSONCoding.decoder.decode(AgentRemoteWuxuDeltaResponse.self, from: data)
    }

    private func resolveToken(
        _ token: String,
        reuseSavedToken: Bool
    ) throws -> (value: String, shouldSave: Bool) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return (trimmed, true)
        }
        if reuseSavedToken,
           let saved = self.savedRemoteToken(),
           !saved.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return (saved, false)
        }
        throw AgentExchangeError.missingRemoteToken
    }

    private func cachedPendingInboxCount(from store: UserDefaults) -> Int {
        max(0, store.integer(forKey: self.pendingInboxCountKey))
    }

    private func cachedReceipts(from store: UserDefaults) -> [AgentReceipt] {
        guard let data = store.data(forKey: self.recentReceiptsKey),
              let decoded = try? AgentJSONCoding.decoder.decode([AgentReceipt].self, from: data)
        else {
            return []
        }
        return Array(decoded.prefix(10))
    }

    private func persistCachedStatus(
        pendingInboxCount: Int,
        recentReceipts: [AgentReceipt],
        to store: UserDefaults
    ) {
        store.set(max(0, pendingInboxCount), forKey: self.pendingInboxCountKey)
        let capped = Array(recentReceipts.prefix(10))
        if let encoded = try? AgentJSONCoding.compactEncoder.encode(capped) {
            store.set(encoded, forKey: self.recentReceiptsKey)
        }
    }

    private static func mergeRecentReceipts(
        incomingChronological: [AgentReceipt],
        existing: [AgentReceipt]
    ) -> [AgentReceipt] {
        var seenRequestIds = Set<String>()
        var merged: [AgentReceipt] = []
        merged.reserveCapacity(min(10, incomingChronological.count + existing.count))

        for receipt in incomingChronological.reversed() + existing
            where seenRequestIds.insert(receipt.requestId).inserted
        {
            merged.append(receipt)
            if merged.count == 10 {
                break
            }
        }
        return merged
    }

    private static func isCancellationError(_ error: any Error) -> Bool {
        if error is CancellationError {
            return true
        }
        if let urlError = error as? URLError, urlError.code == .cancelled {
            return true
        }
        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }

    private func removeLegacyFolderDefaults(from store: UserDefaults) {
        store.removeObject(forKey: self.legacyFolderBookmarkKey)
        store.removeObject(forKey: self.legacyFolderNameKey)
        store.removeObject(forKey: self.legacyTransportModeKey)
    }

    private func isRemoteConfigured() -> Bool {
        guard let rawURL = self.defaults().string(forKey: self.remoteURLKey),
              (try? Self.normalizedRemoteURL(rawURL)) != nil
        else {
            return false
        }
        return self.tokenStorage.readToken(account: self.remoteTokenAccount) != nil
    }

    private func loadRemoteStatus(receiptLimit: Int) async -> AgentExchangeStatus {
        let store = self.defaults()
        let policy = self.currentPolicy()
        let permission = policy.derivedTier
        let lastSyncAt = store.object(forKey: self.lastSyncKey) as? Date
        let cachedError = store.string(forKey: self.lastErrorKey)
        let remoteURL = self.savedRemoteURLString()

        guard self.isRemoteConfigured(),
              let rawURL = remoteURL,
              let baseURL = try? Self.normalizedRemoteURL(rawURL),
              let token = self.tokenStorage.readToken(account: self.remoteTokenAccount)
        else {
            return AgentExchangeStatus(
                isConfigured: false,
                permission: permission,
                policy: policy,
                lastSyncAt: lastSyncAt,
                pendingInboxCount: 0,
                recentReceipts: [],
                lastError: cachedError,
                remoteEndpointURL: remoteURL
            )
        }

        do {
            let clamped = max(1, min(receiptLimit, 50))
            let data = try await self.performRemoteRequest(
                baseURL: baseURL,
                path: "sync/\(self.app.rawValue)/status?limit=\(clamped)",
                method: "GET",
                token: token,
                body: nil
            )
            let decoded = try AgentJSONCoding.decoder.decode(AgentRemoteStatusResponse.self, from: data)
            let resolvedTokenMode = decoded.tokenMode ?? .legacy
            store.set(resolvedTokenMode.rawValue, forKey: self.tokenModeKey)
            self.persistCachedStatus(
                pendingInboxCount: decoded.pendingInboxCount,
                recentReceipts: decoded.recentReceipts,
                to: store
            )
            return AgentExchangeStatus(
                isConfigured: true,
                permission: permission,
                policy: policy,
                lastSyncAt: decoded.lastSyncAt ?? lastSyncAt,
                pendingInboxCount: decoded.pendingInboxCount,
                recentReceipts: decoded.recentReceipts,
                lastError: nil,
                remoteEndpointURL: baseURL.absoluteString,
                tokenMode: resolvedTokenMode
            )
        } catch {
            let resolvedError = Self.isCancellationError(error) ? cachedError : error.localizedDescription
            return AgentExchangeStatus(
                isConfigured: true,
                permission: permission,
                policy: policy,
                lastSyncAt: lastSyncAt,
                pendingInboxCount: self.cachedPendingInboxCount(from: store),
                recentReceipts: self.cachedReceipts(from: store),
                lastError: resolvedError,
                remoteEndpointURL: baseURL.absoluteString,
                tokenMode: self.cachedTokenMode(from: store)
            )
        }
    }

    private func publishRemoteSnapshot(
        metadata: AgentAppMetadata,
        catalog: JSONValue?,
        summary: JSONValue?,
        datasets: [String: JSONValue]?,
        now: Date
    ) async throws {
        guard let config = self.remoteEndpointConfig() else { return }

        let policy = self.currentPolicy()
        let permission = policy.derivedTier
        let body = AgentRemoteSnapshotRequest(
            metadata: metadata,
            permission: permission,
            policy: policy,
            lastSyncAt: now,
            catalog: policy.allowRead ? catalog : nil,
            summary: policy.allowRead ? summary : nil,
            datasets: policy.allowRead ? datasets : [:]
        )
        do {
            let payload = try AgentJSONCoding.compactEncoder.encode(body)
            _ = try await self.performRemoteRequest(
                baseURL: config.baseURL,
                path: "sync/\(self.app.rawValue)/snapshot",
                method: "PUT",
                token: config.token,
                body: payload
            )
            let store = self.defaults()
            store.set(now, forKey: self.lastSyncKey)
            store.removeObject(forKey: self.lastErrorKey)
        } catch {
            if !Self.isCancellationError(error) {
                self.defaults().set(error.localizedDescription, forKey: self.lastErrorKey)
            }
            throw error
        }
    }

    private func processRemoteInbox(
        now: Date,
        handler: @Sendable (AgentInboxEnvelope) async -> AgentInboxOutcome
    ) async throws -> AgentInboxRunResult {
        let policy = self.currentPolicy()
        let permission = policy.derivedTier
        guard (permission.allowsExchangeAccess || policy.allowsExchangeAccess),
              let config = self.remoteEndpointConfig()
        else {
            return AgentInboxRunResult()
        }

        do {
            let inboxData = try await self.performRemoteRequest(
                baseURL: config.baseURL,
                path: "sync/\(self.app.rawValue)/inbox",
                method: "GET",
                token: config.token,
                body: nil
            )
            let inboxResponse = try AgentJSONCoding.decoder.decode(AgentRemoteInboxResponse.self, from: inboxData)

            var result = AgentInboxRunResult()
            for envelope in inboxResponse.envelopes {
                let receipt = await self.evaluateEnvelope(
                    envelope,
                    permission: permission,
                    policy: policy,
                    now: now,
                    handler: handler
                )
                result.processedCount += 1
                result.receipts.append(receipt)
                switch receipt.status {
                case .applied:
                    result.appliedCount += 1
                case .duplicate:
                    result.duplicateCount += 1
                case .rejected:
                    result.rejectedCount += 1
                case .failed:
                    result.failedCount += 1
                }
            }

            if !result.receipts.isEmpty {
                let ackBody = try AgentJSONCoding.compactEncoder.encode(AgentRemoteAckRequest(receipts: result.receipts))
                _ = try await self.performRemoteRequest(
                    baseURL: config.baseURL,
                    path: "sync/\(self.app.rawValue)/ack",
                    method: "POST",
                    token: config.token,
                    body: ackBody
                )
            }

            let store = self.defaults()
            store.set(now, forKey: self.lastSyncKey)
            store.removeObject(forKey: self.lastErrorKey)
            let updatedReceipts = result.receipts.isEmpty
                ? self.cachedReceipts(from: store)
                : Self.mergeRecentReceipts(
                    incomingChronological: result.receipts,
                    existing: self.cachedReceipts(from: store)
                )
            self.persistCachedStatus(
                pendingInboxCount: 0,
                recentReceipts: updatedReceipts,
                to: store
            )
            return result
        } catch {
            if !Self.isCancellationError(error) {
                self.defaults().set(error.localizedDescription, forKey: self.lastErrorKey)
            }
            throw error
        }
    }

    func evaluateEnvelope(
        _ envelope: AgentInboxEnvelope,
        permission: AgentPermissionTier,
        policy: AgentPermissionPolicy? = nil,
        now: Date,
        handler: @Sendable (AgentInboxEnvelope) async -> AgentInboxOutcome
    ) async -> AgentReceipt {
        if envelope.schemaVersion != AgentProtocolConstants.schemaVersion {
            return AgentReceipt(
                requestId: envelope.requestId,
                app: self.app,
                operation: envelope.operation,
                status: .rejected,
                processedAt: now,
                errorCode: "unsupported_schema",
                errorMessage: "Unsupported schemaVersion: \(envelope.schemaVersion)"
            )
        }
        if envelope.app != self.app {
            return AgentReceipt(
                requestId: envelope.requestId,
                app: self.app,
                operation: envelope.operation,
                status: .rejected,
                processedAt: now,
                errorCode: "app_mismatch",
                errorMessage: "Expected app \(self.app.rawValue), got \(envelope.app.rawValue)"
            )
        }
        let resolvedPolicy = policy ?? AgentPermissionPolicy.preset(for: permission, app: self.app)
        if !permission.allows(operation: envelope.operation)
            || !resolvedPolicy.allows(operation: envelope.operation, app: self.app)
        {
            return AgentReceipt(
                requestId: envelope.requestId,
                app: self.app,
                operation: envelope.operation,
                status: .rejected,
                processedAt: now,
                errorCode: "permission_denied",
                errorMessage: "Current permission policy does not allow '\(envelope.operation)'."
            )
        }
        let outcome = await handler(envelope)
        return Self.makeReceipt(from: outcome, envelope: envelope, now: now)
    }

    private static func makeReceipt(
        from outcome: AgentInboxOutcome,
        envelope: AgentInboxEnvelope,
        now: Date
    ) -> AgentReceipt {
        switch outcome {
        case let .applied(recordId, stableId, summary, details):
            AgentReceipt(
                requestId: envelope.requestId,
                app: envelope.app,
                operation: envelope.operation,
                status: .applied,
                processedAt: now,
                recordId: recordId,
                stableId: stableId,
                summary: summary,
                details: details
            )
        case let .duplicate(recordId, stableId, summary, details):
            AgentReceipt(
                requestId: envelope.requestId,
                app: envelope.app,
                operation: envelope.operation,
                status: .duplicate,
                processedAt: now,
                recordId: recordId,
                stableId: stableId,
                summary: summary,
                details: details
            )
        case let .rejected(errorCode, message):
            AgentReceipt(
                requestId: envelope.requestId,
                app: envelope.app,
                operation: envelope.operation,
                status: .rejected,
                processedAt: now,
                errorCode: errorCode,
                errorMessage: message
            )
        case let .failed(errorCode, message):
            AgentReceipt(
                requestId: envelope.requestId,
                app: envelope.app,
                operation: envelope.operation,
                status: .failed,
                processedAt: now,
                errorCode: errorCode,
                errorMessage: message
            )
        }
    }

    private func remoteEndpointConfig() -> (baseURL: URL, token: String)? {
        guard let rawURL = self.defaults().string(forKey: self.remoteURLKey),
              let baseURL = try? Self.normalizedRemoteURL(rawURL),
              let token = self.tokenStorage.readToken(account: self.remoteTokenAccount)
        else {
            return nil
        }
        return (baseURL, token)
    }

    private func performRemoteRequest(
        baseURL: URL,
        path: String,
        method: String,
        token: String?,
        body: Data?
    ) async throws -> Data {
        let relative = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(baseURL.absoluteString)/\(relative)") else {
            throw AgentExchangeError.invalidRemoteURL("Unable to construct URL for '\(relative)'.")
        }

        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }

        let (data, response) = try await self.urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AgentExchangeError.remoteRequestFailed(statusCode: 0, message: "Non-HTTP response received.")
        }
        guard (200 ..< 300).contains(http.statusCode) else {
            let errorMessage = Self.extractRemoteErrorMessage(from: data)
                ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw AgentExchangeError.remoteRequestFailed(statusCode: http.statusCode, message: errorMessage)
        }
        return data
    }

    private static func extractRemoteErrorMessage(from data: Data) -> String? {
        guard !data.isEmpty,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = json["error"] as? String,
              !error.isEmpty
        else {
            return nil
        }
        return error
    }

    static func normalizedRemoteURL(_ raw: String) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = URL(string: trimmed),
              let scheme = parsed.scheme?.lowercased(),
              let host = parsed.host?.lowercased(),
              !host.isEmpty
        else {
            throw AgentExchangeError.invalidRemoteURL("Enter a valid endpoint URL starting with https://.")
        }

        let isLocalhost = host == "localhost" || host == "127.0.0.1" || host == "::1"
        guard scheme == "https" || (scheme == "http" && isLocalhost) else {
            throw AgentExchangeError.invalidRemoteURL(
                "Only https:// endpoints are allowed (http:// is restricted to localhost)."
            )
        }
        guard parsed.user == nil, parsed.password == nil else {
            throw AgentExchangeError.invalidRemoteURL(
                "Endpoint URL must not include embedded credentials. Use Bearer Token instead."
            )
        }

        guard var components = URLComponents(url: parsed, resolvingAgainstBaseURL: false) else {
            throw AgentExchangeError.invalidRemoteURL("Invalid URL format.")
        }
        components.query = nil
        components.fragment = nil
        var path = components.path
        while path.hasSuffix("/") {
            path.removeLast()
        }
        if path.hasSuffix("/mcp") {
            path.removeLast(4)
        }
        while path.hasSuffix("/") {
            path.removeLast()
        }
        components.path = path
        guard let finalURL = components.url else {
            throw AgentExchangeError.invalidRemoteURL("Invalid URL format.")
        }
        return finalURL
    }
}

@testable import CHAOXAgentKit
import Foundation
import Testing

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) static var handler: ((URLRequest, Data?) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let currentHandler: ((URLRequest, Data?) throws -> (Int, Data))? = Self.lock.withLock {
            Self.handler
        }

        let bodyData: Data? = {
            if let direct = self.request.httpBody {
                return direct
            }
            guard let stream = self.request.httpBodyStream else { return nil }
            stream.open()
            defer { stream.close() }
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let readCount = stream.read(&chunk, maxLength: chunk.count)
                if readCount > 0 {
                    buffer.append(chunk, count: readCount)
                } else {
                    break
                }
            }
            return buffer.isEmpty ? nil : buffer
        }()

        do {
            guard let currentHandler else {
                throw AgentExchangeError.remoteRequestFailed(statusCode: 500, message: "No stub configured")
            }
            let (statusCode, data) = try currentHandler(self.request, bodyData)
            let response = HTTPURLResponse(
                url: self.request.url!,
                statusCode: statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: data)
            self.client?.urlProtocolDidFinishLoading(self)
        } catch {
            self.client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@Suite("Remote AgentExchangeStore", .serialized)
struct RemoteExchangeStoreTests {
    private func makeStubSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    @Test("Validates remote URLs and rejects insecure non-localhost HTTP endpoints")
    func validatesRemoteURLs() async {
        let session = self.makeStubSession()
        let store = AgentExchangeStore(
            app: .sx,
            defaultsSuiteName: "RemoteTests.\(UUID().uuidString)",
            urlSession: session,
            inMemoryTokenStorage: true
        )

        await #expect(throws: AgentExchangeError.self) {
            try await store.saveRemoteConfiguration(urlString: "http://example.com", token: "abc")
        }
        #expect(throws: AgentExchangeError.self) {
            _ = try AgentExchangeStore.normalizedRemoteURL("https://user:pass@example.com")
        }
        #expect(throws: AgentExchangeError.self) {
            _ = try AgentExchangeStore.normalizedRemoteURL("https://user@example.com")
        }

        let defaultStore = AgentExchangeStore(app: .sx, inMemoryTokenStorage: true)
        let defaultConfig = await defaultStore.urlSession.configuration
        #expect(defaultConfig.urlCache == nil)
        #expect(defaultConfig.httpCookieStorage == nil)
        #expect(defaultConfig.httpShouldSetCookies == false)

        let stripped = try? AgentExchangeStore.normalizedRemoteURL("https://my.workers.dev/mcp/")
        #expect(stripped?.absoluteString == "https://my.workers.dev")
    }

    @Test("Tests connection, uploads snapshots, processes remote inbox, and acknowledges receipts")
    func remoteSyncEndToEndWithStub() async throws {
        let session = self.makeStubSession()
        let store = AgentExchangeStore(
            app: .sx,
            defaultsSuiteName: "RemoteTests.\(UUID().uuidString)",
            urlSession: session,
            inMemoryTokenStorage: true
        )

        final class ServerState: @unchecked Sendable {
            var uploadedCatalog = false
            var ackedIds: [String] = []
        }
        let serverState = ServerState()

        StubURLProtocol.handler = { req, body in
            #expect(req.cachePolicy == .reloadIgnoringLocalCacheData)
            #expect(req.httpShouldHandleCookies == false)
            let path = req.url?.path ?? ""
            let auth = req.value(forHTTPHeaderField: "Authorization")

            if path == "/health" {
                let data = Data(#"{"status":"ok","schemaVersion":"chaox-agent/v1","mode":"cloudflare-d1"}"#.utf8)
                return (200, data)
            }

            guard auth == "Bearer test-secret" else {
                return (401, Data(#"{"error":"Unauthorized"}"#.utf8))
            }

            if path == "/sync/sx/status" {
                let status = AgentRemoteStatusResponse(
                    schemaVersion: AgentProtocolConstants.schemaVersion,
                    app: .sx,
                    configured: true,
                    permission: .appendOnly,
                    lastSyncAt: Date(),
                    pendingInboxCount: 1,
                    recentReceipts: []
                )
                return (200, try AgentJSONCoding.encoder.encode(status))
            }

            if path == "/sync/sx/inbox" {
                let env = AgentInboxEnvelope(
                    requestId: "rem-1",
                    app: .sx,
                    operation: "record_expense",
                    createdAt: Date(),
                    payload: ["amount": .double(39.9), "projectName": .string("Daily Meals")]
                )
                let inbox = AgentRemoteInboxResponse(
                    schemaVersion: AgentProtocolConstants.schemaVersion,
                    app: .sx,
                    permission: .appendOnly,
                    envelopes: [env]
                )
                return (200, try AgentJSONCoding.encoder.encode(inbox))
            }

            if path == "/sync/sx/ack", let body {
                let ack = try AgentJSONCoding.decoder.decode(AgentRemoteAckRequest.self, from: body)
                serverState.ackedIds = ack.receipts.map(\.requestId)
                return (200, Data(#"{"ackedCount":1}"#.utf8))
            }

            if path == "/sync/sx/snapshot", let body {
                let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
                serverState.uploadedCatalog = json?["catalog"] != nil
                return (200, Data(#"{"schemaVersion":"chaox-agent/v1","app":"sx"}"#.utf8))
            }

            return (404, Data(#"{"error":"Not found"}"#.utf8))
        }

        await #expect(throws: AgentExchangeError.self) {
            try await store.testRemoteConnection(urlString: "https://chaox.workers.dev", token: "bad")
        }

        try await store.testRemoteConnection(urlString: "https://chaox.workers.dev/mcp", token: "test-secret")
        try await store.saveRemoteConfiguration(urlString: "https://chaox.workers.dev/mcp", token: "test-secret")

        let meta = AgentAppMetadata(
            app: .sx,
            bundleId: "ai.chaox.sx",
            appVersion: "1.0",
            capabilities: ["catalog", "summary", "record_expense"]
        )

        let runResult = try await store.processInbox { envelope in
            .applied(recordId: "55", stableId: "sx:55", summary: envelope.requestId)
        }
        #expect(runResult.appliedCount == 1)
        #expect(serverState.ackedIds == ["rem-1"])

        try await store.publishSnapshot(
            metadata: meta,
            catalog: ["summaryCurrency": "CNY"],
            summary: ["total": 39.9]
        )
        #expect(serverState.uploadedCatalog)

        let loadedStatus = await store.loadStatus()
        #expect(loadedStatus.isConfigured)
        #expect(loadedStatus.remoteEndpointURL == "https://chaox.workers.dev")
        #expect(loadedStatus.pendingInboxCount == 1)

        let cachedStatus = await store.cachedStatus()
        #expect(cachedStatus.isConfigured)
        #expect(cachedStatus.remoteEndpointURL == "https://chaox.workers.dev")
        #expect(cachedStatus.permission == .appendOnly)
        #expect(cachedStatus.tokenMode == .legacy)
    }

    @Test("loadStatus persists split tokenMode and resets it on clearRemoteConfiguration")
    func statusPersistsSplitTokenModeAndResetsOnClear() async throws {
        let store = AgentExchangeStore(
            app: .sx,
            defaultsSuiteName: "RemoteTests.\(UUID().uuidString)",
            urlSession: self.makeStubSession(),
            inMemoryTokenStorage: true
        )
        StubURLProtocol.handler = { req, _ in
            guard req.url?.path == "/sync/sx/status" else {
                return (200, Data(#"{"status":"ok"}"#.utf8))
            }
            let status = AgentRemoteStatusResponse(
                app: .sx,
                configured: true,
                permission: .readWrite,
                pendingInboxCount: 0,
                recentReceipts: [],
                tokenMode: .split
            )
            return (200, try AgentJSONCoding.encoder.encode(status))
        }

        try await store.saveRemoteConfiguration(urlString: "https://agent.example.com", token: "sync-only-tok")
        let loaded = await store.loadStatus()
        #expect(loaded.tokenMode == .split)
        let cached = await store.cachedStatus()
        #expect(cached.tokenMode == .split)

        await store.clearRemoteConfiguration()
        let cleared = await store.cachedStatus()
        #expect(!cleared.isConfigured)
        #expect(cleared.tokenMode == .legacy)
        #expect(!cleared.hasSavedMCPToken)
        #expect(await store.savedMCPToken() == nil)
    }

    @Test("testRemoteConnection verifies optional mcpToken against /mcp ping and saveRemoteConfiguration preserves or replaces it")
    func testAndPersistOptionalMCPToken() async throws {
        let store = AgentExchangeStore(
            app: .sx,
            defaultsSuiteName: "RemoteTests.\(UUID().uuidString)",
            urlSession: self.makeStubSession(),
            inMemoryTokenStorage: true
        )

        final class Capture: @unchecked Sendable {
            var mcpPingAuths: [String?] = []
        }
        let capture = Capture()

        StubURLProtocol.handler = { req, _ in
            let path = req.url?.path ?? ""
            if path == "/health" {
                return (200, Data(#"{"status":"ok","schemaVersion":"chaox-agent/v1","mode":"cloudflare-d1"}"#.utf8))
            }
            if path == "/sync/sx/status" {
                let status = AgentRemoteStatusResponse(
                    app: .sx,
                    configured: true,
                    permission: .readWrite,
                    tokenMode: .split
                )
                return (200, try AgentJSONCoding.encoder.encode(status))
            }
            if path == "/mcp" {
                let auth = req.value(forHTTPHeaderField: "Authorization")
                capture.mcpPingAuths.append(auth)
                if auth == "Bearer mcp-good-token" {
                    return (200, Data(#"{"jsonrpc":"2.0","id":1,"result":{}}"#.utf8))
                }
                return (403, Data(#"{"error":"Forbidden"}"#.utf8))
            }
            return (404, Data(#"{}"#.utf8))
        }

        // Swapped/invalid MCP token fails fast with clear error.
        await #expect(throws: AgentExchangeError.self) {
            try await store.testRemoteConnection(
                urlString: "https://agent.example.com",
                token: "sync-token-123",
                mcpToken: "sync-token-123",
                reuseSavedToken: false
            )
        }

        try await store.testRemoteConnection(
            urlString: "https://agent.example.com",
            token: "sync-token-123",
            mcpToken: "mcp-good-token",
            reuseSavedToken: false
        )
        #expect(capture.mcpPingAuths.last == "Bearer mcp-good-token")

        try await store.saveRemoteConfiguration(
            urlString: "https://agent.example.com",
            token: "sync-token-123",
            mcpToken: "mcp-good-token"
        )
        #expect(await store.hasSavedMCPToken())
        #expect(await store.savedMCPToken() == "mcp-good-token")
        #expect(await store.cachedStatus().hasSavedMCPToken)

        // Blank mcpToken during reuseSavedToken preserves existing MCP token.
        try await store.saveRemoteConfiguration(
            urlString: "https://agent.example.com",
            token: "",
            mcpToken: "",
            reuseSavedToken: true
        )
        #expect(await store.savedMCPToken() == "mcp-good-token")

        await store.clearRemoteConfiguration()
        #expect(await store.savedMCPToken() == nil)
        #expect(!(await store.cachedStatus().hasSavedMCPToken))
    }

    @Test("cachedStatus returns offline configuration without network calls")
    func cachedStatusWithoutNetwork() async throws {
        StubURLProtocol.handler = { _, _ in
            Issue.record("cachedStatus should never hit the network")
            throw AgentExchangeError.remoteRequestFailed(statusCode: 500, message: "unexpected")
        }

        let store = AgentExchangeStore(
            app: .bx,
            defaultsSuiteName: "RemoteTests.\(UUID().uuidString)",
            urlSession: self.makeStubSession(),
            inMemoryTokenStorage: true
        )
        let unconfigured = await store.cachedStatus()
        #expect(!unconfigured.isConfigured)
        #expect(unconfigured.permission == .disabled)
        #expect(unconfigured.remoteEndpointURL == nil)

        try await store.saveRemoteConfiguration(
            urlString: "https://chaox.workers.dev/mcp/",
            token: "tok-12345678",
            defaultPermission: .readWrite
        )
        let configured = await store.cachedStatus()
        #expect(configured.isConfigured)
        #expect(configured.permission == .readWrite)
        #expect(configured.remoteEndpointURL == "https://chaox.workers.dev")
    }

    @Test("AgentEndpointParser extracts URL and token across single values, snippets, and JSON")
    func endpointParserHandlesCommonPasteFormats() {
        let plainURL = AgentEndpointParser.parse("https://worker.example.workers.dev/mcp/")
        #expect(plainURL.url == "https://worker.example.workers.dev")
        #expect(plainURL.token == nil)

        let plainToken = AgentEndpointParser.parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        #expect(plainToken.url == nil)
        #expect(plainToken.token == "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")

        let bearerOnly = AgentEndpointParser.parse("Authorization: Bearer short-dev-token-99")
        #expect(bearerOnly.url == nil)
        #expect(bearerOnly.token == "short-dev-token-99")

        let multiLine = AgentEndpointParser.parse("""
        Endpoint URL: https://chaox-agent.user.workers.dev
        Bearer Token: abcdef0123456789abcdef0123456789
        """)
        #expect(multiLine.url == "https://chaox-agent.user.workers.dev")
        #expect(multiLine.token == "abcdef0123456789abcdef0123456789")

        let jsonSnippet = AgentEndpointParser.parse("""
        {
          "mcpServers": {
            "chaox-agent": {
              "url": "https://chaox.workers.dev/mcp",
              "headers": {
                "Authorization": "Bearer json_token_0123456789abcdef"
              }
            }
          }
        }
        """)
        #expect(jsonSnippet.url == "https://chaox.workers.dev")
        #expect(jsonSnippet.token == "json_token_0123456789abcdef")

        #expect(AgentEndpointParser.displayHost(for: "http://localhost:8787/mcp") == "localhost:8787")
        #expect(AgentEndpointParser.displayHost(for: "https://chaox.workers.dev/mcp") == "chaox.workers.dev")
        #expect(AgentEndpointParser.mcpEndpointString(for: "https://chaox.workers.dev/") == "https://chaox.workers.dev/mcp")
    }

    @Test("Rejects writes in readOnly, skips network in disabled, and clears legacy keys on disconnect")
    func enforcesPermissionsAndClearsLegacyKeys() async throws {
        let suiteName = "RemoteTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.set(Data([1, 2, 3]), forKey: "chaox.agent.bx.folderBookmark")
        defaults.set("CHAOX-Agent", forKey: "chaox.agent.bx.folderName")
        defaults.set("folder", forKey: "chaox.agent.bx.transportMode")

        let session = self.makeStubSession()
        let store = AgentExchangeStore(
            app: .bx,
            defaultsSuiteName: suiteName,
            urlSession: session,
            inMemoryTokenStorage: true
        )

        final class ServerState: @unchecked Sendable {
            var requestCount = 0
            var ackedReceipts: [AgentReceipt] = []
        }
        let serverState = ServerState()

        StubURLProtocol.handler = { req, body in
            serverState.requestCount += 1
            let path = req.url?.path ?? ""
            if path == "/sync/bx/inbox" {
                let env = AgentInboxEnvelope(
                    requestId: "ro-1",
                    app: .bx,
                    operation: "record_food",
                    createdAt: Date(),
                    payload: ["name": .string("Salad")]
                )
                let inbox = AgentRemoteInboxResponse(
                    schemaVersion: AgentProtocolConstants.schemaVersion,
                    app: .bx,
                    permission: .readOnly,
                    envelopes: [env]
                )
                return (200, try AgentJSONCoding.encoder.encode(inbox))
            }
            if path == "/sync/bx/ack", let body {
                let ack = try AgentJSONCoding.decoder.decode(AgentRemoteAckRequest.self, from: body)
                serverState.ackedReceipts = ack.receipts
                return (200, Data(#"{"ackedCount":1}"#.utf8))
            }
            return (404, Data(#"{"error":"Not found"}"#.utf8))
        }

        try await store.saveRemoteConfiguration(
            urlString: "https://chaox.workers.dev",
            token: "secret",
            defaultPermission: .readOnly
        )
        #expect(defaults.object(forKey: "chaox.agent.bx.folderBookmark") == nil)
        #expect(defaults.object(forKey: "chaox.agent.bx.folderName") == nil)
        #expect(defaults.object(forKey: "chaox.agent.bx.transportMode") == nil)

        let readOnlyRun = try await store.processInbox { _ in
            Issue.record("Handler should not run in readOnly mode")
            return .failed(errorCode: "unexpected", message: "unexpected")
        }
        #expect(readOnlyRun.rejectedCount == 1)
        #expect(readOnlyRun.receipts.first?.errorCode == "permission_denied")
        #expect(serverState.ackedReceipts.first?.status == .rejected)
        #expect(serverState.ackedReceipts.first?.errorCode == "permission_denied")

        await store.setPermission(.disabled)
        let beforeDisabledCalls = serverState.requestCount
        let disabledRun = try await store.processInbox { _ in
            Issue.record("Handler should not run when disabled")
            return .failed(errorCode: "unexpected", message: "unexpected")
        }
        #expect(disabledRun.processedCount == 0)
        #expect(serverState.requestCount == beforeDisabledCalls)

        // Re-seed legacy keys before clearing to ensure clearRemoteConfiguration scrubs them too.
        defaults.set(Data([9]), forKey: "chaox.agent.bx.folderBookmark")
        defaults.set("Legacy", forKey: "chaox.agent.bx.folderName")
        defaults.set("folder", forKey: "chaox.agent.bx.transportMode")

        await store.clearRemoteConfiguration()
        let clearedStatus = await store.loadStatus()
        #expect(!clearedStatus.isConfigured)
        #expect(clearedStatus.permission == .disabled)
        #expect(await !store.hasSavedRemoteToken())
        #expect(await store.savedRemoteURLString() == nil)
        #expect(defaults.object(forKey: "chaox.agent.bx.folderBookmark") == nil)
        #expect(defaults.object(forKey: "chaox.agent.bx.folderName") == nil)
        #expect(defaults.object(forKey: "chaox.agent.bx.transportMode") == nil)
    }

    @Test("AgentPermissionPolicy enforces granular operations, delete opt-in, domain scopes, and wipe")
    func granularPolicyAndCloudWipe() async throws {
        let suiteName = "PolicyTests.\(UUID().uuidString)"
        let store = AgentExchangeStore(
            app: .sx,
            defaultsSuiteName: suiteName,
            urlSession: self.makeStubSession(),
            inMemoryTokenStorage: true
        )

        var rwPreset = AgentPermissionPolicy.preset(for: .readWrite, app: .sx, consentAcknowledged: true)
        #expect(rwPreset.allowRead)
        #expect(rwPreset.allowCreate)
        #expect(rwPreset.allowUpdate)
        #expect(!rwPreset.allowDelete)
        #expect(rwPreset.allows(operation: "update_expense", app: .sx))
        #expect(!rwPreset.allows(operation: "delete_expense", app: .sx))
        #expect(rwPreset.derivedTier == .readWrite)

        rwPreset.allowedDomains = ["expenses", "projects"]
        #expect(!rwPreset.allows(operation: "record_income", app: .sx))
        #expect(rwPreset.allows(operation: "create_project", app: .sx))
        #expect(!AgentAppID.sx.defaultDomains.contains("credentials"))
        #expect(!rwPreset.allows(operation: "create_credential", app: .sx))
        #expect(!rwPreset.allows(operation: "link_credential", app: .sx))

        var optedInCredentials = rwPreset
        optedInCredentials.allowedDomains.append("credentials")
        #expect(optedInCredentials.allows(operation: "create_credential", app: .sx))
        #expect(optedInCredentials.allows(operation: "update_credential_link", app: .sx))
        #expect(!optedInCredentials.allows(operation: "delete_credential", app: .sx))
        #expect(!optedInCredentials.allows(operation: "unlink_credential", app: .sx))

        final class ServerState: @unchecked Sendable {
            var deleteCalled = false
            var uploadedPolicyDelete = true
            var uploadedNullTagsDataset = false
            var ackedStatuses: [AgentReceiptStatus] = []
        }
        let serverState = ServerState()

        StubURLProtocol.handler = { req, body in
            #expect(req.cachePolicy == .reloadIgnoringLocalCacheData)
            #expect(req.httpShouldHandleCookies == false)
            let path = req.url?.path ?? ""
            let method = req.httpMethod ?? "GET"

            if path == "/sync/sx/snapshot", method == "PUT", let body {
                let rawString = String(data: body, encoding: .utf8) ?? ""
                #expect(!rawString.contains("\n  "))
                let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
                if let policyObj = json?["policy"] as? [String: Any] {
                    serverState.uploadedPolicyDelete = (policyObj["allowDelete"] as? Bool) ?? true
                }
                if let datasets = json?["datasets"] as? [String: Any] {
                    serverState.uploadedNullTagsDataset = datasets["tags"] is NSNull
                }
                return (200, Data(#"{"schemaVersion":"chaox-agent/v1","app":"sx"}"#.utf8))
            }

            if path == "/sync/sx/inbox", method == "GET" {
                let env1 = AgentInboxEnvelope(
                    requestId: "del-exp-1",
                    app: .sx,
                    operation: "delete_expense",
                    createdAt: Date(),
                    payload: ["id": .int(1)]
                )
                let env2 = AgentInboxEnvelope(
                    requestId: "inc-blocked-1",
                    app: .sx,
                    operation: "record_income",
                    createdAt: Date(),
                    payload: ["amount": .double(100), "projectName": .string("Salary")]
                )
                let env3 = AgentInboxEnvelope(
                    requestId: "upd-exp-1",
                    app: .sx,
                    operation: "update_expense",
                    createdAt: Date(),
                    payload: ["id": .int(2), "amount": .double(50)]
                )
                let inbox = AgentRemoteInboxResponse(
                    app: .sx,
                    permission: .readWrite,
                    envelopes: [env1, env2, env3]
                )
                return (200, try AgentJSONCoding.encoder.encode(inbox))
            }

            if path == "/sync/sx/ack", method == "POST", let body {
                let ack = try AgentJSONCoding.decoder.decode(AgentRemoteAckRequest.self, from: body)
                serverState.ackedStatuses = ack.receipts.map(\.status)
                return (200, Data(#"{"ackedCount":3}"#.utf8))
            }

            if path == "/sync/sx/data", method == "DELETE" {
                serverState.deleteCalled = true
                return (200, Data(#"{"wiped":true}"#.utf8))
            }

            return (404, Data(#"{"error":"Not found"}"#.utf8))
        }

        try await store.saveRemoteConfiguration(
            urlString: "https://chaox.workers.dev",
            token: "tok-1234",
            policy: rwPreset
        )
        let meta = AgentAppMetadata(app: .sx, bundleId: "ai.chaox.sx", appVersion: "1.0", capabilities: [])
        try await store.publishSnapshot(
            metadata: meta,
            catalog: ["summaryCurrency": "CNY"],
            summary: ["total": 0],
            datasets: ["tags": .null, "expenses": .array([])]
        )
        #expect(!serverState.uploadedPolicyDelete)
        #expect(serverState.uploadedNullTagsDataset)

        let run = try await store.processInbox { env in
            .applied(recordId: "2", stableId: nil, summary: env.requestId)
        }
        #expect(run.rejectedCount == 2)
        #expect(run.appliedCount == 1)
        #expect(serverState.ackedStatuses == [.rejected, .rejected, .applied])

        try await store.wipeRemoteAndClearConfiguration()
        #expect(serverState.deleteCalled)
        #expect(await !store.isConfigured())
        #expect(await store.currentPermission() == .disabled)
    }

    @Test("Reuses saved token for connection tests and URL updates without rewriting storage")
    func reusesSavedTokenForTestAndSave() async throws {
        final class SpyTokenStorage: AgentTokenStorage, @unchecked Sendable {
            private let lock = NSLock()
            private var tokens: [String: String] = [:]
            var saveCallCount = 0

            func readToken(account: String) -> String? {
                self.lock.withLock { self.tokens[account] }
            }

            func saveToken(_ token: String, account: String) throws {
                self.lock.withLock {
                    self.saveCallCount += 1
                    self.tokens[account] = token
                }
            }

            func deleteToken(account: String) {
                self.lock.withLock {
                    _ = self.tokens.removeValue(forKey: account)
                }
            }
        }

        let suiteName = "TokenReuseTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let spyStorage = SpyTokenStorage()
        let store = AgentExchangeStore(
            app: .sx,
            defaultsSuiteName: suiteName,
            urlSession: self.makeStubSession(),
            tokenStorage: spyStorage
        )

        #expect(await store.savedRemoteToken() == nil)

        await #expect(throws: AgentExchangeError.self) {
            try await store.testRemoteConnection(
                urlString: "https://chaox.workers.dev",
                token: "",
                reuseSavedToken: true
            )
        }
        await #expect(throws: AgentExchangeError.self) {
            try await store.saveRemoteConfiguration(
                urlString: "https://chaox.workers.dev",
                token: "   ",
                reuseSavedToken: true
            )
        }

        final class ServerState: @unchecked Sendable {
            var observedHosts: [String] = []
            var observedAuths: [String?] = []
        }
        let serverState = ServerState()

        StubURLProtocol.handler = { req, _ in
            let path = req.url?.path ?? ""
            if path == "/health" {
                return (200, Data(#"{"status":"ok","schemaVersion":"chaox-agent/v1"}"#.utf8))
            }
            if path == "/sync/sx/status" {
                serverState.observedHosts.append(req.url?.host ?? "")
                serverState.observedAuths.append(req.value(forHTTPHeaderField: "Authorization"))
                let status = AgentRemoteStatusResponse(
                    app: .sx,
                    configured: true,
                    permission: .readWrite
                )
                return try (200, AgentJSONCoding.encoder.encode(status))
            }
            return (404, Data(#"{"error":"Not found"}"#.utf8))
        }

        let customPolicy = AgentPermissionPolicy(
            allowRead: true,
            allowCreate: true,
            allowUpdate: true,
            allowDelete: false,
            allowedDomains: ["expenses", "projects"],
            consentAcknowledged: true
        )
        try await store.saveRemoteConfiguration(
            urlString: "https://old.workers.dev/mcp",
            token: "saved-secret-token",
            policy: customPolicy
        )
        #expect(await store.savedRemoteToken() == "saved-secret-token")
        #expect(spyStorage.saveCallCount == 1)

        // Default reuseSavedToken: false still rejects an empty input token even when one is saved.
        await #expect(throws: AgentExchangeError.self) {
            try await store.testRemoteConnection(urlString: "https://new.workers.dev", token: "")
        }

        // Passing an explicit new token while reuseSavedToken: true uses the new input token.
        try await store.testRemoteConnection(
            urlString: "https://new.workers.dev",
            token: "override-token",
            reuseSavedToken: true
        )
        #expect(serverState.observedAuths.last == "Bearer override-token")

        // Empty token with reuseSavedToken: true uses the saved Keychain token.
        try await store.testRemoteConnection(
            urlString: "https://new.workers.dev/mcp/",
            token: "  \n ",
            reuseSavedToken: true
        )
        #expect(serverState.observedHosts.last == "new.workers.dev")
        #expect(serverState.observedAuths.last == "Bearer saved-secret-token")

        // Verify URL-only save leaves token storage untouched, clears lastError, and preserves policy.
        defaults.set("Transient network failure", forKey: "chaox.agent.sx.lastError")
        try await store.saveRemoteConfiguration(
            urlString: "https://new.workers.dev/mcp",
            token: "",
            reuseSavedToken: true
        )
        #expect(spyStorage.saveCallCount == 1)
        #expect(await store.savedRemoteToken() == "saved-secret-token")
        #expect(await store.savedRemoteURLString() == "https://new.workers.dev")
        #expect(await store.cachedStatus().lastError == nil)
        #expect(await store.currentPolicy().allowedDomains == ["expenses", "projects"])
        #expect(await store.currentPolicy().allowUpdate)

        await store.clearRemoteConfiguration()
        #expect(await store.savedRemoteToken() == nil)
    }

    @Test("Persists cached pending count and up to 10 receipts and updates on inbox sync")
    func cachesReceiptsAndPendingCount() async throws {
        let suiteName = "CachedReceiptsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let store = AgentExchangeStore(
            app: .sx,
            defaultsSuiteName: suiteName,
            urlSession: self.makeStubSession(),
            inMemoryTokenStorage: true
        )

        let serverReceipts = Self.makeSampleReceipts(count: 12)

        final class ServerState: @unchecked Sendable {
            var shouldFailStatus = false
            var envelopes: [AgentInboxEnvelope] = []
        }
        let serverState = ServerState()

        StubURLProtocol.handler = { req, _ in
            let path = req.url?.path ?? ""
            if path == "/sync/sx/status" {
                if serverState.shouldFailStatus {
                    return (503, Data(#"{"error":"Worker unavailable"}"#.utf8))
                }
                let status = AgentRemoteStatusResponse(
                    app: .sx,
                    configured: true,
                    permission: .appendOnly,
                    lastSyncAt: Date(),
                    pendingInboxCount: 3,
                    recentReceipts: serverReceipts
                )
                return try (200, AgentJSONCoding.encoder.encode(status))
            }
            if path == "/sync/sx/inbox" {
                let inbox = AgentRemoteInboxResponse(
                    app: .sx,
                    permission: .appendOnly,
                    envelopes: serverState.envelopes
                )
                return try (200, AgentJSONCoding.encoder.encode(inbox))
            }
            if path == "/sync/sx/ack" {
                return (200, Data(#"{"ackedCount":2}"#.utf8))
            }
            return (404, Data(#"{"error":"Not found"}"#.utf8))
        }

        try await store.saveRemoteConfiguration(urlString: "https://chaox.workers.dev", token: "tok-123")

        // Loading status persists pendingInboxCount and caps cached receipts at 10.
        let loaded = await store.loadStatus(receiptLimit: 12)
        #expect(loaded.pendingInboxCount == 3)
        #expect(loaded.recentReceipts.count == 12)
        #expect(loaded.attentionReceiptCount == 1)
        #expect(loaded.hasAttentionIssue)

        let cachedAfterLoad = await store.cachedStatus()
        #expect(cachedAfterLoad.pendingInboxCount == 3)
        #expect(cachedAfterLoad.recentReceipts.count == 10)
        #expect(cachedAfterLoad.recentReceipts.map(\.requestId) == (1 ... 10).map { "req-\($0)" })
        #expect(cachedAfterLoad.attentionReceiptCount == 1)
        #expect(cachedAfterLoad.hasAttentionIssue)

        // Offline/error status preserves cached pendingInboxCount and recentReceipts while surfacing lastError.
        serverState.shouldFailStatus = true
        let offlineStatus = await store.loadStatus()
        #expect(offlineStatus.lastError != nil)
        #expect(offlineStatus.pendingInboxCount == 3)
        #expect(offlineStatus.recentReceipts.count == 10)
        #expect(offlineStatus.hasAttentionIssue)

        // Processing inbox clears pendingInboxCount and prepends new receipts newest-first (capped at 10).
        serverState.shouldFailStatus = false
        serverState.envelopes = [
            AgentInboxEnvelope(
                requestId: "new-1",
                app: .sx,
                operation: "record_expense",
                payload: ["amount": .double(10)]
            ),
            AgentInboxEnvelope(
                requestId: "new-2",
                app: .sx,
                operation: "record_expense",
                payload: ["amount": .double(20)]
            )
        ]
        let runResult = try await store.processInbox { env in
            if env.requestId == "new-2" {
                return .rejected(errorCode: "missing_project", message: "Project not found")
            }
            return .applied(recordId: "99", stableId: "sx:99", summary: env.requestId)
        }
        #expect(runResult.appliedCount == 1)
        #expect(runResult.rejectedCount == 1)

        let cachedAfterInbox = await store.cachedStatus()
        #expect(cachedAfterInbox.pendingInboxCount == 0)
        #expect(cachedAfterInbox.recentReceipts.count == 10)
        #expect(cachedAfterInbox.recentReceipts.first?.requestId == "new-2")
        #expect(cachedAfterInbox.recentReceipts.dropFirst().first?.requestId == "new-1")
        // First 6 are: new-2 (rejected), new-1 (applied), req-1 (applied), req-2 (failed), req-3, req-4
        #expect(cachedAfterInbox.attentionReceiptCount == 2)
        #expect(cachedAfterInbox.hasAttentionIssue)

        // Empty inbox run still clears pendingInboxCount without dropping cached receipts.
        serverState.envelopes = []
        _ = try await store.processInbox { _ in
            Issue.record("No envelopes expected")
            return .failed(errorCode: "unexpected", message: "unexpected")
        }
        let cachedAfterEmptyInbox = await store.cachedStatus()
        #expect(cachedAfterEmptyInbox.pendingInboxCount == 0)
        #expect(cachedAfterEmptyInbox.recentReceipts.count == 10)

        // Clearing configuration wipes cached pending count and receipt keys.
        await store.clearRemoteConfiguration()
        #expect(defaults.object(forKey: "chaox.agent.sx.pendingInboxCount") == nil)
        #expect(defaults.object(forKey: "chaox.agent.sx.recentReceipts") == nil)
        let cleared = await store.cachedStatus()
        #expect(cleared.pendingInboxCount == 0)
        #expect(cleared.recentReceipts.isEmpty)
        #expect(cleared.attentionReceiptCount == 0)
        #expect(!cleared.hasAttentionIssue)
    }

    @Test("Task and URL cancellation errors never overwrite or pollute lastError")
    func cancellationDoesNotPolluteLastError() async throws {
        let suiteName = "CancellationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let store = AgentExchangeStore(
            app: .sx,
            defaultsSuiteName: suiteName,
            urlSession: self.makeStubSession(),
            inMemoryTokenStorage: true
        )

        final class ServerState: @unchecked Sendable {
            var nextError: (any Error)? = URLError(.cancelled)
        }
        let serverState = ServerState()

        StubURLProtocol.handler = { _, _ in
            if let error = serverState.nextError {
                throw error
            }
            return (503, Data(#"{"error":"Service unavailable"}"#.utf8))
        }

        try await store.saveRemoteConfiguration(urlString: "https://chaox.workers.dev", token: "tok-123")
        let meta = AgentAppMetadata(app: .sx, bundleId: "ai.chaox.sx", appVersion: "1.0", capabilities: [])

        // Verify URLError(.cancelled) leaves clean lastError as nil across all 3 paths.
        serverState.nextError = URLError(.cancelled)
        let cancelledStatus = await store.loadStatus()
        #expect(cancelledStatus.lastError == nil)

        await #expect(throws: Error.self) {
            try await store.publishSnapshot(metadata: meta, catalog: ["k": "v"], summary: ["k": "v"])
        }
        #expect(await store.cachedStatus().lastError == nil)

        await #expect(throws: Error.self) {
            try await store.processInbox { _ in
                .failed(errorCode: "unexpected", message: "unexpected")
            }
        }
        #expect(await store.cachedStatus().lastError == nil)

        // Verify a cancelled Swift Task also leaves lastError untouched, even when preserving an existing error.
        defaults.set("Prior sync error", forKey: "chaox.agent.sx.lastError")
        let cancelledTask = Task {
            let status = await store.loadStatus()
            #expect(status.lastError == "Prior sync error")
            do {
                try await store.publishSnapshot(metadata: meta, catalog: ["k": "v"], summary: ["k": "v"])
                Issue.record("Expected cancelled publishSnapshot to throw")
            } catch {
                // Expected cancellation error.
            }
            do {
                _ = try await store.processInbox { _ in
                    .failed(errorCode: "unexpected", message: "unexpected")
                }
                Issue.record("Expected cancelled processInbox to throw")
            } catch {
                // Expected cancellation error.
            }
        }
        cancelledTask.cancel()
        await cancelledTask.value
        #expect(await store.cachedStatus().lastError == "Prior sync error")

        // Non-cancellation failures still update lastError normally.
        serverState.nextError = nil
        await #expect(throws: AgentExchangeError.self) {
            try await store.publishSnapshot(metadata: meta, catalog: ["k": "v"], summary: ["k": "v"])
        }
        let persistedError = try #require(await store.cachedStatus().lastError)
        #expect(persistedError.contains("Service unavailable"))
    }

    @Test("Enforces CSTEIX default domains, opt-in places exclusion, and Wuxu policy rules")
    func csteixPolicyRulesAndDefaultDomains() {
        #expect(AgentAppID.csteix.defaultDomains == ["wuxu", "dwell", "meditation", "marks"])
        #expect(!AgentAppID.csteix.defaultDomains.contains("places"))

        #expect(AgentPermissionTier.appendOnly.allows(operation: "create_wuxu"))
        #expect(!AgentPermissionTier.appendOnly.allows(operation: "update_wuxu"))
        #expect(!AgentPermissionTier.appendOnly.allows(operation: "delete_wuxu"))

        var rwPolicy = AgentPermissionPolicy.preset(for: .readWrite, app: .csteix, consentAcknowledged: true)
        #expect(rwPolicy.allowedDomains == ["wuxu", "dwell", "meditation", "marks"])
        #expect(rwPolicy.allows(operation: "create_wuxu", app: .csteix))
        #expect(rwPolicy.allows(operation: "update_wuxu", app: .csteix))
        #expect(rwPolicy.allows(operation: "restore_wuxu", app: .csteix))
        #expect(!rwPolicy.allows(operation: "delete_wuxu", app: .csteix))

        // Read-only CSTEIX domains never permit mutation operations.
        #expect(!rwPolicy.allows(operation: "delete_dwell", app: .csteix))
        #expect(!rwPolicy.allows(operation: "update_meditation", app: .csteix))
        #expect(!rwPolicy.allows(operation: "create_mark", app: .csteix))

        // Opting into allowDelete enables delete_wuxu.
        rwPolicy.allowDelete = true
        #expect(rwPolicy.allows(operation: "delete_wuxu", app: .csteix))

        // Turning off the 'wuxu' domain blocks all Wuxu operations.
        rwPolicy.allowedDomains = ["dwell", "meditation", "marks"]
        #expect(!rwPolicy.allows(operation: "create_wuxu", app: .csteix))
        #expect(!rwPolicy.allows(operation: "update_wuxu", app: .csteix))
        #expect(!rwPolicy.allows(operation: "delete_wuxu", app: .csteix))
        #expect(!rwPolicy.allows(operation: "restore_wuxu", app: .csteix))
    }

    @Test("fetchWuxuDelta builds sync/csteix/wuxu query URLs and decodes active and soft-deleted articles")
    func fetchWuxuDeltaDecodesArticlesAndQueryParams() async throws {
        let suiteName = "CsteixWuxuTests.\(UUID().uuidString)"
        let store = AgentExchangeStore(
            app: .csteix,
            defaultsSuiteName: suiteName,
            urlSession: self.makeStubSession(),
            inMemoryTokenStorage: true
        )

        // Unconfigured store throws AgentExchangeError.notConfigured.
        await #expect(throws: AgentExchangeError.self) {
            _ = try await store.fetchWuxuDelta()
        }

        final class CapturedRequests: @unchecked Sendable {
            var pathsAndQueries: [String] = []
            var authHeaders: [String?] = []
        }
        let captured = CapturedRequests()

        StubURLProtocol.handler = { req, _ in
            let url = try #require(req.url)
            let pathWithQuery = if let query = url.query {
                "\(url.path)?\(query)"
            } else {
                url.path
            }
            captured.pathsAndQueries.append(pathWithQuery)
            captured.authHeaders.append(req.value(forHTTPHeaderField: "Authorization"))

            let json = """
            {
              "schemaVersion": "chaox-agent/v1",
              "app": "csteix",
              "syncedAt": "2026-11-22T06:00:00.250Z",
              "totalCount": 1,
              "articles": [
                {
                  "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                  "slug": "bare-treetops",
                  "title": "Bare Treetops",
                  "titleEn": "Bare Treetops EN",
                  "dimensions": ["existence"],
                  "writtenAt": "2026-11-21T11:42:00.000Z",
                  "timezone": "Asia/Shanghai",
                  "bodyZh": "Opening paragraph.",
                  "bodyEn": "Opening paragraph EN.",
                  "rawNotes": "Raw note line.",
                  "revision": 2,
                  "deletedAt": null,
                  "createdAt": "2026-11-21T11:42:00.000Z",
                  "updatedAt": "2026-11-22T05:30:00.500Z"
                },
                {
                  "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                  "slug": "retired-draft",
                  "title": "Retired Draft",
                  "titleEn": null,
                  "dimensions": ["chaos", "ix"],
                  "writtenAt": "2026-11-20T05:36:00Z",
                  "timezone": "Asia/Shanghai",
                  "bodyZh": "Old body.",
                  "bodyEn": null,
                  "rawNotes": null,
                  "revision": 3,
                  "deletedAt": "2026-11-22T05:45:00.000Z",
                  "createdAt": "2026-11-20T05:36:00Z",
                  "updatedAt": "2026-11-22T05:45:00.000Z"
                }
              ]
            }
            """
            return (200, Data(json.utf8))
        }

        try await store.saveRemoteConfiguration(
            urlString: "https://chaox.workers.dev/mcp/",
            token: "csteix-secret-token"
        )

        // Full delta sync (since == nil, includeDeleted == true).
        let fullResponse = try await store.fetchWuxuDelta()
        #expect(fullResponse.schemaVersion == AgentProtocolConstants.schemaVersion)
        #expect(fullResponse.app == .csteix)
        #expect(fullResponse.totalCount == 1)
        #expect(fullResponse.articles.count == 2)
        #expect(fullResponse.articles[0].slug == "bare-treetops")
        #expect(fullResponse.articles[0].titleEn == "Bare Treetops EN")
        #expect(fullResponse.articles[0].dimensions == ["existence"])
        #expect(fullResponse.articles[0].rawNotes == "Raw note line.")
        #expect(fullResponse.articles[0].revision == 2)
        #expect(fullResponse.articles[0].deletedAt == nil)
        #expect(fullResponse.articles[1].slug == "retired-draft")
        #expect(fullResponse.articles[1].deletedAt != nil)
        #expect(captured.pathsAndQueries.last == "/sync/csteix/wuxu?includeDeleted=1")
        #expect(captured.authHeaders.last == "Bearer csteix-secret-token")

        // Incremental delta sync with explicit since cursor and includeDeleted == false.
        let cursor = Date(timeIntervalSince1970: 1_795_327_200.125)
        _ = try await store.fetchWuxuDelta(since: cursor, includeDeleted: false)
        let lastRequest = try #require(captured.pathsAndQueries.last)
        let components = try #require(URLComponents(string: "https://chaox.workers.dev\(lastRequest)"))
        #expect(components.path == "/sync/csteix/wuxu")
        let queryMap = Dictionary(
            uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") }
        )
        #expect(queryMap["includeDeleted"] == "0")
        let sentSince = try #require(queryMap["since"])
        let parsedSince = ISO8601DateFormatter()
        parsedSince.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let decodedCursor = try #require(parsedSince.date(from: sentSince))
        #expect(abs(decodedCursor.timeIntervalSince(cursor)) < 0.001)
    }

    private static func makeSampleReceipts(count: Int) -> [AgentReceipt] {
        (1 ... count).map { index in
            let receiptStatus: AgentReceiptStatus = switch index {
            case 2: .failed
            case 8: .rejected
            default: .applied
            }
            let errorCode: String? = switch index {
            case 2: "db_error"
            case 8: "invalid_currency"
            default: nil
            }
            let errorMessage: String? = switch index {
            case 2: "Disk busy"
            case 8: "Unknown currency"
            default: nil
            }
            return AgentReceipt(
                requestId: "req-\(index)",
                app: .sx,
                operation: "record_expense",
                status: receiptStatus,
                processedAt: Date(timeIntervalSince1970: Double(1000 - index)),
                summary: "Expense \(index)",
                errorCode: errorCode,
                errorMessage: errorMessage
            )
        }
    }
}

@testable import CHAOXAgentKit
import Foundation
import Testing

@Suite("AgentExchangeStore")
struct AgentExchangeStoreTests {
    @Test("Decodes fractional-seconds ISO8601 strings written by JavaScript clients")
    func decodesFractionalISO8601Dates() throws {
        let json = """
        {
          "schemaVersion": "chaox-agent/v1",
          "requestId": "js-1",
          "app": "bx",
          "op": "record_food",
          "createdAt": "2026-11-21T11:30:00.123Z",
          "payload": {
            "mealType": "lunch",
            "name": "Salad",
            "calories": 420
          }
        }
        """
        let envelope = try AgentJSONCoding.decoder.decode(
            AgentInboxEnvelope.self,
            from: Data(json.utf8)
        )
        #expect(envelope.requestId == "js-1")
        #expect(envelope.operation == "record_food")
        #expect(envelope.payload["calories"]?.intValue == 420)
    }

    @Test("AgentEndpointParser builds pretty MCP JSON config snippets with and without tokens")
    func buildsMCPConfigSnippets() throws {
        let withToken = try #require(
            AgentEndpointParser.mcpConfigSnippet(
                for: "https://chaox.workers.dev/mcp/",
                token: "  tok_0123456789abcdef  "
            )
        )
        #expect(!withToken.contains(#"\/"#))
        let parsedObject = try #require(
            try JSONSerialization.jsonObject(with: Data(withToken.utf8)) as? [String: Any]
        )
        let servers = try #require(parsedObject["mcpServers"] as? [String: Any])
        let chaoxServer = try #require(servers["chaox-agent"] as? [String: Any])
        #expect(chaoxServer["url"] as? String == "https://chaox.workers.dev/mcp")
        let headers = try #require(chaoxServer["headers"] as? [String: String])
        #expect(headers["Authorization"] == "Bearer tok_0123456789abcdef")

        let roundTripped = AgentEndpointParser.parse(withToken)
        #expect(roundTripped.url == "https://chaox.workers.dev")
        #expect(roundTripped.token == "tok_0123456789abcdef")

        for omittedToken in [nil, "", "   \n\t "] as [String?] {
            let withoutToken = try #require(
                AgentEndpointParser.mcpConfigSnippet(
                    for: "http://localhost:8787",
                    token: omittedToken
                )
            )
            let obj = try #require(
                try JSONSerialization.jsonObject(with: Data(withoutToken.utf8)) as? [String: Any]
            )
            let mcpServers = try #require(obj["mcpServers"] as? [String: Any])
            let server = try #require(mcpServers["chaox-agent"] as? [String: Any])
            #expect(server["url"] as? String == "http://localhost:8787/mcp")
            #expect(server["headers"] == nil)
        }

        #expect(AgentEndpointParser.mcpConfigSnippet(for: "http://example.com", token: "tok") == nil)
        #expect(AgentEndpointParser.mcpConfigSnippet(for: "not a url", token: "tok") == nil)
    }

    @Test("AgentEndpointParser builds and round-trips concise client config snippets")
    func buildsClientConfigSnippets() throws {
        let shortSnippet = try #require(
            AgentEndpointParser.clientConfigSnippet(
                for: "https://chaox.workers.dev/mcp/",
                token: "  tok_1234  "
            )
        )
        #expect(shortSnippet == "URL: https://chaox.workers.dev\nToken: tok_1234")
        let shortParsed = AgentEndpointParser.parse(shortSnippet)
        #expect(shortParsed.url == "https://chaox.workers.dev")
        #expect(shortParsed.token == "tok_1234")

        let fullSnippet = try #require(
            AgentEndpointParser.clientConfigSnippet(
                for: "https://agent.example.com/mcp",
                token: "tok_0123456789abcdef"
            )
        )
        #expect(fullSnippet == "URL: https://agent.example.com\nToken: tok_0123456789abcdef")
        let fullParsed = AgentEndpointParser.parse(fullSnippet)
        #expect(fullParsed.url == "https://agent.example.com")
        #expect(fullParsed.token == "tok_0123456789abcdef")

        for omittedToken in [nil, "", "   \n\t "] as [String?] {
            let urlOnly = try #require(
                AgentEndpointParser.clientConfigSnippet(
                    for: "http://localhost:8787/mcp",
                    token: omittedToken
                )
            )
            #expect(urlOnly == "URL: http://localhost:8787")
            let parsed = AgentEndpointParser.parse(urlOnly)
            #expect(parsed.url == "http://localhost:8787")
            #expect(parsed.token == nil)
        }

        #expect(AgentEndpointParser.clientConfigSnippet(for: "http://example.com", token: "tok_1234") == nil)
        #expect(AgentEndpointParser.clientConfigSnippet(for: "not a url", token: "tok_1234") == nil)
    }

    @Test("AgentEndpointParser parses JSON, labeled Chinese, 2-line, and space-flattened pastes cleanly")
    func parsesDiverseFormatsWithoutFalsePositives() {
        let jsonInput = #"{"url":"https://chaox.workers.dev/mcp","token":"short_8c"}"#
        let parsedJSON = AgentEndpointParser.parse(jsonInput)
        #expect(parsedJSON.url == "https://chaox.workers.dev")
        #expect(parsedJSON.token == "short_8c")

        let zhInput = "\u{5730}\u{5740}\u{FF1A}https://chaox.workers.dev\n\u{4EE4}\u{724C}\u{FF1A}tok_zh_88"
        let parsedZh = AgentEndpointParser.parse(zhInput)
        #expect(parsedZh.url == "https://chaox.workers.dev")
        #expect(parsedZh.token == "tok_zh_88")

        let twoLine = "https://agent.example.com\nmy-token-123"
        let parsedTwoLine = AgentEndpointParser.parse(twoLine)
        #expect(parsedTwoLine.url == "https://agent.example.com")
        #expect(parsedTwoLine.token == "my-token-123")

        let flattened = "https://agent.example.com my-token-123"
        let parsedFlattened = AgentEndpointParser.parse(flattened)
        #expect(parsedFlattened.url == "https://agent.example.com")
        #expect(parsedFlattened.token == "my-token-123")

        let prose = "Connect to https://agent.example.com please"
        let parsedProse = AgentEndpointParser.parse(prose)
        #expect(parsedProse.url == "https://agent.example.com")
        #expect(parsedProse.token == nil)

        let urlContainingToken = "https://example-token-host.chaox.workers.dev/token/12345678"
        let parsedURLOnly = AgentEndpointParser.parse(urlContainingToken)
        #expect(parsedURLOnly.url == urlContainingToken)
        #expect(parsedURLOnly.token == nil)
    }

    @Test("AgentEndpointParser reconciles direct field pastes without breaking typing or overwriting user edits")
    func reconcilesDirectFieldEditsAndClipboardPastes() throws {
        let clientSnippet = try #require(
            AgentEndpointParser.clientConfigSnippet(
                for: "https://agent.example.com",
                token: "tok_client_1234"
            )
        )
        let mcpSnippet = try #require(
            AgentEndpointParser.mcpConfigSnippet(
                for: "https://agent.example.com",
                token: "tok_agent_5678"
            )
        )

        let pastedClientIntoURL = AgentEndpointParser.reconcileFieldEdit(
            field: .url,
            newValue: clientSnippet,
            currentURL: "",
            currentToken: "",
            canOverwriteOtherField: false
        )
        #expect(pastedClientIntoURL == AgentCredentialInputUpdate(
            url: "https://agent.example.com",
            token: "tok_client_1234",
            didUpdateURL: true,
            didUpdateToken: true,
            didAutoRecognizeConfig: true
        ))

        let flattenedMCP = mcpSnippet.replacingOccurrences(of: "\n", with: " ")
        let pastedMCPIntoToken = AgentEndpointParser.reconcileFieldEdit(
            field: .token,
            newValue: flattenedMCP,
            currentURL: "",
            currentToken: "",
            canOverwriteOtherField: true
        )
        #expect(pastedMCPIntoToken == AgentCredentialInputUpdate(
            url: "https://agent.example.com",
            token: "tok_agent_5678",
            didUpdateURL: true,
            didUpdateToken: true,
            didAutoRecognizeConfig: true
        ))

        let pastedBareIntoURL = AgentEndpointParser.reconcileFieldEdit(
            field: .url,
            newValue: "https://agent.example.com my-token-123",
            currentURL: "",
            currentToken: "",
            canOverwriteOtherField: false
        )
        #expect(pastedBareIntoURL.url == "https://agent.example.com")
        #expect(pastedBareIntoURL.token == "my-token-123")
        #expect(pastedBareIntoURL.didAutoRecognizeConfig)

        let pastedLabeledURL = AgentEndpointParser.reconcileFieldEdit(
            field: .url,
            newValue: "URL: https://agent.example.com",
            currentURL: "",
            currentToken: "",
            canOverwriteOtherField: false
        )
        #expect(pastedLabeledURL.url == "https://agent.example.com")
        #expect(!pastedLabeledURL.didUpdateToken)
        #expect(pastedLabeledURL.didAutoRecognizeConfig)

        let pastedBearer = AgentEndpointParser.reconcileFieldEdit(
            field: .token,
            newValue: "Bearer tok_bearer_1234",
            currentURL: "",
            currentToken: "",
            canOverwriteOtherField: false
        )
        #expect(pastedBearer.token == "tok_bearer_1234")
        #expect(!pastedBearer.didUpdateURL)
        #expect(pastedBearer.didAutoRecognizeConfig)

        let normalURLTyping = AgentEndpointParser.reconcileFieldEdit(
            field: .url,
            newValue: "https://agent.example.com/m",
            currentURL: "https://agent.example.com/",
            currentToken: "",
            canOverwriteOtherField: false
        )
        #expect(normalURLTyping.url == "https://agent.example.com/m")
        #expect(!normalURLTyping.didAutoRecognizeConfig)

        let normalTokenTyping = AgentEndpointParser.reconcileFieldEdit(
            field: .token,
            newValue: "my_manual_token_1234567890",
            currentURL: "",
            currentToken: "",
            canOverwriteOtherField: false
        )
        #expect(normalTokenTyping.token == "my_manual_token_1234567890")
        #expect(!normalTokenTyping.didAutoRecognizeConfig)

        let preserveEditedURL = AgentEndpointParser.reconcileFieldEdit(
            field: .token,
            newValue: clientSnippet,
            currentURL: "https://custom-edited.example.com",
            currentToken: "",
            canOverwriteOtherField: false
        )
        #expect(preserveEditedURL.url == "https://custom-edited.example.com")
        #expect(!preserveEditedURL.didUpdateURL)
        #expect(preserveEditedURL.token == "tok_client_1234")
        #expect(preserveEditedURL.didUpdateToken)

        let preserveManualToken = AgentEndpointParser.reconcileFieldEdit(
            field: .url,
            newValue: clientSnippet,
            currentURL: "",
            currentToken: "manual_token_keep",
            canOverwriteOtherField: false
        )
        #expect(preserveManualToken.url == "https://agent.example.com")
        #expect(preserveManualToken.didUpdateURL)
        #expect(preserveManualToken.token == "manual_token_keep")
        #expect(!preserveManualToken.didUpdateToken)

        let appendedPaste = AgentEndpointParser.reconcileFieldEdit(
            field: .url,
            newValue: "https://old.example.com" + clientSnippet,
            currentURL: "https://old.example.com",
            currentToken: "",
            canOverwriteOtherField: false
        )
        #expect(appendedPaste.url == "https://agent.example.com")
        #expect(appendedPaste.token == "tok_client_1234")
        #expect(appendedPaste.didUpdateURL && appendedPaste.didUpdateToken)

        #expect(
            AgentEndpointParser.reconcileClipboardPaste(
                raw: "not valid text",
                target: .both,
                currentURL: "https://keep.example.com",
                currentToken: "keep_tok",
                hasEditedURL: true
            ) == nil
        )

        let bothPaste = try #require(
            AgentEndpointParser.reconcileClipboardPaste(
                raw: mcpSnippet,
                target: .both,
                currentURL: "https://old.example.com",
                currentToken: "old_tok",
                hasEditedURL: true
            )
        )
        #expect(bothPaste.url == "https://agent.example.com")
        #expect(bothPaste.token == "tok_agent_5678")

        let tokenPasteRespectsEditedURL = try #require(
            AgentEndpointParser.reconcileClipboardPaste(
                raw: clientSnippet,
                target: .token,
                currentURL: "https://edited.example.com",
                currentToken: "",
                hasEditedURL: true
            )
        )
        #expect(tokenPasteRespectsEditedURL.url == "https://edited.example.com")
        #expect(!tokenPasteRespectsEditedURL.didUpdateURL)
        #expect(tokenPasteRespectsEditedURL.token == "tok_client_1234")

        let tokenPasteUpdatesPrefilledURL = try #require(
            AgentEndpointParser.reconcileClipboardPaste(
                raw: clientSnippet,
                target: .token,
                currentURL: "https://prefilled.example.com",
                currentToken: "",
                hasEditedURL: false
            )
        )
        #expect(tokenPasteUpdatesPrefilledURL.url == "https://agent.example.com")
        #expect(tokenPasteUpdatesPrefilledURL.didUpdateURL)
        #expect(tokenPasteUpdatesPrefilledURL.token == "tok_client_1234")
    }

    @Test("AgentExchangeStatus computes attentionReceiptCount over first 6 receipts and hasAttentionIssue")
    func computesAttentionReceiptCountAndIssue() {
        let statusWithErrorOnly = AgentExchangeStatus(
            isConfigured: true,
            lastError: "Timed out"
        )
        #expect(statusWithErrorOnly.attentionReceiptCount == 0)
        #expect(statusWithErrorOnly.hasAttentionIssue)

        let statusWithEmptyError = AgentExchangeStatus(
            isConfigured: true,
            recentReceipts: [
                AgentReceipt(requestId: "1", app: .sx, operation: "op", status: .applied),
                AgentReceipt(requestId: "2", app: .sx, operation: "op", status: .duplicate),
                AgentReceipt(requestId: "3", app: .sx, operation: "op", status: .applied),
                AgentReceipt(requestId: "4", app: .sx, operation: "op", status: .applied),
                AgentReceipt(requestId: "5", app: .sx, operation: "op", status: .applied),
                AgentReceipt(requestId: "6", app: .sx, operation: "op", status: .applied),
                AgentReceipt(requestId: "7", app: .sx, operation: "op", status: .failed),
            ],
            lastError: ""
        )
        #expect(statusWithEmptyError.attentionReceiptCount == 0)
        #expect(!statusWithEmptyError.hasAttentionIssue)

        let statusWithMixedReceipts = AgentExchangeStatus(
            isConfigured: true,
            recentReceipts: [
                AgentReceipt(requestId: "1", app: .sx, operation: "op", status: .rejected),
                AgentReceipt(requestId: "2", app: .sx, operation: "op", status: .applied),
                AgentReceipt(requestId: "3", app: .sx, operation: "op", status: .failed),
                AgentReceipt(requestId: "4", app: .sx, operation: "op", status: .duplicate),
                AgentReceipt(requestId: "5", app: .sx, operation: "op", status: .applied),
                AgentReceipt(requestId: "6", app: .sx, operation: "op", status: .rejected),
                AgentReceipt(requestId: "7", app: .sx, operation: "op", status: .failed),
            ]
        )
        #expect(statusWithMixedReceipts.attentionReceiptCount == 3)
        #expect(statusWithMixedReceipts.hasAttentionIssue)
    }
}

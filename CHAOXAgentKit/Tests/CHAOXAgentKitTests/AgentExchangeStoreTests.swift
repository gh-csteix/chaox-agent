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

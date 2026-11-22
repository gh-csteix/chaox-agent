import Foundation
import Security

public protocol AgentTokenStorage: Sendable {
    func readToken(account: String) -> String?
    func saveToken(_ token: String, account: String) throws
    func deleteToken(account: String)
}

public final class KeychainTokenStorage: AgentTokenStorage, @unchecked Sendable {
    private let service: String

    public init(service: String = "ai.chaox.agent.exchange") {
        self.service = service
    }

    public func readToken(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(bytes: data, encoding: .utf8),
              !token.isEmpty
        else {
            return nil
        }
        return token
    }

    public func saveToken(_ token: String, account: String) throws {
        let data = Data(token.utf8)
        let matchQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: account
        ]

        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]

        let existingStatus = SecItemCopyMatching(matchQuery as CFDictionary, nil)
        let writeStatus: OSStatus
        if existingStatus == errSecSuccess {
            writeStatus = SecItemUpdate(matchQuery as CFDictionary, attributes as CFDictionary)
        } else {
            var addQuery = matchQuery
            for (key, value) in attributes {
                addQuery[key] = value
            }
            writeStatus = SecItemAdd(addQuery as CFDictionary, nil)
        }

        guard writeStatus == errSecSuccess else {
            throw AgentExchangeError.remoteRequestFailed(
                statusCode: Int(writeStatus),
                message: "Unable to save remote token in Keychain (OSStatus \(writeStatus))."
            )
        }
    }

    public func deleteToken(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}

public final class InMemoryTokenStorage: AgentTokenStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: String] = [:]

    public init() {}

    public func readToken(account: String) -> String? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.tokens[account]
    }

    public func saveToken(_ token: String, account: String) throws {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.tokens[account] = token
    }

    public func deleteToken(account: String) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.tokens.removeValue(forKey: account)
    }
}

import Foundation

public enum AgentProtocolConstants {
    public static let schemaVersion = "chaox-agent/v1"
}

public enum AgentAppID: String, Codable, Sendable, CaseIterable {
    case sx
    case bx
    case gx

    public var defaultDomains: [String] {
        switch self {
        case .bx:
            ["sleep", "workouts", "food", "skin", "toilet"]
        case .sx:
            ["projects", "expenses", "incomes", "tags", "slogans"]
        case .gx:
            []
        }
    }
}

public enum AgentPermissionTier: String, Codable, Sendable, CaseIterable {
    case disabled
    case readOnly
    case appendOnly
    case readWrite

    public var allowsExchangeAccess: Bool {
        self != .disabled
    }

    public var allowsWrites: Bool {
        self == .appendOnly || self == .readWrite
    }

    public func allows(operation: String) -> Bool {
        switch self {
        case .disabled, .readOnly:
            false
        case .appendOnly:
            Self.appendOperations.contains(operation)
        case .readWrite:
            true
        }
    }

    private static let appendOperations: Set<String> = [
        "record_expense",
        "record_income",
        "record_refund",
        "record_income_reversal",
        "create_project",
        "create_tag",
        "create_slogan",
        "create_credential",
        "link_credential",
        "record_food",
        "record_skin",
        "record_toilet",
        "add_workout_exercise"
    ]
}

public enum AgentPermissionAction: String, Codable, Sendable {
    case create
    case update
    case delete
}

public struct AgentPermissionPolicy: Codable, Sendable, Equatable {
    public var allowRead: Bool
    public var allowCreate: Bool
    public var allowUpdate: Bool
    public var allowDelete: Bool
    public var allowedDomains: [String]
    public var consentAcknowledged: Bool
    public var updatedAt: Date?

    public init(
        allowRead: Bool = false,
        allowCreate: Bool = false,
        allowUpdate: Bool = false,
        allowDelete: Bool = false,
        allowedDomains: [String] = [],
        consentAcknowledged: Bool = false,
        updatedAt: Date? = nil
    ) {
        self.allowRead = allowRead
        self.allowCreate = allowCreate
        self.allowUpdate = allowUpdate
        self.allowDelete = allowDelete
        self.allowedDomains = allowedDomains
        self.consentAcknowledged = consentAcknowledged
        self.updatedAt = updatedAt
    }

    public static func preset(
        for tier: AgentPermissionTier,
        app: AgentAppID,
        allowedDomains: [String]? = nil,
        consentAcknowledged: Bool = false,
        updatedAt: Date? = nil
    ) -> AgentPermissionPolicy {
        let domains = allowedDomains ?? app.defaultDomains
        switch tier {
        case .disabled:
            return AgentPermissionPolicy(
                allowRead: false,
                allowCreate: false,
                allowUpdate: false,
                allowDelete: false,
                allowedDomains: domains,
                consentAcknowledged: consentAcknowledged,
                updatedAt: updatedAt
            )
        case .readOnly:
            return AgentPermissionPolicy(
                allowRead: true,
                allowCreate: false,
                allowUpdate: false,
                allowDelete: false,
                allowedDomains: domains,
                consentAcknowledged: consentAcknowledged,
                updatedAt: updatedAt
            )
        case .appendOnly:
            return AgentPermissionPolicy(
                allowRead: true,
                allowCreate: true,
                allowUpdate: false,
                allowDelete: false,
                allowedDomains: domains,
                consentAcknowledged: consentAcknowledged,
                updatedAt: updatedAt
            )
        case .readWrite:
            // Delete remains opt-in by default so full edits don't implicitly grant delete access.
            return AgentPermissionPolicy(
                allowRead: true,
                allowCreate: true,
                allowUpdate: true,
                allowDelete: false,
                allowedDomains: domains,
                consentAcknowledged: consentAcknowledged,
                updatedAt: updatedAt
            )
        }
    }

    public var derivedTier: AgentPermissionTier {
        if self.allowUpdate || self.allowDelete {
            return .readWrite
        }
        if self.allowCreate {
            return .appendOnly
        }
        if self.allowRead {
            return .readOnly
        }
        return .disabled
    }

    public var allowsExchangeAccess: Bool {
        self.allowRead || self.allowCreate || self.allowUpdate || self.allowDelete
    }

    public func allowsDomain(_ domain: String) -> Bool {
        self.allowedDomains.contains(domain)
    }

    public func allows(operation: String, app: AgentAppID) -> Bool {
        guard let rule = Self.operationRule(for: operation, app: app) else {
            return false
        }
        guard self.allowedDomains.contains(rule.domain) else {
            return false
        }
        switch rule.action {
        case .create:
            return self.allowCreate
        case .update:
            return self.allowUpdate
        case .delete:
            return self.allowDelete
        }
    }

    private static func operationRule(
        for operation: String,
        app: AgentAppID
    ) -> (action: AgentPermissionAction, domain: String)? {
        switch app {
        case .bx:
            Self.bxOperationRules[operation]
        case .sx:
            Self.sxOperationRules[operation]
        case .gx:
            nil
        }
    }

    private static let bxOperationRules: [String: (action: AgentPermissionAction, domain: String)] = [
        "record_food": (.create, "food"),
        "update_food": (.update, "food"),
        "delete_food": (.delete, "food"),
        "record_skin": (.create, "skin"),
        "update_skin": (.update, "skin"),
        "delete_skin": (.delete, "skin"),
        "record_toilet": (.create, "toilet"),
        "update_toilet": (.update, "toilet"),
        "delete_toilet": (.delete, "toilet"),
        "add_workout_exercise": (.create, "workouts"),
        "update_workout_exercise": (.update, "workouts"),
        "delete_workout_exercise": (.delete, "workouts"),
        "reorder_workout_exercises": (.update, "workouts"),
        "update_workout_type": (.update, "workouts")
    ]

    private static let sxOperationRules: [String: (action: AgentPermissionAction, domain: String)] = [
        "record_expense": (.create, "expenses"),
        "update_expense": (.update, "expenses"),
        "delete_expense": (.delete, "expenses"),
        "record_refund": (.create, "expenses"),
        "update_refund": (.update, "expenses"),
        "delete_refund": (.delete, "expenses"),
        "record_income": (.create, "incomes"),
        "update_income": (.update, "incomes"),
        "delete_income": (.delete, "incomes"),
        "record_income_reversal": (.create, "incomes"),
        "update_income_reversal": (.update, "incomes"),
        "delete_income_reversal": (.delete, "incomes"),
        "create_project": (.create, "projects"),
        "update_project": (.update, "projects"),
        "delete_project": (.delete, "projects"),
        "create_tag": (.create, "tags"),
        "rename_tag": (.update, "tags"),
        "delete_tag": (.delete, "tags"),
        "create_slogan": (.create, "slogans"),
        "update_slogan": (.update, "slogans"),
        "delete_slogan": (.delete, "slogans"),
        "create_credential": (.create, "credentials"),
        "update_credential": (.update, "credentials"),
        "delete_credential": (.delete, "credentials"),
        "link_credential": (.create, "credentials"),
        "update_credential_link": (.update, "credentials"),
        "unlink_credential": (.delete, "credentials")
    ]
}

public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let boolValue = try? container.decode(Bool.self) {
            self = .bool(boolValue)
        } else if let intValue = try? container.decode(Int.self) {
            self = .int(intValue)
        } else if let doubleValue = try? container.decode(Double.self) {
            self = .double(doubleValue)
        } else if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
        } else if let arrayValue = try? container.decode([JSONValue].self) {
            self = .array(arrayValue)
        } else if let objectValue = try? container.decode([String: JSONValue].self) {
            self = .object(objectValue)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .int(value):
            try container.encode(value)
        case let .double(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }

    public var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    public var doubleValue: Double? {
        switch self {
        case let .double(value):
            value
        case let .int(value):
            Double(value)
        default:
            nil
        }
    }

    public var intValue: Int? {
        switch self {
        case let .int(value):
            value
        case let .double(value) where value.rounded() == value && abs(value) <= Double(Int.max):
            Int(value)
        default:
            nil
        }
    }

    public var boolValue: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }

    public var arrayValue: [JSONValue]? {
        guard case let .array(value) = self else { return nil }
        return value
    }

    public var stringArrayValue: [String]? {
        guard case let .array(items) = self else { return nil }
        var result: [String] = []
        result.reserveCapacity(items.count)
        for item in items {
            guard let string = item.stringValue else { return nil }
            result.append(string)
        }
        return result
    }

    public var objectValue: [String: JSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    public static func fromEncodable(_ value: some Encodable) throws -> JSONValue {
        let data = try AgentJSONCoding.encoder.encode(value)
        return try AgentJSONCoding.decoder.decode(JSONValue.self, from: data)
    }

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let data = try AgentJSONCoding.encoder.encode(self)
        return try AgentJSONCoding.decoder.decode(type, from: data)
    }
}

public struct AgentRequestSource: Codable, Sendable, Equatable {
    public var client: String?
    public var agent: String?
    public var note: String?

    public init(client: String? = nil, agent: String? = nil, note: String? = nil) {
        self.client = client
        self.agent = agent
        self.note = note
    }
}

public struct AgentInboxEnvelope: Codable, Sendable, Equatable {
    public var schemaVersion: String
    public var requestId: String
    public var app: AgentAppID
    public var operation: String
    public var createdAt: Date
    public var source: AgentRequestSource?
    public var payload: [String: JSONValue]

    public enum CodingKeys: String, CodingKey {
        case schemaVersion
        case requestId
        case app
        case operation = "op"
        case createdAt
        case source
        case payload
    }

    public init(
        schemaVersion: String = AgentProtocolConstants.schemaVersion,
        requestId: String,
        app: AgentAppID,
        operation: String,
        createdAt: Date = Date(),
        source: AgentRequestSource? = nil,
        payload: [String: JSONValue]
    ) {
        self.schemaVersion = schemaVersion
        self.requestId = requestId
        self.app = app
        self.operation = operation
        self.createdAt = createdAt
        self.source = source
        self.payload = payload
    }
}

public enum AgentReceiptStatus: String, Codable, Sendable, Equatable {
    case applied
    case duplicate
    case rejected
    case failed
}

public struct AgentReceipt: Codable, Sendable, Equatable {
    public var schemaVersion: String
    public var requestId: String
    public var app: AgentAppID
    public var operation: String
    public var status: AgentReceiptStatus
    public var processedAt: Date
    public var recordId: String?
    public var stableId: String?
    public var summary: String?
    public var details: [String: JSONValue]?
    public var errorCode: String?
    public var errorMessage: String?

    public enum CodingKeys: String, CodingKey {
        case schemaVersion
        case requestId
        case app
        case operation = "op"
        case status
        case processedAt
        case recordId
        case stableId
        case summary
        case details
        case errorCode
        case errorMessage
    }

    public init(
        schemaVersion: String = AgentProtocolConstants.schemaVersion,
        requestId: String,
        app: AgentAppID,
        operation: String,
        status: AgentReceiptStatus,
        processedAt: Date = Date(),
        recordId: String? = nil,
        stableId: String? = nil,
        summary: String? = nil,
        details: [String: JSONValue]? = nil,
        errorCode: String? = nil,
        errorMessage: String? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.requestId = requestId
        self.app = app
        self.operation = operation
        self.status = status
        self.processedAt = processedAt
        self.recordId = recordId
        self.stableId = stableId
        self.summary = summary
        self.details = details
        self.errorCode = errorCode
        self.errorMessage = errorMessage
    }
}

public struct AgentAppMetadata: Sendable, Equatable {
    public var app: AgentAppID
    public var bundleId: String
    public var appVersion: String
    public var capabilities: [String]

    public init(
        app: AgentAppID,
        bundleId: String,
        appVersion: String,
        capabilities: [String]
    ) {
        self.app = app
        self.bundleId = bundleId
        self.appVersion = appVersion
        self.capabilities = capabilities
    }
}

public enum AgentInboxOutcome: Sendable, Equatable {
    case applied(
        recordId: String?,
        stableId: String?,
        summary: String,
        details: [String: JSONValue]? = nil
    )
    case duplicate(
        recordId: String?,
        stableId: String?,
        summary: String,
        details: [String: JSONValue]? = nil
    )
    case rejected(errorCode: String, message: String)
    case failed(errorCode: String, message: String)
}

public struct AgentInboxRunResult: Sendable, Equatable {
    public var processedCount: Int
    public var appliedCount: Int
    public var duplicateCount: Int
    public var rejectedCount: Int
    public var failedCount: Int
    public var receipts: [AgentReceipt]

    public init(
        processedCount: Int = 0,
        appliedCount: Int = 0,
        duplicateCount: Int = 0,
        rejectedCount: Int = 0,
        failedCount: Int = 0,
        receipts: [AgentReceipt] = []
    ) {
        self.processedCount = processedCount
        self.appliedCount = appliedCount
        self.duplicateCount = duplicateCount
        self.rejectedCount = rejectedCount
        self.failedCount = failedCount
        self.receipts = receipts
    }
}

public struct AgentExchangeStatus: Sendable, Equatable {
    public var isConfigured: Bool
    public var permission: AgentPermissionTier
    public var policy: AgentPermissionPolicy
    public var lastSyncAt: Date?
    public var pendingInboxCount: Int
    public var recentReceipts: [AgentReceipt]
    public var lastError: String?
    public var remoteEndpointURL: String?

    public var attentionReceiptCount: Int {
        self.recentReceipts.prefix(6).count { receipt in
            receipt.status == .rejected || receipt.status == .failed
        }
    }

    public var hasAttentionIssue: Bool {
        !(self.lastError?.isEmpty ?? true) || self.attentionReceiptCount > 0
    }

    public init(
        isConfigured: Bool = false,
        permission: AgentPermissionTier = .disabled,
        policy: AgentPermissionPolicy? = nil,
        lastSyncAt: Date? = nil,
        pendingInboxCount: Int = 0,
        recentReceipts: [AgentReceipt] = [],
        lastError: String? = nil,
        remoteEndpointURL: String? = nil
    ) {
        self.isConfigured = isConfigured
        self.permission = permission
        self.policy = policy ?? AgentPermissionPolicy.preset(
            for: permission,
            app: .sx,
            consentAcknowledged: isConfigured
        )
        self.lastSyncAt = lastSyncAt
        self.pendingInboxCount = pendingInboxCount
        self.recentReceipts = recentReceipts
        self.lastError = lastError
        self.remoteEndpointURL = remoteEndpointURL
    }
}

public enum AgentExchangeError: LocalizedError, Sendable {
    case notConfigured
    case permissionDenied(String)
    case invalidRemoteURL(String)
    case missingRemoteToken
    case remoteRequestFailed(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .notConfigured:
            "Agent exchange is not configured."
        case let .permissionDenied(reason):
            reason
        case let .invalidRemoteURL(reason):
            reason
        case .missingRemoteToken:
            "Remote endpoint token is missing from Keychain. Please re-enter it in Settings."
        case let .remoteRequestFailed(statusCode, message):
            statusCode > 0 ? "HTTP \(statusCode): \(message)" : message
        }
    }
}

public struct AgentRemoteHealthResponse: Codable, Sendable, Equatable {
    public var status: String
    public var schemaVersion: String
    public var mode: String?

    public init(
        status: String,
        schemaVersion: String = AgentProtocolConstants.schemaVersion,
        mode: String? = nil
    ) {
        self.status = status
        self.schemaVersion = schemaVersion
        self.mode = mode
    }
}

public struct AgentRemoteStatusResponse: Codable, Sendable, Equatable {
    public var schemaVersion: String
    public var app: AgentAppID
    public var configured: Bool
    public var permission: AgentPermissionTier
    public var lastSyncAt: Date?
    public var pendingInboxCount: Int
    public var recentReceipts: [AgentReceipt]

    public init(
        schemaVersion: String = AgentProtocolConstants.schemaVersion,
        app: AgentAppID,
        configured: Bool,
        permission: AgentPermissionTier,
        lastSyncAt: Date? = nil,
        pendingInboxCount: Int = 0,
        recentReceipts: [AgentReceipt] = []
    ) {
        self.schemaVersion = schemaVersion
        self.app = app
        self.configured = configured
        self.permission = permission
        self.lastSyncAt = lastSyncAt
        self.pendingInboxCount = pendingInboxCount
        self.recentReceipts = recentReceipts
    }
}

public struct AgentRemoteInboxResponse: Codable, Sendable, Equatable {
    public var schemaVersion: String
    public var app: AgentAppID
    public var permission: AgentPermissionTier
    public var envelopes: [AgentInboxEnvelope]

    public init(
        schemaVersion: String = AgentProtocolConstants.schemaVersion,
        app: AgentAppID,
        permission: AgentPermissionTier,
        envelopes: [AgentInboxEnvelope] = []
    ) {
        self.schemaVersion = schemaVersion
        self.app = app
        self.permission = permission
        self.envelopes = envelopes
    }
}

public struct AgentRemoteAckRequest: Codable, Sendable, Equatable {
    public var schemaVersion: String
    public var receipts: [AgentReceipt]

    public init(schemaVersion: String = AgentProtocolConstants.schemaVersion, receipts: [AgentReceipt]) {
        self.schemaVersion = schemaVersion
        self.receipts = receipts
    }
}

public struct AgentRemoteSnapshotRequest: Encodable, Sendable {
    public var schemaVersion: String
    public var app: AgentAppID
    public var bundleId: String
    public var appVersion: String
    public var permission: AgentPermissionTier
    public var policy: AgentPermissionPolicy?
    public var capabilities: [String]
    public var lastSyncAt: Date
    public var catalog: JSONValue?
    public var summary: JSONValue?
    public var datasets: [String: JSONValue]?

    public init(
        schemaVersion: String = AgentProtocolConstants.schemaVersion,
        metadata: AgentAppMetadata,
        permission: AgentPermissionTier,
        policy: AgentPermissionPolicy? = nil,
        lastSyncAt: Date,
        catalog: JSONValue? = nil,
        summary: JSONValue? = nil,
        datasets: [String: JSONValue]? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.app = metadata.app
        self.bundleId = metadata.bundleId
        self.appVersion = metadata.appVersion
        self.permission = permission
        self.policy = policy
        self.capabilities = metadata.capabilities
        self.lastSyncAt = lastSyncAt
        self.catalog = catalog
        self.summary = summary
        self.datasets = datasets
    }
}

public enum AgentJSONCoding {
    public static var encoder: JSONEncoder {
        self.makeEncoder(prettyPrinted: true)
    }

    public static var compactEncoder: JSONEncoder {
        self.makeEncoder(prettyPrinted: false)
    }

    private static func makeEncoder(prettyPrinted: Bool) -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = prettyPrinted ? [.prettyPrinted, .sortedKeys] : [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var container = encoder.singleValueContainer()
            try container.encode(formatter.string(from: date))
        }
        return encoder
    }

    public static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: string) {
                return date
            }
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = standard.date(from: string) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO-8601 date: \(string)"
            )
        }
        return decoder
    }
}

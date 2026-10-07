import Foundation
import Security

struct SessionTokenStore {
    private let service = "com.example.MoneyLens"
    private let account = "app-session"

    func load() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data else {
            throw keychainError(status)
        }
        guard let token = String(data: data, encoding: .utf8) else {
            throw SessionTokenError.invalidEncoding
        }
        return token
    }

    func save(_ token: String) throws {
        let data = Data(token.utf8)
        let attributes = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ] as [String: Any]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)

        if status == errSecItemNotFound {
            var query = baseQuery
            attributes.forEach { query[$0.key] = $0.value }
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw keychainError(addStatus)
            }
        } else if status != errSecSuccess {
            throw keychainError(status)
        }
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw keychainError(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    private func keychainError(_ status: OSStatus) -> SessionTokenError {
        SessionTokenError.operationFailed(status)
    }
}

private enum SessionTokenError: LocalizedError {
    case operationFailed(OSStatus)
    case invalidEncoding

    var errorDescription: String? {
        switch self {
        case let .operationFailed(status):
            "Secure session storage failed with status \(status)."
        case .invalidEncoding:
            "The saved session token could not be read."
        }
    }
}

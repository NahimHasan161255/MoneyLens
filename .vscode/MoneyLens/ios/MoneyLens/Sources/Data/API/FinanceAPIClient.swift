import Foundation

struct DashboardResponse: Decodable {
    let timezone: String?
    let currencies: [CurrencySummary]
}

struct CurrencySummary: Decodable, Identifiable {
    let currency: String
    let today: MoneyValue
    let last7Days: MoneyValue
    let last14Days: MoneyValue
    let last30Days: MoneyValue
    let thisMonth: MoneyValue
    let lastMonth: MoneyValue

    var id: String { currency }
}

struct MoneyValue: Decodable {
    let value: Decimal

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self),
           let decimal = Decimal(string: string, locale: Locale(identifier: "en_US_POSIX")) {
            value = decimal
        } else {
            value = try container.decode(Decimal.self)
        }
    }
}

struct TransactionPage: Decodable {
    let items: [FinanceTransaction]
    let total: Int
    let limit: Int
    let offset: Int
}

struct DeleteTransactionsResponse: Decodable {
    let deletedCount: Int
}

struct TransactionCategory: Decodable, Identifiable {
    let id: UUID
    let slug: String
    let name: String
    let isDefault: Bool
}

struct TransactionCategoriesResponse: Decodable {
    let items: [TransactionCategory]
}

struct CategoryUpdateRequest: Encodable {
    let categoryId: UUID?

    private enum CodingKeys: String, CodingKey {
        case categoryId
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(categoryId, forKey: .categoryId)
    }
}

struct SpendingCharts: Decodable {
    let period: String
    let from: String
    let to: String
    let series: [SpendingChartPoint]
    let categories: [CategorySpending]
}

struct SpendingChartPoint: Decodable, Identifiable {
    let date: String
    let currency: String
    let amount: MoneyValue

    var id: String { "\(date)-\(currency)" }
}

struct CategorySpending: Decodable, Identifiable {
    let categoryId: UUID?
    let category: String
    let currency: String
    let amount: MoneyValue

    var id: String { "\(categoryId?.uuidString ?? "other")-\(currency)" }
}

struct FinanceTransaction: Decodable, Identifiable {
    let id: UUID
    let date: String
    let time: String?
    let merchant: String
    let amount: MoneyValue
    let currency: String
    let category: String
    let categoryId: UUID?
    let cardName: String?
    let createdAt: Date
    let updatedAt: Date
}

struct AppSessionResponse: Decodable {
    let accessToken: String
    let tokenType: String
    let expiresIn: Int
}

struct AppleSignInNonce: Decodable {
    let nonce: String
    let expiresIn: Int
}

struct GmailConnectionStatus: Decodable {
    let connected: Bool
    let connectedAt: Date?
}

struct GmailConnectResponse: Decodable {
    let authorizationUrl: URL
    let expiresIn: Int
}

struct GmailSyncResponse: Decodable {
    let runId: UUID
    let status: String
    let addedCount: Int
    let skippedCount: Int
    let unsupportedCount: Int
    let examinedCount: Int
    let reconciled: Bool
}

struct GmailDisconnectResponse: Decodable {
    let disconnected: Bool
    let googleRevocation: String
}

struct AccountDeletionResponse: Decodable {
    let deleted: Bool
    let googleRevocation: String
}

enum FinanceAPIError: LocalizedError {
    case missingBaseURL
    case developmentSessionUnavailable
    case invalidResponse
    case unauthorized
    case server(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .missingBaseURL:
            "The API address is not configured for this build."
        case .developmentSessionUnavailable:
            "App sign-in is not available in this build."
        case .invalidResponse:
            "The server returned an invalid response."
        case .unauthorized:
            "Your session expired. Sign in again to continue."
        case let .server(statusCode, message):
            "The server returned \(statusCode): \(message)"
        }
    }
}

actor FinanceAPIClient {
    private let baseURL: URL?
    private let allowsDevelopmentSession: Bool
    private let urlSession: URLSession
    private let decoder: JSONDecoder
    private let keychain = SessionTokenStore()

    init(
        baseURL: URL? = Bundle.main.object(forInfoDictionaryKey: "MoneyLensAPIBaseURL")
            .flatMap { $0 as? String }
            .flatMap { URL(string: $0) },
        allowsDevelopmentSession: Bool? = nil,
        urlSession: URLSession = .shared
    ) {
        self.baseURL = baseURL
        let configuredDevelopmentSession = Bundle.main.object(
            forInfoDictionaryKey: "MoneyLensDevelopmentSessionEnabled"
        )
        if let allowsDevelopmentSession {
            self.allowsDevelopmentSession = allowsDevelopmentSession
        } else if let configuredValue = configuredDevelopmentSession as? Bool {
            self.allowsDevelopmentSession = configuredValue
        } else {
            self.allowsDevelopmentSession = (configuredDevelopmentSession as? String) == "YES"
        }
        self.urlSession = urlSession
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) {
                return date
            }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected an ISO-8601 date."
            )
        }
    }

    func dashboard() async throws -> DashboardResponse {
        try await get("/v1/dashboard")
    }

    func hasSession() throws -> Bool {
        if allowsDevelopmentSession {
            return true
        }
        return try keychain.load() != nil
    }

    func appleSignInNonce() async throws -> AppleSignInNonce {
        try await sendPublic(
            url: endpoint("/v1/auth/apple/nonce"),
            method: "POST",
            body: Data("{}".utf8)
        )
    }

    func signInWithApple(identityToken: String, nonce: String) async throws {
        let body = try JSONEncoder().encode(AppleSignInRequest(
            identityToken: identityToken,
            nonce: nonce
        ))
        let session: AppSessionResponse = try await sendPublic(
            url: endpoint("/v1/auth/apple"),
            method: "POST",
            body: body
        )
        guard session.tokenType == "Bearer",
              session.accessToken.count == 43,
              session.expiresIn > 0 else {
            throw FinanceAPIError.invalidResponse
        }
        try keychain.save(session.accessToken)
    }

    func signOut() async throws {
        guard let token = try keychain.load() else { return }
        try keychain.delete()

        let response = try await perform(
            url: endpoint("/v1/session"),
            token: token,
            method: "DELETE",
            body: nil
        )
        guard response.statusCode == 204 || response.statusCode == 401 else {
            let message = (try? decoder.decode(APIErrorResponse.self, from: response.data).error)
                ?? "Request failed."
            throw FinanceAPIError.server(statusCode: response.statusCode, message: message)
        }
    }

    func transactions(limit: Int = 50, offset: Int = 0) async throws -> TransactionPage {
        try await transactions(
            limit: limit,
            offset: offset,
            from: nil,
            to: nil,
            categoryId: nil,
            merchant: nil,
            cardName: nil
        )
    }

    func transactions(
        limit: Int,
        offset: Int,
        from: String?,
        to: String?,
        categoryId: UUID?,
        merchant: String?,
        cardName: String?
    ) async throws -> TransactionPage {
        guard var components = URLComponents(
            url: try endpoint("/v1/transactions"),
            resolvingAgainstBaseURL: false
        ) else {
            throw FinanceAPIError.invalidResponse
        }

        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        if let from { queryItems.append(URLQueryItem(name: "from", value: from)) }
        if let to { queryItems.append(URLQueryItem(name: "to", value: to)) }
        if let categoryId {
            queryItems.append(URLQueryItem(name: "categoryId", value: categoryId.uuidString))
        }
        if let merchant, !merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            queryItems.append(URLQueryItem(name: "merchant", value: merchant))
        }
        if let cardName, !cardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            queryItems.append(URLQueryItem(name: "cardName", value: cardName))
        }
        components.queryItems = queryItems

        guard let url = components.url else {
            throw FinanceAPIError.invalidResponse
        }

        return try await send(url: url)
    }

    func categories() async throws -> [TransactionCategory] {
        let response: TransactionCategoriesResponse = try await get("/v1/categories")
        return response.items
    }

    func charts(
        period: String,
        from: String?,
        to: String?
    ) async throws -> SpendingCharts {
        guard var components = URLComponents(
            url: try endpoint("/v1/charts"),
            resolvingAgainstBaseURL: false
        ) else {
            throw FinanceAPIError.invalidResponse
        }

        var queryItems = [URLQueryItem(name: "period", value: period)]
        if let from { queryItems.append(URLQueryItem(name: "from", value: from)) }
        if let to { queryItems.append(URLQueryItem(name: "to", value: to)) }
        components.queryItems = queryItems

        guard let url = components.url else {
            throw FinanceAPIError.invalidResponse
        }
        return try await send(url: url)
    }

    func exportTransactions() async throws -> Data {
        try await responseData(url: endpoint("/v1/transactions/export"))
    }

    func deleteAllTransactions() async throws -> DeleteTransactionsResponse {
        try await send(url: endpoint("/v1/transactions"), method: "DELETE")
    }

    func gmailConnection() async throws -> GmailConnectionStatus {
        try await get("/v1/gmail/connection")
    }

    func connectGmail() async throws -> GmailConnectResponse {
        try await send(
            url: endpoint("/v1/gmail/connect"),
            method: "POST",
            body: Data("{}".utf8)
        )
    }

    func syncGmail() async throws -> GmailSyncResponse {
        try await send(
            url: endpoint("/v1/sync"),
            method: "POST",
            body: Data("{}".utf8)
        )
    }

    func disconnectGmail() async throws -> GmailDisconnectResponse {
        try await send(
            url: endpoint("/v1/gmail/connection"),
            method: "DELETE"
        )
    }

    func deleteAccount() async throws -> AccountDeletionResponse {
        let response: AccountDeletionResponse = try await send(
            url: endpoint("/v1/account"),
            method: "DELETE"
        )
        guard response.deleted else {
            throw FinanceAPIError.invalidResponse
        }
        try keychain.delete()
        return response
    }

    func updateCategory(
        transactionId: UUID,
        categoryId: UUID?
    ) async throws -> FinanceTransaction {
        let body = try JSONEncoder().encode(CategoryUpdateRequest(categoryId: categoryId))
        return try await send(
            url: endpoint("/v1/transactions/\(transactionId.uuidString)"),
            method: "PATCH",
            body: body
        )
    }

    private func get<Response: Decodable>(_ path: String) async throws -> Response {
        try await send(url: endpoint(path))
    }

    private func sendPublic<Response: Decodable>(
        url: URL,
        method: String,
        body: Data
    ) async throws -> Response {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw FinanceAPIError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = (try? decoder.decode(APIErrorResponse.self, from: data).error)
                ?? "Request failed."
            throw FinanceAPIError.server(statusCode: httpResponse.statusCode, message: message)
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw FinanceAPIError.invalidResponse
        }
    }

    private func endpoint(_ path: String) throws -> URL {
        guard let baseURL else {
            throw FinanceAPIError.missingBaseURL
        }
        return baseURL.appending(path: path)
    }

    private func send<Response: Decodable>(
        url: URL,
        method: String = "GET",
        body: Data? = nil
    ) async throws -> Response {
        let data = try await responseData(url: url, method: method, body: body)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw FinanceAPIError.invalidResponse
        }
    }

    private func responseData(
        url: URL,
        method: String = "GET",
        body: Data? = nil
    ) async throws -> Data {
        let response = try await authorizedResponse(url: url, method: method, body: body)
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? decoder.decode(APIErrorResponse.self, from: response.data).error)
                ?? "Request failed."
            throw FinanceAPIError.server(statusCode: response.statusCode, message: message)
        }
        return response.data
    }

    private func authorizedResponse(
        url: URL,
        method: String,
        body: Data?
    ) async throws -> (data: Data, statusCode: Int) {
        var token = try await accessToken()
        var response = try await perform(url: url, token: token, method: method, body: body)

        if response.statusCode == 401 {
            try keychain.delete()
            guard allowsDevelopmentSession else {
                throw FinanceAPIError.unauthorized
            }
            token = try await createDevelopmentSession()
            response = try await perform(url: url, token: token, method: method, body: body)
        }

        if response.statusCode == 401 {
            try keychain.delete()
            throw FinanceAPIError.unauthorized
        }
        return response
    }

    private func perform(
        url: URL,
        token: String,
        method: String,
        body: Data?
    ) async throws -> (data: Data, statusCode: Int) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }

        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw FinanceAPIError.invalidResponse
        }

        return (data, httpResponse.statusCode)
    }

    private struct APIErrorResponse: Decodable {
        let error: String
    }

    private struct AppleSignInRequest: Encodable {
        let identityToken: String
        let nonce: String
    }

    private func accessToken() async throws -> String {
        if let token = try keychain.load() {
            return token
        }

        guard allowsDevelopmentSession else {
            throw FinanceAPIError.developmentSessionUnavailable
        }

        return try await createDevelopmentSession()
    }

    private func createDevelopmentSession() async throws -> String {
        guard allowsDevelopmentSession else {
            throw FinanceAPIError.developmentSessionUnavailable
        }

        let url = try endpoint("/v1/dev/session")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw FinanceAPIError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw FinanceAPIError.server(
                statusCode: httpResponse.statusCode,
                message: "Could not start a development session."
            )
        }

        let session: AppSessionResponse
        do {
            session = try decoder.decode(AppSessionResponse.self, from: data)
        } catch {
            throw FinanceAPIError.invalidResponse
        }

        try keychain.save(session.accessToken)
        return session.accessToken
    }
}

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

struct DevelopmentSession: Decodable {
    let accessToken: String
    let tokenType: String
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
            "Sign in is not available yet. Connect a Google account in a later app update."
        case .invalidResponse:
            "The server returned an invalid response."
        case .unauthorized:
            "Your session expired. Try refreshing to sign in again."
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

    func transactions(limit: Int = 50, offset: Int = 0) async throws -> TransactionPage {
        guard var components = URLComponents(
            url: try endpoint("/v1/transactions"),
            resolvingAgainstBaseURL: false
        ) else {
            throw FinanceAPIError.invalidResponse
        }

        components.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]

        guard let url = components.url else {
            throw FinanceAPIError.invalidResponse
        }

        return try await send(url: url)
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

    private func get<Response: Decodable>(_ path: String) async throws -> Response {
        try await send(url: endpoint(path))
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

        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 {
                try keychain.delete()
                throw FinanceAPIError.unauthorized
            }
            let message = (try? decoder.decode(APIErrorResponse.self, from: response.data).error)
                ?? "Request failed."
            throw FinanceAPIError.server(statusCode: response.statusCode, message: message)
        }

        do {
            return try decoder.decode(Response.self, from: response.data)
        } catch {
            throw FinanceAPIError.invalidResponse
        }
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

        let session: DevelopmentSession
        do {
            session = try decoder.decode(DevelopmentSession.self, from: data)
        } catch {
            throw FinanceAPIError.invalidResponse
        }

        try keychain.save(session.accessToken)
        return session.accessToken
    }
}

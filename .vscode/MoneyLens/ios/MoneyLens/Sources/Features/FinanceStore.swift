import Foundation
import Combine

@MainActor
final class FinanceStore: ObservableObject {
    @Published private(set) var dashboard: DashboardResponse?
    @Published private(set) var transactions: [FinanceTransaction] = []
    @Published private(set) var categories: [TransactionCategory] = []
    @Published private(set) var charts: SpendingCharts?
    @Published private(set) var isLoadingCharts = false
    @Published private(set) var chartsErrorMessage: String?
    @Published private(set) var categoriesErrorMessage: String?
    @Published private(set) var gmailConnection: GmailConnectionStatus?
    @Published private(set) var lastSync: GmailSyncResponse?
    @Published private(set) var isAuthenticated = false
    @Published private(set) var isSigningIn = false
    @Published private(set) var authenticationErrorMessage: String?
    @Published private(set) var accountDeletionGoogleRevocation: String?
    @Published private(set) var isLoading = false
    @Published private(set) var isWorkingOnGmail = false
    @Published private(set) var isWorkingOnData = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var settingsErrorMessage: String?

    private let api = FinanceAPIClient()

    func restoreAuthentication() async {
        do {
            isAuthenticated = try await api.hasSession()
            authenticationErrorMessage = nil
        } catch {
            authenticationErrorMessage = error.localizedDescription
        }
    }

    func loadAppleSignInNonce() async -> String? {
        authenticationErrorMessage = nil
        do {
            return try await api.appleSignInNonce().nonce
        } catch {
            authenticationErrorMessage = error.localizedDescription
            return nil
        }
    }

    func signInWithApple(identityToken: String, nonce: String) async -> Bool {
        guard !isSigningIn else { return false }
        isSigningIn = true
        authenticationErrorMessage = nil
        defer { isSigningIn = false }

        do {
            try await api.signInWithApple(identityToken: identityToken, nonce: nonce)
            isAuthenticated = true
            await refresh()
            return true
        } catch {
            authenticationErrorMessage = error.localizedDescription
            return false
        }
    }

    func signOut() async {
        isAuthenticated = false
        dashboard = nil
        transactions = []
        categories = []
        charts = nil
        gmailConnection = nil
        lastSync = nil
        authenticationErrorMessage = nil
        do {
            try await api.signOut()
        } catch {
            authenticationErrorMessage = error.localizedDescription
        }
    }

    func deleteAccount() async {
        settingsErrorMessage = nil
        do {
            let result = try await api.deleteAccount()
            accountDeletionGoogleRevocation = result.googleRevocation
            isAuthenticated = false
            dashboard = nil
            transactions = []
            categories = []
            charts = nil
            gmailConnection = nil
            lastSync = nil
        } catch {
            expireSessionIfNeeded(error)
            settingsErrorMessage = error.localizedDescription
        }
    }

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            async let dashboardRequest = api.dashboard()
            async let transactionsRequest = api.transactions()
            let (loadedDashboard, loadedTransactions) = try await (
                dashboardRequest,
                transactionsRequest
            )
            dashboard = loadedDashboard
            transactions = loadedTransactions.items
        } catch {
            expireSessionIfNeeded(error)
            errorMessage = error.localizedDescription
        }
    }

    func transaction(id: UUID) -> FinanceTransaction? {
        transactions.first { $0.id == id }
    }

    func loadTransactions(
        from: String? = nil,
        to: String? = nil,
        categoryId: UUID? = nil,
        merchant: String? = nil,
        cardName: String? = nil
    ) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await api.transactions(
                limit: 100,
                offset: 0,
                from: from,
                to: to,
                categoryId: categoryId,
                merchant: merchant,
                cardName: cardName
            )
            transactions = page.items
            errorMessage = nil
        } catch {
            expireSessionIfNeeded(error)
            errorMessage = error.localizedDescription
        }
    }

    func loadCategories() async {
        categoriesErrorMessage = nil
        do {
            categories = try await api.categories()
        } catch {
            expireSessionIfNeeded(error)
            categoriesErrorMessage = error.localizedDescription
        }
    }

    func updateCategory(transactionId: UUID, categoryId: UUID?) async -> Bool {
        errorMessage = nil
        do {
            let updated = try await api.updateCategory(
                transactionId: transactionId,
                categoryId: categoryId
            )
            transactions = transactions.map { $0.id == updated.id ? updated : $0 }
            return true
        } catch {
            expireSessionIfNeeded(error)
            errorMessage = error.localizedDescription
            return false
        }
    }

    func loadCharts(period: String, from: String?, to: String?) async {
        isLoadingCharts = true
        chartsErrorMessage = nil
        defer { isLoadingCharts = false }
        do {
            charts = try await api.charts(period: period, from: from, to: to)
        } catch {
            expireSessionIfNeeded(error)
            chartsErrorMessage = error.localizedDescription
        }
    }

    func loadGmailConnection() async {
        settingsErrorMessage = nil
        do {
            gmailConnection = try await api.gmailConnection()
        } catch {
            expireSessionIfNeeded(error)
            settingsErrorMessage = error.localizedDescription
        }
    }

    func connectGmail() async -> URL? {
        guard !isWorkingOnGmail else { return nil }
        isWorkingOnGmail = true
        settingsErrorMessage = nil
        defer { isWorkingOnGmail = false }

        do {
            return try await api.connectGmail().authorizationUrl
        } catch {
            expireSessionIfNeeded(error)
            settingsErrorMessage = error.localizedDescription
            return nil
        }
    }

    func syncGmail() async {
        guard !isWorkingOnGmail else { return }
        isWorkingOnGmail = true
        settingsErrorMessage = nil
        defer { isWorkingOnGmail = false }

        do {
            let syncResult = try await api.syncGmail()
            await refresh()
            lastSync = syncResult
            gmailConnection = try await api.gmailConnection()
        } catch {
            expireSessionIfNeeded(error)
            settingsErrorMessage = error.localizedDescription
        }
    }

    func disconnectGmail() async {
        guard !isWorkingOnGmail else { return }
        isWorkingOnGmail = true
        settingsErrorMessage = nil
        defer { isWorkingOnGmail = false }

        do {
            _ = try await api.disconnectGmail()
            gmailConnection = try await api.gmailConnection()
            lastSync = nil
        } catch {
            expireSessionIfNeeded(error)
            settingsErrorMessage = error.localizedDescription
            await loadGmailConnection()
        }
    }

    func exportTransactions() async -> Data? {
        guard !isWorkingOnData else { return nil }
        isWorkingOnData = true
        settingsErrorMessage = nil
        defer { isWorkingOnData = false }

        do {
            return try await api.exportTransactions()
        } catch {
            expireSessionIfNeeded(error)
            settingsErrorMessage = error.localizedDescription
            return nil
        }
    }

    func deleteAllTransactions() async -> Int? {
        guard !isWorkingOnData else { return nil }
        isWorkingOnData = true
        settingsErrorMessage = nil
        defer { isWorkingOnData = false }

        do {
            let result = try await api.deleteAllTransactions()
            transactions = []
            dashboard = nil
            charts = nil
            chartsErrorMessage = nil
            return result.deletedCount
        } catch {
            settingsErrorMessage = error.localizedDescription
            return nil
        }
    }

    func dismissSettingsError() {
        settingsErrorMessage = nil
    }

    func dismissAuthenticationError() {
        authenticationErrorMessage = nil
    }

    func presentAuthenticationError(_ message: String) {
        authenticationErrorMessage = message
    }

    func dismissAccountDeletionNotice() {
        accountDeletionGoogleRevocation = nil
    }

    private func expireSessionIfNeeded(_ error: Error) {
        guard let apiError = error as? FinanceAPIError,
              case .unauthorized = apiError else {
            return
        }
        isAuthenticated = false
        authenticationErrorMessage = apiError.localizedDescription
        dashboard = nil
        transactions = []
        charts = nil
        gmailConnection = nil
        lastSync = nil
    }
}

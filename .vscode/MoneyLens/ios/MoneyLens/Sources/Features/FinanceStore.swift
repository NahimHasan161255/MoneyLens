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
    @Published private(set) var isLoading = false
    @Published private(set) var isWorkingOnGmail = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var settingsErrorMessage: String?

    private let api = FinanceAPIClient()

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
            errorMessage = error.localizedDescription
        }
    }

    func loadCategories() async {
        categoriesErrorMessage = nil
        do {
            categories = try await api.categories()
        } catch {
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
            chartsErrorMessage = error.localizedDescription
        }
    }

    func loadGmailConnection() async {
        settingsErrorMessage = nil
        do {
            gmailConnection = try await api.gmailConnection()
        } catch {
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
            settingsErrorMessage = error.localizedDescription
            await loadGmailConnection()
        }
    }

    func dismissSettingsError() {
        settingsErrorMessage = nil
    }
}

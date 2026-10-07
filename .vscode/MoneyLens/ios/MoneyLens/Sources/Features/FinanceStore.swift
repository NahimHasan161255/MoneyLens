import Foundation
import Combine

@MainActor
final class FinanceStore: ObservableObject {
    @Published private(set) var dashboard: DashboardResponse?
    @Published private(set) var transactions: [FinanceTransaction] = []
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
            lastSync = try await api.syncGmail()
            await refresh()
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

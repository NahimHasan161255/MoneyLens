import Foundation
import Combine

@MainActor
final class FinanceStore: ObservableObject {
    @Published private(set) var dashboard: DashboardResponse?
    @Published private(set) var transactions: [FinanceTransaction] = []
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

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
}

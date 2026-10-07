import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
    case dashboard = "Dashboard"
    case transactions = "Transactions"
    case charts = "Charts"
    case settings = "Settings"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .dashboard: "square.grid.2x2"
        case .transactions: "list.bullet.rectangle"
        case .charts: "chart.bar.xaxis"
        case .settings: "gearshape"
        }
    }
}

struct MainTabView: View {
    @StateObject private var store = FinanceStore()
    @State private var selectedTab: AppTab = .dashboard
    @State private var isRestoringAuthentication = true

    var body: some View {
        Group {
            if isRestoringAuthentication {
                ProgressView("Loading MoneyLens…")
            } else if store.isAuthenticated {
                mainTabs
            } else {
                AppleSignInView()
            }
        }
        .tint(.indigo)
        .environmentObject(store)
        .alert(
            "MoneyLens account deleted",
            isPresented: Binding(
                get: { store.accountDeletionGoogleRevocation != nil },
                set: { if !$0 { store.dismissAccountDeletionNotice() } }
            )
        ) {
            Button("OK", role: .cancel) {
                store.dismissAccountDeletionNotice()
            }
        } message: {
            Text(accountDeletionMessage)
        }
        .task {
            await store.restoreAuthentication()
            isRestoringAuthentication = false
            if store.isAuthenticated {
                await store.refresh()
            }
        }
    }

    private var mainTabs: some View {
        TabView(selection: $selectedTab) {
            NavigationStack {
                DashboardView()
                    .navigationTitle("Dashboard")
            }
            .tabItem {
                Label(AppTab.dashboard.rawValue, systemImage: AppTab.dashboard.symbol)
            }
            .tag(AppTab.dashboard)

            NavigationStack {
                TransactionsView()
                    .navigationTitle("Transactions")
            }
            .tabItem {
                Label(AppTab.transactions.rawValue, systemImage: AppTab.transactions.symbol)
            }
            .tag(AppTab.transactions)

            NavigationStack {
                ChartsView()
                    .navigationTitle(AppTab.charts.rawValue)
            }
            .tabItem {
                Label(AppTab.charts.rawValue, systemImage: AppTab.charts.symbol)
            }
            .tag(AppTab.charts)

            NavigationStack {
                SettingsView()
                    .navigationTitle(AppTab.settings.rawValue)
            }
            .tabItem {
                Label(AppTab.settings.rawValue, systemImage: AppTab.settings.symbol)
            }
            .tag(AppTab.settings)
        }
    }

    private var accountDeletionMessage: String {
        switch store.accountDeletionGoogleRevocation {
        case .some("failed"):
            "Your MoneyLens data was deleted, but Google could not confirm revoking Gmail access. Remove MoneyLens from your Google Account security settings."
        case .some("unavailable"):
            "Your MoneyLens data was deleted. Gmail access could not be revoked by the server; remove MoneyLens from your Google Account security settings."
        case .some("revoked"):
            "Your MoneyLens data was deleted and Gmail access was revoked. Your Gmail messages were not deleted."
        case .some("not_connected"):
            "Your MoneyLens account and saved data were deleted. Your Gmail messages were not deleted."
        default:
            ""
        }
    }
}

struct EmptyFeatureView: View {
    let title: String
    let symbol: String
    let description: String

    var body: some View {
        ContentUnavailableView(
            title,
            systemImage: symbol,
            description: Text(description)
        )
    }
}

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

    var body: some View {
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
        .tint(.indigo)
        .environmentObject(store)
        .task {
            await store.refresh()
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

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

    var description: String {
        switch self {
        case .dashboard: "Your spending overview will appear here."
        case .transactions: "Your transaction history will appear here."
        case .charts: "Your spending charts will appear here."
        case .settings: "Account and app settings will appear here."
        }
    }
}

struct MainTabView: View {
    @State private var selectedTab: AppTab = .dashboard

    var body: some View {
        TabView(selection: $selectedTab) {
            ForEach(AppTab.allCases) { tab in
                NavigationStack {
                    ContentPlaceholder(tab: tab)
                        .navigationTitle(tab.rawValue)
                }
                .tabItem {
                    Label(tab.rawValue, systemImage: tab.symbol)
                }
                .tag(tab)
            }
        }
        .tint(.indigo)
    }
}

private struct ContentPlaceholder: View {
    let tab: AppTab

    var body: some View {
        ContentUnavailableView(
            tab.rawValue,
            systemImage: tab.symbol,
            description: Text(tab.description)
        )
    }
}

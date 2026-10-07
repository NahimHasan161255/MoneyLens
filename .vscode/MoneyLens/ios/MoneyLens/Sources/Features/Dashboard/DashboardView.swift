import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var store: FinanceStore

    var body: some View {
        Group {
            if let errorMessage = store.errorMessage, store.dashboard == nil {
                ContentUnavailableView {
                    Label("Couldn't load your spending", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Try Again") {
                        Task { await store.refresh() }
                    }
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        monthHeading

                        if let dashboard = store.dashboard {
                            ForEach(dashboard.currencies) { summary in
                                currencySummary(summary)
                            }

                            if dashboard.currencies.isEmpty {
                                ContentUnavailableView(
                                    "No spending yet",
                                    systemImage: "creditcard",
                                    description: Text(
                                        "New card transactions will appear after your account is connected and synced."
                                    )
                                )
                            }
                        } else if store.isLoading {
                            ProgressView("Loading spending…")
                                .frame(maxWidth: .infinity, minHeight: 180)
                        }

                        if let errorMessage = store.errorMessage {
                            Label(errorMessage, systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding()
                }
                .refreshable {
                    await store.refresh()
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await store.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(store.isLoading)
                .accessibilityLabel("Refresh spending")
            }
        }
    }

    private var monthHeading: some View {
        Text(.now, format: .dateTime.month(.wide).year())
            .font(.title2.weight(.semibold))
            .accessibilityAddTraits(.isHeader)
    }

    private func currencySummary(_ summary: CurrencySummary) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Total spent this month")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text(summary.thisMonth.value, format: .currency(code: summary.currency))
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
            }

            Divider()

            metricRow("Today", amount: summary.today.value, currency: summary.currency)
            metricRow("Last 7 days", amount: summary.last7Days.value, currency: summary.currency)
            metricRow("Last 14 days", amount: summary.last14Days.value, currency: summary.currency)
            metricRow("Last 30 days", amount: summary.last30Days.value, currency: summary.currency)
            metricRow("Last month", amount: summary.lastMonth.value, currency: summary.currency)
        }
        .padding()
        .background(.background, in: RoundedRectangle(cornerRadius: 20))
        .overlay {
            RoundedRectangle(cornerRadius: 20)
                .stroke(.quaternary, lineWidth: 1)
        }
    }

    private func metricRow(_ title: String, amount: Decimal, currency: String) -> some View {
        HStack {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer()
            Text(amount, format: .currency(code: currency))
                .fontWeight(.semibold)
                .monospacedDigit()
        }
        .font(.subheadline)
    }
}

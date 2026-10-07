import Charts
import SwiftUI

private enum SpendingChartPeriod: String, CaseIterable, Identifiable {
    case daily = "Daily"
    case weekly = "Weekly"
    case monthly = "Monthly"

    var id: String { rawValue }

    var apiValue: String {
        switch self {
        case .daily: "daily"
        case .weekly: "weekly"
        case .monthly: "monthly"
        }
    }

    var startDate: Date {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        switch self {
        case .daily:
            return calendar.date(byAdding: .day, value: -29, to: today) ?? today
        case .weekly:
            return calendar.date(byAdding: .day, value: -89, to: today) ?? today
        case .monthly:
            return calendar.date(byAdding: .month, value: -11, to: today) ?? today
        }
    }
}

struct ChartsView: View {
    @EnvironmentObject private var store: FinanceStore
    @State private var period: SpendingChartPeriod = .daily
    @State private var selectedCurrency: String?

    private var currencies: [String] {
        Array(Set((store.charts?.series.map(\.currency) ?? [])
            + (store.charts?.categories.map(\.currency) ?? [])))
            .sorted()
    }

    private var displayedCurrency: String? {
        if let selectedCurrency, currencies.contains(selectedCurrency) {
            return selectedCurrency
        }
        return currencies.first
    }

    private var points: [SpendingChartPoint] {
        store.charts?.series.filter { $0.currency == displayedCurrency } ?? []
    }

    private var categoryTotals: [CategorySpending] {
        store.charts?.categories
            .filter { $0.currency == displayedCurrency }
            .sorted {
                NSDecimalNumber(decimal: $0.amount.value)
                    .compare(NSDecimalNumber(decimal: $1.amount.value)) == .orderedDescending
            } ?? []
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Picker("Chart period", selection: $period) {
                    ForEach(SpendingChartPeriod.allCases) { choice in
                        Text(choice.rawValue).tag(choice)
                    }
                }
                .pickerStyle(.segmented)

                if currencies.count > 1 {
                    Picker("Currency", selection: Binding(
                        get: { displayedCurrency ?? "" },
                        set: { selectedCurrency = $0 }
                    )) {
                        ForEach(currencies, id: \.self) { currency in
                            Text(currency).tag(currency)
                        }
                    }
                    .pickerStyle(.menu)
                }

                if let error = store.chartsErrorMessage, store.charts != nil {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let error = store.chartsErrorMessage, store.charts == nil {
                    ContentUnavailableView {
                        Label("Couldn't load charts", systemImage: "chart.bar.xaxis")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try Again") { Task { await reload() } }
                    }
                } else if points.isEmpty && categoryTotals.isEmpty {
                    ContentUnavailableView(
                        "No spending data",
                        systemImage: "chart.bar.xaxis",
                        description: Text("Sync transactions to see your spending trends.")
                    )
                } else {
                    chartCard(title: "Spending over time") {
                        if points.isEmpty {
                            ContentUnavailableView(
                                "No spending in this period",
                                systemImage: "chart.bar"
                            )
                            .frame(height: 220)
                        } else {
                            Chart(points) { point in
                                if let date = ChartDate.parse(point.date) {
                                    BarMark(
                                        x: .value("Date", date, unit: chartCalendarUnit),
                                        y: .value("Amount", NSDecimalNumber(
                                            decimal: point.amount.value
                                        ).doubleValue)
                                    )
                                    .foregroundStyle(.indigo.gradient)
                                    .cornerRadius(4)
                                }
                            }
                            .chartXAxis {
                                AxisMarks(values: .automatic(desiredCount: 5)) { value in
                                    AxisGridLine()
                                    AxisValueLabel(format: axisDateFormat)
                                }
                            }
                            .frame(height: 240)
                        }
                    }

                    chartCard(title: "Spending by category") {
                        if categoryTotals.isEmpty {
                            ContentUnavailableView(
                                "No category data",
                                systemImage: "chart.bar"
                            )
                            .frame(height: 180)
                        } else {
                            Chart(categoryTotals) { item in
                                BarMark(
                                    x: .value(
                                        "Amount",
                                        NSDecimalNumber(decimal: item.amount.value).doubleValue
                                    ),
                                    y: .value("Category", item.category)
                                )
                                .foregroundStyle(by: .value("Category", item.category))
                                .cornerRadius(4)
                            }
                            .chartLegend(.hidden)
                            .frame(height: max(180, CGFloat(categoryTotals.count) * 38))
                        }
                    }
                }
            }
            .padding()
        }
        .overlay {
            if store.isLoadingCharts && store.charts == nil {
                ProgressView("Loading charts…")
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await reload() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh charts")
            }
        }
        .task {
            await reload()
        }
        .onChange(of: period) { _, _ in
            Task { await reload() }
        }
    }

    private var chartCalendarUnit: Calendar.Component {
        switch period {
        case .daily: .day
        case .weekly: .weekOfYear
        case .monthly: .month
        }
    }

    private var axisDateFormat: Date.FormatStyle {
        switch period {
        case .daily:
            .dateTime.month(.abbreviated).day()
        case .weekly:
            .dateTime.month(.abbreviated).day()
        case .monthly:
            .dateTime.month(.abbreviated).year(.twoDigits)
        }
    }

    private func chartCard<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.headline)
            content()
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(.quaternary, lineWidth: 1)
        }
    }

    private func reload() async {
        await store.loadCharts(
            period: period.apiValue,
            from: ChartDate.format(period.startDate),
            to: ChartDate.format(.now)
        )
    }
}

private enum ChartDate {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        return formatter.date(from: value)
    }

    static func format(_ value: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: value)
    }
}

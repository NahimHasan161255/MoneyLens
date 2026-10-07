import SwiftUI

struct TransactionsView: View {
    @EnvironmentObject private var store: FinanceStore
    @State private var filters = TransactionFilters()
    @State private var filterDraft = TransactionFilters()
    @State private var isShowingFilters = false

    var body: some View {
        Group {
            if let errorMessage = store.errorMessage, store.transactions.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load transactions", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Try Again") {
                        Task { await reload() }
                    }
                }
            } else if store.transactions.isEmpty, store.isLoading {
                ProgressView("Loading transactions…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.transactions.isEmpty {
                ContentUnavailableView(
                    "No transactions found",
                    systemImage: "list.bullet.rectangle",
                    description: Text(
                        filters.isActive
                            ? "Try changing or clearing your filters."
                            : "Your transaction history will appear here after your first sync."
                    )
                )
            } else {
                List {
                    if let errorMessage = store.errorMessage {
                        Section {
                            Label(errorMessage, systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    ForEach(store.transactions) { transaction in
                        NavigationLink(value: transaction.id) {
                            TransactionRow(transaction: transaction)
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .navigationDestination(for: UUID.self) { id in
                    if let transaction = store.transaction(id: id) {
                        TransactionDetailView(transaction: transaction)
                    } else {
                        ContentUnavailableView(
                            "Transaction unavailable",
                            systemImage: "questionmark.folder"
                        )
                    }
                }
                .refreshable {
                    await reload()
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    filterDraft = filters
                    isShowingFilters = true
                } label: {
                    Label(
                        filters.isActive ? "Filters (\(filters.activeCount))" : "Filter",
                        systemImage: "line.3.horizontal.decrease"
                    )
                }
                .accessibilityLabel("Filter transactions")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await reload() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(store.isLoading)
                .accessibilityLabel("Refresh transactions")
            }
        }
        .sheet(isPresented: $isShowingFilters) {
            TransactionFiltersSheet(
                filters: $filterDraft,
                categories: store.categories,
                categoriesErrorMessage: store.categoriesErrorMessage,
                onApply: {
                    filters = filterDraft
                    isShowingFilters = false
                    Task { await reload() }
                },
                onClear: {
                    filterDraft = TransactionFilters()
                }
            )
        }
        .task {
            await store.loadCategories()
            await reload()
        }
        .onChange(of: store.lastSync?.runId) { _, runId in
            guard runId != nil else { return }
            Task { await reload() }
        }
    }

    private func reload() async {
        let bounds = filters.dateBounds
        await store.loadTransactions(
            from: bounds?.from,
            to: bounds?.to,
            categoryId: filters.categoryId,
            merchant: filters.merchant,
            cardName: filters.cardName
        )
    }
}

private enum TransactionDateRange: String, CaseIterable, Identifiable {
    case last7Days = "Last 7 days"
    case last14Days = "Last 14 days"
    case last30Days = "Last 30 days"
    case thisMonth = "This month"
    case lastMonth = "Last month"
    case custom = "Custom range"

    var id: String { rawValue }
}

private struct TransactionFilters {
    var dateRange: TransactionDateRange = .last30Days
    var categoryId: UUID?
    var merchant = ""
    var cardName = ""
    var customFrom = Calendar.current.startOfDay(for: .now)
    var customTo = Calendar.current.startOfDay(for: .now)

    var isActive: Bool {
        dateRange != .last30Days
            || categoryId != nil
            || !merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !cardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var activeCount: Int {
        (dateRange == .last30Days ? 0 : 1)
            + (categoryId == nil ? 0 : 1)
            + (merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : 1)
            + (cardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : 1)
    }

    var dateBounds: (from: String, to: String)? {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        let start: Date

        switch dateRange {
        case .last7Days:
            start = calendar.date(byAdding: .day, value: -6, to: today) ?? today
        case .last14Days:
            start = calendar.date(byAdding: .day, value: -13, to: today) ?? today
        case .last30Days:
            start = calendar.date(byAdding: .day, value: -29, to: today) ?? today
        case .thisMonth:
            start = calendar.dateInterval(of: .month, for: today)?.start ?? today
        case .lastMonth:
            let previousMonth = calendar.date(byAdding: .month, value: -1, to: today) ?? today
            start = calendar.dateInterval(of: .month, for: previousMonth)?.start ?? previousMonth
            let end = calendar.dateInterval(of: .month, for: today)?.start ?? today
            return (formatDate(start), formatDate(calendar.date(byAdding: .day, value: -1, to: end) ?? end))
        case .custom:
            return (
                formatDate(min(customFrom, customTo)),
                formatDate(max(customFrom, customTo))
            )
        }

        return (formatDate(start), formatDate(today))
    }
}

private struct TransactionFiltersSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var filters: TransactionFilters
    let categories: [TransactionCategory]
    let categoriesErrorMessage: String?
    let onApply: () -> Void
    let onClear: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Date") {
                    Picker("Range", selection: $filters.dateRange) {
                        ForEach(TransactionDateRange.allCases) { range in
                            Text(range.rawValue).tag(range)
                        }
                    }

                    if filters.dateRange == .custom {
                        DatePicker("From", selection: $filters.customFrom, displayedComponents: .date)
                        DatePicker("To", selection: $filters.customTo, displayedComponents: .date)
                    }
                }

                Section("Transaction") {
                    if let error = categoriesErrorMessage {
                        Text("Categories couldn't be loaded: \(error)")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    Picker("Category", selection: $filters.categoryId) {
                        Text("All categories").tag(UUID?.none)
                        ForEach(categories) { category in
                            Text(category.name).tag(Optional(category.id))
                        }
                    }
                    TextField("Merchant", text: $filters.merchant)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Card", text: $filters.cardName)
                }

                Section {
                    Button("Clear filters", role: .destructive, action: onClear)
                }
            }
            .navigationTitle("Filter transactions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply", action: onApply)
                }
            }
        }
    }
}

private struct TransactionRow: View {
    let transaction: FinanceTransaction

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "creditcard")
                .font(.title3)
                .foregroundStyle(.indigo)
                .frame(width: 42, height: 42)
                .background(.indigo.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))

            VStack(alignment: .leading, spacing: 4) {
                Text(transaction.merchant)
                    .font(.headline)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(TransactionDateFormat.display(transaction.date))
                    Text("·")
                    Text(transaction.category)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Text(transaction.amount.value, format: .currency(code: transaction.currency))
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .padding(.vertical, 4)
    }
}

private struct TransactionDetailView: View {
    @EnvironmentObject private var store: FinanceStore
    let transaction: FinanceTransaction
    @State private var selectedCategoryId: UUID?
    @State private var savedCategoryId: UUID?
    @State private var isSavingCategory = false
    @State private var isShowingCategoryError = false

    var body: some View {
        List {
            LabeledContent("Merchant", value: transaction.merchant)
            LabeledContent("Date", value: TransactionDateFormat.display(transaction.date))
            if let time = transaction.time {
                LabeledContent("Time", value: time)
            }
            Picker("Category", selection: $selectedCategoryId) {
                Text("Other").tag(UUID?.none)
                ForEach(store.categories) { category in
                    Text(category.name).tag(Optional(category.id))
                }
            }
            LabeledContent(
                "Amount",
                value: transaction.amount.value.formatted(
                    .currency(code: transaction.currency)
                )
            )
            if let cardName = transaction.cardName {
                LabeledContent("Card", value: cardName)
            }
        }
        .navigationTitle("Transaction")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    isSavingCategory = true
                    Task {
                        let saved = await store.updateCategory(
                            transactionId: transaction.id,
                            categoryId: selectedCategoryId
                        )
                        if saved {
                            savedCategoryId = selectedCategoryId
                        }
                        isSavingCategory = false
                        isShowingCategoryError = !saved
                    }
                }
                .disabled(isSavingCategory || selectedCategoryId == savedCategoryId)
            }
        }
        .task {
            selectedCategoryId = transaction.categoryId
            savedCategoryId = transaction.categoryId
            if store.categories.isEmpty {
                await store.loadCategories()
            }
            isShowingCategoryError = store.categoriesErrorMessage != nil
        }
        .alert("Couldn't update category", isPresented: $isShowingCategoryError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.errorMessage ?? store.categoriesErrorMessage ?? "Please try again.")
        }
    }
}

private enum TransactionDateFormat {
    static func display(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        guard let date = formatter.date(from: value) else {
            return value
        }
        return date.formatted(date: .numeric, time: .omitted)
    }
}

private func formatDate(_ value: Date) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: value)
}

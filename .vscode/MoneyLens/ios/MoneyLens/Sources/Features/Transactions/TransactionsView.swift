import SwiftUI

struct TransactionsView: View {
    @EnvironmentObject private var store: FinanceStore

    var body: some View {
        Group {
            if let errorMessage = store.errorMessage, store.transactions.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load transactions", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Try Again") {
                        Task { await store.refresh() }
                    }
                }
            } else if store.transactions.isEmpty, store.isLoading {
                ProgressView("Loading transactions…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.transactions.isEmpty {
                ContentUnavailableView(
                    "No transactions yet",
                    systemImage: "list.bullet.rectangle",
                    description: Text(
                        "Your transaction history will appear here after your first sync."
                    )
                )
            } else {
                List(store.transactions) { transaction in
                    NavigationLink(value: transaction.id) {
                        TransactionRow(transaction: transaction)
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
                .accessibilityLabel("Refresh transactions")
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
    let transaction: FinanceTransaction

    var body: some View {
        List {
            LabeledContent("Merchant", value: transaction.merchant)
            LabeledContent(
                "Date",
                value: TransactionDateFormat.display(transaction.date)
            )
            if let time = transaction.time {
                LabeledContent("Time", value: time)
            }
            LabeledContent("Category", value: transaction.category)
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

import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @EnvironmentObject private var store: FinanceStore
    @Environment(\.openURL) private var openURL
    @State private var isConfirmingDisconnect = false
    @State private var isConfirmingSignOut = false
    @State private var isConfirmingAccountDeletion = false
    @State private var isConfirmingDataDeletion = false
    @State private var isShowingDeleteSuccess = false
    @State private var isExportingFile = false
    @State private var exportDocument = TransactionExportDocument(data: Data())
    @State private var deletedTransactionCount = 0
    @State private var exportFileError: String?

    var body: some View {
        List {
            gmailSection
            syncSection

            Section("Data") {
                Button {
                    Task {
                        guard let data = await store.exportTransactions() else { return }
                        exportDocument = TransactionExportDocument(data: data)
                        isExportingFile = true
                    }
                } label: {
                    HStack {
                        Label("Export transactions as CSV", systemImage: "square.and.arrow.up")
                        Spacer()
                        if store.isWorkingOnData {
                            ProgressView()
                        }
                    }
                }
                .disabled(store.isWorkingOnData)

                Button(role: .destructive) {
                    isConfirmingDataDeletion = true
                } label: {
                    Label("Delete all transaction data", systemImage: "trash")
                }
                .disabled(store.isWorkingOnData)

                Text("CSV exports include transaction details but never email contents or Gmail message IDs.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                Text("MoneyLens reads card-notification emails with Gmail read-only access. Your Gmail password is never requested or stored.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Privacy")
            }

            Section("Account") {
                Button(role: .destructive) {
                    isConfirmingSignOut = true
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }

                Button(role: .destructive) {
                    isConfirmingAccountDeletion = true
                } label: {
                    Label("Delete MoneyLens account", systemImage: "person.crop.circle.badge.xmark")
                }
            }
        }
        .listStyle(.insetGrouped)
        .task {
            await store.loadGmailConnection()
        }
        .refreshable {
            await store.loadGmailConnection()
        }
        .fileExporter(
            isPresented: $isExportingFile,
            document: exportDocument,
            contentType: .commaSeparatedText,
            defaultFilename: "moneylens-transactions",
            onCompletion: { result in
                if case let .failure(error) = result {
                    exportFileError = error.localizedDescription
                }
            }
        )
        .alert(
            "Gmail settings",
            isPresented: Binding(
                get: { store.settingsErrorMessage != nil },
                set: { if !$0 { store.dismissSettingsError() } }
            )
        ) {
            Button("OK", role: .cancel) {
                store.dismissSettingsError()
            }
        } message: {
            Text(store.settingsErrorMessage ?? "")
        }
        .confirmationDialog(
            "Disconnect Gmail?",
            isPresented: $isConfirmingDisconnect,
            titleVisibility: .visible
        ) {
            Button("Disconnect Gmail", role: .destructive) {
                Task { await store.disconnectGmail() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("MoneyLens will remove its saved Gmail connection. Your existing transactions will remain.")
        }
        .confirmationDialog(
            "Sign out of MoneyLens?",
            isPresented: $isConfirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) {
                Task { await store.signOut() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your account and saved transactions will remain available when you sign in again.")
        }
        .confirmationDialog(
            "Delete your MoneyLens account?",
            isPresented: $isConfirmingAccountDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete account and data", role: .destructive) {
                Task { await store.deleteAccount() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes your MoneyLens account, transactions, and saved Gmail authorization. It does not delete emails in Gmail.")
        }
        .confirmationDialog(
            "Delete all transaction data?",
            isPresented: $isConfirmingDataDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete all transactions", role: .destructive) {
                Task {
                    guard let count = await store.deleteAllTransactions() else { return }
                    deletedTransactionCount = count
                    isShowingDeleteSuccess = true
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently removes saved transactions. Gmail stays connected and sync history is kept so previously imported emails won't add these transactions again.")
        }
        .alert("Transactions deleted", isPresented: $isShowingDeleteSuccess) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("\(deletedTransactionCount) transaction(s) deleted. Your Gmail connection was not changed.")
        }
        .alert("Couldn't export transactions", isPresented: Binding(
            get: { exportFileError != nil },
            set: { if !$0 { exportFileError = nil } }
        )) {
            Button("OK", role: .cancel) { exportFileError = nil }
        } message: {
            Text(exportFileError ?? "")
        }
    }

    private struct TransactionExportDocument: FileDocument {
        static var readableContentTypes: [UTType] { [.commaSeparatedText] }
        static var writableContentTypes: [UTType] { [.commaSeparatedText] }

        let data: Data

        init(data: Data) {
            self.data = data
        }

        init(configuration: ReadConfiguration) throws {
            guard let contents = configuration.file.regularFileContents else {
                throw CocoaError(.fileReadCorruptFile)
            }
            data = contents
        }

        func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
            FileWrapper(regularFileWithContents: data)
        }
    }

    private var gmailSection: some View {
        Section("Gmail account") {
            HStack(spacing: 12) {
                Image(systemName: store.gmailConnection?.connected == true
                      ? "checkmark.circle.fill"
                      : "envelope")
                    .font(.title2)
                    .foregroundStyle(
                        store.gmailConnection?.connected == true ? Color.green : Color.secondary
                    )
                VStack(alignment: .leading, spacing: 3) {
                    Text(store.gmailConnection?.connected == true ? "Connected" : "Not connected")
                        .font(.headline)
                    if let connectedAt = store.gmailConnection?.connectedAt {
                        Text("Connected \(connectedAt.formatted(date: .abbreviated, time: .omitted))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Connect your Google account to import card notifications.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                }
            }
            .padding(.vertical, 4)

            if store.gmailConnection?.connected == true {
                Button {
                    isConfirmingDisconnect = true
                } label: {
                    Label("Disconnect account", systemImage: "xmark.circle")
                        .foregroundStyle(.red)
                }
                .disabled(store.isWorkingOnGmail)
            } else {
                Button {
                    Task {
                        guard let authorizationURL = await store.connectGmail() else {
                            return
                        }
                        openURL(authorizationURL)
                    }
                } label: {
                    HStack {
                        Label("Connect Gmail", systemImage: "envelope.badge")
                        Spacer()
                        if store.isWorkingOnGmail {
                            ProgressView()
                        }
                    }
                }
                .disabled(store.isWorkingOnGmail)
            }

            Text("Permission requested: Gmail read-only. After approving access in your browser, return here and refresh connection status.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var syncSection: some View {
        Section("Email synchronization") {
            Button {
                Task { await store.syncGmail() }
            } label: {
                HStack {
                    Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
                    Spacer()
                    if store.isWorkingOnGmail {
                        ProgressView()
                    }
                }
            }
            .disabled(store.isWorkingOnGmail || store.gmailConnection?.connected != true)

            if let lastSync = store.lastSync {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Last sync completed")
                        .font(.subheadline.weight(.medium))
                    Text("\(lastSync.addedCount) added · \(lastSync.skippedCount) skipped · \(lastSync.unsupportedCount) unsupported")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if lastSync.reconciled {
                        Text("A full search was used to restore the expired Gmail history cursor.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

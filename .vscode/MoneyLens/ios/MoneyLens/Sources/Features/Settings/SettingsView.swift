import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: FinanceStore
    @Environment(\.openURL) private var openURL
    @State private var isConfirmingDisconnect = false

    var body: some View {
        List {
            gmailSection
            syncSection

            Section("Data") {
                Label("Export and data management", systemImage: "square.and.arrow.up")
                Text("Export and delete-data options will be available in a later update.")
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
        }
        .listStyle(.insetGrouped)
        .task {
            await store.loadGmailConnection()
        }
        .refreshable {
            await store.loadGmailConnection()
        }
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

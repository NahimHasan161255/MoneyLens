import AuthenticationServices
import CryptoKit
import SwiftUI
import UIKit

struct AppleSignInView: View {
    @EnvironmentObject private var store: FinanceStore
    @State private var nonce: String?
    @State private var isLoadingNonce = false

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            Image(systemName: "chart.pie.fill")
                .font(.system(size: 52))
                .foregroundStyle(.indigo)
                .accessibilityHidden(true)

            VStack(spacing: 10) {
                Text("Welcome to MoneyLens")
                    .font(.largeTitle.bold())
                    .multilineTextAlignment(.center)
                Text("Sign in securely to view and manage your spending.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            if let nonce {
                SignInWithAppleButton(.signIn) { request in
                    request.nonce = hashed(nonce)
                } onCompletion: { result in
                    handle(result, rawNonce: nonce)
                }
                .signInWithAppleButtonStyle(.black)
                .frame(height: 52)
                .disabled(store.isSigningIn || isLoadingNonce)
            } else {
                Button {
                    Task { await loadNonce() }
                } label: {
                    HStack {
                        if isLoadingNonce {
                            ProgressView()
                                .tint(.white)
                        }
                        Text(isLoadingNonce ? "Preparing secure sign-in…" : "Try again")
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(.black, in: RoundedRectangle(cornerRadius: 8))
                    .foregroundStyle(.white)
                }
                .disabled(isLoadingNonce)
            }

            if store.isSigningIn {
                ProgressView("Signing in…")
            }

            Text("Your Apple account is used only to securely sign in. MoneyLens never receives your Apple password.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground))
        .task {
            await loadNonce()
        }
        .alert(
            "Apple sign-in",
            isPresented: Binding(
                get: { store.authenticationErrorMessage != nil },
                set: { if !$0 { store.dismissAuthenticationError() } }
            )
        ) {
            Button("OK", role: .cancel) {
                store.dismissAuthenticationError()
            }
        } message: {
            Text(store.authenticationErrorMessage ?? "")
        }
    }

    private func loadNonce() async {
        isLoadingNonce = true
        nonce = await store.loadAppleSignInNonce()
        isLoadingNonce = false
    }

    private func handle(_ result: Result<ASAuthorization, Error>, rawNonce: String) {
        switch result {
        case let .success(authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let identityToken = String(data: tokenData, encoding: .utf8) else {
                store.presentAuthenticationError("Apple did not return a valid identity token.")
                nonce = nil
                Task { await loadNonce() }
                return
            }
            nonce = nil
            Task {
                if !(await store.signInWithApple(
                    identityToken: identityToken,
                    nonce: rawNonce
                )) {
                    await loadNonce()
                }
            }
        case let .failure(error):
            if let authorizationError = error as? ASAuthorizationError,
               authorizationError.code == .canceled {
                nonce = nil
                Task { await loadNonce() }
                return
            }
            store.presentAuthenticationError(error.localizedDescription)
            nonce = nil
            Task { await loadNonce() }
        }
    }

    private func hashed(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

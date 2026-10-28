#if os(iOS) && !SKIP
import SwiftUI

struct JoinCodeSheet: View {
    let premeeting: PremeetingPresenter
    @State private var input = ""
    @State private var showsInvalid = false
    @State private var detent: PresentationDetent = .medium
    @FocusState private var isFocused: Bool

    private var isValid: Bool {
        EntryPolicies.isValidJoinInput(input)
    }

    private var suggestion: String? {
        premeeting.home.rejoin?.title
    }

    private var inputBinding: Binding<String> {
        Binding(get: { input }, set: { newValue in
            input = EntryPolicies.sanitizeRoomInput(newValue)
            showsInvalid = false
        })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(text: inputBinding, prompt: Text(ConclaveStrings.text("Code or Link"))) {
                        Text(ConclaveStrings.text("Meeting Code or Link"))
                    }
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.join)
                    .onSubmit(submit)
                    .focused($isFocused)
                    .accessibilityIdentifier("join.field")
                    PasteButton(payloadType: String.self) { strings in
                        guard let first = strings.first else { return }
                        input = EntryPolicies.sanitizeRoomInput(first)
                        showsInvalid = EntryPolicies.showsInvalidJoinInput(input)
                    }
                    .accessibilityIdentifier("join.paste")
                } header: {
                    Text(ConclaveStrings.text("Meeting Code or Link"))
                } footer: {
                    JoinCodeFooter(showsInvalid: showsInvalid)
                }
                if let suggestion {
                    Section {
                        Button { premeeting.rejoin() } label: {
                            Label {
                                Text(ConclaveStrings.format("Rejoin %@", suggestion))
                            } icon: {
                                Image(systemName: ConclaveSymbols.arrowClockwise).accessibilityHidden(true)
                            }
                        }
                            .tint(HostingTheme.coralText)
                            .accessibilityIdentifier("join.rejoinSuggestion")
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(ConclaveStrings.text("Join Meeting"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(ConclaveStrings.text("Cancel"), role: .cancel) { premeeting.dismissJoinSheet() }
                        .accessibilityIdentifier("join.cancel")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    Divider()
                    JoinConfirmButton(isValid: isValid, action: submit)
                        .padding(16)
                }
                .background(Color(uiColor: .systemGroupedBackground))
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .onChange(of: isFocused) {
            if isFocused {
                detent = .large
            }
        }
    }

    private func submit() {
        guard isValid else {

            showsInvalid = !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            premeeting.submitJoinInput(input)
            return
        }
        premeeting.submitJoinInput(input)
    }
}

private struct JoinCodeFooter: View {
    let showsInvalid: Bool

    var body: some View {
        if showsInvalid {
            Label(ConclaveStrings.text("This isn\u{2019}t a Conclave code or link."), systemImage: PremeetingSymbols.error)
                .foregroundStyle(Color(uiColor: .systemRed))
                .accessibilityIdentifier("join.error")
        } else {
            Text(ConclaveStrings.text("Enter the code from your invite, or paste the link."))
                .accessibilityIdentifier("join.help")
        }
    }
}

private struct JoinConfirmButton: View {
    let isValid: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(ConclaveStrings.text("Join"))
                .foregroundStyle(HostingTheme.onCoral)
                .frame(maxWidth: .infinity, minHeight: 28)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .tint(HostingTheme.coralFill)
        .opacity(isValid ? 1 : HostingTheme.disabledOpacity)
        .disabled(!isValid)
        .accessibilityIdentifier("join.confirm")
    }
}
#endif

#if os(iOS) && !SKIP
import SwiftUI

private enum JoinCodeSheetAnchor {
    static let rejoin = "join.row.rejoin"
    static let confirm = "join.row.confirm"
}

struct JoinCodeSheet: View {
    let premeeting: PremeetingPresenter
    @State private var input = ""
    @State private var showsInvalid = false
    @State private var invalidReveal = 0
    @State private var detent: PresentationDetent = .medium
    @FocusState private var isFocused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isValid: Bool {
        EntryPolicies.isValidJoinInput(input)
    }

    private var suggestion: String? {
        premeeting.home.rejoin?.title
    }

    private var seed: String {
        JoinRoomIdentityPolicy.seed(input: input, knownRoomIds: JoinRoomIdentityPolicy.knownRoomIds(home: premeeting.home))
    }

    private var rejoinSeed: String {
        JoinRoomIdentityPolicy.rejoinSeed(home: premeeting.home)
    }

    private var confirmsInForm: Bool {
        dynamicTypeSize.isAccessibilitySize
    }

    private var inputBinding: Binding<String> {
        Binding(get: { input }, set: { newValue in
            input = EntryPolicies.sanitizeRoomInput(newValue)
            showsInvalid = false
        })
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    Section {
                        HStack(spacing: 12) {
                            JoinRoomSlot(seed: seed)
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
                            .alignmentGuide(.listRowSeparatorLeading) { dimensions in dimensions[.leading] }
                        }
                        PasteButton(payloadType: String.self) { strings in
                            guard let first = strings.first else { return }
                            input = EntryPolicies.sanitizeRoomInput(first)
                            revealInvalid(EntryPolicies.showsInvalidJoinInput(input))
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
                                    if rejoinSeed.isEmpty {
                                        Image(systemName: ConclaveSymbols.arrowClockwise).accessibilityHidden(true)
                                    } else {
                                        ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(rejoinSeed), size: .mention, diameter: 24)
                                            .accessibilityHidden(true)
                                    }
                                }
                            }
                            .tint(HostingTheme.coralText)
                            .accessibilityIdentifier("join.rejoinSuggestion")
                            .id(JoinCodeSheetAnchor.rejoin)
                        }
                    }
                    if confirmsInForm {
                        Section {
                            JoinConfirmButton(isValid: isValid, action: submit)
                                .listRowInsets(EdgeInsets())
                                .listRowBackground(Color.clear)
                                .id(JoinCodeSheetAnchor.confirm)
                        }
                    }
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: invalidReveal) {
                    guard confirmsInForm else { return }
                    withAnimation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion)) {
                        proxy.scrollTo(suggestion == nil ? JoinCodeSheetAnchor.confirm : JoinCodeSheetAnchor.rejoin)
                    }
                }
            }
            .navigationTitle(ConclaveStrings.text("Join Meeting"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(ConclaveStrings.text("Cancel"), role: .cancel) { premeeting.dismissJoinSheet() }
                        .accessibilityIdentifier("join.cancel")
                }
            }
            .modifier(JoinConfirmBar(isVisible: !confirmsInForm, bar: JoinConfirmButton(isValid: isValid, action: submit)))
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .onChange(of: isFocused) {
            if isFocused {
                detent = .large
            }
        }
    }

    private func revealInvalid(_ invalid: Bool) {
        showsInvalid = invalid
        if invalid {
            invalidReveal += 1
        }
    }

    private func submit() {
        guard isValid else {
            revealInvalid(!input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            premeeting.submitJoinInput(input)
            return
        }
        premeeting.submitJoinInput(input)
    }
}

private struct JoinConfirmBar<Bar: View>: ViewModifier {
    let isVisible: Bool
    let bar: Bar

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                .safeAreaBar(edge: .bottom, spacing: 0) {
                    if isVisible {
                        bar.padding(16)
                    }
                }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                if isVisible {
                    VStack(spacing: 0) {
                        Divider()
                        bar.padding(16)
                    }
                    .background(Color(uiColor: .systemGroupedBackground))
                }
            }
        }
    }
}

private struct JoinRoomSlot: View {
    let seed: String

    var body: some View {
        ZStack {
            if seed.isEmpty {
                Image(systemName: ConclaveSymbols.link)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            } else {
                ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(seed), size: .mention, diameter: 28)
                    .id(seed)
                    .transition(.scale(0.85).combined(with: .opacity))
            }
        }
        .frame(width: 28, height: 28)
        .animation(ConclaveMotion.snap, value: seed)
        .accessibilityHidden(true)
    }
}

private struct JoinCodeFooter: View {
    let showsInvalid: Bool

    var body: some View {
        if showsInvalid {
            Label(ConclaveStrings.text("This isn\u{2019}t a Conclave code or link."), systemImage: PremeetingSymbols.error)
                .foregroundStyle(Color(uiColor: .systemRed))
                .accessibilityIdentifier("join.error")
        }
    }
}

private struct JoinConfirmButton: View {
    let isValid: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            label
                .frame(maxWidth: .infinity, minHeight: 28)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .tint(HostingTheme.coralFill)
        .disabled(!isValid)
        .accessibilityIdentifier("join.confirm")
    }

    @ViewBuilder
    private var label: some View {
        if isValid {
            Text(ConclaveStrings.text("Join"))
                .foregroundStyle(HostingTheme.onCoral)
        } else {
            Text(ConclaveStrings.text("Join"))
        }
    }
}
#endif

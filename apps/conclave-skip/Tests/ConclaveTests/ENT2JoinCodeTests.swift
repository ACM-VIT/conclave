#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ENT2JoinCodeTests {
    @Test func submittingALinkPushesItsLobbyOnlyAfterTheSheetIsGoneWithTheInviteCode() throws {
        let presenter = PremeetingPresenter()
        presenter.openJoinSheet()
        #expect(presenter.isJoinSheetPresented)
        presenter.submitJoinInput("https://conclave.acmvit.in/rose-sora-luffy?meetingInviteCode=abc")
        #expect(!presenter.isJoinSheetPresented)
        #expect(presenter.path.isEmpty, "never pushed while the sheet is dismissing")
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.count == 1)
        let target = presenter.target(forRoute: try #require(presenter.path.first).id)
        #expect(target?.roomId == "rose-sora-luffy")
        #expect(target?.meetingInviteCode == "abc")
        #expect(target?.allowRoomCreation == true)
        #expect(target?.intent == .join)

        presenter.joinSheetDidDismiss()
        #expect(presenter.path.count == 1)
        #expect(presenter.feedbackState.token.kind == .none)
    }

    @Test func aTypedCodeAndAWebinarLinkOpenTheirPages() {
        let presenter = PremeetingPresenter()
        presenter.openJoinSheet()
        presenter.submitJoinInput(EntryPolicies.sanitizeRoomInput("Rose Sora Luffy"))
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.map { $0.roomId } == ["rose-sora-luffy"])
        presenter.setPath([])
        presenter.openJoinSheet()
        presenter.submitJoinInput("https://conclave.acmvit.in/w/yuki-haz")
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.map { $0.kind } == [.webinarLanding])
    }

    @Test func aRejectedSubmitKeepsTheSheetAndPublishesValidationFailed() {
        let presenter = PremeetingPresenter()
        presenter.openJoinSheet()
        presenter.submitJoinInput("https://example.com/rose")
        #expect(presenter.isJoinSheetPresented)
        #expect(presenter.feedbackState.token == FeedbackToken(sequence: 1, kind: .validationFailed))
        presenter.submitJoinInput("")
        #expect(presenter.feedbackState.token.sequence == 2)

        presenter.dismissJoinSheet()
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.isEmpty)
    }

    @Test func theRejoinSuggestionLeavesTheSheetBeforeOpeningTheLobby() {
        let presenter = PremeetingPresenter()
        let now: Double = 1793102400000.0
        presenter.nowMillis = { now }
        presenter.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: .home, nowMillis: now))
        presenter.openJoinSheet()
        presenter.rejoin()
        #expect(!presenter.isJoinSheetPresented)
        #expect(presenter.path.isEmpty)
        presenter.joinSheetDidDismiss()
        #expect(presenter.path.first?.roomId == "rose-sora-luffy")
        #expect(presenter.lobbyStatus?.intent == .rejoin)
    }

    @Test func theIOSSheetFollowsTheS10Layout() throws {
        let ios = try ent2Source("Sources/Conclave/Features/Join/JoinCodeSheet+iOS.swift")
        let flat = ent2Flat(ios)
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(flat.contains(".presentationDetents([.medium, .large], selection: $detent)"))
        #expect(flat.contains(".presentationDragIndicator(.visible)"))
        #expect(flat.contains(".onChange(of: isFocused) { if isFocused { detent = .large } }"))
        #expect(flat.contains("PasteButton(payloadType: String.self)"))
        #expect(flat.contains(".keyboardType(.URL) .textContentType(.URL) .textInputAutocapitalization(.never) .autocorrectionDisabled() .submitLabel(.join)"))

        #expect(!ios.contains("isFocused = true"))
        #expect(!ios.contains("defaultFocus"))

        #expect(flat.contains("ToolbarItem(placement: .cancellationAction) { Button(ConclaveStrings.text(\"Cancel\"), role: .cancel)"))
        #expect(!flat.contains("ToolbarItem(placement: .confirmationAction)"))
        #expect(flat.contains(".safeAreaInset(edge: .bottom, spacing: 0) { VStack(spacing: 0) { Divider() JoinConfirmButton(isValid: isValid, action: submit) .padding(16) } .background(Color(uiColor: .systemGroupedBackground)) }"))
        #expect(!ios.contains("role: .close"))

        #expect(flat.contains("Button(action: action) { Text(ConclaveStrings.text(\"Join\")) .foregroundStyle(HostingTheme.onCoral) .frame(maxWidth: .infinity, minHeight: 28) } .buttonStyle(.borderedProminent) .controlSize(.large) .tint(HostingTheme.coralFill) .opacity(isValid ? 1 : HostingTheme.disabledOpacity) .disabled(!isValid)"))
        #expect(flat.contains(".scrollDismissesKeyboard(.interactively)"))
        #expect(!ios.contains("Color.white") && !ios.contains(".foregroundStyle(.white)"))
        #expect(flat.contains("input = EntryPolicies.sanitizeRoomInput(newValue)"))

        let root = ent2Flat(try ent2Source("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift"))
        #expect(root.contains(".sheet(isPresented: joinSheetBinding, onDismiss: { premeeting.joinSheetDidDismiss() }) { JoinCodeSheet(premeeting: premeeting) }"))
        #expect(root.contains("Binding(get: { premeeting.isJoinSheetPresented }, set: { if !$0 { premeeting.dismissJoinSheet() } })"))
    }

    @Test func theAndroidSheetFollowsTheS10Layout() throws {
        let android = try ent2Source("Sources/Conclave/Skip/ui/join/JoinCodeSheet.kt")
        let flat = ent2Flat(android)
        #expect(flat.contains("rememberModalBottomSheetState(skipPartiallyExpanded = true)"))
        #expect(flat.contains("ModalBottomSheet( onDismissRequest = { premeeting.dismissJoinSheet() },"))

        #expect(flat.contains("LaunchedEffect(Unit) { snapshotFlow { sheetState.isVisible }.first { it } focus.requestFocus() }"))

        #expect(android.contains("primaryClipDescription?.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN)"))
        #expect(flat.contains("keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go,"))

        #expect(!android.contains("invokeOnCompletion"))
        #expect(flat.contains("sheetState.hide() if (!sheetState.isVisible) premeeting.submitJoinInput(raw)"))
        #expect(flat.contains("if (isSubmitting) return"))
        #expect(flat.contains("Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())"))
        #expect(flat.contains("DisposableEffect(premeeting) { onDispose { premeeting.joinSheetDidDismiss() } }"))
        #expect(flat.contains("containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer"))
        #expect(!android.contains("FlexibleBottomSheet"), "a handwritten M3 sheet, not the legacy bridge")
    }

    @Test func theSwitchPromptUsesTheSystemAlertOnIOSAndAnAlertDialogOnAndroid() throws {
        let ios = ent2Flat(try ent2Source("Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift"))
        #expect(ios.contains("content.alert(ConclaveStrings.text(\"Join Another Meeting?\"), isPresented: isPresented, presenting: premeeting.switchPrompt) { prompt in Button(ConclaveStrings.text(\"Stay\"), role: .cancel) { premeeting.stay(id: prompt.id) } Button(ConclaveStrings.text(\"Leave and Join\")) { premeeting.confirmSwitch(id: prompt.id) }"))
        let android = ent2Flat(try ent2Source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt"))
        #expect(android.contains("AlertDialog( onDismissRequest = { premeeting.stay(id = prompt.id) },"))
        #expect(android.contains("HostingTheme(inCall = inCall) { PremeetingSwitchDialog(premeeting, prompt) }"))
    }

    @Test func entryStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(ent2Source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        for key in ["Meetings", "New Meeting", "Join", "Recent", "Join Meeting", "Meeting Code or Link", "Code or Link",
                    "Enter the code from your invite, or paste the link.", "This isn\u{2019}t a Conclave code or link.",
                    "Join Another Meeting?", "You\u{2019}re in %@. Leave it and join %@?", "Stay", "Leave and Join",
                    "This link can\u{2019}t be opened in Conclave.", "Update Conclave", "No Recent Meetings"] {
            let entry = strings[key] as? [String: Any]
            #expect(entry != nil, "missing \(key)")
            #expect(entry?["extractionState"] as? String == "manual", "\(key)")
        }
        let xml = try ent2Source("Android/app/src/main/res/values/strings.xml")
        for name in ["pm_app_title", "pm_new_meeting", "pm_join_with_code", "pm_join_meeting", "pm_code_or_link_label",
                     "pm_code_help", "pm_code_invalid", "pm_paste", "pm_join", "pm_switch_title", "pm_switch_body",
                     "pm_switch_stay", "pm_switch_leave_and_join", "pm_notice_invalid_link", "pm_update_title", "pm_empty_title"] {
            #expect(xml.contains("<string name=\"\(name)\">"), "missing \(name)")
        }
        #expect(xml.contains("<string name=\"pm_switch_body\">You\u{2019}re in %1$s. Leave it and join %2$s?</string>"))
    }
}

private func ent2Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func ent2Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif

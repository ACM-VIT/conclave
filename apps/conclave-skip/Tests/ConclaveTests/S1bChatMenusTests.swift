#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1bChatMenusTests {
    private static let sheetFile = "Sources/Conclave/Skip/ui/chat/MessageActionsSheet.kt"
    private static let composerFile = "Sources/Conclave/Skip/ui/chat/ChatComposer.kt"
    private static let voiceFile = "Sources/Conclave/Skip/ui/chat/VoiceBubble.kt"
    private static let transcriptPageFile = "Sources/Conclave/Skip/ui/transcript/TranscriptPage.kt"
    private static let transcriptListsFile = "Sources/Conclave/Skip/ui/transcript/TranscriptLists.kt"
    private static let questionRowFile = "Sources/Conclave/Skip/ui/qa/QuestionRow.kt"
    private static let ownedFiles = [sheetFile, composerFile, voiceFile, transcriptPageFile, transcriptListsFile, questionRowFile]

    @Test func recipientFacesSeedExactlyLikeThePeopleRows() throws {
        let local = "u-jordan"
        let avery = "u-avery"
        let sam = "u-sam"
        let chat = ChatPresenter()
        chat.now = { 1_800_014_400_000.0 }
        chat.sleep = { _ in }
        chat.apply(ChatInputs.make(callSession: 1, roomId: "room-a", localUserId: local, localName: "Jordan Lee", gate: .allowed,
                                   roster: [ChatRosterEntry(userId: local, name: "Jordan Lee", isPresent: true),
                                            ChatRosterEntry(userId: avery, name: "Avery Lee Smith", isPresent: true),
                                            ChatRosterEntry(userId: sam, name: "Sam", isPresent: true)],
                                   assistant: .available), change: .messages)
        let recipients = chat.composer.recipients
        #expect(recipients.map { $0.userId } == [avery, sam])

        let shell = MeetingShellPresenter()
        let people = PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
        people.apply(PeopleInputs.make(callSession: 1, phase: MeetingPhaseKind.inCall.rawValue, localUserId: local,
                                       participants: [PeopleParticipantInput.make(userId: local, displayName: "Jordan Lee", isLocal: true),
                                                      PeopleParticipantInput.make(userId: avery, displayName: "Avery Lee Smith"),
                                                      PeopleParticipantInput.make(userId: sam, displayName: "Sam")],
                                       isRosterLoaded: true))
        for recipient in recipients {
            let key = PeopleOrderPolicy.rosterKey(recipient.userId)
            #expect(people.rows.contains(key), "\(recipient.userId)")
            let menuFace = ConclaveAvatarIdentity.fromSeed(PeopleRowPolicy.avatarSeed(name: recipient.name, userId: recipient.userId,
                                                                                      isLocal: false))
            let peopleFace = ConclaveAvatarIdentity.fromSeed(people.rows.entry(for: key).model.avatarSeed)
            #expect(menuFace == peopleFace, "the recipient face for \(recipient.userId) is the People face")
        }

        let threeWords = try #require(recipients.first(where: { $0.userId == avery }))
        #expect(threeWords.name == "Avery Lee Smith")
        let seed = PeopleRowPolicy.avatarSeed(name: threeWords.name, userId: threeWords.userId, isLocal: false)
        #expect(seed == FacehashPresentation.seed(name: "Avery Lee", id: avery), "People seeds the first two words of a longer name")
        #expect(seed != threeWords.avatarSeed, "the recipient model's own seed keeps every word, so the menu must not read it")

        let kotlin = s1bcmFlat(try s1bcmSource(Self.composerFile))
        #expect(kotlin.contains("leadingContent = { ConclaveAvatar(ConclaveAvatarIdentity.fromSeed(PeopleRowPolicy.avatarSeed(name = person.name, userId = person.userId, isLocal = false)), 24.dp) },"))
        #expect(!kotlin.contains("person.avatarSeed"))
        let policy = s1bcmFlat(try s1bcmSource("Sources/Conclave/Features/Meeting/People/PeopleOrderPolicy.swift"))
        #expect(policy.contains("enum PeopleRowPolicy { static func detail("))
        #expect(policy.contains("static func avatarSeed(name: String, userId: String, isLocal: Bool) -> String {"))
        #expect(s1bcmFlat(try s1bcmSource("Sources/Conclave/Skip/ui/people/PersonRow.kt")).contains("ConclaveAvatarIdentity.fromSeed(model.avatarSeed)"))
    }

    @Test func theRecipientMenuIsOneSingleChoiceGroupWithTheNeutralCheck() throws {
        let kotlin = try s1bcmSource(Self.composerFile)
        let menu = s1bcmFlat(try s1bcmSlice(kotlin, from: "private fun ChatComposerModeRow(", to: "private fun ChatSuggestionList("))
        #expect(menu.contains("ConclaveDropdownMenu( expanded = expanded, onDismissRequest = close, identifier = \"chat.composer.recipients\","))
        #expect(menu.contains("val everyone = recipient == null"))
        #expect(menu.contains("title = conclaveString(\"chat_everyone\"), identifier = \"chat.recipient.everyone\","))
        #expect(menu.contains("role = ConclaveMenuRole.Single(everyone), leadingIcon = ConclaveIcons.GroupFill0,"))
        #expect(menu.contains("val current = recipient?.userId == person.userId"))
        #expect(menu.contains("role = ConclaveMenuRole.Single(current),"))
        #expect(s1bcmCount(menu, "role = ConclaveMenuRole.Single(") == 2, "every recipient row is a single-choice row, so the component gives it Role.RadioButton")
        #expect(s1bcmCount(menu, "ConclaveMenuItem(") == 2)

        let everyone = try #require(menu.range(of: "identifier = \"chat.recipient.everyone\""))
        let divider = try #require(menu.range(of: "ConclaveMenuDivider()"))
        let header = try #require(menu.range(of: "ConclaveMenuHeader(conclaveString(\"chat_send_privately_to\"), \"chat.recipient.header\")"))
        let people = try #require(menu.range(of: "for (person in composer.recipients) {"))
        #expect(everyone.lowerBound < divider.lowerBound && divider.lowerBound < header.lowerBound && header.lowerBound < people.lowerBound,
                "Everyone sits in its own section above the Send privately to header")

        for banned in ["RadioButton(", "Checkbox(", "CheckFill0", "scheme.primary", "NativeSemanticsPopupRoot(", "HorizontalDivider(",
                       "labelMedium", "DropdownMenuItem("] {
            #expect(!menu.contains(banned), "the recipient menu uses \(banned)")
        }

        let ios = s1bcmFlat(try s1bcmSlice(try s1bcmSource("Sources/Conclave/Features/Meeting/Chat/ChatComposer+iOS.swift"),
                                           from: "private struct ChatComposerModeRow: View {",
                                           to: ".accessibilityIdentifier(\"chat.composer.recipient\")"))
        #expect(ios.contains("Picker(ConclaveStrings.text(\"Send To\")") && ios.contains("Section(ConclaveStrings.text(\"Send Privately To\"))"))
        #expect(!ios.contains("ConclaveAvatar"), "iOS keeps the system menu rows without faces")
        let row = try s1bcmSource("Sources/Conclave/Skip/ui/chat/ChatRow.kt")
        #expect(!row.contains("ConclaveAvatar("), "chat message rows gain no avatar")
    }

    @Test func messageMenusGiveRetryAnIconAndKeepDeleteLastAndDestructive() throws {
        let sheet = try s1bcmSource(Self.sheetFile)
        let flat = s1bcmFlat(sheet)
        #expect(flat.contains("private class ChatMenuAction(val tag: String, val label: String, val icon: ImageVector, val destructive: Boolean, val run: () -> Unit)"))
        #expect(!sheet.contains("ImageVector?"))
        #expect(flat.contains("ChatMenuAction(\"retry\", conclaveString(\"ds_retry\"), ConclaveIcons.RefreshFill0, false)"))
        #expect(flat.contains("ChatMenuAction(\"delete\", conclaveString(\"chat_delete\"), ConclaveIcons.DeleteFill0, true)"))
        let retry = try #require(flat.range(of: "ChatMenuAction(\"retry\""))
        let delete = try #require(flat.range(of: "ChatMenuAction(\"delete\""))
        #expect(retry.lowerBound < delete.lowerBound)
        #expect(flat.contains("return listOf(main, safety, failed).filter { it.isNotEmpty() }"))

        let menu = s1bcmFlat(try s1bcmSlice(sheet, from: "internal fun MessageActionsMenu(", to: "\n}\n"))
        #expect(menu.contains("ConclaveDropdownMenu( expanded = true, onDismissRequest = { actions.closeMenu() }, identifier = \"chat.actions.menu\", ) {"))
        #expect(menu.contains("if (index > 0 || row.canReact) ConclaveMenuDivider()"))
        #expect(menu.contains("ConclaveMenuItem( title = item.label, identifier = \"chat.menu.${item.tag}\", onClick = { item.run() }, role = if (item.destructive) ConclaveMenuRole.Destructive else ConclaveMenuRole.Plain, leadingIcon = item.icon, )"))
        for banned in ["color =", "tint =", "HorizontalDivider(", "NativeSemanticsPopupRoot(", "MaterialTheme.colorScheme.error"] {
            #expect(!menu.contains(banned), "the side-pane menu uses \(banned)")
        }
    }

    @Test func emojiCirclesAreStockTonalToggleButtonsInACappedRow() throws {
        let sheet = try s1bcmSource(Self.sheetFile)
        let flat = s1bcmFlat(sheet)
        #expect(flat.contains("FilledTonalIconToggleButton( checked = selected, onCheckedChange = { if (!selected) haptics.gesture(FeedbackKind.reactionSent) onPick(emoji) },"))
        #expect(flat.contains("modifier = Modifier.size(48.dp).testTag(\"chat.actions.emoji.$emoji\").semantics { contentDescription = label },"))
        #expect(flat.contains("colors = IconButtonDefaults.filledTonalIconToggleButtonColors( containerColor = scheme.surfaceContainerHighest, checkedContainerColor = scheme.secondaryContainer, ),"))
        #expect(flat.contains("ConclaveText(emoji, line = \"chat.actions.emoji.$emoji.face\", style = MaterialTheme.typography.titleLarge)"))
        #expect(flat.contains("maxItemsInEachRow = 8"))
        #expect(flat.contains("return ChatReactionRules.emojis.toList().filter { !row.isAtReactionCap || present.contains(it) }"), "the emoji set is unchanged")
        #expect(ChatReactionRules.emojis.count == 8)
        for banned in ["CircleShape", "background(", ".clickable(role = Role.Button)", "Role.Button", "this.selected"] {
            #expect(!sheet.contains(banned), "the emoji row uses \(banned)")
        }
        #expect(s1bcmCount(sheet, "ChatEmojiRow(") == 3, "one shared row for the phone sheet and the side-pane menu")

        #expect(flat.contains("private val ChatEmojiRowMaxWidth = 296.dp"))
        #expect(flat.contains("ChatEmojiRow( row, Modifier.widthIn(max = ChatEmojiRowMaxWidth).fillMaxWidth().then(conclaveMenuRowModifier()) .padding(ConclaveMenuDefaults.ContentPadding).padding(vertical = 8.dp), )"),
                "the side-pane row sits on the menu row inset and never grows past the menu maximum")
        #expect(flat.contains("ChatEmojiRow(row, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) { emoji ->"))
        let circle = 48.0
        let inset = 16.0
        #expect(296.0 - 2.0 * inset >= circle * 5.0, "five circles fit on a line inside the capped side-pane row")
    }

    @Test func phoneSheetRowsTakeTheirColoursFromTheListItemDefaults() throws {
        let sheet = try s1bcmSource(Self.sheetFile)
        let body = try s1bcmSlice(sheet, from: "internal fun MessageActionsSheet(", to: "internal fun MessageActionsMenu(")
        let rows = s1bcmFlat(try s1bcmSlice(body, from: "groups.forEachIndexed", to: "\n}\n"))
        #expect(rows.contains("ListItem( headlineContent = { ConclaveText(item.label, line = \"chat.actions.${item.tag}\") }, leadingContent = { Icon(item.icon, contentDescription = null) },"))
        #expect(rows.contains("ListItemDefaults.colors(containerColor = scheme.surfaceContainerLow, headlineColor = scheme.error, leadingIconColor = scheme.error)"))
        #expect(rows.contains("ListItemDefaults.colors(containerColor = scheme.surfaceContainerLow)"))
        #expect(s1bcmCount(rows, "ListItemDefaults.colors(") == 2)
        #expect(!rows.contains("color =") && !rows.contains("tint ="), "no sheet row passes an explicit colour or tint")
        #expect(sheet.contains("NativeSemanticsPopupRoot(\"chat.actions.sheet\")") && sheet.contains("rememberModalBottomSheetState(skipPartiallyExpanded = true)"))
    }

    @Test func attachItemsUseTheSlotColoursAndShowReasonsAsSupportingLines() throws {
        let kotlin = try s1bcmSource(Self.composerFile)
        let attach = s1bcmFlat(try s1bcmSlice(kotlin, from: "private fun ChatAttachMenuButton(", to: "private fun ChatAttachmentChipRow("))
        #expect(attach.contains("ConclaveDropdownMenu( expanded = expanded,"))
        #expect(attach.contains("identifier = \"chat.composer.attach.menu\","))
        #expect(attach.contains("ConclaveMenuItem( title = title, identifier = \"chat.composer.attach.$kind\","))
        #expect(attach.contains("leadingIcon = if (kind == \"gif\") ConclaveIcons.GifBoxFill0 else ConclaveIcons.ImageFill0,"))
        #expect(attach.contains("supporting = if (reasonText.isEmpty()) null else reasonText, enabled = reason.isEmpty() && !busy,"))
        for banned in ["tint =", "scheme.onSurfaceVariant", "bodySmall", "NativeSemanticsPopupRoot(", "DropdownMenuItem("] {
            #expect(!attach.contains(banned), "the attach menu uses \(banned)")
        }
        #expect(!kotlin.contains("tint = scheme.onSurfaceVariant"))

        let voice = try s1bcmSource(Self.voiceFile)
        let item = s1bcmFlat(try s1bcmSlice(voice, from: "internal fun ChatVoiceAttachMenuItem(", to: "\n}\n"))
        #expect(item.contains("ConclaveMenuItem( title = conclaveString(\"chat_attach_voice\"), identifier = \"chat.composer.attach.voice\","))
        #expect(item.contains("leadingIcon = VoiceIcons.voiceMessage, supporting = if (reason.isEmpty()) null else reason, enabled = reason.isEmpty(),"))
        for banned in ["tint =", "LocalContentColor", "Icon(", "DropdownMenuItem("] {
            #expect(!item.contains(banned), "the voice attach item uses \(banned)")
        }
        #expect(!voice.contains("contentDescription = null, tint = LocalContentColor.current)"))
    }

    @Test func suggestionRowsClipTheirPressLayerToTheRoundedHighlight() throws {
        let kotlin = try s1bcmSource(Self.composerFile)
        let list = try s1bcmSlice(kotlin, from: "private fun ChatSuggestionList(", to: "private fun chatMentionTitle(")
        let flat = s1bcmFlat(list)
        var cursor = flat.startIndex
        var clicks = 0
        while let click = flat.range(of: ".clickable(", range: cursor..<flat.endIndex) {
            clicks += 1
            #expect(flat[flat.startIndex..<click.lowerBound].hasSuffix(".clip(MaterialTheme.shapes.small) "),
                    "suggestion row \(clicks) clips before its clickable")
            cursor = click.upperBound
        }
        #expect(clicks == 2)
        #expect(s1bcmCount(flat, ".clip(MaterialTheme.shapes.small)") == 2)
        #expect(s1bcmCount(flat, "Modifier.background(scheme.surfaceContainerHighest, MaterialTheme.shapes.small)") == 2)
        #expect(list.contains("color = scheme.surfaceContainerLow,") && list.contains("shape = MaterialTheme.shapes.medium,"))
        #expect(kotlin.contains("import androidx.compose.ui.draw.clip"))
    }

    @Test func composerMenusKeepTheirOpenTimeFocusRule() throws {
        let kotlin = try s1bcmSource(Self.composerFile)
        let expression = "properties = if (capture.menuFocusable) PopupProperties(focusable = true) else PopupProperties(focusable = false),"
        let lines = kotlin.components(separatedBy: "\n").filter { $0.contains("PopupProperties(focusable = false)") }
        #expect(lines.count == 2)
        #expect(lines.allSatisfy { $0.trimmingCharacters(in: .whitespaces) == expression })
        let flat = s1bcmFlat(kotlin)
        #expect(flat.contains("identifier = \"chat.composer.recipients\", " + expression))
        #expect(flat.contains("identifier = \"chat.composer.attach.menu\", " + expression))
        #expect(s1bcmCount(kotlin, "BackHandler(enabled = expanded && !capture.menuFocusable)") == 2)
        #expect(s1bcmCount(kotlin, "if (capture.menuFocusable) restoreFocus(capture)") == 3)
    }

    @Test func transcriptAndQaMenusOpenThroughTheSharedComponent() throws {
        let page = try s1bcmSource(Self.transcriptPageFile)
        #expect(page.contains("ConclaveDropdownMenu(expanded = page.menuOpen, onDismissRequest = { page.menuOpen = false }, identifier = \"transcript.menu\") {"),
                "the overflow opens through ConclaveDropdownMenu, not a raw DropdownMenu that only shares its name")
        let overflow = try s1bcmSlice(page, from: "ConclaveDropdownMenu(expanded = page.menuOpen", to: "private fun TranscriptStopDialog(")
        let flat = s1bcmFlat(overflow)
        #expect(s1bcmCount(flat, "ConclaveMenuItem(") == 4)
        for icon in ["leadingIcon = ConclaveIcons.ShareFill0,", "leadingIcon = ConclaveIcons.ContentCopyFill0,", "leadingIcon = ConclaveIcons.AutoAwesomeFill0,"] {
            #expect(flat.contains(icon), "\(icon)")
        }
        #expect(flat.contains("identifier = \"transcript.menu.stop\", onClick = { page.menuOpen = false presenter.requestStop() }, role = ConclaveMenuRole.Destructive, leadingIcon = ConclaveIcons.StopFill1, enabled = !snapshot.controlsDisabled, )"))
        #expect(flat.contains("if (snapshot.canStop) { if (snapshot.hasContent || snapshot.offersRecapToChat) ConclaveMenuDivider() ConclaveMenuItem( title = conclaveString(\"trn_stop_menu\"),"),
                "Stop is the last item, in its own section after a divider")
        #expect(flat.contains("enabled = snapshot.recap != RecapPhase.posting,"))
        for banned in ["tint =", "color =", "scheme.error", "NativeSemanticsPopupRoot("] {
            #expect(!flat.contains(banned), "the transcript overflow uses \(banned)")
        }
        #expect(page.contains("RadioButton(selected = selected, onClick = null)"), "the model sheet keeps its list radios")
        #expect(page.contains("DropdownMenu(") && page.contains("SnackbarHost(snackbars)"))

        let lists = s1bcmFlat(try s1bcmSource(Self.transcriptListsFile))
        #expect(lists.contains("ConclaveDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, identifier = \"transcript.ask.menu\") { ConclaveMenuItem( title = copyAnswer, identifier = \"transcript.ask.copyAnswer\","))
        #expect(!lists.contains("NativeSemanticsPopupRoot(\"transcript.ask.menu\")"), "the Ask popup root moved into the component")

        let row = s1bcmFlat(try s1bcmSource(Self.questionRowFile))
        #expect(row.contains("ConclaveDropdownMenu(expanded = menu, onDismissRequest = { menu = false }, identifier = \"$identifier.menu\") { for (action in hostActions) { ConclaveMenuItem( title = conclaveString(qaHostActionName(action)), identifier = \"$identifier.menu.$action\", onClick = { run(action) }, ) } }"))
        #expect(row.contains("internal fun qaHostActionName(action: String): String = when (action) {"))
    }

    @Test func theOwnedFilesHoldNoRawMenuAndStayFlatAndDashFree() throws {
        let rawMenu = #"(?<![A-Za-z])DropdownMenu(Item)?\("#
        let roots: [String: Int] = [Self.sheetFile: 1, Self.composerFile: 0, Self.voiceFile: 0, Self.transcriptPageFile: 1,
                                    Self.transcriptListsFile: 0, Self.questionRowFile: 0]
        for file in Self.ownedFiles {
            let text = try s1bcmSource(file)
            #expect(s1bcmMatchCount(rawMenu, in: text) == 0, "\(file) calls a raw menu")
            #expect(!text.contains("import androidx.compose.material3.DropdownMenu"), "\(file) imports the raw menu")
            #expect(s1bcmCount(text, "NativeSemanticsPopupRoot(") == (roots[file] ?? -1), "\(file) popup roots")
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradi" + "ent"), "\(file)")
            #expect(!text.contains("Color(0x"), "\(file) uses a colour literal")
        }
        let tests = try s1bcmSource("Tests/ConclaveTests/S1bChatMenusTests.swift")
        #expect(!tests.contains("\u{2013}") && !tests.contains("\u{2014}"))
    }
}

private func s1bcmRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1bcmSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1bcmRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bcmFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1bcmSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1bcmCount(_ text: String, _ needle: String) -> Int {
    text.components(separatedBy: needle).count - 1
}

private func s1bcmMatchCount(_ pattern: String, in text: String) -> Int {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return -1 }
    return regex.numberOfMatches(in: text, range: NSRange(text.startIndex..<text.endIndex, in: text))
}
#endif

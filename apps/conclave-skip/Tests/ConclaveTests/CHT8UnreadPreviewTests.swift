#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CHT-8 (OUT/PLAN-screens.md section 5; S40 8, 0.7 R40-4, R40-8, R40-13, 0.8 CH12; S60 0.8 C6-22; RECONCILE R1, R3):
/// the unread rules, the preview bodies (never a file name), the R40-4 event, the in-place coalescing with the count line
/// and the "and 2 others" title, the drops (Chat current, a suspended lane, previews off, attendees, your own messages),
/// `/clear` and hide sender, the tap that opens Chat at the newest message, the stage fixture states, the display time,
/// the two toast sources and the strings. The core wiring pins at the end need HD requests B6-T5 R1 to R3. The Kotlin
/// half is T/Skip/CHT8PreviewBridgeTests.kt.
@MainActor
struct CHT8UnreadPreviewTests {
    final class Clock {
        var millis = 1_000_000.0
    }

    static let longSleep: (Double) async -> Void = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }

    private func host(isAttendee: Bool = false) -> StageNoticeInputs {
        StageNoticeInputs.make(callSession: 1, isAttendee: isAttendee, isHost: !isAttendee, localUserId: "you",
                               participantCount: 4, hasInitialPresenceSnapshot: true)
    }

    private func message(_ id: String, from userId: String = "r1", name: String = "Avery Lee", _ content: String,
                         isDirect: Bool = false, image: ChatImageAttachment? = nil, gif: ChatGifAttachment? = nil,
                         isTts: Bool = false) -> ChatMessage {
        ChatMessage(id: id, userId: userId, displayName: name, content: content, gif: gif, image: image, isDirect: isDirect,
                    isTts: isTts)
    }

    private func preview(_ id: String, from userId: String = "r1", name: String = "Avery Lee", _ content: String,
                         isDirect: Bool = false) -> StageEvent {
        ChatPreviewPolicy.event(message: message(id, from: userId, name: name, content, isDirect: isDirect),
                                canonicalSenderId: userId)
    }

    private func center() -> MeetingNoticeCenter {
        let center = MeetingNoticeCenter()
        _ = center.applyState(host(), nowMillis: 0)
        return center
    }

    private func presenter(_ clock: Clock, previews: Bool = true) -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.now = { clock.millis }
        stage.sleep = CHT8UnreadPreviewTests.longSleep
        stage.captions.sleep = CHT8UnreadPreviewTests.longSleep
        stage.chatPreviewsEnabled = { previews }
        stage.setViewport(StagePoliciesTests.iphoneSE)
        stage.apply(StageFixtureScript.base(count: 4))
        stage.applyNotices(host())
        return stage
    }

    // MARK: CH12 unread and posting rules

    @Test func unreadRulesFollowCH12() {
        // +1 for a remote message (public, private, voice, a completed assistant answer) while Chat is not current.
        #expect(ChatPreviewPolicy.countsUnread(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: false,
                                               isChatCurrent: false, isAttendee: false))
        // Nothing for your own message, a hidden sender, the empty assistant start, an open Chat or an attendee.
        #expect(!ChatPreviewPolicy.countsUnread(isOwn: true, isHiddenSender: false, isEmptyAssistantStart: false,
                                                isChatCurrent: false, isAttendee: false))
        #expect(!ChatPreviewPolicy.countsUnread(isOwn: false, isHiddenSender: true, isEmptyAssistantStart: false,
                                                isChatCurrent: false, isAttendee: false))
        #expect(!ChatPreviewPolicy.countsUnread(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: true,
                                                isChatCurrent: false, isAttendee: false))
        #expect(!ChatPreviewPolicy.countsUnread(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: false,
                                                isChatCurrent: true, isAttendee: false))
        #expect(!ChatPreviewPolicy.countsUnread(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: false,
                                                isChatCurrent: false, isAttendee: true))
        // Previews post for remote arrivals only; the stage drops them while Chat is current.
        #expect(ChatPreviewPolicy.postsPreview(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: false, isAttendee: false))
        #expect(!ChatPreviewPolicy.postsPreview(isOwn: true, isHiddenSender: false, isEmptyAssistantStart: false, isAttendee: false))
        #expect(!ChatPreviewPolicy.postsPreview(isOwn: false, isHiddenSender: true, isEmptyAssistantStart: false, isAttendee: false))
        #expect(!ChatPreviewPolicy.postsPreview(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: true, isAttendee: false),
                "an empty assistant start posts nothing")
        #expect(!ChatPreviewPolicy.postsPreview(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: false, isAttendee: true))
    }

    // MARK: Bodies (S40 8 f)

    @Test func previewBodiesNeverShowAFileName() {
        let text = ChatPreviewPolicy.body(message: message("m1", "Can you share the deck?\nThe one from Tuesday"))
        #expect(text == ChatPreviewBody(kind: .text, text: "Can you share the deck?"), "the first line")
        let photo = ChatImageAttachment(id: "i1", url: "https://assets.example/IMG_2041.jpg", fileName: "IMG_2041.jpg",
                                        mimeType: "image/jpeg", size: 1_000)
        #expect(ChatPreviewPolicy.body(message: message("m2", "IMG_2041.jpg", image: photo)) == ChatPreviewBody(kind: .photo, text: ""))
        #expect(ChatPreviewPolicy.body(message: message("m3", "https://assets.example/IMG_2041.jpg", image: photo)).text.isEmpty)
        #expect(ChatPreviewPolicy.body(message: message("m4", "  ", image: photo)).text.isEmpty)
        let captioned = ChatPreviewPolicy.body(message: message("m5", "Whiteboard from today", image: photo))
        #expect(captioned == ChatPreviewBody(kind: .photo, text: "Whiteboard from today"))
        #expect(!captioned.text.contains("IMG_2041"))
        let gif = ChatGifAttachment(id: "g1", title: "Party", url: "https://m.example/g1.gif", previewUrl: nil, pageUrl: nil,
                                    width: 2, height: 1, kind: "gif", videoUrl: nil, source: "klipy")
        #expect(ChatPreviewPolicy.body(message: message("m6", "", gif: gif)) == ChatPreviewBody(kind: .gif, text: "Party"))
        let sticker = ChatGifAttachment(id: "g2", title: "Wave", url: "https://m.example/g2.png", previewUrl: nil, pageUrl: nil,
                                        width: 1, height: 1, kind: "sticker", videoUrl: nil, source: "klipy")
        #expect(ChatPreviewPolicy.body(message: message("m7", "", gif: sticker)) == ChatPreviewBody(kind: .sticker, text: "Wave"))
        let clip = ChatGifAttachment(id: "g3", title: "", url: "https://m.example/g3.mp4", previewUrl: nil, pageUrl: nil,
                                     width: 1, height: 1, kind: "clip", videoUrl: nil, source: "klipy")
        #expect(ChatPreviewPolicy.body(message: message("m8", "https://m.example/g3.mp4", gif: clip)) == ChatPreviewBody(kind: .clip, text: ""))
        #expect(ChatPreviewPolicy.body(message: message("m9", "so good", gif: clip)) == ChatPreviewBody(kind: .clip, text: "so good"))
        #expect(ChatPreviewPolicy.gifKind(nil) == .gif && ChatPreviewPolicy.gifKind("unknown") == .gif)
        let voice = ChatPreviewPolicy.body(message: message("m10", "TTS: Welcome everyone\nto the call", isTts: true))
        #expect(voice == ChatPreviewBody(kind: .voice, text: "Welcome everyone"))
        #expect(ChatPreviewPolicy.body(message: message("m11", "/me waves")) == ChatPreviewBody(kind: .text, text: "Avery Lee waves"))
        let answer = message("m12", from: ConclaveAssistantChatIdentity.userId, name: ConclaveAssistantChatIdentity.displayName,
                             "Sure. Here is the plan for today.\n1. Intro")
        #expect(ChatPreviewPolicy.body(message: answer) == ChatPreviewBody(kind: .text, text: "Sure."), "the first sentence")
        #expect(ChatPreviewPolicy.firstSentence("Version 2.1 is out") == "Version 2.1 is out", "a dot inside a word is no end")
        let long = String(repeating: "a", count: 400)
        #expect(ChatPreviewPolicy.body(message: message("m13", long)).text.count == ChatPreviewPolicy.maxDetailCharacters)
    }

    @Test func theEventCarriesTheR404Fields() {
        let event = ChatPreviewPolicy.event(message: message("srv-7", "Are you free?", isDirect: true), canonicalSenderId: "r1")
        #expect(event.kind == StageEventKind.chatPreview)
        #expect(event.userId == "r1" && event.name == "Avery Lee" && event.messageId == "srv-7")
        #expect(event.detail == "Are you free?" && event.isPrivate)
        #expect(event.serverText == ChatPreviewBodyKind.text.rawValue)
        // The assistant keeps its identity (it has no canonical stage id).
        let answer = message("a1", from: ConclaveAssistantChatIdentity.userId, name: ConclaveAssistantChatIdentity.displayName,
                             "Done! I opened the issue.")
        let assistant = ChatPreviewPolicy.event(message: answer, canonicalSenderId: "")
        #expect(assistant.userId == ConclaveAssistantChatIdentity.userId && assistant.detail == "Done!")
        // The notice carries the body kind through; "" reads as text.
        let notice = MeetingNoticePolicy.toast(fromEvent: event)
        #expect(notice?.serverText == "text" && notice?.messageId == "srv-7" && notice?.isPrivate == true)
        let bare = MeetingNoticePolicy.toast(fromEvent: StageEvent.make(kind: StageEventKind.chatPreview, userId: "r1", name: "A"))
        #expect(bare.map { ChatPreviewPolicy.bodyKind($0) } == .text)
        #expect(ChatPreviewPolicy.isAssistant(MeetingNoticePolicy.toast(fromEvent: assistant)!))
    }

    // MARK: Coalescing (S40 8 f, S20 10 f)

    @Test func oneSenderUpdatesTheShownPreviewInPlace() {
        let center = center()
        _ = center.post(preview("m1", "Can you share the deck?"), nowMillis: 100)
        let first = center.toast
        #expect(first?.kind == NoticeKind.chatPreview && first?.count == 1)
        #expect(first.map { ChatPreviewPolicy.showsCountLine($0) } == false)
        _ = center.post(preview("m2", "The one from Tuesday"), nowMillis: 900)
        _ = center.post(preview("m3", "Thanks!"), nowMillis: 1_700)
        let shown = center.toast
        #expect(shown?.id == first?.id, "the shown toast updates in place")
        #expect(shown?.count == 3 && shown?.senderCount == 1 && shown?.name == "Avery Lee")
        #expect(shown?.detail == "Thanks!" && shown?.messageId == "m3")
        #expect(shown.map { ChatPreviewPolicy.showsCountLine($0) } == true)
        #expect(shown.map { ChatPreviewPolicy.othersCount($0) } == 0)
        #expect(center.queue.isEmpty)
        center.dismiss(id: shown?.id ?? "", nowMillis: 6_000)
        #expect(center.toast == nil && center.queue.isEmpty)
    }

    @Test func severalSendersReadAsTheNewestNameAndOthers() {
        let center = center()
        _ = center.post(preview("m1", from: "r2", name: "Ben Ortiz", "I can take notes"), nowMillis: 0)
        _ = center.post(preview("m2", from: "r3", name: "Cai Moreno", "Same here", isDirect: true), nowMillis: 300)
        let privateStep = center.toast
        #expect(privateStep?.isPrivate == true && privateStep?.name == "Cai Moreno", "the private tag follows the newest body")
        _ = center.post(preview("m3", "Can you share the deck?"), nowMillis: 600)
        let shown = center.toast
        #expect(shown?.count == 3 && shown?.senderCount == 3)
        #expect(shown?.name == "Avery Lee" && shown?.userId == "r1" && shown?.isPrivate == false)
        #expect(shown.map { ChatPreviewPolicy.othersCount($0) } == 2)
        #expect(shown.map { ChatPreviewPolicy.showsCountLine($0) } == false, "several senders show no count line")
        #expect(center.previewSenders(noticeId: shown?.id ?? "") == ["r2", "r3", "r1"])
        // Without ids the name separates people.
        #expect(ChatPreviewPolicy.senderKey(userId: "", name: "Guest") == "name:Guest")
        #expect(ChatPreviewPolicy.senderKey(userId: "r1", name: "Avery Lee") == "r1")
    }

    @Test func previewsWaitingBehindAnotherToastCoalesceInTheQueue() {
        let center = center()
        _ = center.post(StageEvent.make(kind: StageEventKind.userJoined, userId: "j1", name: "Dev"), nowMillis: 0)
        _ = center.post(preview("m1", from: "r2", name: "Ben Ortiz", "Hi"), nowMillis: 100)
        _ = center.post(preview("m2", "Hello"), nowMillis: 200)
        #expect(center.toast?.kind == NoticeKind.joined)
        let waiting = center.queue.first
        #expect(waiting?.kind == NoticeKind.chatPreview && waiting?.count == 2 && waiting?.senderCount == 2)
        #expect(waiting?.name == "Avery Lee" && waiting?.detail == "Hello")
    }

    // MARK: Drops

    @Test func aSuspendedLaneDropsPreviewsButKeepsEvents() {
        let center = center()
        _ = center.post(preview("m1", "Can you share the deck?"), nowMillis: 0)
        #expect(center.toast?.kind == NoticeKind.chatPreview)
        // RECONCILE R3: a compact sheet at any detent (or an Android overlay) suspends the lane; the preview is dropped.
        center.setToastLaneSuspended(true)
        #expect(center.toast == nil && center.queue.isEmpty)
        _ = center.post(preview("m2", "Still there?"), nowMillis: 100)
        _ = center.post(StageEvent.make(kind: StageEventKind.userJoined, userId: "j1", name: "Dev"), nowMillis: 200)
        #expect(center.queue.count == 1 && center.queue.first?.kind == NoticeKind.joined, "events queue, previews drop")
        center.setToastLaneSuspended(false)
        #expect(center.toast?.kind == NoticeKind.joined)
        #expect(!MeetingNoticePolicy.suspendsToastLane(style: .inspector) && !MeetingNoticePolicy.suspendsToastLane(style: .sidePane),
                "the inspector and the side pane keep the lane")
    }

    @Test func previewsOffPostNothingButTheBadgeStillCounts() {
        let center = center()
        let dropped = center.droppedToasts
        _ = center.post(preview("m1", "Hi"), nowMillis: 0, showsChatPreviews: false)
        #expect(center.toast == nil && center.droppedToasts == dropped + 1)
        #expect(ChatPreviewPolicy.countsUnread(isOwn: false, isHiddenSender: false, isEmptyAssistantStart: false,
                                               isChatCurrent: false, isAttendee: false), "the preference never gates the badge")
        let clock = Clock()
        let off = presenter(clock, previews: false)
        off.post(preview("m1", "Hi"))
        #expect(off.toast == nil)
        let on = presenter(clock)
        on.post(preview("m1", "Hi"))
        #expect(on.toast?.kind == NoticeKind.chatPreview)
        #expect(VoicePreferenceSnapshot.defaults.showsChatPreviews, "previews default on (C6-22)")
    }

    @Test func chatCurrentAttendeesAndYourOwnMessagesGetNoPreview() {
        let open = center()
        open.setCurrentPanel(MeetingPanel.chat.rawValue, nowMillis: 0)
        _ = open.post(preview("m1", "Hi"), nowMillis: 10)
        #expect(open.toast == nil && open.queue.isEmpty)
        // Opening Chat clears what was waiting or showing.
        let shown = center()
        _ = shown.post(preview("m1", "Hi"), nowMillis: 0)
        shown.setCurrentPanel(MeetingPanel.chat.rawValue, nowMillis: 10)
        #expect(shown.toast == nil)
        let attendee = MeetingNoticeCenter()
        _ = attendee.applyState(host(isAttendee: true), nowMillis: 0)
        _ = attendee.post(preview("m1", "Hi"), nowMillis: 10)
        #expect(attendee.toast == nil)
        let own = center()
        _ = own.post(preview("m1", from: "you", name: "You", "Mine"), nowMillis: 0)
        #expect(own.toast == nil)
    }

    @Test func clearAndHideSenderDropOnlyPreviews() {
        let clock = Clock()
        let stage = presenter(clock)
        stage.post(StageEvent.make(kind: StageEventKind.userJoined, userId: "j1", name: "Dev"))
        stage.post(preview("m1", "Hi"))
        #expect(stage.toast?.kind == NoticeKind.joined && stage.queuedToasts == 1)
        stage.clearChatPreviews()
        #expect(stage.toast?.kind == NoticeKind.joined && stage.queuedToasts == 0, "/clear drops previews, not other toasts")
        let hide = presenter(clock)
        hide.post(preview("m1", from: "r2", name: "Ben Ortiz", "Hi"))
        hide.post(preview("m2", "Hello"))
        #expect(hide.toast?.senderCount == 2)
        hide.dropChatPreviews(fromUserId: "r2")
        #expect(hide.toast == nil, "a coalesced preview that carries a hidden sender's message goes")
        hide.post(preview("m3", from: "r3", name: "Cai Moreno", "Later"))
        hide.dropChatPreviews(fromUserId: "r2")
        #expect(hide.toast?.name == "Cai Moreno", "other senders' previews stay")
        hide.dropChatPreviews(fromUserId: "")
        #expect(hide.toast != nil)
    }

    // MARK: Actions

    @Test func tappingThePreviewOpensChatAtTheNewestMessage() {
        let clock = Clock()
        let stage = presenter(clock)
        stage.post(preview("m1", "Can you share the deck?"))
        stage.post(preview("m2", "Thanks!"))
        let shown = stage.toast
        #expect(shown?.hasAction(NoticeAction.view) == true)
        stage.performNoticeAction(noticeId: shown?.id ?? "", actionId: NoticeAction.view)
        let current = stage.shell.panels.snapshot.current
        #expect(current?.panel == .chat && current?.invoker == .call)
        #expect(current?.destination == .chatMessage && current?.targetId == "m2")
        #expect(stage.toast == nil, "the toast leaves after its action")
        #expect(stage.chatPreviewReadout() == "none")
    }

    @Test func displayTimeIsTheHostsAndHeldUnderVoiceOver() {
        #expect(ChatPreviewPolicy.displayMillis(isScreenReaderRunning: false) == 4_000)
        #expect(ChatPreviewPolicy.displayMillis(isScreenReaderRunning: true) == 0, "held until dismissed or replaced")
        let notice = MeetingNotice.make(kind: NoticeKind.chatPreview, userId: "r1", name: "Avery Lee", count: 3, serverText: "photo",
                                        messageId: "m3", detail: "Board", senderCount: 1)
        #expect(ChatPreviewPolicy.readout(notice) == "count=3 senders=1 name=Avery Lee private=0 body=photo message=m3")
        #expect(ChatPreviewPolicy.readout(nil) == "none")
        #expect(notice.expiresAtMillis == 0, "toasts carry no presenter expiry")
    }

    // MARK: Stage fixture (SL14 with the chat preview states)

    @Test func chatPreviewFixturesShowTheirToasts() {
        let same = StageFixtureSession(state: .chatPreviewsSameSender3)
        #expect(same.stage.toast?.count == 3 && same.stage.toast?.senderCount == 1)
        #expect(same.chatPreviewReadout().hasPrefix("count=3 senders=1 name=Avery Lee private=0 body=text message=cp-s3 unread=3"))
        let mixed = StageFixtureSession(state: .chatPreviewsMixed3)
        #expect(mixed.stage.toast?.name == "Avery Lee" && mixed.stage.toast?.senderCount == 3)
        let secret = StageFixtureSession(state: .chatPreviewsPrivate)
        #expect(secret.stage.toast?.isPrivate == true)
        let photo = StageFixtureSession(state: .chatPreviewsPhoto)
        #expect(photo.stage.toast.map { ChatPreviewPolicy.bodyKind($0) } == .photo)
        #expect(photo.stage.toast?.detail == "Whiteboard from today")
        let off = StageFixtureSession(state: .chatPreviewsOff)
        #expect(off.stage.toast == nil && off.unreadChatCount == 1, "previews off: the badge still counts")
        let attendee = StageFixtureSession(state: .chatPreviewsAttendee)
        #expect(attendee.stage.toast == nil && attendee.unreadChatCount == 0, "attendees: no badge and no toast")
        // The scripted badge reaches the S1 controls row (what a mounted bar reads).
        let row = same.shell.controls.rows.first { $0.id == MeetingControlID.chat.rawValue }
        #expect(row?.badgeCount == 3)
        // Tap: Chat opens at the newest message, the badge resets and the preview leaves.
        same.stage.performNoticeAction(noticeId: same.stage.toast?.id ?? "", actionId: NoticeAction.view)
        #expect(same.panelReadout() == "panel=chat invoker=call destination=chatMessage")
        #expect(same.shell.panels.snapshot.current?.targetId == "cp-s3")
        #expect(same.unreadChatCount == 0 && same.stage.toast == nil)
        // A preview script while Chat is open adds nothing.
        same.postChatPreviewScript(named: "mixed3")
        #expect(same.stage.toast == nil && same.unreadChatCount == 0)
        // The script on a plain stage.
        let plain = StageFixtureSession(state: .grid4)
        plain.postChatPreviewScript(named: "mixed3")
        #expect(plain.stage.toast?.senderCount == 3 && plain.unreadChatCount == 3)
    }

    // MARK: Sources and strings

    @Test func previewSourcesFollowTheStageRules() throws {
        let ios = try stageSource("Sources/Conclave/Features/Meeting/Stage/ChatPreviewToast+iOS.swift")
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP\n"))
        let flat = stageNormalized(ios)
        #expect(flat.contains(".accessibilityAction(.escape) { onDismiss() }"))
        #expect(flat.contains("DragGesture(minimumDistance: ChatPreviewToastMetrics.dragMinimumDistance)"))
        #expect(flat.contains(".accessibilityIdentifier(\"chat.preview.toast\")"))
        #expect(flat.contains(".dynamicTypeSize(...DynamicTypeSize.xxxLarge)") && flat.contains(".accessibilityShowsLargeContentViewer"))
        #expect(flat.contains(".conclaveLanePresence(from: .bottom)"))
        #expect(flat.contains("HostingTheme.token(DesignTokens.iosInCallSurfaceRaised)") && flat.contains("HostingTheme.inCallBorder"))
        #expect(flat.contains("text.accessibilitySpeechAnnouncementPriority = .low"))
        #expect(flat.contains("count: notice.count, screenReader: screenReader"), "an in-place update restarts the time")
        #expect(!ios.contains("Image(systemName: \""), "raw symbol literal")
        #expect(!ios.contains("sensoryFeedback") && !ios.contains("conclaveGestureFeedback"), "no haptic (S20 10 h)")
        let kotlin = try stageSource("Sources/Conclave/Skip/ui/call/stage/ChatPreviewSnackbar.kt")
        let flatKotlin = stageNormalized(kotlin)
        #expect(flatKotlin.contains("enableDismissFromStartToEnd = true, enableDismissFromEndToStart = true"))
        #expect(flatKotlin.contains("containerColor = scheme.surfaceContainerHigh") && flatKotlin.contains(".border(1.dp, ext.border, shape)"))
        #expect(flatKotlin.contains("testTag(\"chat.preview.toast\")") && flatKotlin.contains("testTag(\"chat.preview.view\")"))
        #expect(flatKotlin.contains("conclaveString(\"ds_view\")"))
        #expect(flatKotlin.contains("duration = SnackbarDuration.Indefinite"))
        #expect(flatKotlin.contains("LaunchedEffect(preview?.id, preview?.count)"), "an in-place update restarts the time")
        #expect(!kotlin.contains("stageLane = false") && !kotlin.contains("inverseSurface"), "dark in call, never the light inverse (R1)")
        #expect(stageMatches(#"Text\(\s*""#, in: kotlin).isEmpty, "no literal Text")
        #expect(!kotlin.contains("haptics") && !kotlin.contains("Color(0x"))
        let icons = kotlin.components(separatedBy: "Icon(").dropFirst()
        for call in icons {
            let head = call.prefix(while: { $0 != "\n" })
            #expect(head.contains("tint ="), "Icon without tint: \(head)")
        }
        for text in [ios, kotlin] {
            #expect(!text.lowercased().contains("gradient") && !chatHasDash(text))
        }
        let shared = try stageSource("Sources/Conclave/Features/Meeting/Stage/MeetingNoticePolicy.swift")
        #expect(shared.contains("enum ChatPreviewPolicy") && !shared.contains("#if"))
    }

    @Test func previewStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(
            with: Data(chatSource("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let keys = try #require(catalog["strings"] as? [String: Any])
        for key in ["Private", "Photo", "Photo: %@", "GIF", "GIF: %@", "Sticker", "Sticker: %@", "Clip", "Clip: %@", "Voice message",
                    "Voice message: %@", "%lld new messages", "%@ and %lld others", "Message from %@: %@", "Opens chat",
                    "Dismiss Message from %@"] {
            #expect(keys[key] != nil, "missing iOS key \(key)")
        }
        let xml = try chatSource("Android/app/src/main/res/values/strings.xml")
        let kotlin = try stageSource("Sources/Conclave/Skip/ui/call/stage/ChatPreviewSnackbar.kt")
        for name in ["chat_preview_private", "chat_preview_photo", "chat_preview_photo_caption", "chat_preview_gif",
                     "chat_preview_sticker", "chat_preview_clip", "chat_preview_voice", "chat_preview_label",
                     "chat_preview_open", "chat_preview_dismiss", "chat_reply_gif", "chat_sticker", "chat_clip", "chat_ax_voice",
                     "ds_view"] {
            #expect(kotlin.contains("\"" + name + "\""), "ChatPreviewSnackbar.kt names \(name)")
            #expect(xml.contains("name=\"" + name + "\""), "missing Android resource \(name)")
        }
        for plural in ["chat_preview_new_count", "ds_name_and_others"] {
            #expect(kotlin.contains("conclavePlural(\"" + plural + "\""), "\(plural) resolves as a plural")
            #expect(xml.contains("<plurals name=\"" + plural + "\""), "missing Android plurals \(plural)")
        }
    }

    // MARK: Core and lane wiring (need HD requests B6-T5 R1 to R3)

    @Test func theCoreAndTheLanesUseThePreviewPolicy() throws {
        let vm = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift"))
        #expect(vm.contains("ChatPreviewPolicy.event(message:"), "the core posts the R40-4 event through the policy")
        #expect(vm.contains("ChatPreviewPolicy.countsUnread("), "the badge follows CH12")
        #expect(vm.contains("stage.clearChatPreviews()"), "/clear drops the previews")
        #expect(vm.contains("stage.dropChatPreviews(fromUserId:"), "hiding a sender drops their previews")
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/NoticeLanes+iOS.swift"))
        #expect(ios.contains("ChatPreviewToastHost(stage: stage, screenReader: screenReader)"))
        #expect(ios.contains("ChatPreviewPolicy.isChatPreview(current) ? nil"))
        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/NoticeLanes.kt"))
        #expect(android.contains("ChatPreviewSnackbarHost(stage)"))
        #expect(android.contains("ChatPreviewPolicy.isChatPreview(notice)"))
    }
}
#endif

#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CHT-6 (OUT/PLAN-screens.md section 5; S40 3 voice bubbles, 6 voice mode, 0.8 CH4, Q12; S60 0.8 C6-22): the voice
/// preference keys and defaults, the voice message text and rules, the shared playback queue on a recording speaker
/// (6 waiting, 250 ms gaps, replay, stop, one start per message id, the standard voice applied once per change, the
/// call audio owner's gate, the failsafe), the speakers' shared API and audio routing (source), the voice bubble and
/// voice mode sources, and the strings. The presenter, composer and core round trip tests at the end need HD requests
/// B5-T7 R1 to R3 (core fields, presenter API). The Kotlin half is T/Skip/CHT6VoiceBridgeTests.kt. Nothing here makes
/// a sound: the queue runs on `TtsRecordingSpeaker` and the macOS host speaker is silent.
@MainActor
struct CHT6VoiceMessagesTests {
    static let local = "jordan@example.com#s1"
    static let avery = "avery@example.com#w1"
    /// Noon UTC, as in ChatPoliciesTests.
    static let base = 1_800_014_400_000.0

    // MARK: C6-22 keys and defaults

    @Test func voicePreferencesUseTheC622KeysAndDefaults() {
        #expect(VoicePreferences.showsChatPreviewsKey == "conclave.pref.chatPreviews")
        #expect(VoicePreferences.playsVoiceMessagesKey == "conclave.pref.playVoiceMessages")
        #expect(VoicePreferences.voiceKindKey == "conclave.pref.voiceKind")
        #expect(VoicePreferences.standardVoiceIdKey == "conclave.pref.standardVoice")
        let defaults = Self.freshDefaults()
        #expect(VoicePreferences.snapshot(defaults: defaults) == VoicePreferenceSnapshot.defaults)
        #expect(VoicePreferenceSnapshot.defaults.showsChatPreviews)
        #expect(VoicePreferenceSnapshot.defaults.playsVoiceMessages)
        #expect(VoicePreferenceSnapshot.defaults.voiceKind == .system)
        #expect(VoicePreferenceSnapshot.defaults.standardVoiceId == "")
    }

    @Test func voicePreferencesPersistTheChoiceAndFallBackOnBadValues() {
        let defaults = Self.freshDefaults()
        VoicePreferences.setShowsChatPreviews(false, defaults: defaults)
        VoicePreferences.setPlaysVoiceMessages(false, defaults: defaults)
        VoicePreferences.setVoiceKind(.personal, defaults: defaults)
        VoicePreferences.setStandardVoiceId("  com.apple.voice.compact.en-GB.Daniel  ", defaults: defaults)
        #expect(VoicePreferences.snapshot(defaults: defaults) == VoicePreferenceSnapshot(
            showsChatPreviews: false, playsVoiceMessages: false, voiceKind: .personal,
            standardVoiceId: "com.apple.voice.compact.en-GB.Daniel"))
        defaults.set("cloned", forKey: VoicePreferences.voiceKindKey)
        #expect(VoicePreferences.voiceKind(defaults: defaults) == .system)
        VoicePreferences.setStandardVoiceId("", defaults: defaults)
        #expect(VoicePreferences.standardVoiceId(defaults: defaults) == "")
    }

    @Test func personalVoiceNeedsTheCapability() {
        #expect(VoicePreferences.effectiveVoiceKind(preferred: .personal, canUsePersonalVoice: false) == .system)
        #expect(VoicePreferences.effectiveVoiceKind(preferred: .personal, canUsePersonalVoice: true) == .personal)
        #expect(VoicePreferences.effectiveVoiceKind(preferred: .system, canUsePersonalVoice: true) == .system)
        let defaults = Self.freshDefaults()
        VoicePreferences.setVoiceKind(.personal, defaults: defaults)
        // S40 Q12: no native token path yet, so the composer line names the system voice.
        #expect(VoicePreferences.composerVoiceKind(defaults: defaults) == .system)
    }

    // MARK: Voice message text (CH4)

    @Test func voiceTextKeepsEveryLine() {
        #expect(VoiceMessageText.fullText(from: "/tts Welcome everyone\nto the call") == "Welcome everyone\nto the call")
        #expect(VoiceMessageText.fullText(from: "/TTS\tspeak up  ") == "speak up")
        #expect(VoiceMessageText.fullText(from: "/tts\nhello") == "hello")
        #expect(VoiceMessageText.fullText(from: " /tts speak") == nil)
        #expect(VoiceMessageText.fullText(from: "/tts") == nil)
        #expect(VoiceMessageText.fullText(from: "/tts   ") == nil)
        #expect(VoiceMessageText.fullText(from: "/ttsx hi") == nil)
        #expect(VoiceMessageText.spokenText(normalizedContent: "TTS: line one\nline two") == "line one\nline two")
        #expect(VoiceMessageText.spokenText(normalizedContent: "/tts raw text") == "raw text")
        #expect(VoiceMessageText.normalizedContent(text: "hi") == "TTS: hi")
        // The legacy first-line parser is unchanged (testChatMessageContentPolicyMatchesWebWhitespace).
        #expect(ChatMessageContentPolicy.ttsText(from: "/tts speak\nignored") == "speak")
    }

    // MARK: Rules (S40 3 f, 6 c, CH4, C6-22)

    @Test func autoplayFollowsThePreferenceForOthersOnly() {
        let rule = VoiceMessagePolicy.shouldAutoplay
        #expect(rule(false, false, false, false, true))
        #expect(!rule(false, false, false, false, false))
        #expect(rule(true, false, false, false, false))
        #expect(!rule(false, true, false, false, true))
        #expect(!rule(false, false, true, false, true))
        #expect(!rule(true, false, false, true, true))
    }

    @Test func voiceRowsAndThePlayControl() {
        #expect(VoiceMessagePolicy.isVoiceRow(isTts: true, isAssistant: false, hasImage: false, hasGif: false, isDirect: false))
        #expect(!VoiceMessagePolicy.isVoiceRow(isTts: true, isAssistant: true, hasImage: false, hasGif: false, isDirect: false))
        #expect(!VoiceMessagePolicy.isVoiceRow(isTts: true, isAssistant: false, hasImage: true, hasGif: false, isDirect: false))
        #expect(!VoiceMessagePolicy.isVoiceRow(isTts: true, isAssistant: false, hasImage: false, hasGif: false, isDirect: true))
        #expect(!VoiceMessagePolicy.isVoiceRow(isTts: false, isAssistant: false, hasImage: false, hasGif: false, isDirect: false))
        #expect(VoiceMessagePolicy.canPlay(kind: .voice, voiceEnabled: true, text: "hi"))
        #expect(!VoiceMessagePolicy.canPlay(kind: .voice, voiceEnabled: false, text: "hi"))
        #expect(!VoiceMessagePolicy.canPlay(kind: .voice, voiceEnabled: true, text: "  "))
        #expect(!VoiceMessagePolicy.canPlay(kind: .text, voiceEnabled: true, text: "hi"))
    }

    @Test func theComposerVoiceRowFollowsModeDraftPrivacyAndTheHost() {
        let shows = VoiceMessagePolicy.showsComposerRow
        #expect(shows(true, "", false, true))
        #expect(shows(false, "/tts hello", false, true))
        #expect(shows(false, "/TTS\thello", false, true))
        #expect(!shows(false, "/tts", false, true))
        #expect(!shows(false, "/ttsx", false, true))
        #expect(!shows(true, "", true, true))
        #expect(!shows(true, "", false, false))
        #expect(VoiceMessagePolicy.voiceModeAllowed(voiceEnabled: true, isPrivateMode: false))
        #expect(!VoiceMessagePolicy.voiceModeAllowed(voiceEnabled: true, isPrivateMode: true))
        #expect(!VoiceMessagePolicy.voiceModeAllowed(voiceEnabled: false, isPrivateMode: false))
        #expect(VoiceMessagePolicy.attachKind == "voice")
    }

    @Test func theCallAudioOwnerBlocksPlaybackDuringInterruptions() {
        #expect(!VoiceMessagePolicy.blocksPlayback(.none))
        #expect(VoiceMessagePolicy.blocksPlayback(.otherAudio))
        #expect(VoiceMessagePolicy.blocksPlayback(.held))
        #expect(VoiceMessagePolicy.blocksPlayback(.servicesReset))
        #expect(!VoiceMessagePolicy.blocksPlayback(.deviceMicMuted))
    }

    @Test func theSpeechBudgetMatchesTheWeb() {
        #expect(VoiceMessagePolicy.estimateSpeechMillis("") == 8000)
        #expect(VoiceMessagePolicy.estimateSpeechMillis("hi there") == 8000)
        let twenty = Array(repeating: "word", count: 20).joined(separator: " ")
        #expect(VoiceMessagePolicy.estimateSpeechMillis(twenty) == 20 * 700 + 5000)
        #expect(VoiceMessagePolicy.estimateSpeechMillis(String(repeating: "字", count: 60)) == 10 * 700 + 5000)
        #expect(VoiceMessagePolicy.estimateSpeechMillis(String(repeating: "a ", count: 500)) == 90000)
    }

    @Test func thePersonalVoiceEndpointSitsUnderTheWebOrigin() {
        #expect(VoiceMessagePolicy.speechEndpoint(baseURL: URL(string: "https://conclave.acmvit.in/"))
                == "https://conclave.acmvit.in/api/tts/speech")
        #expect(VoiceMessagePolicy.speechEndpoint(baseURL: URL(string: "http://127.0.0.1:3000"))
                == "http://127.0.0.1:3000/api/tts/speech")
        #expect(VoiceMessagePolicy.speechEndpoint(baseURL: nil) == "")
        #expect(VoiceMessagePolicy.maxQueued == 6 && VoiceMessagePolicy.advanceGapMillis == 250)
        #expect(VoiceMessagePolicy.personalVoiceTimeoutMillis == 15000)
    }

    // MARK: The queue on a recording speaker (CH4)

    @Test func theQueueHoldsSixAndDropsTheOldest() {
        let harness = VoiceHarness()
        for index in 1...8 {
            harness.queue.enqueue(harness.item("m\(index)"), isOwn: false)
        }
        #expect(harness.queue.activeMessageId == "m1")
        #expect(harness.queue.queued.map { $0.messageId } == ["m3", "m4", "m5", "m6", "m7", "m8"])
        #expect(harness.queue.droppedCount == 1)
        #expect(harness.speaker.events == ["start m1 applies"])
    }

    @Test func theNextMessageStartsOnlyAfterTheGap() {
        let harness = VoiceHarness()
        harness.queue.enqueue(harness.item("m1"), isOwn: false)
        harness.queue.enqueue(harness.item("m2"), isOwn: false)
        harness.speaker.finishActive()
        #expect(harness.queue.activeMessageId == "")
        #expect(harness.queue.isAdvancePending)
        // A message arriving inside the gap waits behind m2 (order kept).
        harness.queue.enqueue(harness.item("m3"), isOwn: false)
        #expect(harness.queue.activeMessageId == "")
        harness.queue.advanceNow()
        #expect(harness.queue.activeMessageId == "m2")
        harness.speaker.finishActive()
        harness.queue.advanceNow()
        #expect(harness.queue.activeMessageId == "m3")
        harness.speaker.finishActive()
        #expect(harness.queue.isIdle)
        #expect(harness.playback == ["m1|avery", "|", "m2|avery", "|", "m3|avery", "|"])
    }

    @Test func theGapIs250Milliseconds() async {
        let harness = VoiceHarness()
        harness.queue.schedulesTimers = true
        let sleeps = SleepLog()
        harness.queue.sleep = { millis in
            sleeps.values.append(millis)
        }
        harness.queue.enqueue(harness.item("m1", text: "one two three"), isOwn: false)
        harness.queue.enqueue(harness.item("m2"), isOwn: false)
        harness.speaker.finishActive()
        var spins = 0
        while !harness.queue.startedMessageIds.contains("m2") && spins < 50 {
            await Task.yield()
            spins += 1
        }
        #expect(harness.queue.startedMessageIds.prefix(2) == ["m1", "m2"])
        #expect(sleeps.values.contains(250))
        #expect(sleeps.values.contains(8000))
    }

    @Test func replayStopsTheCurrentMessageAndTheQueueContinues() {
        let harness = VoiceHarness()
        harness.queue.enqueue(harness.item("m1"), isOwn: false)
        harness.queue.enqueue(harness.item("m2"), isOwn: false)
        harness.queue.replay(harness.item("m0", user: "sam"))
        #expect(harness.speaker.events == ["start m1 applies", "cancel", "start m0"])
        #expect(harness.queue.activeMessageId == "m0")
        #expect(harness.queue.queued.map { $0.messageId } == ["m2"])
        harness.speaker.finishActive()
        harness.queue.advanceNow()
        #expect(harness.queue.activeMessageId == "m2")
        // Replay plays a message that already played (the one-start rule is for arrivals only).
        harness.speaker.finishActive()
        harness.queue.replay(harness.item("m1"))
        #expect(harness.queue.activeMessageId == "m1")
    }

    @Test func stopClearsTheCurrentMessageAndTheQueue() {
        let harness = VoiceHarness()
        harness.queue.enqueue(harness.item("m1"), isOwn: false)
        harness.queue.enqueue(harness.item("m2"), isOwn: false)
        harness.queue.stop()
        #expect(harness.queue.isIdle)
        #expect(harness.speaker.events.last == "cancel")
        #expect(harness.playback.last == "|")
        harness.queue.stop()
        #expect(harness.speaker.events.filter { $0 == "cancel" }.count == 1)
    }

    @Test func aMessageIdSpeaksOnceAndStaleFinishesAreIgnored() {
        let harness = VoiceHarness()
        harness.queue.enqueue(harness.item("m1"), isOwn: true)
        let first = harness.speaker.lastToken
        harness.queue.enqueue(harness.item("m1"), isOwn: true)
        #expect(harness.queue.duplicateCount == 1 && harness.queue.queued.isEmpty)
        harness.queue.replay(harness.item("m2"))
        harness.queue.finished(token: first)
        #expect(harness.queue.activeMessageId == "m2")
        harness.queue.finished(token: 0)
        #expect(harness.queue.activeMessageId == "m2")
        // An empty text never starts.
        harness.queue.stop()
        harness.queue.enqueue(harness.item("m3", text: "   "), isOwn: false)
        #expect(harness.queue.isIdle)
    }

    @Test func othersAreSkippedWhilePlayVoiceMessagesIsOff() {
        let harness = VoiceHarness()
        harness.prefs = VoicePreferenceSnapshot(showsChatPreviews: true, playsVoiceMessages: false, voiceKind: .system,
                                                standardVoiceId: "")
        harness.queue.enqueue(harness.item("m1"), isOwn: false)
        #expect(harness.queue.isIdle && harness.queue.skippedByPreferenceCount == 1)
        harness.queue.enqueue(harness.item("m2", user: "jordan"), isOwn: true)
        #expect(harness.queue.activeMessageId == "m2")
        // Replay is an explicit tap and always plays.
        harness.queue.replay(harness.item("m1"))
        #expect(harness.queue.activeMessageId == "m1")
    }

    @Test func aStandardVoiceChangeReachesTheEngineOnce() {
        let harness = VoiceHarness()
        harness.queue.enqueue(harness.item("m1"), isOwn: false)
        harness.speaker.finishActive()
        harness.queue.enqueue(harness.item("m2"), isOwn: false)
        harness.speaker.finishActive()
        #expect(harness.queue.voiceApplyCount == 1)
        harness.prefs = VoicePreferenceSnapshot(showsChatPreviews: true, playsVoiceMessages: true, voiceKind: .system,
                                                standardVoiceId: "en-GB-voice")
        harness.queue.enqueue(harness.item("m3"), isOwn: false)
        harness.speaker.finishActive()
        harness.queue.enqueue(harness.item("m4"), isOwn: false)
        #expect(harness.queue.voiceApplyCount == 2)
        #expect(harness.speaker.events == ["start m1 applies", "start m2", "start m3 voice=en-GB-voice applies",
                                           "start m4 voice=en-GB-voice"])
    }

    @Test func blockedOutputDropsTheMessageAndMovesOn() {
        let harness = VoiceHarness()
        harness.blocked = true
        harness.queue.enqueue(harness.item("m1"), isOwn: false)
        #expect(harness.queue.activeMessageId == "" && harness.queue.blockedCount == 1)
        #expect(harness.speaker.events.isEmpty)
        harness.blocked = false
        harness.queue.enqueue(harness.item("m2"), isOwn: false)
        #expect(harness.queue.activeMessageId == "m2")
        // A replay that the owner blocks still leaves the stopped message idle.
        harness.blocked = true
        harness.queue.replay(harness.item("m3"))
        #expect(harness.queue.activeMessageId == "" && harness.playback.last == "|")
    }

    @Test func theFailsafeFinishesStuckPlayback() {
        let harness = VoiceHarness()
        harness.queue.enqueue(harness.item("m1"), isOwn: false)
        harness.queue.enqueue(harness.item("m2"), isOwn: false)
        harness.queue.failsafeFired(token: harness.speaker.lastToken)
        #expect(harness.queue.failsafeCount == 1)
        #expect(harness.speaker.events.last == "cancel")
        #expect(harness.queue.isAdvancePending)
        harness.queue.advanceNow()
        #expect(harness.queue.activeMessageId == "m2")
        harness.queue.failsafeFired(token: 999)
        #expect(harness.queue.activeMessageId == "m2")
    }

    @Test func personalVoiceItemsCarryTheToken() {
        let harness = VoiceHarness()
        harness.queue.enqueue(harness.item("m1", token: "abc.def"), isOwn: false)
        #expect(harness.speaker.events == ["start m1 applies personal"])
        #expect(harness.speaker.lastItem?.voiceToken == "abc.def")
    }

    @Test func resetForgetsTheSpokenMessageIds() {
        let harness = VoiceHarness()
        harness.queue.enqueue(harness.item("m1"), isOwn: false)
        harness.queue.reset()
        #expect(harness.queue.isIdle)
        harness.queue.enqueue(harness.item("m1"), isOwn: false)
        #expect(harness.queue.activeMessageId == "m1")
    }

    #if os(macOS)
    /// The macOS host speaker keeps the shared API and is silent: a message starts and ends at once.
    @Test func theHostSpeakerIsSilentAndKeepsTheSharedMembers() {
        let speaker = TtsSpeaker()
        speaker.queue.schedulesTimers = false
        speaker.queue.preferences = { VoicePreferenceSnapshot.defaults }
        var changes: [String] = []
        speaker.onPlaybackChanged = { messageId, userId in
            changes.append(messageId + "|" + userId)
        }
        speaker.enqueue(messageId: "m1", userId: Self.avery, displayName: "Avery Lee", text: "hello", voiceToken: "", isOwn: false)
        #expect(changes == ["m1|" + Self.avery, "|"])
        #expect(speaker.activeMessageId == "")
        speaker.replay(messageId: "m1", userId: Self.avery, displayName: "Avery Lee", text: "hello", voiceToken: "")
        speaker.speak(text: "legacy", userId: Self.avery, displayName: "Avery Lee")
        speaker.stop()
        speaker.reset()
        #expect(speaker.queue.startedMessageIds == ["m1", "m1", ""])
    }
    #endif

    // MARK: Sources

    @Test func bothSpeakersExposeTheSameMembersAndRouteThroughTheCallAudioOwner() throws {
        let ios = try chatSource("Sources/Conclave/Core/Audio/TtsSpeaker.swift")
        let kotlin = try chatSource("Sources/Conclave/Skip/TtsSpeaker.kt")
        for member in ["func enqueue(messageId: String, userId: String, displayName: String, text: String, voiceToken: String, isOwn: Bool)",
                       "func replay(messageId: String, userId: String, displayName: String, text: String, voiceToken: String)",
                       "func stop()", "func reset()", "func speak(text: String, userId: String, displayName: String)",
                       "var onPlaybackChanged: ((String, String) -> Void)?", "var activeMessageId: String"] {
            #expect(ios.components(separatedBy: member).count - 1 == 2, "iOS and host speakers declare \(member)")
        }
        for member in ["fun enqueue(messageId: String, userId: String, displayName: String, text: String, voiceToken: String, isOwn: Boolean)",
                       "fun replay(messageId: String, userId: String, displayName: String, text: String, voiceToken: String)",
                       "fun stop()", "fun reset()", "fun speak(text: String, userId: String, displayName: String)",
                       "var onPlaybackChanged: ((String, String) -> Unit)?", "val activeMessageId: String"] {
            #expect(kotlin.contains(member), "Kotlin speaker declares \(member)")
        }
        // The call audio owner: the call's session and route, no category, activation, focus or mode changes.
        #expect(ios.contains("usesApplicationAudioSession = true") && ios.contains("mixToTelephonyUplink = false"))
        #expect(!ios.contains("setCategory") && !ios.contains("setActive(") && !ios.contains("overrideOutputAudioPort"))
        #expect(kotlin.contains("USAGE_VOICE_COMMUNICATION") && kotlin.contains("CONTENT_TYPE_SPEECH"))
        #expect(!kotlin.contains("requestAudioFocus") && !kotlin.contains(".mode =") && !kotlin.contains("setMode("))
        for text in [ios, kotlin] {
            #expect(text.contains("VoiceMessagePolicy.blocksPlayback(AudioRouteOwner.shared.interruption)"))
            #expect(text.contains("VoiceMessagePolicy.defaultSpeechEndpoint()"))
            #expect(!chatHasDash(text))
        }
        // Nothing shared lives in the overridden file (K/TtsSpeaker.kt replaces its transpiled output).
        for shared in ["class TtsPlaybackQueue", "struct TtsQueueItem", "enum VoicePreferences", "enum VoiceMessagePolicy"] {
            #expect(!ios.contains(shared))
        }
        #expect(kotlin.contains("QUEUE_FLUSH") && !kotlin.contains("QUEUE_ADD"))
    }

    @Test func sharedVoiceCodeStaysTranspilable() throws {
        let shared = try chatSource("Sources/Conclave/Core/Audio/VoicePreferences.swift")
        #expect(!shared.contains("#if"))
        #expect(!shared.contains("isLetter"))
        #expect(!shared.contains(".map(") && !shared.contains(".compactMap("))
        #expect(!shared.contains("withObservationTracking"))
        #expect(!chatHasDash(shared))
        #expect(shared.contains("static let maxQueued = 6") && shared.contains("static let advanceGapMillis = 250.0"))
    }

    @Test func voiceBubbleSourcesFollowTheChatRules() throws {
        let ios = try chatSource("Sources/Conclave/Features/Meeting/Chat/VoiceBubble+iOS.swift")
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(!ios.contains("Image(systemName: \""), "raw symbol literal")
        #expect(!ios.contains("sensoryFeedback") && !ios.contains("conclaveGestureFeedback"), "no voice haptic (D6)")
        #expect(!ios.contains("repeatForever") && !ios.contains("symbolEffect"), "static glyph, no equalizer (R13)")
        // Only the voice control and its accessibility action read the playback snapshot.
        #expect(ios.components(separatedBy: "chat.playback.activeVoiceRowId").count - 1 == 2)
        #expect(ios.contains(".accessibilityHint(isPlaying ? \"\" : VoiceCopy.playHint)"))
        let kotlin = try chatSource("Sources/Conclave/Skip/ui/chat/VoiceBubble.kt")
        #expect(!kotlin.contains("haptics") && !kotlin.contains("infiniteRepeatable") && !kotlin.contains("Color(0x"))
        #expect(kotlin.components(separatedBy: "presenter.playback.activeVoiceRowId").count - 1 == 2)
        // Every icon has an explicit tint (Skip Compose gotcha).
        let icons = kotlin.components(separatedBy: "Icon(").dropFirst()
        for call in icons where !call.hasPrefix("Button") {
            let head = call.prefix(while: { $0 != "\n" })
            #expect(head.contains("tint ="), "Icon without tint: \(head)")
        }
        for text in [ios, kotlin] {
            #expect(!text.lowercased().contains("gradient") && !chatHasDash(text))
        }
    }

    @Test func voiceStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(
            with: Data(chatSource("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let keys = try #require(catalog["strings"] as? [String: Any])
        for key in ["Voice Message", "Speaking", "Play Voice Message", "Only you will hear it", "Stop Speaking",
                    "Read aloud to everyone", "System voice", "Your voice", "Voice Mode Line %@ %@", "Exit Voice Message",
                    "Message to read aloud", "Send Voice Message", "Voice message", "Send",
                    "Private messages are text only.", "Voice messages are turned off by the host."] {
            #expect(keys[key] != nil, "missing iOS key \(key)")
        }
        let xml = try chatSource("Android/app/src/main/res/values/strings.xml")
        let kotlin = try chatSource("Sources/Conclave/Skip/ui/chat/VoiceBubble.kt")
        for name in ["chat_voice", "chat_voice_speaking", "chat_voice_play", "chat_voice_play_hint", "chat_voice_stop",
                     "chat_voice_line", "chat_voice_hint", "chat_voice_system", "chat_voice_personal", "chat_voice_exit",
                     "chat_placeholder_voice", "chat_send_voice", "chat_ax_voice", "chat_attach_voice",
                     "chat_reason_private_text", "chat_reason_voice_off"] {
            #expect(kotlin.contains("\"" + name + "\""), "VoiceBubble.kt names \(name)")
            #expect(xml.contains("name=\"" + name + "\""), "missing Android resource \(name)")
        }
    }

    // MARK: Presenter, composer and core (need HD requests B5-T7 R1 to R3)

    @Test func voiceRowsShowTheFullTextAndFollowThePlaybackSnapshot() {
        let chat = ChatPresenter()
        chat.now = { Self.base + 600_000 }
        var log: [String] = []
        chat.onCommand = { log.append($0.logLine) }
        let voice = ChatMessageInput.make(id: "s-v1", senderId: Self.avery, senderName: "Avery Lee",
                                          content: "TTS: Welcome everyone\nto the call", timestampMillis: Self.base,
                                          isHistory: true, isTts: true)
        chat.apply(Self.inputs([voice]), change: .messages)
        let row = chat.rows.entry(for: "s-v1").row
        #expect(row.kind == .voice)
        #expect(row.plainText == "Welcome everyone\nto the call")
        #expect(row.canPlayVoice)
        #expect(chat.playback.activeVoiceRowId == "")
        chat.playVoice(rowId: "s-v1")
        #expect(log.last?.hasPrefix("playVoice rowId=s-v1") == true)
        chat.apply(Self.inputs([voice], activeTtsMessageId: "s-v1"), change: .playback)
        #expect(chat.playback.activeVoiceRowId == "s-v1")
        chat.stopVoice()
        #expect(log.last == "stopVoice")
        chat.apply(Self.inputs([voice]), change: .playback)
        #expect(chat.playback.activeVoiceRowId == "")
        // The host turns voice messages off: the play control hides, the voice label stays (3 f).
        chat.apply(Self.inputs([voice], voiceEnabled: false), change: .policy)
        let off = chat.rows.entry(for: "s-v1").row
        #expect(off.kind == .voice && !off.canPlayVoice)
    }

    @Test func voiceModeSendsThroughTheVoicePrefixAndRespectsPrivacyAndTheHost() {
        let chat = ChatPresenter()
        chat.now = { Self.base + 600_000 }
        var log: [String] = []
        chat.onCommand = { log.append($0.logLine) }
        chat.apply(Self.inputs([]), change: .messages)
        #expect(chat.composer.attachKinds.contains(VoiceMessagePolicy.attachKind))
        #expect(chat.composer.voiceKind == VoiceKind.system.rawValue)
        chat.setVoiceMode(true)
        #expect(chat.composer.isVoiceMode)
        #expect(chat.send(text: String(repeating: "c", count: 501)) == .blocked)
        #expect(chat.composer.inlineNotice == .voiceTooLong)
        #expect(chat.send(text: "Read this aloud") == .dispatched)
        #expect(log.last == "send emoji=voice text=/tts Read this aloud")
        // One voice message per entry into voice mode.
        #expect(!chat.composer.isVoiceMode)
        chat.setVoiceMode(true)
        chat.setPrivateTo(userId: Self.avery)
        #expect(!chat.composer.isVoiceMode)
        chat.setVoiceMode(true)
        #expect(!chat.composer.isVoiceMode)
        chat.setPrivateTo(userId: "")
        chat.apply(Self.inputs([], voiceEnabled: false), change: .policy)
        chat.setVoiceMode(true)
        #expect(!chat.composer.isVoiceMode)
    }

    #if os(macOS)
    @Test func theCoreKeepsIsTtsTheFullTextAndTheVoiceToken() throws {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "admin@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "admin@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.applyChatHistorySnapshot(ChatHistorySnapshotNotification(
            messages: [
                ChatMessageNotification(id: "tts-multi", userId: "remote@example.com#web-session", displayName: "Remote",
                                        content: "/tts Welcome everyone\nto the call", timestamp: 3_000, gif: nil, image: nil,
                                        isDirect: false, dmTargetUserId: nil, dmTargetDisplayName: nil, roomId: nil,
                                        replyTo: nil),
            ],
            roomId: "room-a"
        ))
        let message = try #require(viewModel.state.chatMessages.first)
        #expect(message.isTts)
        #expect(message.content == "TTS: Welcome everyone\nto the call")
        #expect(viewModel.makeChatMessageInput(message).isTts)
        #expect(viewModel.state.activeTtsMessageId == "")
        let json = #"{"id":"s-1","userId":"u","content":"/tts hi","timestamp":1,"ttsVoiceToken":"abc.def"}"#
        let notification = try JSONDecoder().decode(ChatMessageNotification.self, from: Data(json.utf8))
        #expect(notification.chatMessage(taggedRoomId: nil).ttsVoiceToken == "abc.def")
        let vm = try chatSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(vm.contains("ttsSpeaker.enqueue(messageId:") && vm.contains("ttsSpeaker.onPlaybackChanged"))
        #expect(vm.contains("case .playVoice:") && vm.contains("case .stopVoice:"))
        #expect(!vm.contains("ttsHighlightTask"))
        #expect(vm.contains("VoiceMessageText.fullText(from:"))
    }
    #endif

    // MARK: Helpers

    static func freshDefaults() -> UserDefaults {
        let suite = "cht6-voice-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite) ?? UserDefaults.standard
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    static func inputs(_ messages: [ChatMessageInput], voiceEnabled: Bool = true, activeTtsMessageId: String = "") -> ChatInputs {
        ChatInputs.make(callSession: 1, roomId: "room-a", localUserId: local, localName: "Jordan Lee", messages: messages,
                        voiceEnabled: voiceEnabled, gate: .open,
                        roster: [ChatRosterEntry(userId: local, name: "Jordan Lee", isPresent: true),
                                 ChatRosterEntry(userId: avery, name: "Avery Lee", isPresent: true)],
                        assistant: .available, activeTtsMessageId: activeTtsMessageId)
    }
}

/// The real queue on the recording speaker with scripted preferences and output gate; timers off, so tests drive the
/// 250 ms gap (`advanceNow()`) and the failsafe (`failsafeFired(token:)`) themselves.
@MainActor
private final class VoiceHarness {
    let queue = TtsPlaybackQueue()
    let speaker: TtsRecordingSpeaker
    var prefs = VoicePreferenceSnapshot.defaults
    var blocked = false
    var playback: [String] = []

    init() {
        speaker = TtsRecordingSpeaker(queue: queue)
        queue.schedulesTimers = false
        queue.preferences = { [unowned self] in self.prefs }
        queue.isOutputBlocked = { [unowned self] in self.blocked }
        queue.onPlaybackChanged = { [unowned self] messageId, userId in
            self.playback.append(messageId + "|" + userId)
        }
    }

    func item(_ messageId: String, user: String = "avery", text: String = "Hello everyone", token: String = "") -> TtsQueueItem {
        TtsQueueItem.make(messageId: messageId, userId: user, displayName: user, text: text, voiceToken: token)
    }
}

@MainActor
private final class SleepLog {
    var values: [Double] = []
}
#endif

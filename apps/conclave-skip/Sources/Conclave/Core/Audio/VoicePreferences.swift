import Foundation

// S40 CH4 and S60 0.8 C6-22 (CHT-6; SET-4 adds the standard voice list and the Preview rules), transpiled for both platforms. Everything iOS and Android share about voice
// messages lives here: the four voice preference keys with their defaults (read by TtsSpeaker on both platforms, by
// the chat presenter, by the stage chat previews in CHT-8 and by the Settings voice pages in SET-4), the pure voice
// message rules, and the playback queue both speakers drive (6 queued, 250 ms gaps, one active message id). The
// platform speakers only synthesize: S/Core/Audio/TtsSpeaker.swift on iOS (K/TtsSpeaker.kt replaces that file's
// transpiled output on Android, so nothing shared may live there). Skip Lite rules: String raw-value enums, scalar
// structs, closures instead of protocols, no tuples, no self-observation.

// MARK: - Preference keys and defaults (S60 C6-22)

/// The voice your own voice messages use (S40 Q12, S60 Q12). `personal` needs a voice token only the web server mints,
/// so native sends with the system voice until WP10 publishes `canUsePersonalVoice`.
enum VoiceKind: String, CaseIterable {
    case system, personal
}

/// The four C6-22 values at one moment.
struct VoicePreferenceSnapshot: Equatable {
    /// Stage chat previews (S40 Q8, CHT-8); off never hides the unread badge.
    let showsChatPreviews: Bool
    /// Local playback of other people's voice messages (CHT-G4); off never hides the bubble, and replay still plays.
    let playsVoiceMessages: Bool
    let voiceKind: VoiceKind
    /// The standard voice you hear for speakers without a personal voice; "" is Automatic (the device language).
    let standardVoiceId: String

    static let defaults = VoicePreferenceSnapshot(showsChatPreviews: true, playsVoiceMessages: true,
                                                  voiceKind: VoiceKind.system, standardVoiceId: "")
}

/// C6-22: one place for the keys and defaults. Every getter falls back to the default while the key is unset; the
/// setters write the person's choice (SET-4 owns the pages that call them).
enum VoicePreferences {
    static let showsChatPreviewsKey = "conclave.pref.chatPreviews"
    static let playsVoiceMessagesKey = "conclave.pref.playVoiceMessages"
    static let voiceKindKey = "conclave.pref.voiceKind"
    static let standardVoiceIdKey = "conclave.pref.standardVoice"

    static func showsChatPreviews(defaults: UserDefaults = UserDefaults.standard) -> Bool {
        boolValue(forKey: showsChatPreviewsKey, fallback: VoicePreferenceSnapshot.defaults.showsChatPreviews, defaults: defaults)
    }

    static func setShowsChatPreviews(_ on: Bool, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(on, forKey: showsChatPreviewsKey)
    }

    static func playsVoiceMessages(defaults: UserDefaults = UserDefaults.standard) -> Bool {
        boolValue(forKey: playsVoiceMessagesKey, fallback: VoicePreferenceSnapshot.defaults.playsVoiceMessages, defaults: defaults)
    }

    static func setPlaysVoiceMessages(_ on: Bool, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(on, forKey: playsVoiceMessagesKey)
    }

    static func voiceKind(defaults: UserDefaults = UserDefaults.standard) -> VoiceKind {
        guard let raw = defaults.string(forKey: voiceKindKey) else { return VoicePreferenceSnapshot.defaults.voiceKind }
        return VoiceKind(rawValue: raw) ?? VoicePreferenceSnapshot.defaults.voiceKind
    }

    static func setVoiceKind(_ kind: VoiceKind, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(kind.rawValue, forKey: voiceKindKey)
    }

    static func standardVoiceId(defaults: UserDefaults = UserDefaults.standard) -> String {
        defaults.string(forKey: standardVoiceIdKey) ?? VoicePreferenceSnapshot.defaults.standardVoiceId
    }

    /// "" returns to Automatic.
    static func setStandardVoiceId(_ voiceId: String, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(voiceId.trimmingCharacters(in: .whitespacesAndNewlines), forKey: standardVoiceIdKey)
    }

    static func snapshot(defaults: UserDefaults = UserDefaults.standard) -> VoicePreferenceSnapshot {
        VoicePreferenceSnapshot(showsChatPreviews: showsChatPreviews(defaults: defaults),
                                playsVoiceMessages: playsVoiceMessages(defaults: defaults),
                                voiceKind: voiceKind(defaults: defaults),
                                standardVoiceId: standardVoiceId(defaults: defaults))
    }

    /// The voice your messages actually use: personal only while it is available (S40 Q12), else the system voice.
    static func effectiveVoiceKind(preferred: VoiceKind, canUsePersonalVoice: Bool) -> VoiceKind {
        if preferred == VoiceKind.personal && canUsePersonalVoice { return VoiceKind.personal }
        return VoiceKind.system
    }

    /// What the composer's voice line names ("System voice" or "Your voice"). `canUsePersonalVoice` stays false until
    /// the WP10 token path exists (W10-4 is out of this push).
    static func composerVoiceKind(canUsePersonalVoice: Bool = false, defaults: UserDefaults = UserDefaults.standard) -> VoiceKind {
        effectiveVoiceKind(preferred: voiceKind(defaults: defaults), canUsePersonalVoice: canUsePersonalVoice)
    }

    private static func boolValue(forKey key: String, fallback: Bool, defaults: UserDefaults) -> Bool {
        if defaults.object(forKey: key) == nil { return fallback }
        return defaults.bool(forKey: key)
    }
}

// MARK: - Standard voices and Preview (S60 2 c, 2 d; C6-22; SET-4)

/// One system voice the person can hear for speakers without a personal voice: the platform identifier (iOS
/// `AVSpeechSynthesisVoice.identifier`, Android `Voice.getName()`), its display name and its BCP 47 tag, both shown
/// verbatim (S60 0.5).
struct VoiceOptionModel: Equatable, Identifiable {
    let id: String
    let name: String
    let languageTag: String
}

/// The Voice Messages page's shared rules: which system voices are listed and how the Preview is recognized.
enum VoicePreviewPolicy {
    /// The reserved message id a Preview plays under (`TtsSpeaker.replay`), so the speaker's `activeMessageId` tells
    /// whether the Preview is playing and no chat row matches it.
    static let messageId = "conclave-settings-voice-preview"

    static func isPreviewPlaying(activeMessageId: String) -> Bool {
        activeMessageId == messageId
    }

    /// The voices for the current language (the primary subtag of `languageTag`, case-insensitive, `_` read as `-`),
    /// without duplicates or empty ids, sorted by name and then id so both platforms list them in one order.
    static func options(_ voices: [VoiceOptionModel], languageTag: String) -> [VoiceOptionModel] {
        let wanted = primaryLanguage(languageTag)
        var seen: [String] = []
        var kept: [VoiceOptionModel] = []
        for voice in voices {
            if voice.id.isEmpty || seen.contains(voice.id) { continue }
            if !wanted.isEmpty && primaryLanguage(voice.languageTag) != wanted { continue }
            seen.append(voice.id)
            kept.append(voice)
        }
        return kept.sorted { first, second in
            if first.name != second.name { return first.name < second.name }
            return first.id < second.id
        }
    }

    static func primaryLanguage(_ tag: String) -> String {
        let normalized = tag.replacingOccurrences(of: "_", with: "-").lowercased()
        guard let first = normalized.components(separatedBy: "-").first else { return "" }
        return first.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Voice message text (S40 CH4)

/// The spoken text of a voice message. The wire content is `/tts <text>`; the core keeps the legacy normalized content
/// `TTS: <text>` plus `isTts` (request B5-T7 R1), and native rows show the full text with every line (fixes the
/// first-line cut of `ChatMessageContentPolicy.ttsText`, CC:316-321).
enum VoiceMessageText {
    static let normalizedPrefix = "TTS: "

    /// The whole body after `/tts` (any whitespace or newline separates it, matching the SFU and meeting-core), every
    /// line kept and the ends trimmed; nil when the content is not a voice message or the body is empty. Leading
    /// whitespace before `/tts` is not a voice message (the web parser anchors at the start).
    static func fullText(from content: String) -> String? {
        guard content.lowercased().hasPrefix("/tts") else { return nil }
        let remainder = String(content.dropFirst(4))
        guard let separator = remainder.first, separator.isWhitespace || separator.isNewline else { return nil }
        let text = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    /// The text a row shows and the speaker reads, from either the normalized content or a raw `/tts` content.
    static func spokenText(normalizedContent content: String) -> String {
        if content.hasPrefix(normalizedPrefix) {
            return String(content.dropFirst(normalizedPrefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let raw = fullText(from: content) { return raw }
        return content.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The content the core stores for a voice message (legacy chat keeps showing it as before).
    static func normalizedContent(text: String) -> String {
        normalizedPrefix + text
    }
}

// MARK: - Voice message rules (S40 3 f, 6 c, 6 f, CH4)

enum VoiceMessagePolicy {
    /// The attach menu item (`ChatComposerSnapshot.attachKinds`).
    static let attachKind = "voice"
    /// Web parity (`useMeetTts.ts`): at most 6 waiting, the oldest dropped first; 250 ms between messages.
    static let maxQueued = 6
    static let advanceGapMillis = 250.0
    /// A personal voice that takes longer than this falls back to the system voice (CH4).
    static let personalVoiceTimeoutMillis = 15000.0
    /// The stuck-playback failsafe never fires sooner than this.
    static let failsafeGraceMillis = 8000.0
    static let failsafeCeilingMillis = 90000.0
    /// The web route that synthesizes a personal voice from a sender's voice token (no auth; token and text only).
    static let speechPath = "/api/tts/speech"

    /// Whether a received voice message plays by itself: never private (the SFU never treats a private message as
    /// voice), never history, never while the host turned voice messages off; others' messages only while
    /// `playsVoiceMessages` is on (C6-22: off skips local synthesis of others' messages, never your own).
    static func shouldAutoplay(isOwn: Bool, isDirect: Bool, isHistory: Bool, isVoiceDisabled: Bool,
                               playsVoiceMessages: Bool) -> Bool {
        if isDirect || isHistory || isVoiceDisabled { return false }
        return isOwn || playsVoiceMessages
    }

    /// A voice row: a voice message that is not the assistant and carries no photo or GIF.
    static func isVoiceRow(isTts: Bool, isAssistant: Bool, hasImage: Bool, hasGif: Bool, isDirect: Bool) -> Bool {
        isTts && !isAssistant && !hasImage && !hasGif && !isDirect
    }

    /// S40 3 f: the play control shows on voice rows with text while voice messages are on; with voice off by the host
    /// the play control hides and the label stays.
    static func canPlay(kind: ChatRowKind, voiceEnabled: Bool, text: String) -> Bool {
        kind == ChatRowKind.voice && voiceEnabled && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// S40 6 c: the composer's voice row shows in voice mode and while the draft starts with `/tts ` (web CHT-18),
    /// never in private mode (D24) or while the host turned voice messages off.
    static func showsComposerRow(isVoiceMode: Bool, draft: String, isPrivateMode: Bool, voiceEnabled: Bool) -> Bool {
        if isPrivateMode || !voiceEnabled { return false }
        return isVoiceMode || isVoiceDraft(draft)
    }

    /// A typed `/tts` draft with its separator.
    static func isVoiceDraft(_ draft: String) -> Bool {
        let lower = draft.lowercased()
        guard lower.hasPrefix("/tts") else { return false }
        let remainder = String(draft.dropFirst(4))
        guard let separator = remainder.first else { return false }
        return separator.isWhitespace || separator.isNewline
    }

    /// Voice mode can only be on while voice messages are on and you write to everyone (D24).
    static func voiceModeAllowed(voiceEnabled: Bool, isPrivateMode: Bool) -> Bool {
        voiceEnabled && !isPrivateMode
    }

    /// The call audio owner (SYS-2): nothing new starts while another app or a phone call holds the audio, the call is
    /// on hold, or media services are rebuilding. A muted microphone never blocks output.
    static func blocksPlayback(_ interruption: AudioInterruptionKind) -> Bool {
        interruption == AudioInterruptionKind.otherAudio || interruption == AudioInterruptionKind.held
            || interruption == AudioInterruptionKind.servicesReset
    }

    /// The failsafe budget for a playback whose real end is unknown (web `estimateSpeechMs`): the larger of words and
    /// characters over 6 (whitespace-free scripts), 700 ms each plus 5 s, between 8 s and 90 s.
    static func estimateSpeechMillis(_ text: String) -> Double {
        var words = 0
        var characters = 0
        var inWord = false
        for character in text {
            characters += 1
            if character.isWhitespace || character.isNewline {
                inWord = false
            } else if !inWord {
                inWord = true
                words += 1
            }
        }
        let units = max(words, (characters + 5) / 6)
        return min(failsafeCeilingMillis, max(failsafeGraceMillis, Double(units) * 700.0 + 5000.0))
    }

    /// The personal voice endpoint under the app's web origin; "" when no origin is configured.
    static func speechEndpoint(baseURL: URL?) -> String {
        guard let base = baseURL else { return "" }
        var text = base.absoluteString
        while text.hasSuffix("/") {
            text = String(text.dropLast())
        }
        if text.isEmpty { return "" }
        return text + speechPath
    }

    static func defaultSpeechEndpoint() -> String {
        speechEndpoint(baseURL: NativeAuthService.resolveAppBaseURL())
    }
}

// MARK: - Playback queue (S40 CH4)

/// One voice message to speak. `voiceId` and `appliesVoice` are filled when it starts.
struct TtsQueueItem: Equatable {
    let messageId: String
    let userId: String
    let displayName: String
    let text: String
    /// The sender's voice token (personal voice through `speechPath`); "" for the system voice.
    let voiceToken: String
    /// The standard voice to use ("" = Automatic), read from the preferences when the message starts.
    let voiceId: String
    /// True when the voice differs from the one the engine last applied, so a standard voice change reaches the
    /// engine once (C6-22).
    let appliesVoice: Bool

    static func make(messageId: String, userId: String, displayName: String, text: String,
                     voiceToken: String = "") -> TtsQueueItem {
        TtsQueueItem(messageId: messageId, userId: userId, displayName: displayName,
                     text: text.trimmingCharacters(in: .whitespacesAndNewlines), voiceToken: voiceToken, voiceId: "",
                     appliesVoice: false)
    }

    func starting(voiceId: String, appliesVoice: Bool) -> TtsQueueItem {
        TtsQueueItem(messageId: messageId, userId: userId, displayName: displayName, text: text, voiceToken: voiceToken,
                     voiceId: voiceId, appliesVoice: appliesVoice)
    }
}

/// S40 CH4: the voice message engine's state machine, shared by both speakers and by the recording speaker the
/// fixtures and tests use (no audio). One message plays at a time; up to 6 wait (the oldest dropped first); the next
/// starts 250 ms after the previous ends; replay stops the current message and plays the chosen one at once (the queue
/// continues after it); stop clears everything. A message id is spoken once even when it arrives twice (the echo and
/// the acknowledgement), except through replay. The backend reports every end through `finished(token:)`; a failsafe
/// finishes playback that never reports back, so the queue cannot wedge. `onPlaybackChanged` publishes
/// `activeTtsMessageId` and the speaking user ("" and "" when idle) to the core.
@MainActor
final class TtsPlaybackQueue {
    private(set) var activeMessageId = ""
    private(set) var activeUserId = ""
    /// 0 while idle.
    private(set) var activeToken = 0
    private(set) var queued: [TtsQueueItem] = []
    /// True between a finished message and the next start (the 250 ms gap).
    private(set) var isAdvancePending = false

    // Diagnostics (fixtures, tests and readouts).
    private(set) var startedMessageIds: [String] = []
    private(set) var droppedCount = 0
    private(set) var skippedByPreferenceCount = 0
    private(set) var duplicateCount = 0
    private(set) var blockedCount = 0
    private(set) var failsafeCount = 0
    /// How many times a standard voice reached the engine (the first start counts once).
    private(set) var voiceApplyCount = 0

    /// Starts synthesis of the item; the backend calls `finished(token:)` when it ends, fails or is cancelled.
    var onStart: ((TtsQueueItem, Int) -> Void)? = nil
    /// Stops whatever the backend is playing, immediately.
    var onCancel: (() -> Void)? = nil
    /// (message id, user id) of the message now playing; ("", "") when idle.
    var onPlaybackChanged: ((String, String) -> Void)? = nil
    var preferences: () -> VoicePreferenceSnapshot = { VoicePreferences.snapshot() }
    /// The call audio owner's gate (`VoiceMessagePolicy.blocksPlayback`); installed by the platform speakers.
    var isOutputBlocked: () -> Bool = { false }
    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }
    /// False in tests that drive `advanceNow()` and `failsafeFired(token:)` themselves.
    var schedulesTimers = true

    static let recentMessageIdLimit = 64
    static let startedLogLimit = 50

    private var tokenCounter = 0
    private var recentMessageIds: [String] = []
    private var hasAppliedVoice = false
    private var appliedVoiceId = ""
    private var advanceGeneration = 0
    private var advanceTask: Task<Void, Never>? = nil
    private var failsafeTask: Task<Void, Never>? = nil

    init() {}

    var isIdle: Bool {
        activeToken == 0 && queued.isEmpty && !isAdvancePending
    }

    /// A received or acknowledged voice message (web `handleTtsMessage`). `isOwn` messages play even while
    /// `playsVoiceMessages` is off.
    func enqueue(_ item: TtsQueueItem, isOwn: Bool) {
        if item.text.isEmpty { return }
        if !isOwn && !preferences().playsVoiceMessages {
            skippedByPreferenceCount += 1
            return
        }
        if !item.messageId.isEmpty {
            if recentMessageIds.contains(item.messageId) {
                duplicateCount += 1
                return
            }
            remember(item.messageId)
        }
        if activeToken != 0 || !queued.isEmpty || isAdvancePending {
            queued.append(item)
            while queued.count > VoiceMessagePolicy.maxQueued {
                queued.remove(at: 0)
                droppedCount += 1
            }
            return
        }
        start(item)
    }

    /// Local replay from a voice bubble ("only you will hear it"): stops the current message and plays this one now.
    func replay(_ item: TtsQueueItem) {
        if item.text.isEmpty { return }
        if !item.messageId.isEmpty && !recentMessageIds.contains(item.messageId) {
            remember(item.messageId)
        }
        cancelAdvance()
        var interrupted = false
        if activeToken != 0 {
            let current = activeToken
            onCancel?()
            clearActive(token: current, publish: false)
            interrupted = true
        }
        // The new message publishes itself; when the call audio owner blocks it, the stopped one still reads idle.
        if !start(item) && interrupted {
            onPlaybackChanged?("", "")
        }
    }

    /// Stops the current message and drops everything waiting (web `stopTts`).
    func stop() {
        queued = []
        cancelAdvance()
        if activeToken != 0 {
            let current = activeToken
            onCancel?()
            clearActive(token: current, publish: true)
        }
    }

    /// The backend's single completion path; stale tokens are ignored.
    func finished(token: Int) {
        guard token != 0, token == activeToken else { return }
        clearActive(token: token, publish: true)
        scheduleAdvanceIfNeeded()
    }

    /// The end of the 250 ms gap: the next waiting message starts.
    func advanceNow() {
        guard isAdvancePending else { return }
        isAdvancePending = false
        advanceTask = nil
        guard activeToken == 0, !queued.isEmpty else { return }
        let next = queued[0]
        queued.remove(at: 0)
        start(next)
    }

    /// The stuck-playback failsafe for one token.
    func failsafeFired(token: Int) {
        guard token != 0, token == activeToken else { return }
        failsafeCount += 1
        onCancel?()
        finished(token: token)
    }

    /// Call end: stops, drops the queue and forgets the spoken message ids.
    func reset() {
        stop()
        recentMessageIds = []
    }

    /// Returns false when the call audio owner blocked the start (the message is dropped and the queue moves on).
    @discardableResult
    private func start(_ item: TtsQueueItem) -> Bool {
        if isOutputBlocked() {
            blockedCount += 1
            scheduleAdvanceIfNeeded()
            return false
        }
        tokenCounter += 1
        let token = tokenCounter
        let voiceId = preferences().standardVoiceId
        let applies = !hasAppliedVoice || appliedVoiceId != voiceId
        if applies {
            hasAppliedVoice = true
            appliedVoiceId = voiceId
            voiceApplyCount += 1
        }
        activeToken = token
        activeMessageId = item.messageId
        activeUserId = item.userId
        startedMessageIds.append(item.messageId)
        while startedMessageIds.count > TtsPlaybackQueue.startedLogLimit {
            startedMessageIds.remove(at: 0)
        }
        onPlaybackChanged?(item.messageId, item.userId)
        let budget = item.voiceToken.isEmpty
            ? VoiceMessagePolicy.estimateSpeechMillis(item.text)
            : VoiceMessagePolicy.personalVoiceTimeoutMillis + VoiceMessagePolicy.estimateSpeechMillis(item.text)
        armFailsafe(token: token, millis: budget)
        onStart?(item.starting(voiceId: voiceId, appliesVoice: applies), token)
        return true
    }

    private func clearActive(token: Int, publish: Bool) {
        guard token == activeToken else { return }
        activeToken = 0
        activeMessageId = ""
        activeUserId = ""
        cancelFailsafe()
        if publish { onPlaybackChanged?("", "") }
    }

    private func scheduleAdvanceIfNeeded() {
        guard !queued.isEmpty, !isAdvancePending, activeToken == 0 else { return }
        isAdvancePending = true
        advanceGeneration += 1
        let generation = advanceGeneration
        guard schedulesTimers else { return }
        let wait = sleep
        advanceTask = Task { @MainActor [weak self] in
            await wait(VoiceMessagePolicy.advanceGapMillis)
            if Task.isCancelled { return }
            guard let self = self else { return }
            if self.advanceGeneration != generation { return }
            self.advanceNow()
        }
    }

    private func cancelAdvance() {
        advanceTask?.cancel()
        advanceTask = nil
        isAdvancePending = false
        advanceGeneration += 1
    }

    private func armFailsafe(token: Int, millis: Double) {
        cancelFailsafe()
        guard schedulesTimers else { return }
        let wait = sleep
        failsafeTask = Task { @MainActor [weak self] in
            await wait(millis)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.failsafeFired(token: token)
        }
    }

    private func cancelFailsafe() {
        failsafeTask?.cancel()
        failsafeTask = nil
    }

    private func remember(_ messageId: String) {
        recentMessageIds.append(messageId)
        while recentMessageIds.count > TtsPlaybackQueue.recentMessageIdLimit {
            recentMessageIds.remove(at: 0)
        }
    }
}

/// The recording speaker (S40 CH4 fixtures, PLAN CHT-6 "queue and replay fixtures on a recording speaker"): it
/// installs itself as a queue's backend and records every start and cancel instead of making sound, so the chat
/// fixture, the host tests and Robolectric run the real queue silently.
@MainActor
final class TtsRecordingSpeaker {
    let queue: TtsPlaybackQueue
    private(set) var events: [String] = []
    private(set) var lastToken = 0
    private(set) var lastItem: TtsQueueItem? = nil

    init(queue: TtsPlaybackQueue) {
        self.queue = queue
        queue.onStart = { [weak self] item, token in
            self?.recordStart(item, token: token)
        }
        queue.onCancel = { [weak self] in
            self?.recordCancel()
        }
    }

    /// The engine finished the current message.
    func finishActive() {
        queue.finished(token: lastToken)
    }

    /// One line per event, for the fixture readout.
    var log: String {
        events.joined(separator: "\n")
    }

    private func recordStart(_ item: TtsQueueItem, token: Int) {
        lastToken = token
        lastItem = item
        var line = "start " + item.messageId
        if !item.voiceId.isEmpty { line += " voice=" + item.voiceId }
        if item.appliesVoice { line += " applies" }
        if !item.voiceToken.isEmpty { line += " personal" }
        events.append(line)
    }

    private func recordCancel() {
        events.append("cancel")
    }
}

import Foundation

enum VoiceKind: String, CaseIterable {
    case system, personal
}

struct VoicePreferenceSnapshot: Equatable {

    let showsChatPreviews: Bool

    let playsVoiceMessages: Bool
    let voiceKind: VoiceKind

    let standardVoiceId: String

    static let defaults = VoicePreferenceSnapshot(showsChatPreviews: true, playsVoiceMessages: true,
                                                  voiceKind: VoiceKind.system, standardVoiceId: "")
}

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

    static func setStandardVoiceId(_ voiceId: String, defaults: UserDefaults = UserDefaults.standard) {
        defaults.set(voiceId.trimmingCharacters(in: .whitespacesAndNewlines), forKey: standardVoiceIdKey)
    }

    static func snapshot(defaults: UserDefaults = UserDefaults.standard) -> VoicePreferenceSnapshot {
        VoicePreferenceSnapshot(showsChatPreviews: showsChatPreviews(defaults: defaults),
                                playsVoiceMessages: playsVoiceMessages(defaults: defaults),
                                voiceKind: voiceKind(defaults: defaults),
                                standardVoiceId: standardVoiceId(defaults: defaults))
    }

    static func effectiveVoiceKind(preferred: VoiceKind, canUsePersonalVoice: Bool) -> VoiceKind {
        if preferred == VoiceKind.personal && canUsePersonalVoice { return VoiceKind.personal }
        return VoiceKind.system
    }

    static func composerVoiceKind(canUsePersonalVoice: Bool = false, defaults: UserDefaults = UserDefaults.standard) -> VoiceKind {
        effectiveVoiceKind(preferred: voiceKind(defaults: defaults), canUsePersonalVoice: canUsePersonalVoice)
    }

    private static func boolValue(forKey key: String, fallback: Bool, defaults: UserDefaults) -> Bool {
        if defaults.object(forKey: key) == nil { return fallback }
        return defaults.bool(forKey: key)
    }
}

struct VoiceOptionModel: Equatable, Identifiable {
    let id: String
    let name: String
    let languageTag: String
}

enum VoicePreviewPolicy {

    static let messageId = "conclave-settings-voice-preview"

    static func isPreviewPlaying(activeMessageId: String) -> Bool {
        activeMessageId == messageId
    }

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

enum VoiceMessageText {
    static let normalizedPrefix = "TTS: "

    static func fullText(from content: String) -> String? {
        guard content.lowercased().hasPrefix("/tts") else { return nil }
        let remainder = String(content.dropFirst(4))
        guard let separator = remainder.first, separator.isWhitespace || separator.isNewline else { return nil }
        let text = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    static func spokenText(normalizedContent content: String) -> String {
        if content.hasPrefix(normalizedPrefix) {
            return String(content.dropFirst(normalizedPrefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let raw = fullText(from: content) { return raw }
        return content.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func normalizedContent(text: String) -> String {
        normalizedPrefix + text
    }
}

enum VoiceMessagePolicy {

    static let attachKind = "voice"

    static let maxQueued = 6
    static let advanceGapMillis = 250.0

    static let personalVoiceTimeoutMillis = 15000.0

    static let failsafeGraceMillis = 8000.0
    static let failsafeCeilingMillis = 90000.0

    static let speechPath = "/api/tts/speech"

    static func shouldAutoplay(isOwn: Bool, isDirect: Bool, isHistory: Bool, isVoiceDisabled: Bool,
                               playsVoiceMessages: Bool) -> Bool {
        if isDirect || isHistory || isVoiceDisabled { return false }
        return isOwn || playsVoiceMessages
    }

    static func isVoiceRow(isTts: Bool, isAssistant: Bool, hasImage: Bool, hasGif: Bool, isDirect: Bool) -> Bool {
        isTts && !isAssistant && !hasImage && !hasGif && !isDirect
    }

    static func canPlay(kind: ChatRowKind, voiceEnabled: Bool, text: String) -> Bool {
        kind == ChatRowKind.voice && voiceEnabled && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func showsComposerRow(isVoiceMode: Bool, draft: String, isPrivateMode: Bool, voiceEnabled: Bool) -> Bool {
        if isPrivateMode || !voiceEnabled { return false }
        return isVoiceMode || isVoiceDraft(draft)
    }

    static func isVoiceDraft(_ draft: String) -> Bool {
        let lower = draft.lowercased()
        guard lower.hasPrefix("/tts") else { return false }
        let remainder = String(draft.dropFirst(4))
        guard let separator = remainder.first else { return false }
        return separator.isWhitespace || separator.isNewline
    }

    static func voiceModeAllowed(voiceEnabled: Bool, isPrivateMode: Bool) -> Bool {
        voiceEnabled && !isPrivateMode
    }

    static func blocksPlayback(_ interruption: AudioInterruptionKind) -> Bool {
        interruption == AudioInterruptionKind.otherAudio || interruption == AudioInterruptionKind.held
            || interruption == AudioInterruptionKind.servicesReset
    }

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

struct TtsQueueItem: Equatable {
    let messageId: String
    let userId: String
    let displayName: String
    let text: String

    let voiceToken: String

    let voiceId: String

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

@MainActor
final class TtsPlaybackQueue {
    private(set) var activeMessageId = ""
    private(set) var activeUserId = ""

    private(set) var activeToken = 0
    private(set) var queued: [TtsQueueItem] = []

    private(set) var isAdvancePending = false

    private(set) var startedMessageIds: [String] = []
    private(set) var droppedCount = 0
    private(set) var skippedByPreferenceCount = 0
    private(set) var duplicateCount = 0
    private(set) var blockedCount = 0
    private(set) var failsafeCount = 0

    private(set) var voiceApplyCount = 0

    var onStart: ((TtsQueueItem, Int) -> Void)? = nil

    var onCancel: (() -> Void)? = nil

    var onPlaybackChanged: ((String, String) -> Void)? = nil
    var preferences: () -> VoicePreferenceSnapshot = { VoicePreferences.snapshot() }

    var isOutputBlocked: () -> Bool = { false }
    var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

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

        if !start(item) && interrupted {
            onPlaybackChanged?("", "")
        }
    }

    func stop() {
        queued = []
        cancelAdvance()
        if activeToken != 0 {
            let current = activeToken
            onCancel?()
            clearActive(token: current, publish: true)
        }
    }

    func finished(token: Int) {
        guard token != 0, token == activeToken else { return }
        clearActive(token: token, publish: true)
        scheduleAdvanceIfNeeded()
    }

    func advanceNow() {
        guard isAdvancePending else { return }
        isAdvancePending = false
        advanceTask = nil
        guard activeToken == 0, !queued.isEmpty else { return }
        let next = queued[0]
        queued.remove(at: 0)
        start(next)
    }

    func failsafeFired(token: Int) {
        guard token != 0, token == activeToken else { return }
        failsafeCount += 1
        onCancel?()
        finished(token: token)
    }

    func reset() {
        stop()
        recentMessageIds = []
    }

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

    func finishActive() {
        queue.finished(token: lastToken)
    }

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

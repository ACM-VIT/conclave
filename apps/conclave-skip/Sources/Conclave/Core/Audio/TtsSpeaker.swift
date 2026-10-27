import Foundation
#if os(iOS) && !SKIP
import AVFoundation
#endif

// S40 CH4 (CHT-6): the voice message speaker. The queue (6 waiting, 250 ms gaps, the active message id), the
// preference keys and every rule live in VoicePreferences.swift, shared with Android; K/TtsSpeaker.kt replaces this
// file's transpiled output there, so this file only synthesizes. Both speakers expose the same members, because the
// transpiled view model calls them: `enqueue(messageId:userId:displayName:text:voiceToken:isOwn:)`,
// `replay(messageId:userId:displayName:text:voiceToken:)`, `stop()`, `reset()`, `onPlaybackChanged`,
// `activeMessageId`, plus the legacy `speak(text:userId:displayName:)`.
//
// Playback goes through the call audio owner (SYS-2): the synthesizer and the personal voice player use the app's
// audio session that CallAudioSession configures for the call, so speech follows the call's route (receiver, speaker,
// Bluetooth); nothing here changes the category, activates the session or sends speech into the call, and nothing
// starts while the owner reports another app's audio, a hold or a media services reset.

#if os(iOS) && !SKIP
@MainActor
final class TtsSpeaker {
    let queue: TtsPlaybackQueue
    private var synthesizer: AVSpeechSynthesizer? = nil
    private let speechDelegate = TtsSpeechDelegate()
    private var utteranceTokens: [ObjectIdentifier: Int] = [:]
    private var hasResolvedVoice = false
    private var resolvedVoiceId = ""
    private var resolvedVoice: AVSpeechSynthesisVoice? = nil
    private var personalTask: Task<Void, Never>? = nil
    private var player: AVAudioPlayer? = nil
    private var playerDelegate: TtsAudioPlayerDelegate? = nil
    /// The system speech rate and pitch the app has always used (0.94 of the default rate).
    static let rateFactor: Float = 0.94

    /// (message id, user id) while a message plays; ("", "") when idle. The core writes `activeTtsMessageId` and
    /// `ttsSpeakerId` from it.
    var onPlaybackChanged: ((String, String) -> Void)? {
        get { queue.onPlaybackChanged }
        set { queue.onPlaybackChanged = newValue }
    }

    var activeMessageId: String {
        queue.activeMessageId
    }

    init(queue: TtsPlaybackQueue? = nil) {
        // A default argument runs outside the main actor, so the main-actor queue is made here.
        let queue = queue ?? TtsPlaybackQueue()
        self.queue = queue
        queue.onStart = { [weak self] item, token in
            self?.start(item, token: token)
        }
        queue.onCancel = { [weak self] in
            self?.cancelPlayback()
        }
        queue.isOutputBlocked = {
            VoiceMessagePolicy.blocksPlayback(AudioRouteOwner.shared.interruption)
        }
        speechDelegate.onFinish = { [weak self] identifier in
            self?.utteranceEnded(identifier)
        }
    }

    /// A received or acknowledged voice message; others' messages are skipped while Play Voice Messages is off.
    func enqueue(messageId: String, userId: String, displayName: String, text: String, voiceToken: String, isOwn: Bool) {
        queue.enqueue(TtsQueueItem.make(messageId: messageId, userId: userId, displayName: displayName, text: text,
                                        voiceToken: voiceToken), isOwn: isOwn)
    }

    /// Local replay from a voice bubble; only you hear it.
    func replay(messageId: String, userId: String, displayName: String, text: String, voiceToken: String) {
        queue.replay(TtsQueueItem.make(messageId: messageId, userId: userId, displayName: displayName, text: text,
                                       voiceToken: voiceToken))
    }

    /// Stops the current message and drops the queue (Stop Speaking, the host turning voice messages off).
    func stop() {
        queue.stop()
    }

    /// Call end.
    func reset() {
        queue.reset()
    }

    /// The legacy entry point (no message id, so no bubble state); kept until the core moves to `enqueue`.
    func speak(text: String, userId: String, displayName: String) {
        enqueue(messageId: "", userId: userId, displayName: displayName, text: text, voiceToken: "", isOwn: false)
    }

    // MARK: Engine

    private func start(_ item: TtsQueueItem, token: Int) {
        if item.voiceToken.isEmpty {
            speakSystem(item, token: token)
        } else {
            startPersonal(item, token: token)
        }
    }

    private func speakSystem(_ item: TtsQueueItem, token: Int) {
        let speech = speechSynthesizer()
        if speech.isSpeaking || speech.isPaused {
            // The stopped utterance reports a cancel with its old token, which the queue ignores.
            speech.stopSpeaking(at: .immediate)
        }
        let utterance = AVSpeechUtterance(string: item.text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * TtsSpeaker.rateFactor
        utterance.pitchMultiplier = 1.0
        utterance.volume = 1.0
        utterance.voice = voice(for: item)
        utteranceTokens[ObjectIdentifier(utterance)] = token
        speech.speak(utterance)
    }

    private func speechSynthesizer() -> AVSpeechSynthesizer {
        if let existing = synthesizer { return existing }
        let created = AVSpeechSynthesizer()
        // The call's session (CallAudioSession owns category, mode and activation); speech never enters the call.
        created.usesApplicationAudioSession = true
        created.mixToTelephonyUplink = false
        created.delegate = speechDelegate
        synthesizer = created
        return created
    }

    /// C6-22: the standard voice reaches the engine once per change; an identifier that is no longer installed falls
    /// back to Automatic (the preferred language's default voice).
    private func voice(for item: TtsQueueItem) -> AVSpeechSynthesisVoice? {
        if item.appliesVoice || !hasResolvedVoice || resolvedVoiceId != item.voiceId {
            hasResolvedVoice = true
            resolvedVoiceId = item.voiceId
            resolvedVoice = TtsSpeaker.resolveVoice(identifier: item.voiceId)
        }
        return resolvedVoice
    }

    static func resolveVoice(identifier: String) -> AVSpeechSynthesisVoice? {
        if !identifier.isEmpty, let chosen = AVSpeechSynthesisVoice(identifier: identifier) {
            return chosen
        }
        return AVSpeechSynthesisVoice(language: Locale.preferredLanguages.first ?? Locale.current.identifier)
    }

    private func utteranceEnded(_ identifier: ObjectIdentifier) {
        guard let token = utteranceTokens.removeValue(forKey: identifier) else { return }
        queue.finished(token: token)
    }

    // MARK: Personal voice (CH4: `/api/tts/speech`, 15 s, then the system voice)

    private func startPersonal(_ item: TtsQueueItem, token: Int) {
        let endpoint = VoiceMessagePolicy.defaultSpeechEndpoint()
        guard !endpoint.isEmpty, let url = URL(string: endpoint) else {
            speakSystem(item, token: token)
            return
        }
        personalTask?.cancel()
        personalTask = Task { @MainActor [weak self] in
            let data = await TtsSpeaker.fetchPersonalSpeech(url: url, voiceToken: item.voiceToken, text: item.text)
            guard let self = self, !Task.isCancelled, self.queue.activeToken == token else { return }
            self.personalTask = nil
            if let data = data, self.playPersonal(data, item: item, token: token) { return }
            self.speakSystem(item, token: token)
        }
    }

    /// One session whose whole request (connect, synthesis and download) ends after 15 s.
    private nonisolated static let personalSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = VoiceMessagePolicy.personalVoiceTimeoutMillis / 1000.0
        configuration.timeoutIntervalForResource = VoiceMessagePolicy.personalVoiceTimeoutMillis / 1000.0
        return URLSession(configuration: configuration)
    }()

    nonisolated static func fetchPersonalSpeech(url: URL, voiceToken: String, text: String) async -> Data? {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let body = try? JSONSerialization.data(withJSONObject: ["token": voiceToken, "text": text]) else { return nil }
        request.httpBody = body
        do {
            let (data, response) = try await personalSession.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode), !data.isEmpty else {
                return nil
            }
            return data
        } catch {
            return nil
        }
    }

    private func playPersonal(_ data: Data, item: TtsQueueItem, token: Int) -> Bool {
        guard let created = try? AVAudioPlayer(data: data) else { return false }
        let delegate = TtsAudioPlayerDelegate()
        delegate.onFinish = { [weak self] succeeded in
            self?.personalEnded(item: item, token: token, succeeded: succeeded)
        }
        created.delegate = delegate
        created.volume = 1.0
        created.prepareToPlay()
        guard created.play() else { return false }
        player = created
        playerDelegate = delegate
        return true
    }

    private func personalEnded(item: TtsQueueItem, token: Int, succeeded: Bool) {
        player = nil
        playerDelegate = nil
        guard queue.activeToken == token else { return }
        if succeeded {
            queue.finished(token: token)
        } else {
            // A decode failure reads the message with the system voice instead (web parity).
            speakSystem(item, token: token)
        }
    }

    private func cancelPlayback() {
        personalTask?.cancel()
        personalTask = nil
        if let current = player {
            current.delegate = nil
            current.stop()
        }
        player = nil
        playerDelegate = nil
        synthesizer?.stopSpeaking(at: .immediate)
    }
}

/// Speech ends (finished or cancelled) hop to the main actor with the utterance identity.
@MainActor
private final class TtsSpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onFinish: ((ObjectIdentifier) -> Void)? = nil

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let identifier = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            self?.onFinish?(identifier)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let identifier = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            self?.onFinish?(identifier)
        }
    }
}

/// The personal voice player's end (true) or decode failure (false), on the main actor.
@MainActor
private final class TtsAudioPlayerDelegate: NSObject, AVAudioPlayerDelegate {
    var onFinish: ((Bool) -> Void)? = nil

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            self?.onFinish?(flag)
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            self?.onFinish?(false)
        }
    }
}
#else
/// The macOS test host (and the transpile pass, whose output K/TtsSpeaker.kt replaces): the same members and the real
/// queue, but silent: every message ends as soon as it starts, so host tests never make a sound.
@MainActor
final class TtsSpeaker {
    let queue: TtsPlaybackQueue

    var onPlaybackChanged: ((String, String) -> Void)? {
        get { queue.onPlaybackChanged }
        set { queue.onPlaybackChanged = newValue }
    }

    var activeMessageId: String {
        queue.activeMessageId
    }

    init(queue: TtsPlaybackQueue? = nil) {
        let queue = queue ?? TtsPlaybackQueue()
        self.queue = queue
        queue.onStart = { [weak queue] _, token in
            queue?.finished(token: token)
        }
    }

    func enqueue(messageId: String, userId: String, displayName: String, text: String, voiceToken: String, isOwn: Bool) {
        queue.enqueue(TtsQueueItem.make(messageId: messageId, userId: userId, displayName: displayName, text: text,
                                        voiceToken: voiceToken), isOwn: isOwn)
    }

    func replay(messageId: String, userId: String, displayName: String, text: String, voiceToken: String) {
        queue.replay(TtsQueueItem.make(messageId: messageId, userId: userId, displayName: displayName, text: text,
                                       voiceToken: voiceToken))
    }

    func stop() {
        queue.stop()
    }

    func reset() {
        queue.reset()
    }

    func speak(text: String, userId: String, displayName: String) {
        enqueue(messageId: "", userId: userId, displayName: displayName, text: text, voiceToken: "", isOwn: false)
    }
}
#endif

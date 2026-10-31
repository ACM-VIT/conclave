import Foundation
#if os(iOS) && !SKIP
import AVFoundation
#endif

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

    static let rateFactor: Float = 0.94

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

    func togglePreview(sentence: String, start: Bool) {
        if VoicePreviewPolicy.isPreviewPlaying(activeMessageId: queue.activeMessageId) {
            queue.stop()
            if !start { return }
        }
        if !start { return }
        replay(messageId: VoicePreviewPolicy.messageId, userId: "", displayName: "", text: sentence, voiceToken: "")
    }

    static func standardVoiceOptions(languageTag: String = Locale.preferredLanguages.first ?? Locale.current.identifier) -> [VoiceOptionModel] {
        var voices: [VoiceOptionModel] = []
        for voice in AVSpeechSynthesisVoice.speechVoices() {
            voices.append(VoiceOptionModel(id: voice.identifier, name: voice.name, languageTag: voice.language))
        }
        return VoicePreviewPolicy.options(voices, languageTag: languageTag)
    }

    private func start(_ item: TtsQueueItem, token: Int) {
        if item.voiceToken.isEmpty {
            speakSystem(item, token: token)
        } else {
            startPersonal(item, token: token)
        }
    }

    private func speakSystem(_ item: TtsQueueItem, token: Int) {
        guard canStartPlayback(token: token) else { return }
        let speech = speechSynthesizer()
        if speech.isSpeaking || speech.isPaused {

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

        created.usesApplicationAudioSession = true
        created.mixToTelephonyUplink = false
        created.delegate = speechDelegate
        synthesizer = created
        return created
    }

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
        guard canStartPlayback(token: token) else { return false }
        guard let created = try? AVAudioPlayer(data: data) else { return false }
        let delegate = TtsAudioPlayerDelegate()
        delegate.onFinish = { [weak self] succeeded in
            self?.personalEnded(item: item, token: token, succeeded: succeeded)
        }
        created.delegate = delegate
        created.volume = 1.0
        created.prepareToPlay()
        guard canStartPlayback(token: token), created.play() else { return false }
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

            speakSystem(item, token: token)
        }
    }

    func canStartPlayback(token: Int) -> Bool {
        guard token != 0, queue.activeToken == token else { return false }
        guard !queue.isOutputBlocked() else {
            queue.finished(token: token)
            return false
        }
        return true
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

    func togglePreview(sentence: String, start: Bool) {
        if VoicePreviewPolicy.isPreviewPlaying(activeMessageId: queue.activeMessageId) {
            queue.stop()
            if !start { return }
        }
        if !start { return }
        replay(messageId: VoicePreviewPolicy.messageId, userId: "", displayName: "", text: sentence, voiceToken: "")
    }

    static func standardVoiceOptions(languageTag: String = "") -> [VoiceOptionModel] {
        []
    }
}
#endif

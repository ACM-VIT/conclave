#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SET4VoicePagesTests {

    @Test func voiceOptionsKeepTheCurrentLanguageInOneOrder() {
        let voices = [
            VoiceOptionModel(id: "en-gb-x-rjs", name: "Serena", languageTag: "en-GB"),
            VoiceOptionModel(id: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", languageTag: "en-US"),
            VoiceOptionModel(id: "fr-fr-x-vlf", name: "Amelie", languageTag: "fr_FR"),
            VoiceOptionModel(id: "", name: "Nameless", languageTag: "en-US"),
            VoiceOptionModel(id: "en-gb-x-rjs", name: "Serena", languageTag: "en-GB"),
            VoiceOptionModel(id: "en-au-x-a", name: "Samantha", languageTag: "EN_au"),
        ]
        let english = VoicePreviewPolicy.options(voices, languageTag: "en-IN")
        #expect(english.map { $0.id } == ["com.apple.voice.compact.en-US.Samantha", "en-au-x-a", "en-gb-x-rjs"])
        #expect(VoicePreviewPolicy.options(voices, languageTag: "fr").map { $0.id } == ["fr-fr-x-vlf"])
        #expect(VoicePreviewPolicy.options(voices, languageTag: "").count == 4)
        #expect(VoicePreviewPolicy.primaryLanguage("pt_BR") == "pt")
        #expect(VoicePreviewPolicy.isPreviewPlaying(activeMessageId: VoicePreviewPolicy.messageId))
        #expect(!VoicePreviewPolicy.isPreviewPlaying(activeMessageId: "message-1"))
    }

    @Test func aChosenStandardVoiceIsStoredOnceAndAnUninstalledOneReadsAutomatic() {
        let defaults = Self.freshDefaults()
        let (presenter, core) = Self.make(.voiceUnavailable, defaults: defaults)
        presenter.setStandardVoices([VoiceOptionModel(id: "v1", name: "One", languageTag: "en-US")])
        presenter.setStandardVoice(" v1 ")
        presenter.setStandardVoice("v1")
        #expect(VoicePreferences.standardVoiceId(defaults: defaults) == "v1")
        #expect(presenter.chat.standardVoiceId == "v1")
        #expect(core.calls == ["preferenceChanged"])

        presenter.setStandardVoices([VoiceOptionModel(id: "v2", name: "Two", languageTag: "en-US")])
        #expect(presenter.chat.standardVoiceId == "")

        let queue = TtsPlaybackQueue()
        queue.schedulesTimers = false
        queue.preferences = { VoicePreferences.snapshot(defaults: defaults) }
        let speaker = TtsRecordingSpeaker(queue: queue)
        queue.replay(TtsQueueItem.make(messageId: "m1", userId: "u", displayName: "U", text: "Hello"))
        #expect(speaker.lastItem?.voiceId == "v1")
    }

    @Test func previewCountsPerTapNeverOnOpenAndIsCallOnly() {
        let (presenter, core) = Self.make(.voiceUnavailable)
        presenter.panelDidOpen()

        #expect(presenter.voicePreviewCount == 0 && core.calls == ["mirrorOn"])
        #expect(presenter.toggleStandardVoicePreview(sentence: "Sample") == .dispatched)
        #expect(presenter.voicePreviewCount == 1)
        presenter.apply(SettingsInputs.make(callSession: 1, roomId: "fixture-room", isJoined: true, isMuted: false,
                                            savedDisplayName: "Avery Lee", account: .signedIn, accountName: "Avery Lee",
                                            accountEmail: "avery@example.com", accountProvider: "google", hasCore: true,
                                            isStandardPreviewPlaying: true))
        #expect(presenter.chat.standardPreview == .playing)
        #expect(presenter.toggleStandardVoicePreview(sentence: "Sample") == .dispatched)
        #expect(presenter.voicePreviewCount == 1)
        #expect(core.calls == ["mirrorOn", "voicePreviewStart", "voicePreviewStop"])
        let app = SettingsPresenter(scope: .app, platform: .ios, defaults: Self.freshDefaults())
        #expect(!app.chat.canPreviewStandardVoice)
        #expect(app.toggleStandardVoicePreview(sentence: "Sample") == .ignored)
    }

    @Test func personalVoiceStaysHiddenWithoutTheCapability() {
        let (signedIn, _) = Self.make(.voiceUnavailable)
        #expect(!signedIn.chat.canUsePersonalVoice && signedIn.chat.personalVoice == .unavailable)
        #expect(signedIn.chat.personalVoiceReason == .notInAppYet)
        signedIn.setVoiceKind(.personal)
        #expect(signedIn.chat.voiceKind == .system && signedIn.chat.effectiveVoiceKind == .system)
        let (guest, _) = Self.make(.guest)
        #expect(guest.chat.personalVoiceReason == .guest)
        let before = guest.voiceSampleCount
        guest.startVoiceSample()
        #expect(guest.voiceSampleCount == before && guest.chat.personalVoice == .unavailable)
    }

    @Test func aReadyPersonalVoiceCanBeChosenHeardAndDeleted() {
        let defaults = Self.freshDefaults()
        let (presenter, core) = Self.make(.voiceReady, defaults: defaults)
        #expect(presenter.chat.personalVoice == .ready)
        presenter.setVoiceKind(.personal)
        #expect(presenter.chat.effectiveVoiceKind == .personal)
        presenter.hearPersonalVoice()
        presenter.deletePersonalVoice()
        #expect(presenter.chat.personalVoice == .deleting)
        presenter.personalVoiceDeleted(true)
        #expect(presenter.chat.personalVoice == PersonalVoicePhase.none)
        #expect(VoicePreferences.voiceKind(defaults: defaults) == .system)
        #expect(core.calls == ["preferenceChanged", "hearPersonalVoice", "deletePersonalVoice", "preferenceChanged"])
    }

    @Test func theRecorderPausesTheMeetingMicForTheTakeAndNeedsSixtySecondsAndConsent() {

        let fresh = SettingsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        let freshCore = SettingsRecordingCore()
        freshCore.install(on: fresh)
        fresh.apply(SettingsInputs.make(callSession: 1, roomId: "fixture-room", isJoined: true, isMuted: false, account: .signedIn,
                                        hasCore: true, canUsePersonalVoice: true, hasPersonalVoice: false))
        #expect(fresh.chat.personalVoice == PersonalVoicePhase.none)
        let rootRevision = fresh.audio.revision
        fresh.startVoiceSample()
        #expect(fresh.chat.personalVoice == .recording && fresh.voiceSampleCount == 1)
        for second in 1...30 { fresh.voiceSampleProgress(elapsedSeconds: second, level: 0.2) }
        #expect(fresh.recorder.secondsLeft == 30 && !fresh.recorder.canCreate)
        let chatRevision = fresh.chat.revision
        for second in 31...61 { fresh.voiceSampleProgress(elapsedSeconds: second, level: 0.2) }

        #expect(fresh.chat.revision == chatRevision && fresh.audio.revision == rootRevision)
        fresh.stopVoiceSample()
        #expect(fresh.chat.personalVoice == .review && !fresh.recorder.canCreate)
        fresh.setVoiceConsent(true)
        #expect(fresh.recorder.canCreate)
        fresh.createPersonalVoice()
        #expect(fresh.chat.personalVoice == .creating)
        fresh.personalVoiceCreated(true)
        #expect(fresh.chat.personalVoice == .ready)
        #expect(freshCore.calls == ["micPause", "micRestore", "createPersonalVoice"])
    }

    @Test func theTakeStopsAtTheCapAndADiscardRestoresTheMic() {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        let core = SettingsRecordingCore()
        core.install(on: presenter)
        presenter.apply(SettingsInputs.make(callSession: 1, isJoined: true, isMuted: false, hasCore: true, canUsePersonalVoice: true))
        presenter.startVoiceSample()
        presenter.voiceSampleProgress(elapsedSeconds: VoiceRecorderPolicy.maximumSeconds, level: 0.1)
        #expect(presenter.chat.personalVoice == .review)
        presenter.discardVoiceSample()
        #expect(presenter.chat.personalVoice == PersonalVoicePhase.none && presenter.recorder.elapsedSeconds == 0)
        presenter.startVoiceSample()
        presenter.discardVoiceSample()
        #expect(core.calls == ["micPause", "micRestore", "micPause", "micRestore"])
        #expect(VoiceRecorderPolicy.shouldAnnounce(secondsLeft: 40) && !VoiceRecorderPolicy.shouldAnnounce(secondsLeft: 41))
        #expect(!VoiceRecorderPolicy.shouldAnnounce(secondsLeft: 0))
    }

    @Test func theHostSpeakerPlaysThePreviewUnderTheReservedIdSilently() {
        let speaker = TtsSpeaker()
        speaker.queue.schedulesTimers = false
        var playback: [String] = []
        speaker.onPlaybackChanged = { messageId, _ in playback.append(messageId) }
        speaker.togglePreview(sentence: "Sample", start: true)
        #expect(playback.first == VoicePreviewPolicy.messageId)
        speaker.togglePreview(sentence: "Sample", start: false)
        #expect(speaker.activeMessageId == "")
        #expect(TtsSpeaker.standardVoiceOptions().isEmpty)
    }

    @Test func voiceSourcesLoadTheListOncePerPageAndPreviewOnTapOnly() throws {
        let ios = try Self.source("Sources/Conclave/Features/Meeting/Settings/VoicePages+iOS.swift")
        #expect(ios.contains(".task {\n            settings.setStandardVoices(TtsSpeaker.standardVoiceOptions())"))
        #expect(ios.contains("if chat.canUsePersonalVoice"))
        #expect(ios.contains(".pickerStyle(.navigationLink)"))
        let android = try Self.source("Sources/Conclave/Skip/ui/settings/VoicePages.kt")
        #expect(android.contains("TtsSpeaker.loadStandardVoices(Locale.getDefault().toLanguageTag())"))
        #expect(android.contains("if (chat.canUsePersonalVoice)"))
        #expect(android.contains("Intent(\"com.android.settings.TTS_SETTINGS\")"))
        let speakerSwift = try Self.source("Sources/Conclave/Core/Audio/TtsSpeaker.swift")
        #expect(speakerSwift.components(separatedBy: "func togglePreview(sentence: String, start: Bool)").count - 1 == 2)
        #expect(speakerSwift.contains("AVSpeechSynthesisVoice.speechVoices()"))
        let speakerKotlin = try Self.source("Sources/Conclave/Skip/TtsSpeaker.kt")
        #expect(speakerKotlin.contains("internal fun togglePreview(sentence: String, start: Boolean)"))
        #expect(speakerKotlin.contains("internal fun loadStandardVoices(languageTag: String, onLoaded: (List<VoiceOptionModel>) -> Unit)"))

        #expect(speakerKotlin.contains("var probe: TextToSpeech? = null"))
        let recorderIOS = try Self.source("Sources/Conclave/Features/Meeting/Settings/VoiceSampleRecorder+iOS.swift")
        #expect(recorderIOS.contains("confirmationDialog(ConclaveStrings.text(\"Discard Recording?\")"))
        let recorderKotlin = try Self.source("Sources/Conclave/Skip/ui/settings/VoiceSampleRecorder.kt")
        #expect(recorderKotlin.contains("BackHandler(enabled = midTake)"))
        #expect(recorderKotlin.contains("settings.discardVoiceSample()"))
    }

    static func make(_ state: SettingsFixtureState, defaults: UserDefaults = SET4VoicePagesTests.freshDefaults())
        -> (SettingsPresenter, SettingsRecordingCore) {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: defaults)
        presenter.sleep = { _ in }
        let core = SettingsRecordingCore()
        core.install(on: presenter)
        presenter.apply(state.inputs())
        return (presenter, core)
    }

    nonisolated static func freshDefaults() -> UserDefaults {
        let suite = "set4-voice-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite) ?? UserDefaults.standard
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    static func source(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }
}
#endif

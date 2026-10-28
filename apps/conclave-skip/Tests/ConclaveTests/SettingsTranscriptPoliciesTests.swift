#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SettingsTranscriptPoliciesTests {
    static let all = SettingsRowCapabilities.make(hostAlertSounds: true, hasAccountIdentity: true, isSignedIn: true)

    @Test func callScopeParticipantRowsFollowTheSectionOrder() throws {
        let sections = SettingsRowPolicy.sections(scope: .call, isAttendee: false, isHost: false, platform: .ios,
                                                  capabilities: SettingsRowCapabilities.make(hasAccountIdentity: true))
        #expect(sections.map { $0.section } == [.audio, .video, .captions, .chat, .general, .account, .about])
        try #require(sections.count == 7)
        #expect(sections[0].rows == [.output, .microphone, .noiseSuppression, .testSound])
        #expect(sections[1].rows == [.cameraFacing])
        #expect(sections[2].rows == [.captions])
        #expect(sections[3].rows == [.chatPreviews, .playVoiceMessages, .voiceMessages])
        #expect(sections[4].rows == [.connection, .alwaysShowControls, .haptics])
        #expect(sections[5].rows == [.name, .identity])
        #expect(sections[6].rows == [.privacy, .version])
    }

    @Test func hostsGetTheHostSectionWithSoundsOnlyWhenTheCapabilityExists() {
        let withSounds = SettingsRowPolicy.sections(scope: .call, isAttendee: false, isHost: true, platform: .ios, capabilities: Self.all)
        #expect(withSounds.first { $0.section == .host }?.rows == [.hostControls, .knockSound, .handSound])
        let withoutSounds = SettingsRowPolicy.sections(scope: .call, isAttendee: false, isHost: true, platform: .ios,
                                                       capabilities: SettingsRowCapabilities.make(isSignedIn: true))
        #expect(withoutSounds.first { $0.section == .host }?.rows == [.hostControls])
        #expect(withoutSounds.first { $0.section == .account }?.rows == [.name, .signOut])
        let guest = SettingsRowPolicy.sections(scope: .call, isAttendee: false, isHost: false, platform: .ios, capabilities: Self.all)
        #expect(!guest.contains { $0.section == .host })
    }

    @Test func appScopeNeverRendersInCallRows() {
        let rows = SettingsRowPolicy.rows(SettingsRowPolicy.sections(scope: .app, isAttendee: false, isHost: true, platform: .ios,
                                                                    capabilities: Self.all))
        for inCall in [SettingsRowID.output, .microphone, .testSound, .cameraFacing, .screenShareQuality, .effects, .connection,
                       .hostControls, .knockSound, .handSound, .name, .identity, .signOut] {
            #expect(!rows.contains(inCall), "\(inCall)")
        }
        #expect(rows == [.noiseSuppression, .captions, .chatPreviews, .playVoiceMessages, .voiceMessages, .alwaysShowControls,
                         .haptics, .privacy, .version])
    }

    @Test func appScopeAddsTheR704RowsOnlyWithTheirCapabilities() {
        let caps = SettingsRowCapabilities.make(dataSaver: true, messageNotifications: true, callNotificationStatus: true,
                                                linkVerification: true, exportDiagnostics: true)
        let android = SettingsRowPolicy.rows(SettingsRowPolicy.sections(scope: .app, isAttendee: false, isHost: false,
                                                                       platform: .android, capabilities: caps))
        #expect(android.contains(.dataSaver) && android.contains(.messageNotifications) && android.contains(.callNotification)
                && android.contains(.openLinks) && android.contains(.exportDiagnostics))
        #expect(!android.contains(.haptics) && android.contains(.captionStyle))
        let ios = SettingsRowPolicy.rows(SettingsRowPolicy.sections(scope: .app, isAttendee: false, isHost: false,
                                                                   platform: .ios, capabilities: caps))
        #expect(!ios.contains(.callNotification) && !ios.contains(.openLinks) && !ios.contains(.captionStyle))
        #expect(ios.contains(.haptics) && ios.contains(.messageNotifications))
        let none = SettingsRowPolicy.rows(SettingsRowPolicy.sections(scope: .app, isAttendee: false, isHost: false,
                                                                    platform: .android, capabilities: SettingsRowCapabilities.make()))
        #expect(!none.contains(.dataSaver) && !none.contains(.messageNotifications) && !none.contains(.exportDiagnostics))
    }

    @Test func attendeeScopeKeepsOnlyDataSaverGeneralAndAbout() {
        let caps = SettingsRowCapabilities.make(dataSaver: true, exportDiagnostics: true, hasAccountIdentity: true, isSignedIn: true)
        let ios = SettingsRowPolicy.sections(scope: .call, isAttendee: true, isHost: true, platform: .ios, capabilities: caps)
        #expect(ios.map { $0.section } == [.video, .general, .about])
        #expect(SettingsRowPolicy.rows(ios) == [.dataSaver, .haptics, .privacy, .exportDiagnostics, .version])
        let autoHides = SettingsRowCapabilities.make(attendeeChromeAutoHides: true)
        let android = SettingsRowPolicy.rows(SettingsRowPolicy.sections(scope: .call, isAttendee: true, isHost: false,
                                                                       platform: .android, capabilities: autoHides))
        #expect(android == [.alwaysShowControls, .privacy, .version])
    }

    @Test func routesMapDestinationsAndHostPages() {
        #expect(SettingsRoutePolicy.initialPath(destination: .settingsVoice) == [.voice])
        #expect(SettingsRoutePolicy.initialPath(destination: .settingsAudio).isEmpty)
        #expect(SettingsRoutePolicy.scrollsToAudio(destination: .settingsAudio))
        #expect(!SettingsRoutePolicy.scrollsToAudio(destination: .none))
        for page in PeopleRoute.allCases where page != .root {
            let route = SettingsRoutePolicy.hostRoute(page)
            #expect(SettingsRoutePolicy.peopleRoute(route) == page)
            #expect(SettingsRoutePolicy.hostRouteForPeopleRoute(rawValue: page.rawValue) == route)
        }
        #expect(SettingsRoutePolicy.hostRoute(.root) == .hostControls)
        #expect(SettingsRoutePolicy.peopleRoute(.voice) == nil)
        #expect(SettingsRoutePolicy.hostRouteForPeopleRoute(rawValue: "nope") == nil)
        #expect(SettingsRoutePolicy.pathAfterHostLoss([.voice, .hostControls, .hostInviteCode]) == [.voice])
        #expect(SettingsRoutePolicy.pathAfterHostLoss([.microphone]) == [.microphone])
        #expect(!SettingsRoutePolicy.isAvailable(.voiceRecord, canUsePersonalVoice: false))
        #expect(SettingsRoutePolicy.isAvailable(.voiceRecord, canUsePersonalVoice: true))
        #expect(SettingsRoutePolicy.isAvailable(.cameraQuality, canUsePersonalVoice: true))

        #expect(SettingsRoute.allCases.count == 18)
        #expect(SettingsRoute.hostCustomLink.rawValue == "hostCustomLink")
    }

    @Test func settingsStoresUseTheirKeysAndDefaults() {
        #expect(SettingsPreferences.noiseSuppressionKey == "conclave.pref.noiseSuppression")
        #expect(SettingsPreferences.alwaysShowControlsKey == "conclave.pref.alwaysShowControls")
        #expect(SettingsPreferences.hapticsKey == "conclave.pref.haptics")
        #expect(SettingsPreferences.knockSoundKey == "conclave.pref.knockSound")
        #expect(SettingsPreferences.handSoundKey == "conclave.pref.handSound")
        let defaults = Self.freshDefaults()
        #expect(SettingsPreferences.noiseSuppression(defaults: defaults))
        #expect(!SettingsPreferences.alwaysShowControls(defaults: defaults))
        #expect(SettingsPreferences.haptics(defaults: defaults))
        #expect(!SettingsPreferences.knockSound(defaults: defaults) && !SettingsPreferences.handSound(defaults: defaults))
    }

    @Test func aChangeInTheAppScopeReadsTheSameInTheNextCall() {
        let defaults = Self.freshDefaults()
        let app = SettingsPresenter(scope: .app, platform: .ios, defaults: defaults)
        app.setCaptions(true)
        app.setNoiseSuppression(false)
        app.setShowsChatPreviews(false)
        app.setAlwaysShowControls(true)
        let call = SettingsPresenter(scope: .call, platform: .ios, defaults: defaults)
        call.apply(SettingsFixtureState.guest.inputs())
        #expect(call.chat.captionsOn)
        #expect(!call.audio.noiseSuppressionOn)
        #expect(!call.chat.showsChatPreviews)
        #expect(call.general.alwaysShowControls)

        #expect(!app.dispatchedKinds.contains(SettingsCommandKind.setNoiseSuppression.rawValue))
    }

    @Test func preferenceWritesTellTheCoreWhichStoreChanged() {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        let core = SettingsRecordingCore()
        core.install(on: presenter)
        presenter.apply(SettingsFixtureState.host.inputs())
        presenter.setKnockSound(true)
        presenter.setKnockSound(true)
        presenter.setHandSound(true)
        presenter.setCaptions(true)
        #expect(core.calls == ["preferenceChanged", "preferenceChanged", "preferenceChanged"])
        #expect(presenter.general.knockSoundOn && presenter.general.handSoundOn && presenter.chat.captionsOn)
    }

    @Test func refreshPicksUpAStoreWrittenElsewhere() {
        let defaults = Self.freshDefaults()
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: defaults)
        let before = presenter.chat.revision
        CaptionsPreference.set(!presenter.chat.captionsOn, defaults: defaults)
        presenter.refreshPreferences()
        #expect(presenter.chat.revision == before + 1)
        presenter.refreshPreferences()
        #expect(presenter.chat.revision == before + 1)
    }

    @Test func snapshotsAreEqualityGuardedAndPerSection() {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        presenter.apply(SettingsFixtureState.guest.inputs())
        let audio = presenter.audio.revision, video = presenter.video.revision, account = presenter.account.revision
        presenter.apply(SettingsFixtureState.guest.inputs())
        #expect(presenter.audio.revision == audio && presenter.video.revision == video)

        let flipped = SettingsInputs.make(callSession: 1, roomId: "fixture-room", isJoined: true, isMuted: false, isFrontCamera: false,
                                          canFlipCamera: true, connection: .good, savedDisplayName: "Avery Lee", account: .guest,
                                          noiseSuppressionLive: true, hasCore: true)
        presenter.apply(flipped)
        #expect(presenter.video.revision == video + 1 && presenter.video.cameraFacing == "back")
        #expect(presenter.audio.revision == audio && presenter.account.revision == account)
    }

    @Test func recoveringDisablesHostControlsAndTheNameButNotMedia() {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        presenter.apply(SettingsFixtureState.recovering.inputs())
        #expect(presenter.general.isRecovering && presenter.general.hostReason == .reconnecting)
        #expect(!presenter.account.canEditName && presenter.account.nameReason == .reconnecting)
        #expect(presenter.audio.noiseSuppression == .available)
        #expect(presenter.video.canFlipCamera)
    }

    @Test func audioOnlyDisablesTheCameraWithItsReason() {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        presenter.apply(SettingsFixtureState.audioOnly.inputs())
        #expect(!presenter.video.canFlipCamera && presenter.video.flipReason == .audioOnly)
        #expect(presenter.setCameraFacing(front: false) == .ignored)
    }

    @Test func cameraFlipDispatchesOnlyAChange() {
        let presenter = SettingsPresenter(scope: .call, platform: .android, defaults: Self.freshDefaults())
        let core = SettingsRecordingCore()
        core.install(on: presenter)
        presenter.apply(SettingsFixtureState.guest.inputs())
        #expect(presenter.setCameraFacing(front: true) == .ignored)
        #expect(presenter.setCameraFacing(front: false) == .dispatched)
        #expect(core.calls == ["setCameraFacing"])
    }

    @Test func namePolicyStatusAndEditability() {
        #expect(SettingsNamePolicy.status(isSaving: true, refusal: "", draft: "A", saved: "B", hasEdited: true) == .saving)
        #expect(SettingsNamePolicy.status(isSaving: false, refusal: "renameRateLimited", draft: "A", saved: "B", hasEdited: true) == .failed)
        #expect(SettingsNamePolicy.status(isSaving: false, refusal: "", draft: " Avery  Lee ", saved: "Avery Lee", hasEdited: true) == .saved)
        #expect(SettingsNamePolicy.status(isSaving: false, refusal: "", draft: "Avery Lee", saved: "Avery Lee", hasEdited: false) == .idle)
        #expect(SettingsNamePolicy.canEdit(isJoined: true, isAttendee: false, isRecovering: false, isOffline: false, isRenameDisabled: false))
        #expect(!SettingsNamePolicy.canEdit(isJoined: true, isAttendee: false, isRecovering: false, isOffline: false, isRenameDisabled: true))
        #expect(!SettingsNamePolicy.canEdit(isJoined: true, isAttendee: true, isRecovering: false, isOffline: false, isRenameDisabled: false))
        #expect(!SettingsNamePolicy.canEdit(isJoined: false, isAttendee: false, isRecovering: false, isOffline: false, isRenameDisabled: false))
    }

    @Test func signOutIsSingleFlightWithTheGenerationAndRoomGuard() throws {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        var commands: [SettingsCommand] = []
        presenter.onCommand = { commands.append($0) }
        presenter.apply(SettingsFixtureState.host.inputs())
        presenter.signOut()
        presenter.signOut()
        #expect(commands.count == 1 && commands[0].kind == .signOut)
        try #require(commands.count == 1)
        #expect(presenter.account.signOutPending)

        presenter.signOutFinished(generation: commands[0].generation + 1)
        #expect(presenter.account.signOutPending)
        presenter.signOutFinished(generation: commands[0].generation)
        #expect(!presenter.account.signOutPending)
        #expect(SettingsSignOutCompletionPolicy.shouldApply(generation: 2, currentGeneration: 2, actionRoomId: "room-a", currentRoomId: "room-a"))
        #expect(!SettingsSignOutCompletionPolicy.shouldApply(generation: 2, currentGeneration: 2, actionRoomId: "room-a", currentRoomId: "room-b"))
        #expect(!SettingsSignOutCompletionPolicy.shouldApply(generation: 1, currentGeneration: 2, actionRoomId: "room-a", currentRoomId: "room-a"))
    }

    @Test func guestsAndTheAppScopeCannotSignOutHere() {
        let guest = SettingsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        var count = 0
        guest.onCommand = { if $0.kind == .signOut { count += 1 } }
        guest.apply(SettingsFixtureState.guest.inputs())
        guest.signOut()
        let app = SettingsPresenter(scope: .app, platform: .ios, defaults: Self.freshDefaults())
        app.onCommand = { if $0.kind == .signOut { count += 1 } }
        app.signOut()
        #expect(count == 0)
    }

    @Test func aNewCallSessionClearsAPendingSignOut() {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: Self.freshDefaults())
        presenter.onCommand = { _ in }
        presenter.apply(SettingsFixtureState.host.inputs(callSession: 1))
        presenter.signOut()
        presenter.apply(SettingsFixtureState.host.inputs(callSession: 2))
        #expect(!presenter.account.signOutPending)
    }

    @Test func everyIOSCopyKeyIsInTheCatalog() throws {
        let catalog = try Self.catalogKeys()
        let source = try Self.source("Sources/Conclave/Features/Meeting/Settings/SettingsCopy+iOS.swift")
        let keys = Self.catalogKeysUsed(in: source)
        #expect(keys.count > 60)
        for key in keys { #expect(catalog.contains(key), "missing catalog key: \(key)") }

        for reason in SettingsReason.allCases where reason != .none {
            #expect(source.contains("case ." + reason.rawValue) || source.contains(", ." + reason.rawValue), "\(reason)")
        }
    }

    @Test func everySettingsSourceKeyAndNameResolves() throws {
        let catalog = try Self.catalogKeys()
        let names = try Self.androidStringNames()
        for file in Self.iosFiles {
            for key in Self.catalogKeysUsed(in: try Self.source(file)) {
                #expect(catalog.contains(key), "\(file): missing catalog key \(key)")
            }
        }
        for file in Self.kotlinFiles {
            let text = try Self.source(file)
            for name in Self.matches(#""((?:set|sys)_[a-z0-9_]+)""#, in: text) {
                #expect(names.contains(name), "\(file): missing resource \(name)")
            }
        }
    }

    @Test func settingsSourcesFollowThePlatformRules() throws {
        for file in Self.iosFiles + Self.kotlinFiles + Self.sharedFiles {
            let text = try Self.source(file)
            #expect(!text.lowercased().contains("gradient"), "\(file)")
            #expect(!text.contains("\u{2014}") && !text.contains("\u{2013}"), "\(file)")
            #expect(!text.contains("Color(red:") && !text.contains("Color(0x"), "\(file)")
        }
        for file in Self.iosFiles {
            let text = try Self.source(file)
            #expect(text.hasPrefix("#if os(iOS) && !SKIP"), "\(file)")

            #expect(!text.contains(".onAppear") && !text.contains(".onDisappear"), "\(file)")
        }
        for file in Self.kotlinFiles {
            #expect(Self.matches(#"Text\(\s*""#, in: try Self.source(file)).isEmpty, "\(file) has a literal Text")
        }
        for file in Self.sharedFiles {
            let text = try Self.source(file)
            #expect(!text.contains("inout") && !text.contains("isLetter"), "\(file)")
            #expect(Self.matches(#"\.(?:compactMap|map)\([A-Za-z.]+\)"#, in: text).isEmpty, "\(file)")
            #expect(!text.contains("import SwiftUI") && !text.contains("import UIKit"), "\(file)")
        }
    }

    @Test func accountOffersAppScopeSettings() throws {
        let ios = try Self.source("Sources/Conclave/Features/Account/AccountView+iOS.swift")
        #expect(ios.contains("case privacy, settings, settingsVoice, settingsCameraQuality, settingsCameraAdvanced"))
        #expect(ios.contains("SettingsAppScopeList(settings: appSettings"))
        #expect(ios.contains("SettingsPresenter(scope: SettingsScope.app)"))
        #expect(!ios.contains("SETTINGS ROW SLOT"))
        let android = try Self.source("Sources/Conclave/Skip/ui/account/AccountScreen.kt")
        #expect(android.contains("onOpenSettings: (() -> Unit)? = null"))
        #expect(android.contains("\"account.settings\""))
        #expect(!android.contains("SETTINGS ROW SLOT"))
        let app = try Self.source("Sources/Conclave/Skip/ui/settings/SettingsPanel.kt")
        #expect(app.contains("internal fun AppSettingsScreen(onBack: () -> Unit"))
        #expect(app.contains("SettingsPresenter(scope = SettingsScope.app)"))
    }

    static let sharedFiles = [
        "Sources/Conclave/Features/Meeting/Settings/SettingsPresenter.swift",
        "Sources/Conclave/Features/Meeting/Settings/SettingsRoute.swift",
    ]
    static let iosFiles = [
        "Sources/Conclave/Features/Meeting/Settings/SettingsPanel+iOS.swift",
        "Sources/Conclave/Features/Meeting/Settings/SettingsRows+iOS.swift",
        "Sources/Conclave/Features/Meeting/Settings/SettingsCopy+iOS.swift",
        "Sources/Conclave/Features/Meeting/Settings/AudioPages+iOS.swift",
        "Sources/Conclave/Features/Meeting/Settings/VoicePages+iOS.swift",
        "Sources/Conclave/Features/Meeting/Settings/VoiceSampleRecorder+iOS.swift",
    ]
    static let kotlinFiles = [
        "Sources/Conclave/Skip/ui/settings/SettingsPanel.kt",
        "Sources/Conclave/Skip/ui/settings/SettingsNavHost.kt",
        "Sources/Conclave/Skip/ui/settings/SettingsRows.kt",
        "Sources/Conclave/Skip/ui/settings/AudioPages.kt",
        "Sources/Conclave/Skip/ui/settings/VoicePages.kt",
        "Sources/Conclave/Skip/ui/settings/VoiceSampleRecorder.kt",
        "Sources/Conclave/Skip/ui/copy/SettingsCopy.kt",
    ]

    static func freshDefaults() -> UserDefaults {
        let suite = "set1-settings-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite) ?? UserDefaults.standard
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    static func packageRoot() -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    static func source(_ path: String) throws -> String {
        try String(contentsOf: packageRoot().appendingPathComponent(path), encoding: .utf8)
    }

    static func catalogKeys() throws -> Set<String> {
        let data = try Data(contentsOf: packageRoot().appendingPathComponent("Sources/Conclave/Resources/Localizable.xcstrings"))
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let strings = json?["strings"] as? [String: Any] ?? [:]
        return Set(strings.keys)
    }

    static func androidStringNames() throws -> Set<String> {
        let text = try source("Android/app/src/main/res/values/strings.xml")
        return Set(matches(#"<(?:string|plurals) name="([a-z0-9_]+)""#, in: text))
    }

    static func catalogKeysUsed(in text: String) -> [String] {
        matches(#"ConclaveStrings\.(?:text|format)\("((?:[^"\\]|\\.)*)""#, in: text).map { unescape($0) }
    }

    static func unescape(_ raw: String) -> String {
        var result = ""
        var index = raw.startIndex
        while index < raw.endIndex {
            if raw[index] == "\\", raw[raw.index(after: index)...].hasPrefix("u{"),
               let close = raw[index...].firstIndex(of: "}") {
                let hexStart = raw.index(index, offsetBy: 3)
                if let scalar = UInt32(raw[hexStart..<close], radix: 16).flatMap({ Unicode.Scalar($0) }) {
                    result.unicodeScalars.append(scalar)
                    index = raw.index(after: close)
                    continue
                }
            }
            result.append(raw[index])
            index = raw.index(after: index)
        }
        return result
    }

    static func matches(_ pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { match in
            guard match.numberOfRanges > 1, let found = Range(match.range(at: 1), in: text) else { return nil }
            return String(text[found])
        }
    }
}
#endif

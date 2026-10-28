package conclave.module

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import skip.foundation.UserDefaults

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SettingsTranscriptBridgeTests {
    private fun freshDefaults(): UserDefaults {
        val prefs = RuntimeEnvironment.getApplication().getSharedPreferences("set1-" + System.nanoTime(), Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        return UserDefaults(platformValue = prefs)
    }

    private fun rows(scope: SettingsScope, attendee: Boolean, host: Boolean, platform: SettingsPlatform,
                     caps: SettingsRowCapabilities): List<SettingsRowID> =
        SettingsRowPolicy.rows(SettingsRowPolicy.sections(scope = scope, isAttendee = attendee, isHost = host, platform = platform,
            capabilities = caps)).toList()

    @Test
    fun rowSetsMatchTheSwiftVectors() {
        val caps = SettingsRowCapabilities.make(hostAlertSounds = true, hasAccountIdentity = true, isSignedIn = true)
        assertEquals(listOf(SettingsRowID.output, SettingsRowID.microphone, SettingsRowID.noiseSuppression, SettingsRowID.testSound,
            SettingsRowID.cameraFacing, SettingsRowID.captions, SettingsRowID.captionStyle, SettingsRowID.chatPreviews,
            SettingsRowID.playVoiceMessages, SettingsRowID.voiceMessages, SettingsRowID.hostControls, SettingsRowID.knockSound,
            SettingsRowID.handSound, SettingsRowID.connection, SettingsRowID.alwaysShowControls, SettingsRowID.name_,
            SettingsRowID.identity, SettingsRowID.signOut, SettingsRowID.privacy, SettingsRowID.version),
            rows(SettingsScope.call, attendee = false, host = true, platform = SettingsPlatform.android, caps = caps))
        assertEquals(listOf(SettingsRowID.noiseSuppression, SettingsRowID.captions, SettingsRowID.captionStyle, SettingsRowID.chatPreviews,
            SettingsRowID.playVoiceMessages, SettingsRowID.voiceMessages, SettingsRowID.alwaysShowControls, SettingsRowID.privacy,
            SettingsRowID.version),
            rows(SettingsScope.app, attendee = false, host = true, platform = SettingsPlatform.android, caps = caps))
        assertEquals(listOf(SettingsRowID.privacy, SettingsRowID.version),
            rows(SettingsScope.call, attendee = true, host = true, platform = SettingsPlatform.android, caps = caps))
        assertEquals(listOf(SettingsRowID.haptics, SettingsRowID.privacy, SettingsRowID.version),
            rows(SettingsScope.call, attendee = true, host = false, platform = SettingsPlatform.ios, caps = caps))
    }

    @Test
    fun routesMapDestinationsAndHostPages() {
        assertEquals(listOf(SettingsRoute.voice), SettingsRoutePolicy.initialPath(destination = PanelDestination.settingsVoice).toList())
        assertTrue(SettingsRoutePolicy.initialPath(destination = PanelDestination.none).isEmpty)
        assertTrue(SettingsRoutePolicy.scrollsToAudio(destination = PanelDestination.settingsAudio))
        assertEquals(SettingsRoute.hostInviteCode, SettingsRoutePolicy.hostRouteForPeopleRoute(rawValue = "inviteCode"))
        assertEquals(PeopleRoute.notice, SettingsRoutePolicy.peopleRoute(SettingsRoute.hostNotice))
        assertNull(SettingsRoutePolicy.peopleRoute(SettingsRoute.voice))
        assertEquals(SettingsRoute.root, settingsRouteForKey(null))
        assertEquals(SettingsRoute.microphone, settingsRouteForKey("microphone"))
        assertEquals(SettingsRoute.root, settingsRouteForKey("unknown"))
    }

    @Test
    fun storesUseTheSameKeysAndDefaultsAndBothScopesShareThem() {
        assertEquals("conclave.pref.noiseSuppression", SettingsPreferences.noiseSuppressionKey)
        assertEquals("conclave.pref.alwaysShowControls", SettingsPreferences.alwaysShowControlsKey)
        assertEquals("conclave.pref.knockSound", SettingsPreferences.knockSoundKey)
        val defaults = freshDefaults()
        assertTrue(SettingsPreferences.noiseSuppression(defaults = defaults))
        assertFalse(SettingsPreferences.alwaysShowControls(defaults = defaults))
        val app = SettingsPresenter(scope = SettingsScope.app, platform = SettingsPlatform.android, defaults = defaults)
        app.setNoiseSuppression(false)
        app.setAlwaysShowControls(true)
        app.setShowsChatPreviews(false)
        val call = SettingsPresenter(scope = SettingsScope.call, platform = SettingsPlatform.android, defaults = defaults)
        call.apply(SettingsFixtureState.guest.inputs(callSession = 1))
        assertFalse(call.audio.noiseSuppressionOn)
        assertTrue(call.general.alwaysShowControls)
        assertFalse(call.chat.showsChatPreviews)
    }

    @Test
    fun speakerTestCountsOncePerTapAndCameraFlipDispatchesAChange() {
        val presenter = SettingsPresenter(scope = SettingsScope.call, platform = SettingsPlatform.android, defaults = freshDefaults())
        val core = SettingsRecordingCore()
        core.install(on = presenter)
        presenter.apply(SettingsFixtureState.guest.inputs(callSession = 1))
        assertEquals(ControlTapResult.dispatched, presenter.playTestSound())
        assertEquals(ControlTapResult.ignored, presenter.playTestSound())
        assertEquals(1, presenter.speakerTestCount)
        assertEquals(ControlTapResult.ignored, presenter.setCameraFacing(front = true))
        assertEquals(ControlTapResult.dispatched, presenter.setCameraFacing(front = false))
        assertEquals(listOf("testTone", "setCameraFacing"), core.calls.toList())
    }

    @Test
    fun micTestSubscribesOnceAndStopsOnce() {
        val presenter = SettingsPresenter(scope = SettingsScope.call, platform = SettingsPlatform.android, defaults = freshDefaults())
        val core = SettingsRecordingCore()
        core.install(on = presenter)
        presenter.apply(SettingsFixtureState.mic.inputs(callSession = 1))
        presenter.startMicTest()
        presenter.startMicTest()
        presenter.stopMicTest()
        presenter.stopMicTest()
        assertEquals(1, core.count("micTestSubscribe"))
        assertEquals(1, core.count("micTestStop"))
        assertEquals(MicTestPhase.idle, presenter.audio.micPhase)
    }

    @Test
    fun levelAndTonePoliciesMatchSwift() {
        assertEquals(0, MicLevelPolicy.filledSegments(level = 0.0))
        assertEquals(6, MicLevelPolicy.filledSegments(level = 0.25))
        assertEquals(12, MicLevelPolicy.filledSegments(level = 4.0))
        assertEquals(8000, TestTonePolicy.sampleCount)
        assertEquals(0.0, TestTonePolicy.sample(0), 0.0)
        var peak = 0.0
        for (index in 0 until TestTonePolicy.sampleCount) peak = maxOf(peak, Math.abs(TestTonePolicy.sample(index)))
        assertTrue(peak <= TestTonePolicy.amplitude + 0.0001)
    }

    @Test
    fun voiceOptionsKeepTheCurrentLanguageInOneOrder() {
        val voices = skip.lib.Array(listOf(
            VoiceOptionModel(id = "en-gb-x-rjs", name = "Serena", languageTag = "en-GB"),
            VoiceOptionModel(id = "fr-fr-x-vlf", name = "Amelie", languageTag = "fr_FR"),
            VoiceOptionModel(id = "en-au-x-a", name = "Samantha", languageTag = "EN_au"),
            VoiceOptionModel(id = "en-gb-x-rjs", name = "Serena", languageTag = "en-GB"),
        ))
        assertEquals(listOf("en-au-x-a", "en-gb-x-rjs"), VoicePreviewPolicy.options(voices, languageTag = "en-US").toList().map { it.id })
        assertTrue(VoicePreviewPolicy.isPreviewPlaying(activeMessageId = VoicePreviewPolicy.messageId))
    }

    @Test
    fun personalVoiceStaysHiddenWithoutTheCapability() {
        val presenter = SettingsPresenter(scope = SettingsScope.call, platform = SettingsPlatform.android, defaults = freshDefaults())
        presenter.apply(SettingsFixtureState.voiceUnavailable.inputs(callSession = 1))
        assertFalse(presenter.chat.canUsePersonalVoice)
        assertEquals(PersonalVoicePhase.unavailable, presenter.chat.personalVoice)
        assertEquals(SettingsReason.notInAppYet, presenter.chat.personalVoiceReason)
        presenter.startVoiceSample()
        assertEquals(0, presenter.voiceSampleCount)
    }

    @Test
    fun copyMapsEveryCaseToAResourceName() {
        val prefixes = listOf("set_", "sys_", "stg_", "ds_", "hst_")
        fun valid(name: String?) = name != null && prefixes.any { name.startsWith(it) }
        for (section in SettingsSection.allCases) assertTrue(valid(SettingsCopy.sectionName(section)))
        for (row in SettingsRowID.allCases) assertTrue(row.rawValue, valid(SettingsCopy.rowName(row)))
        for (route in SettingsRoute.allCases) assertTrue(route.rawValue, valid(SettingsCopy.pageTitleName(route)))
        for (reason in SettingsReason.allCases) {
            val name = SettingsCopy.reasonName(reason)
            if (reason == SettingsReason.none) assertNull(name) else assertTrue(reason.rawValue, valid(name))
        }
        for (kind in VoiceKind.allCases) assertTrue(valid(SettingsCopy.voiceKindName(kind)))
        for (label in ConnectionQualityLabel.allCases) assertTrue(valid(SettingsCopy.connectionName(label)))
        assertNull(SettingsCopy.micPhaseName(MicTestPhase.metering))
        assertEquals("set_mic_starting", SettingsCopy.micPhaseName(MicTestPhase.starting))
        assertEquals("set_saving", SettingsCopy.nameStatusName(NameSavePhase.saving))
        assertNull(SettingsCopy.nameStatusName(NameSavePhase.failed))
        assertEquals("set_signed_in_google", SettingsCopy.providerName("google"))
        assertNull(SettingsCopy.providerName("email"))
    }

    @Test
    fun listItemsCarryHeadersRowsAndTheHostSoundsFooter() {
        val sections = SettingsRowPolicy.sections(scope = SettingsScope.call, isAttendee = false, isHost = true,
            platform = SettingsPlatform.android, capabilities = SettingsRowCapabilities.make(hostAlertSounds = true)).toList()
        val items = settingsListItems(sections)
        assertEquals("h:audio", items.first().key)
        assertTrue(items.any { it.key == "f:host" })
        assertEquals(items.size, items.map { it.key }.toSet().size)
    }
}

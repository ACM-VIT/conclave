package conclave.module

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import skip.foundation.UserDefaults

/**
 * SET-3 through the transpiled SettingsPresenter (video rows, presets as encoder ceilings, Data Saver, the preview on
 * the fake WP3 owner), NativeQualityOptions, DataSaverPolicy, LocalVideoMirrorPolicy, SettingsPreviewPolicy and
 * ConnectionStatsPolicy, plus the handwritten SettingsCopy SET-3 mappings and settingsListItems (the preview card item
 * before the Camera row). The Swift half is T/SET3VideoConnectionTests.swift; the same vectors give the same results
 * on both platforms. Pure: no composition, no camera, no transport.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SET3VideoBridgeTests {
    private fun freshDefaults(): UserDefaults {
        val prefs = RuntimeEnvironment.getApplication().getSharedPreferences("set3-" + System.nanoTime(), Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        return UserDefaults(platformValue = prefs)
    }

    private fun make(state: SettingsFixtureState, defaults: UserDefaults = freshDefaults()): Pair<SettingsPresenter, SettingsRecordingCore> {
        val presenter = SettingsPresenter(scope = SettingsScope.call, platform = SettingsPlatform.android, defaults = defaults)
        val core = SettingsRecordingCore()
        core.install(on = presenter)
        presenter.apply(state.inputs(callSession = 1))
        return Pair(presenter, core)
    }

    private fun videoRows(presenter: SettingsPresenter): List<SettingsRowID> =
        presenter.sections.toList().firstOrNull { it.section == SettingsSection.video }?.rows?.toList() ?: emptyList()

    @Test
    fun videoRowsMatchTheSwiftVectors() {
        val (call, _) = make(SettingsFixtureState.video)
        assertEquals(listOf(SettingsRowID.cameraFacing, SettingsRowID.mirror, SettingsRowID.cameraQuality,
            SettingsRowID.screenShareQuality, SettingsRowID.dataSaver), videoRows(call))
        val (attendee, _) = make(SettingsFixtureState.attendee)
        assertEquals(listOf(SettingsRowID.dataSaver), videoRows(attendee))
        val app = SettingsPresenter(scope = SettingsScope.app, platform = SettingsPlatform.android, defaults = freshDefaults())
        assertEquals(listOf(SettingsRowID.mirror, SettingsRowID.cameraQuality, SettingsRowID.dataSaver), videoRows(app))
    }

    @Test
    fun listItemsPutThePreviewCardBeforeTheCameraRow() {
        val (call, _) = make(SettingsFixtureState.video)
        val keys = settingsListItems(call.sections.toList()).map { it.key }
        val card = keys.indexOf("c:preview")
        assertTrue(card >= 0)
        assertEquals("r:cameraFacing", keys[card + 1])
        assertTrue(keys.contains("f:video"))
        assertEquals(keys.size, keys.toSet().size)
    }

    @Test
    fun presetsPersistAndRecordOneCeilingWithItsValue() {
        val defaults = freshDefaults()
        val (presenter, core) = make(SettingsFixtureState.video, defaults)
        assertEquals(listOf("auto", "high-definition", "studio", "custom"), presenter.video.presets.toList())
        assertEquals(ControlTapResult.dispatched, presenter.setCameraPreset("high-definition"))
        assertEquals(ControlTapResult.ignored, presenter.setCameraPreset("high-definition"))
        assertEquals(1, core.count("setPublishCeiling"))
        val ceiling = core.lastPublishCeiling
        assertNotNull(ceiling)
        assertEquals(1080, ceiling?.height)
        assertEquals(3_000_000, ceiling?.maxBitrateBps)
        assertEquals(NativeCameraQualityPreset.highDefinition, NativeMediaQualityPreferences.load(defaults = defaults).camera.preset)
        assertEquals(ControlTapResult.ignored, presenter.setCameraPreset("data-saver"))
    }

    @Test
    fun dataSaverAppliesTheCeilingAndTheSystemSignalHoldsIt() {
        val (presenter, core) = make(SettingsFixtureState.video)
        presenter.setDataSaver(true)
        assertTrue(presenter.video.dataSaverOn)
        assertEquals("data-saver", presenter.video.effectiveCameraPreset)
        assertEquals(360, core.lastPublishCeiling?.height)
        assertEquals(ControlTapResult.ignored, presenter.setCameraPreset("studio"))
        val (system, systemCore) = make(SettingsFixtureState.systemDataSaver)
        assertTrue(system.video.dataSaverOn && system.video.systemDataSaverOn)
        system.setDataSaver(false)
        assertTrue(system.video.dataSaverOn)
        assertEquals(0, systemCore.count("preferenceChanged"))
    }

    @Test
    fun theHostLimitMapsToTheCeiling() {
        val (presenter, _) = make(SettingsFixtureState.hostQualityCap)
        assertTrue(presenter.video.qualityCappedByHost)
        assertEquals("data-saver", presenter.video.effectiveCameraPreset)
        assertEquals(360, presenter.publishCeiling().height)
    }

    @Test
    fun previewIsLocalOnlyAndStopsOnceOnClose() {
        val (presenter, core) = make(SettingsFixtureState.video)
        presenter.panelDidOpen()
        assertTrue(presenter.video.canStartPreview)
        presenter.startPreview()
        assertEquals(PreviewState.live, presenter.video.preview)
        assertEquals(1, core.count("previewStart"))
        assertEquals(0, core.count("producerCreate"))
        core.scriptPreview(state = PreviewState.interrupted, interruption = PreviewInterruption.inUseByAnotherClient)
        assertEquals(PreviewState.interrupted, presenter.video.preview)
        assertEquals(SettingsReason.cameraInUse, presenter.video.previewReason)
        assertFalse(presenter.video.canStartPreview)
        presenter.panelDidClose()
        presenter.panelDidClose()
        assertEquals(1, core.count("previewStop"))
        assertEquals(PreviewState.off, presenter.video.preview)
    }

    @Test
    fun cameraOnShowsTheSentTrackAndOffersNoPreview() {
        val (presenter, core) = make(SettingsFixtureState.cameraOn)
        presenter.panelDidOpen()
        assertEquals(PreviewState.published, presenter.video.preview)
        presenter.startPreview()
        assertEquals(0, core.count("previewStart"))
    }

    @Test
    fun policiesMatchSwift() {
        assertTrue(LocalVideoMirrorPolicy.mirrors(isFront = true, preference = true))
        assertFalse(LocalVideoMirrorPolicy.mirrors(isFront = false, preference = true))
        assertFalse(LocalVideoMirrorPolicy.mirrorsSentStream)
        assertTrue(DataSaverPolicy.isOn(preference = false, systemDataSaver = true))
        assertTrue(DataSaverPolicy.reducesReceive(isLowQuality = false, dataSaverOn = true))
        assertEquals(listOf(NativeCameraQualityPreset.auto, NativeCameraQualityPreset.custom),
            NativeQualityOptions.cameraPresets(capability = CameraCaptureCapability(maxHeight = 720, maxFrameRate = 30)).toList())
        assertEquals(1_250, NativeQualityOptions.snappedBitrate(1_274, minimum = 150, maximum = 6_000, step = 50))
        assertTrue(SettingsPreviewPolicy.canStart(state = PreviewState.unavailable, isParticipantInCall = true, isAudioOnly = false))
        assertFalse(SettingsPreviewPolicy.canStart(state = PreviewState.interrupted, isParticipantInCall = true, isAudioOnly = false))
        assertEquals(SettingsReason.cameraMultitasking, SettingsPreviewPolicy.reason(state = PreviewState.interrupted,
            interruption = PreviewInterruption.multipleForegroundApps, isAudioOnly = false))
    }

    @Test
    fun statsPolicyWindowsRatesAndLoss() {
        val first = ConnectionStatsCounters(timestampMillis = 1000.0, rttMillis = 40.0, jitterMillis = 5.0, packetsLost = 0.0,
            packetsReceived = 100.0, remoteLossFraction = null, videoBytesSent = null, audioBytesSent = null, bytesSent = 10_000.0,
            bytesReceived = null, videoCodec = "")
        val second = ConnectionStatsCounters(timestampMillis = 2000.0, rttMillis = 84.6, jitterMillis = 12.4, packetsLost = 5.0,
            packetsReceived = 195.0, remoteLossFraction = 0.01, videoBytesSent = 125_000.0, audioBytesSent = 4_000.0,
            bytesSent = 135_000.0, bytesReceived = 250_000.0, videoCodec = "VP8")
        val values = ConnectionStatsPolicy.values(current = second, previous = first)
        assertEquals(85, values.latencyMillis)
        assertEquals(1_000, values.uploadKbps)
        assertEquals("VP8", values.videoCodec)
        assertNull(ConnectionStatsPolicy.values(current = first, previous = null).uploadKbps)
        assertEquals("H264", ConnectionStatsPolicy.codecName(mimeType = "video/H264"))
    }

    @Test
    fun statsModelNeverPollsWhileUnsubscribed() {
        val model = ConnectionStatsModel()
        assertEquals(0, model.pollCount)
        assertFalse(model.isSubscribed)
        model.setFrozen(true)
        assertTrue(model.isFrozen)
    }

    @Test
    fun set3CopyMapsEveryCaseToAResourceName() {
        val prefixes = listOf("set_", "stg_", "ds_")
        fun valid(name: String?) = name != null && prefixes.any { name.startsWith(it) }
        for (preset in NativeCameraQualityPreset.allCases) {
            assertTrue(preset.rawValue, valid(SettingsCopy.cameraPresetName(preset.rawValue)))
            assertTrue(preset.rawValue, valid(SettingsCopy.cameraPresetDetailName(preset.rawValue)))
        }
        for (preset in NativeScreenShareQualityPreset.allCases) {
            assertTrue(valid(SettingsCopy.screenSharePresetName(preset.rawValue)))
            assertTrue(valid(SettingsCopy.screenSharePresetDetailName(preset.rawValue)))
        }
        for (resolution in NativeMediaResolution.allCases) assertTrue(valid(SettingsCopy.resolutionName(resolution.rawValue)))
        for (hint in NativeCameraContentHint.allCases) assertTrue(valid(SettingsCopy.cameraOptimizeName(hint.rawValue)))
        for (hint in NativeScreenShareContentHint.allCases) assertTrue(valid(SettingsCopy.screenShareOptimizeName(hint.rawValue)))
        for (preference in NativeMediaDegradationPreference.allCases) {
            assertTrue(valid(SettingsCopy.underPressureName(preference.rawValue, isScreenShare = false)))
            assertTrue(valid(SettingsCopy.underPressureName(preference.rawValue, isScreenShare = true)))
        }
        for (label in ConnectionQualityLabel.allCases) assertTrue(valid(SettingsCopy.connectionSummaryName(label)))
        assertEquals("set_visible_everyone", SettingsCopy.previewStatusName(PreviewState.published))
        assertEquals("set_only_you", SettingsCopy.previewStatusName(PreviewState.live))
        assertNull(SettingsCopy.previewStatusName(PreviewState.off))
        assertEquals("set_camera_access_off", SettingsCopy.previewReasonName(SettingsReason.permissionDenied))
        assertEquals("set_quality_data_saver", SettingsCopy.cameraQualityFooterName(dataSaverOn = true, qualityCappedByHost = true))
        assertEquals("set_keep_text", SettingsCopy.underPressureName("maintain-resolution", isScreenShare = true))
        assertEquals("set_keep_sharp", SettingsCopy.underPressureName("maintain-resolution", isScreenShare = false))
    }
}

package conclave.module

import android.app.Notification
import androidx.core.app.NotificationCompat
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import android.os.Looper
import java.util.concurrent.TimeUnit

/**
 * SYS-10 (S70 10 d, l2, l3, l6; SY20, SY23) against the transpiled ScreenShareStartPolicy and the handwritten
 * ScreenCaptureManager, ScreenCaptureService and PipManager: the Android failure reasons (cancel silent, a refused
 * foreground service toasts once), the fallback notification's resource names, category and visibility, the PiP
 * suppression held across the consent dialog, and the device audio capability. App-module names resolve to 0 in this
 * library-module run, so a recording resolver stands in; resolved resources are a silent AVD cell. Not run in the
 * heads-down push.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SYS10ScreenShareBridgeTests {
    private class RecordingResolver : ConclaveResourceResolver {
        val strings = mutableListOf<String>()
        val drawables = mutableListOf<String>()
        val colors = mutableListOf<String>()
        private val english = mapOf(
            "sys_channel_share" to "Screen sharing",
            "sys_channel_share_desc" to "Shows while you’re sharing your screen.",
            "sys_share_notif_title" to "Sharing your screen",
            "sys_call_stop_sharing" to "Stop sharing",
        )

        override fun string(name: String): String {
            strings += name
            return english[name] ?: "[$name]"
        }

        override fun drawable(name: String): Int {
            drawables += name
            return 0
        }

        override fun color(name: String): Int? {
            colors += name
            return null
        }
    }

    @After
    fun releaseHold() {
        PipManager.restoreAutoEnterAfterExternalActivity()
    }

    // MARK: S70 10 l2: failures

    @Test
    fun consentCancelIsSilentAndARefusedServiceToastsOnce() {
        val cancelled = ScreenShareFailurePolicy.androidFailure(
            blockedByPolicy = false, launchFailed = false, consentGranted = false, serviceRefused = false,
        )
        assertEquals(ScreenShareFailure.cancelled, cancelled)
        assertFalse(ScreenShareFailurePolicy.showsToast(cancelled))

        ScreenCaptureManager.onServiceForegroundFailed()
        assertEquals(ScreenShareFailure.serviceRefused, ScreenCaptureManager.lastStartFailure())
        assertTrue(ScreenShareFailurePolicy.showsToast(ScreenCaptureManager.lastStartFailure()))
        assertFalse(ScreenCaptureManager.isCaptureActive())

        val notice = ScreenShareFailurePolicy.notice(ScreenShareFailure.serviceRefused)
        assertEquals(NoticeKind.shareFailed, notice.kind)
        assertEquals("sys_share_failed", ScreenShareFailurePolicy.androidResourceName(detail = notice.detail))
        assertEquals("sys_err_screen_denied", ScreenShareFailurePolicy.androidResourceName(detail = "deniedBySystem"))
    }

    // MARK: S70 10 d, e, g: the fallback notification

    @Test
    fun fallbackNotificationAsksForTheSentenceCaseResourcesAndIsAPublicServiceNotification() {
        val context = RuntimeEnvironment.getApplication()
        val resolver = RecordingResolver()
        val notification = ScreenShareNotification.build(context, resolver)
        assertEquals(listOf("sys_share_notif_title", "sys_call_stop_sharing"), resolver.strings)
        assertEquals(listOf("conclave_ic_stat", "conclave_cancel_presentation_fill1"), resolver.drawables)
        assertEquals(listOf("sys_notification_accent"), resolver.colors)
        assertEquals(NotificationCompat.CATEGORY_SERVICE, notification.category)
        assertEquals(Notification.VISIBILITY_PUBLIC, notification.visibility)
        assertEquals("Sharing your screen", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(1, notification.actions.size)
        assertEquals("Stop sharing", notification.actions[0].title.toString())
        assertTrue((notification.flags and Notification.FLAG_ONGOING_EVENT) != 0)
        assertEquals(ScreenShareNotificationPolicy.channelId, NotificationCompat.getChannelId(notification))
    }

    // MARK: S70 10 l3, S30 CC15: the consent suppression

    @Test
    fun consentRecordsOneSuppressionAndHoldsItPastTheHandOffWindowUntilTheResult() {
        val before = PipController.suppressionCount
        PipManager.suppressForExternalHandoff(ExternalHandoffKind.mediaProjectionConsent)
        assertEquals(before + 1, PipController.suppressionCount)
        assertEquals("media_projection", PipController.lastSuppressionReason)
        assertTrue(PipManager.isHoldingConsentSuppression)
        // The 2 s hand-off window passes with the dialog still up: the hold stays and the leave hint is consumed.
        shadowOf(Looper.getMainLooper()).idleFor(3, TimeUnit.SECONDS)
        assertTrue(PipManager.isHoldingConsentSuppression)
        assertTrue(PipManager.consumeAutoEnterSuppression())
        assertTrue(PipManager.isHoldingConsentSuppression)
        // The consent result returns: restored, no second suppression recorded.
        PipManager.restoreAutoEnterAfterExternalActivity()
        assertFalse(PipManager.isHoldingConsentSuppression)
        assertFalse(PipManager.consumeAutoEnterSuppression())
        assertEquals(before + 1, PipController.suppressionCount)
        // Other hand-offs keep the 2 s window (no hold).
        PipManager.suppressForExternalHandoff(ExternalHandoffKind.meetingShare)
        assertFalse(PipManager.isHoldingConsentSuppression)
    }

    @Test
    fun theConsentHoldEndsAtItsCapIfNoResultArrives() {
        PipManager.suppressForExternalHandoff(ExternalHandoffKind.mediaProjectionConsent)
        assertTrue(PipManager.isHoldingConsentSuppression)
        shadowOf(Looper.getMainLooper()).idleFor(ScreenSharePipPolicy.consentHoldCapMs.toLong() + 1_000L, TimeUnit.MILLISECONDS)
        assertFalse(PipManager.isHoldingConsentSuppression)
    }

    // MARK: S70 10 l6, SY23: device audio

    @Test
    fun deviceAudioCapabilityStaysOffUntilThePublishPathShips() {
        assertFalse(ScreenCaptureManager.canShareDeviceAudio())
        assertFalse(ScreenShareCapabilityPolicy.canShareDeviceAudio(platform = ScreenSharePlatform.android, apiLevel = 28, publishPathShips = true))
        assertTrue(ScreenShareCapabilityPolicy.canShareDeviceAudio(platform = ScreenSharePlatform.android, apiLevel = 29, publishPathShips = true))
        assertFalse(ScreenShareCapabilityPolicy.attachesDeviceAudio(canShareDeviceAudio = true, preferenceOn = false))
        val usages = ScreenShareCapabilityPolicy.playbackCaptureUsages.toList()
        assertEquals(listOf(android.media.AudioAttributes.USAGE_MEDIA, android.media.AudioAttributes.USAGE_GAME,
            android.media.AudioAttributes.USAGE_UNKNOWN), usages)
        assertFalse(usages.contains(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION))
        assertEquals(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION, ScreenShareCapabilityPolicy.excludedVoiceCommunicationUsage)
    }
}

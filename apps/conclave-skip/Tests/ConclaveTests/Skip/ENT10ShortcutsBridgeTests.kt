package conclave.module

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ENT10ShortcutsBridgeTests {
    private val context: Context get() = RuntimeEnvironment.getApplication()

    @After
    fun detach() {
        ShortcutIntake.shared.attach(null)
    }

    private fun dynamic(): Map<String, ShortcutInfoCompat> =
        ShortcutManagerCompat.getDynamicShortcuts(context).associateBy { it.id }

    @Test
    fun recentsBecomeDynamicShortcutsAndStaleOnesAreRemoved() {
        val other = ShortcutInfoCompat.Builder(context, "other")
            .setShortLabel("Other")
            .setIntent(Intent(Intent.ACTION_VIEW).setClassName(context.packageName, ConclaveShortcutActions.ACTIVITY_CLASS))
            .build()
        ShortcutManagerCompat.pushDynamicShortcut(context, other)

        RecentShortcuts.publish(context, listOf(RecentShortcutEntry("a", "Rose Sora Luffy"), RecentShortcutEntry("b", "Maple Goku Tulip")))
        val first = dynamic()
        assertEquals(setOf("other", "recent_a", "recent_b"), first.keys)
        val a = first.getValue("recent_a")
        assertEquals("Rose Sora Luffy", a.shortLabel.toString())
        assertEquals(ConclaveShortcutActions.OPEN_RECENT, a.intent.action)
        assertEquals("a", a.intent.getStringExtra(ConclaveShortcutActions.EXTRA_PAYLOAD))

        RecentShortcuts.publish(context, listOf(RecentShortcutEntry("b", "Maple Goku Tulip")))
        assertEquals(setOf("other", "recent_b"), dynamic().keys)

        RecentShortcuts.publish(context, emptyList())
        assertEquals(setOf("other"), dynamic().keys)
    }

    @Test
    fun aLauncherShortcutIntentReachesThePresenterThroughTheTranspiledIntake() {
        val presenter = PremeetingPresenter()
        ShortcutIntake.shared.attach(presenter)

        assertFalse(handleConclaveShortcutIntent(context, Intent(Intent.ACTION_VIEW)))
        assertEquals(0, presenter.path.count)

        assertTrue(handleConclaveShortcutIntent(context, Intent(ConclaveShortcutActions.JOIN_WITH_CODE)))
        assertTrue(presenter.isJoinSheetPresented)
        presenter.dismissJoinSheet()
        presenter.joinSheetDidDismiss()

        assertTrue(handleConclaveShortcutIntent(context, Intent(ConclaveShortcutActions.NEW_MEETING)))
        assertEquals(1, presenter.path.count)
        val target = presenter.target(forRoute = presenter.path[0].id)
        assertEquals(LobbyIntent.newMeeting, target?.intent)
    }

    @Test
    fun aShortcutOnTheOutcomeScreenReplacesTheOutcomeInTheAndroidBackStack() {
        val presenter = PremeetingPresenter()
        ShortcutIntake.shared.attach(presenter)
        presenter.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.inCall, roomLabel = "maple-goku-tulip",
            hasBeenAdmittedThisSession = true, currentRoomId = "maple-goku-tulip"))
        presenter.apply(PremeetingInputs.make(callSession = 1, phase = MeetingPhaseKind.outcome, outcomeId = 9,
            outcomeKind = MeetingTerminalOutcomeKind.removed, hasBeenAdmittedThisSession = true))
        assertEquals(listOf(PremeetingKey.HomeKey, PremeetingKey.OutcomeKey(9)),
            PremeetingBackStack.from(presenter.path.toList(), presenter.outcome))

        assertTrue(handleConclaveShortcutIntent(context, Intent(ConclaveShortcutActions.NEW_MEETING)))
        val keys = PremeetingBackStack.from(presenter.path.toList(), presenter.outcome)
        assertEquals(2, keys.size)
        assertTrue(keys.last() is PremeetingKey.LobbyKey)
    }
}

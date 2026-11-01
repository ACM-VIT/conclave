package conclave.module

import android.content.Context
import android.content.Intent
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.KeyboardShortcutInfo
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat

internal object ConclaveShortcutActions {
    const val NEW_MEETING = "com.acmvit.conclave.action.NEW_MEETING"
    const val JOIN_WITH_CODE = "com.acmvit.conclave.action.JOIN_WITH_CODE"
    const val OPEN_RECENT = "com.acmvit.conclave.action.OPEN_RECENT"
    const val EXTRA_PAYLOAD = "com.acmvit.conclave.extra.SHORTCUT_PAYLOAD"
    const val ACTIVITY_CLASS = "conclave.module.MainActivity"

    fun shortcutType(action: String?): String? = when (action) {
        NEW_MEETING -> ConclaveShortcut.newMeeting.rawValue
        JOIN_WITH_CODE -> ConclaveShortcut.joinCode.rawValue
        OPEN_RECENT -> ConclaveShortcut.recent.rawValue
        else -> null
    }

    fun shortcutId(type: String, payload: String): String? = when (type) {
        ConclaveShortcut.newMeeting.rawValue, ConclaveShortcut.joinCode.rawValue -> type
        ConclaveShortcut.recent.rawValue -> if (payload.isEmpty()) null else RecentShortcuts.ID_PREFIX + payload
        else -> null
    }

    fun homeShortcutType(keyCode: Int, ctrl: Boolean, shift: Boolean, alt: Boolean): String? {
        if (!ctrl || shift || alt) return null
        return when (keyCode) {
            KeyEvent.KEYCODE_N -> ConclaveShortcut.newMeeting.rawValue
            KeyEvent.KEYCODE_J -> ConclaveShortcut.joinCode.rawValue
            else -> null
        }
    }

    fun reportUsed(context: Context, type: String, payload: String) {
        val id = shortcutId(type, payload) ?: return
        try {
            ShortcutManagerCompat.reportShortcutUsed(context, id)
        } catch (_: Throwable) {
        }
    }
}

internal data class RecentShortcutEntry(val recentId: String, val label: String)

internal object RecentShortcuts {
    const val ID_PREFIX = "recent_"
    const val MAX_RECENTS = 3

    fun entries(home: HomeSnapshot): List<RecentShortcutEntry> {
        val out = ArrayList<RecentShortcutEntry>()
        for (row in home.recents) {
            if (out.size >= MAX_RECENTS) break
            out.add(RecentShortcutEntry(row.id, EntryPolicies.roomLabel(row.title)))
        }
        return out
    }

    fun publish(context: Context, entries: List<RecentShortcutEntry>) {
        val wanted = entries.take(MAX_RECENTS)
        val wantedIds = wanted.map { ID_PREFIX + it.recentId }.toSet()
        try {
            val stale = ShortcutManagerCompat.getDynamicShortcuts(context)
                .map { it.id }
                .filter { it.startsWith(ID_PREFIX) && it !in wantedIds }
            if (stale.isNotEmpty()) ShortcutManagerCompat.removeDynamicShortcuts(context, stale)
            val iconId = context.resources.getIdentifier("ic_shortcut_recent", "drawable", context.packageName)
            for ((rank, entry) in wanted.withIndex()) {
                val intent = Intent(ConclaveShortcutActions.OPEN_RECENT)
                    .setClassName(context.packageName, ConclaveShortcutActions.ACTIVITY_CLASS)
                    .putExtra(ConclaveShortcutActions.EXTRA_PAYLOAD, entry.recentId)
                val builder = ShortcutInfoCompat.Builder(context, ID_PREFIX + entry.recentId)
                    .setShortLabel(entry.label)
                    .setLongLabel(entry.label)
                    .setIntent(intent)
                    .setRank(rank)
                if (iconId != 0) builder.setIcon(IconCompat.createWithResource(context, iconId))
                ShortcutManagerCompat.pushDynamicShortcut(context, builder.build())
            }
        } catch (_: Throwable) {
        }
    }

    fun homeShortcutsActive(premeeting: PremeetingPresenter): Boolean =
        !PipController.isInCall && premeeting.path.count == 0 &&
            !premeeting.isJoinSheetPresented && !premeeting.isAccountSheetPresented

    fun homeKeyboardShortcutGroup(context: Context): KeyboardShortcutGroup =
        KeyboardShortcutGroup(
            conclaveStringOf(context, "pm_kb_group"),
            listOf(
                KeyboardShortcutInfo(conclaveStringOf(context, "pm_new_meeting"), KeyEvent.KEYCODE_N, KeyEvent.META_CTRL_ON),
                KeyboardShortcutInfo(conclaveStringOf(context, "pm_join_with_code"), KeyEvent.KEYCODE_J, KeyEvent.META_CTRL_ON),
            ),
        )
}

fun handleConclaveShortcutIntent(context: Context, intent: Intent?): Boolean {
    val type = ConclaveShortcutActions.shortcutType(intent?.action) ?: return false
    val payload = intent?.getStringExtra(ConclaveShortcutActions.EXTRA_PAYLOAD).orEmpty()
    ConclaveAppDelegate.shared.onShortcut(type = type, payload = payload)
    ConclaveShortcutActions.reportUsed(context, type, payload)
    return true
}

fun handleConclaveHomeKeyShortcut(keyCode: Int, event: KeyEvent): Boolean {
    val type = ConclaveShortcutActions.homeShortcutType(keyCode, event.isCtrlPressed, event.isShiftPressed, event.isAltPressed)
        ?: return false
    if (!conclaveHomeShortcutsActive()) return false
    ConclaveAppDelegate.shared.onShortcut(type = type, payload = "")
    return true
}

fun conclaveHomeKeyboardShortcutGroup(context: Context): KeyboardShortcutGroup? =
    if (conclaveHomeShortcutsActive()) RecentShortcuts.homeKeyboardShortcutGroup(context) else null

private fun conclaveHomeShortcutsActive(): Boolean =
    NativeRouteFlags.shared.routesPremeetingNatively && RecentShortcuts.homeShortcutsActive(MeetingViewModel.shared.premeeting)

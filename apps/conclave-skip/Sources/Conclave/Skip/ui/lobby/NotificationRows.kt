package conclave.module

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag

/*
 * SYS-3 (S70 2 d, f, g; S60 1 R26 and S70 R70-4): the Android notification rows. Settings mounts them (HD request
 * B8-T5 R3) in a call and on the app-scope page outside one, so both read the one process-lifetime
 * SystemNotifications snapshot (the leaf reads only that). Android needs no waiting-room row: POST_NOTIFICATIONS covers
 * both channels (S10 9 d, RECONCILE R5). Settings rows follow the system appearance; no haptics (S70 D7).
 */

/**
 * "Message notifications" (S70 2 g): a SwitchRow whose value is the preference AND the granted permission. Off with
 * the description while a request can still help (turning it on asks once); permanently denied or the app's
 * notifications off: "Notifications are off for Conclave" and an "Open settings" row (the app's notification
 * settings). Granted with the conclave_messages channel blocked (S70 2 f "One channel blocked"): the row names the
 * channel and Open settings goes to that channel.
 */
@Composable
internal fun MessageNotificationsItem(identifier: String) {
    val notifications = SystemNotifications.shared
    val snapshot = notifications.snapshot
    LaunchedEffect(Unit) { notifications.refreshStatus() }
    val off = snapshot.offersOpenSettings
    val channelOff = !off && snapshot.permission == NotificationPermissionState.granted && !snapshot.messagesChannelEnabled
    val supporting = when {
        off -> "sys_notif_off"
        channelOff -> "sys_notif_messages_channel_off"
        else -> "set_message_notifications_desc"
    }
    SettingsSwitchItem(
        conclaveString("set_message_notifications"),
        snapshot.messageNotificationsOn,
        identifier,
        enabled = !snapshot.isRequesting && !off,
        supporting = conclaveString(supporting),
    ) { on -> notifications.setMessageNotifications(on) }
    if (off || channelOff) {
        SettingsNavItem(conclaveString("ds_open_settings"), null, "$identifier.openSettings") {
            notifications.openSystemSettings(channel = if (channelOff) LocalNotificationChannel.messages.rawValue else "")
        }
    }
}

/**
 * "Call notification" (S70 2 g): On, or "Off. Mute and Hang up won't appear in your notifications." with Open settings:
 * the app's notification settings while the permission is missing, otherwise the call channel's.
 */
@Composable
internal fun CallNotificationStatusItem(identifier: String) {
    val notifications = SystemNotifications.shared
    val snapshot = notifications.snapshot
    LaunchedEffect(Unit) { notifications.refreshStatus() }
    val on = snapshot.callNotificationOn
    SettingsNavItem(
        conclaveString("sys_call_notif_title"),
        conclaveString(if (on) "sys_call_notif_on" else "sys_call_notif_off"),
        identifier,
        enabled = !on,
    ) {
        val channel = if (snapshot.permission == NotificationPermissionState.granted) NotificationChannelMigrationPolicy.channelId else ""
        notifications.openSystemSettings(channel = channel)
    }
}

/**
 * S70 SX1 readout `sys.notifications` (`permission/banner/posted`) and the Debug posts for the silent AVD check (S70 2 l,
 * PLAN SYS-3 verification): one admission and one mention, posted directly (the fixture is in front, so the
 * foreground rule is skipped) to resolve the channels, icon, color and copy on a real system; the grant is set with
 * pm grant / pm revoke and read back here, never by accepting a prompt. `posted` counts the presenter's posts plus the
 * fixture's. Mounted in the system fixture root (HD request B8-T5 R7).
 */
@Composable
internal fun NotificationFixtureReadouts() {
    val notifications = SystemNotifications.shared
    val snapshot = notifications.snapshot
    val context = LocalContext.current
    var fixturePosts by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) { notifications.refreshStatus() }
    Text(
        text = snapshot.permission.rawValue + "/" + (if (snapshot.showsPrimingBanner) "1" else "0") + "/" +
            (notifications.postedCount + fixturePosts),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onBackground,
        modifier = Modifier.testTag("sys.notifications"),
    )
    OutlinedButton(onClick = {
        LocalNotifications.postForFixture(context, LocalNotificationPostPolicy.admissionRequest(
            roomId = FIXTURE_ROOM, roomLabel = FIXTURE_ROOM, callSession = 1, presenceSession = 1,
            timeMillis = System.currentTimeMillis().toDouble()))
        fixturePosts += 1
    }, modifier = Modifier.testTag("sys.notifications.postAdmission")) {
        Text(text = conclaveString("sys_channel_admission"))
    }
    OutlinedButton(onClick = {
        val now = System.currentTimeMillis()
        val message = LocalChatMessageInput.make(messageId = "fixture-$now", senderId = "avery", senderName = "Avery Lee",
            text = "@you the deck is ready", timeMillis = now.toDouble(), isMention = true)
        LocalNotifications.postForFixture(context, LocalNotificationPostPolicy.messageRequest(kind = LocalNotificationKind.mention,
            message = message, roomId = FIXTURE_ROOM, roomLabel = FIXTURE_ROOM, callSession = 1, presenceSession = 1,
            previousSenderId = ""))
        fixturePosts += 1
    }, modifier = Modifier.testTag("sys.notifications.postMessage")) {
        Text(text = conclaveString("sys_channel_messages"))
    }
    OutlinedButton(onClick = {
        LocalNotifications.removeDelivered(context, FIXTURE_ROOM, emptyList())
    }, modifier = Modifier.testTag("sys.notifications.clear")) {
        Text(text = conclaveString("sys_fixture_clear_notifications"))
    }
}

private const val FIXTURE_ROOM = "lily-zoro-iris"

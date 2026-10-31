package conclave.module

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.provider.CalendarContract
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WebinarLandingScreen(premeeting: PremeetingPresenter, key: PremeetingKey.WebinarLandingKey, onBack: () -> Unit) {
    val routeId = key.routeId
    DisposableEffect(premeeting, routeId) {
        premeeting.webinarDidAppear(routeId = routeId)
        onDispose { premeeting.webinarDidDisappear(routeId = routeId) }
    }
    WebinarLifecycleEffect(premeeting)
    val snapshot = premeeting.webinar?.takeIf { it.routeId == routeId }
    val joining = snapshot != null && WebinarLandingPolicy.isJoining(snapshot.status)
    BackHandler(enabled = joining) { onBack() }
    val snackbarHostState = remember { SnackbarHostState() }
    val scheme = MaterialTheme.colorScheme
    Scaffold(
        topBar = { WebinarTopBar(premeeting, joining, onBack) },
        bottomBar = { WebinarPrimaryBar(premeeting, routeId) },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        containerColor = scheme.surface,
        contentWindowInsets = WindowInsets.safeDrawing,
        modifier = Modifier.testTag("webinar"),
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (snapshot == null || snapshot.status == WebinarLandingStatus.loading) {
                ConclaveLoadingStatus(identifier = "webinar.loading", label = conclaveString("pm_loading_webinar"))
            } else {
                WebinarHeader(snapshot.tag, snapshot.title, snapshot.hostName)
                WebinarStatusContent(premeeting, snapshot, snackbarHostState)
            }
            WebinarAnnouncer(routeId, snapshot?.status)
        }
    }
}

@Composable
private fun WebinarLifecycleEffect(premeeting: PremeetingPresenter) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, premeeting) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                premeeting.webinarSceneDidChange(isActive = true)
            } else if (event == Lifecycle.Event.ON_PAUSE) {
                premeeting.webinarSceneDidChange(isActive = false)
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WebinarTopBar(premeeting: PremeetingPresenter, joining: Boolean, onBack: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    TopAppBar(
        navigationIcon = {
            if (joining) {
                IconButton(onClick = { premeeting.cancelJoin() }, modifier = Modifier.testTag("webinar.cancel")) {
                    Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("pm_cancel_joining"))
                }
            } else {
                ConclaveBackButton(toCall = false, onClick = onBack, identifier = "webinar.back")
            }
        },
        title = { Text(conclaveString("pm_webinar_title"), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = scheme.surface),
    )
}

@Composable
private fun WebinarPrimaryBar(premeeting: PremeetingPresenter, routeId: Int) {
    val snapshot = premeeting.webinar?.takeIf { it.routeId == routeId } ?: return
    if (snapshot.action != WebinarLandingAction.startWatching) return
    val scheme = MaterialTheme.colorScheme
    Surface(color = scheme.surface) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding()) {
            HorizontalDivider(color = scheme.outlineVariant)
            ConclaveButton(
                title = conclaveString("pm_start_watching"),
                role = ConclaveButtonRole.Primary,
                identifier = "webinar.startWatching",
                onClick = { premeeting.startWatching() },
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                enabled = snapshot.isPrimaryEnabled,
            )
        }
    }
}

@Composable
private fun WebinarHeader(tag: WebinarLandingTag, title: String, hostName: String) {
    SideEffect { WebinarLandingDiagnostics.headerCompositions += 1 }
    val scheme = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (tag != WebinarLandingTag.none) {
            WebinarStatusTag(tag)
        }
        Text(
            if (title.isEmpty()) conclaveString("pm_webinar_fallback_title") else title,
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.semantics { heading() }.testTag("webinar.title"),
        )
        Text(
            if (hostName.isEmpty()) conclaveString("pm_hosted_by_organizer") else conclaveString("pm_hosted_by", hostName),
            style = MaterialTheme.typography.bodyMedium,
            color = scheme.onSurfaceVariant,
            modifier = Modifier.testTag("webinar.host"),
        )
        if (NativeRouteFlags.shared.premeetingFixture.isNotEmpty()) {

            val readout = "webinar.header.compositions " + WebinarLandingDiagnostics.headerCompositions +
                " countdown " + WebinarLandingDiagnostics.countdownCompositions
            Box(Modifier.size(1.dp).testTag("webinar.header.compositions").semantics { contentDescription = readout })
        }
    }
}

@Composable
private fun WebinarStatusTag(tag: WebinarLandingTag) {
    val scheme = MaterialTheme.colorScheme
    val live = LocalConclaveExtendedColors.current.live
    Surface(shape = MaterialTheme.shapes.small, color = scheme.surfaceContainerHighest, modifier = Modifier.testTag("webinar.tag")) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (tag == WebinarLandingTag.live) {
                Box(Modifier.size(8.dp).background(live, CircleShape))
            }
            Text(webinarTagTitle(tag), style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun WebinarStatusContent(premeeting: PremeetingPresenter, snapshot: WebinarLandingSnapshot, snackbarHostState: SnackbarHostState) {
    when (snapshot.status) {
        WebinarLandingStatus.loading -> Unit
        WebinarLandingStatus.early -> WebinarEarlyContent(premeeting, snapshot, snackbarHostState)
        WebinarLandingStatus.openNow -> WebinarOpenContent(premeeting, snapshot)
        WebinarLandingStatus.joining, WebinarLandingStatus.almostThere, WebinarLandingStatus.waitingForHost ->
            WebinarProgressRow(snapshot.status)
        else -> WebinarStatusMessage(premeeting, snapshot)
    }
}

@Composable
private fun WebinarEarlyContent(premeeting: PremeetingPresenter, snapshot: WebinarLandingSnapshot, snackbarHostState: SnackbarHostState) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val scheme = MaterialTheme.colorScheme
    OutlinedCard(modifier = Modifier.fillMaxWidth().testTag("webinar.early")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(conclaveString("pm_early_title"), style = MaterialTheme.typography.titleMedium)
            if (snapshot.startsAtMillis > 0.0) {
                CountdownText(startsAtMillis = snapshot.startsAtMillis)
            }
            if (snapshot.earlyEntryMinutes > 0) {
                Text(
                    conclavePlural("pm_lobby_opens", snapshot.earlyEntryMinutes, snapshot.earlyEntryMinutes),
                    style = MaterialTheme.typography.bodyMedium,
                    color = scheme.onSurfaceVariant,
                    modifier = Modifier.testTag("webinar.opensNote"),
                )
            }
        }
    }
    if (snapshot.startsAtMillis > 0.0) {
        val resolverDisabled = premeeting.webinarCalendarResolverDisabled
        OutlinedButton(
            onClick = {
                val opened = openWebinarCalendarEditor(context, snapshot, resolverDisabled)
                if (!opened) {
                    val message = conclaveStringOf(context, "pm_no_calendar_app")
                    scope.launch { snackbarHostState.showSnackbar(message) }
                }
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("webinar.calendar"),
        ) {
            Text(conclaveString("pm_add_to_calendar"))
        }
    }
    if (snapshot.link.isNotEmpty()) {
        val shareTitle = if (snapshot.title.isEmpty()) conclaveString("pm_webinar_title") else snapshot.title
        OutlinedButton(
            onClick = { NativeMeetingShare.shareText(title = shareTitle, text = snapshot.link) },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("webinar.share"),
        ) {
            Icon(ConclaveIcons.ShareFill0, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(conclaveString("pm_share_link"))
        }
    }
}

@Composable
private fun WebinarOpenContent(premeeting: PremeetingPresenter, snapshot: WebinarLandingSnapshot) {
    val scheme = MaterialTheme.colorScheme
    val routeId = snapshot.routeId
    if (snapshot.needsName) {
        var name by remember(routeId) { mutableStateOf(premeeting.webinarNameText) }
        Column {
            ConclaveTextField(
                label = conclaveString("pm_your_name"),
                value = name,
                onValueChange = { raw ->

                    val capped = DisplayNamePolicy.capped(raw)
                    name = capped
                    premeeting.setWebinarName(capped)
                },
                kind = ConclaveTextFieldKind.Name,
                identifier = "webinar.name",
                onSubmit = { premeeting.startWatching() },
            )
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(conclaveString("pm_webinar_name_reason"), style = MaterialTheme.typography.bodySmall,
                    color = scheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                ConclaveCharacterCounter(count = name.length, limit = snapshot.nameLimit,
                    visibleFrom = DisplayNamePolicy.counterThreshold, identifier = "webinar.name.counter")
            }
        }
    }
    if (snapshot.needsInviteCode) {
        var code by remember(routeId) { mutableStateOf(premeeting.webinarInviteText) }
        Column {
            ConclaveTextField(
                label = conclaveString("pm_invite_code"),
                value = code,
                onValueChange = { raw ->
                    code = raw
                    premeeting.setWebinarInviteCode(raw)
                },
                kind = ConclaveTextFieldKind.Code,
                identifier = "webinar.invite",
                error = if (snapshot.inviteCodeInvalid) conclaveString("pm_invite_invalid") else null,
                onSubmit = { premeeting.startWatching() },
            )
            if (!snapshot.inviteCodeInvalid) {
                Text(conclaveString("pm_webinar_invite_footer"), style = MaterialTheme.typography.bodySmall,
                    color = scheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
    Text(conclaveString("pm_attendee_note"), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant,
        modifier = Modifier.testTag("webinar.attendeeNote"))
}

@Composable
private fun WebinarProgressRow(status: WebinarLandingStatus) {
    val scheme = MaterialTheme.colorScheme
    Column(
        modifier = Modifier.fillMaxWidth().testTag("webinar.progress").semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 3.dp)
            Text(webinarProgressTitle(status), style = MaterialTheme.typography.titleMedium)
        }
        if (status == WebinarLandingStatus.waitingForHost) {
            Text(conclaveString("pm_waiting_host_body"), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun WebinarStatusMessage(premeeting: PremeetingPresenter, snapshot: WebinarLandingSnapshot) {
    val icon = when (snapshot.status) {
        WebinarLandingStatus.ended, WebinarLandingStatus.cancelled -> ConclaveIcons.InfoFill0
        WebinarLandingStatus.failed -> ConclaveIcons.ErrorFill1
        else -> ConclaveIcons.WarningFill1
    }
    val title = webinarMessageTitle(snapshot.status)
    val body = webinarMessageBody(snapshot.status)
    if (snapshot.action == WebinarLandingAction.tryAgain) {
        ConclaveErrorStatus(title = title, body = body, icon = icon, identifier = "webinar.status",
            onRetry = { premeeting.retryWebinar() })
    } else {
        ConclaveErrorStatus(title = title, body = body, icon = icon, identifier = "webinar.status",
            onRetry = { premeeting.webinarBackHome() }, retryTitle = conclaveString("pm_back_home"))
    }
}

@Composable
private fun WebinarAnnouncer(routeId: Int, status: WebinarLandingStatus?) {
    val context = LocalContext.current
    var previous by remember(routeId) { mutableStateOf(status) }
    var announcement by remember(routeId) { mutableStateOf("") }
    LaunchedEffect(routeId, status) {
        val prior = previous
        previous = status
        if (status != null && prior != null && prior != status && WebinarLandingPolicy.announces(status)) {
            announcement = webinarAnnouncementOf(context, status)
        }
    }
    if (announcement.isNotEmpty()) {
        val text = announcement
        Box(Modifier.size(1.dp).testTag("webinar.announcement").semantics {
            liveRegion = LiveRegionMode.Polite
            contentDescription = text
        })
    }
}

internal fun openWebinarCalendarEditor(context: Context, snapshot: WebinarLandingSnapshot, resolverDisabled: Boolean): Boolean {
    if (resolverDisabled) return false
    val title = if (snapshot.title.isEmpty()) conclaveStringOf(context, "pm_webinar_title") else snapshot.title
    val end = WebinarLandingPolicy.eventEndMillis(startsAtMillis = snapshot.startsAtMillis, endsAtMillis = snapshot.endsAtMillis)
    val intent = webinarCalendarIntent(title = title, startMillis = snapshot.startsAtMillis.toLong(), endMillis = end.toLong(),
        link = snapshot.link)
    return try {
        context.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        false
    }
}

internal fun webinarCalendarIntent(title: String, startMillis: Long, endMillis: Long, link: String): Intent =
    Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
        .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMillis)
        .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endMillis)
        .putExtra(CalendarContract.Events.TITLE, title)
        .putExtra(CalendarContract.Events.DESCRIPTION, link)

@Composable
private fun webinarTagTitle(tag: WebinarLandingTag): String = when (tag) {
    WebinarLandingTag.live -> conclaveString("pm_tag_live")
    WebinarLandingTag.startsSoon -> conclaveString("pm_tag_starts_soon")
    WebinarLandingTag.ended -> conclaveString("pm_tag_ended")
    else -> ""
}

@Composable
private fun webinarProgressTitle(status: WebinarLandingStatus): String = when (status) {
    WebinarLandingStatus.almostThere -> conclaveString("pm_almost_there")
    WebinarLandingStatus.waitingForHost -> conclaveString("pm_waiting_host_start")
    else -> conclaveString("pm_getting_you_in")
}

@Composable
private fun webinarMessageTitle(status: WebinarLandingStatus): String = conclaveString(webinarMessageTitleName(status))

@Composable
private fun webinarMessageBody(status: WebinarLandingStatus): String {
    val name = webinarMessageBodyName(status)
    return if (name.isEmpty()) "" else conclaveString(name)
}

internal fun webinarMessageTitleName(status: WebinarLandingStatus): String = when (status) {
    WebinarLandingStatus.locked -> "pm_webinar_locked"
    WebinarLandingStatus.full -> "pm_webinar_full"
    WebinarLandingStatus.unavailable -> "pm_webinar_unavailable"
    WebinarLandingStatus.ended -> "pm_webinar_ended_title"
    WebinarLandingStatus.cancelled -> "pm_webinar_cancelled_title"
    else -> "pm_snag_title"
}

internal fun webinarMessageBodyName(status: WebinarLandingStatus): String = when (status) {
    WebinarLandingStatus.ended -> "pm_webinar_ended_body"
    WebinarLandingStatus.cancelled -> "pm_webinar_cancelled_body"
    WebinarLandingStatus.failed -> "pm_webinar_load_failed"
    else -> ""
}

private fun webinarAnnouncementOf(context: Context, status: WebinarLandingStatus): String = when (status) {
    WebinarLandingStatus.openNow -> conclaveStringOf(context, "pm_start_watching")
    WebinarLandingStatus.waitingForHost -> conclaveStringOf(context, "pm_waiting_host_start")
    WebinarLandingStatus.ended -> conclaveStringOf(context, "pm_webinar_ended_title")
    WebinarLandingStatus.cancelled -> conclaveStringOf(context, "pm_webinar_cancelled_title")
    else -> ""
}

internal object WebinarLandingDiagnostics {
    var headerCompositions = 0
    var countdownCompositions = 0
}

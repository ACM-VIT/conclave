package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.ui.NavDisplay

/*
 * ENT-1 (S10 0.4, 1 d): the Android native premeeting root, handwritten Compose Material 3 mounted by MainActivity
 * outside SkipUI behind the Debug `premeeting` route flag (PLAN-screens 2), or by the L9 fixture with standalone
 * presenters. It takes its presenters as parameters and never reads a static presenter. The premeeting stack is a
 * NavDisplay over keys built from the presenter's path (PremeetingBackStack); the call branch draws above it while
 * the 0.4 table says call. Exactly one system-bar writer is composed at a time: ConclaveSystemBars for the
 * premeeting stack, the call content's own writer while it shows (S10 1 d).
 */
@Composable
internal fun PremeetingHost(
    shell: MeetingShellPresenter,
    premeeting: PremeetingPresenter,
    usesNativeCallRoot: Boolean,
    // STG-1 (HD request B3-T2 R5): the session's stage presenter for the native call root; null (the L9 fixture)
    // always shows the interim call content.
    stage: StagePresenter? = null,
    callContent: @Composable () -> Unit,
) {
    val systemDark = isSystemInDarkTheme()
    val inCall = premeeting.root.root == PremeetingRootKind.call
    HostingTheme {
        Box(Modifier.fillMaxSize()) {
            PremeetingStack(premeeting)
            if (inCall) {
                // CALL-ROOT SLOT: B3-T2 (STG-1) mounts its CallRoot here when `usesNativeCallRoot` (the Debug `call`
                // key) is on (HD request B3-T2 R5); always when the key is off, the interim call content. The native
                // call root is then the system-bar writer. The control bar slot stays empty until CTL-1.
                if (usesNativeCallRoot && stage != null) {
                    CallRoot(shell = shell, stage = stage, renderers = StageRenderers.live,
                        onMinimize = { stageMinimizeToBackground() })
                } else {
                    callContent()
                }
            }
        }
        if (!inCall) {
            ConclaveSystemBars(SystemBarPolicy.resolve(rootDark = systemDark, overlayVisible = false, overlayInCall = false,
                bottomStripInCall = false, systemDark = systemDark))
        }
        val prompt = premeeting.switchPrompt
        if (prompt != null) {
            // Over the stage the dialog takes the in-call theme; otherwise the system appearance (S10 4 d).
            HostingTheme(inCall = inCall) { PremeetingSwitchDialog(premeeting, prompt) }
        }
        if (premeeting.isUpdatePromptPresented) {
            PremeetingUpdateDialog(premeeting)
        }
    }
}

@Composable
private fun PremeetingStack(premeeting: PremeetingPresenter) {
    val keys = PremeetingBackStack.from(premeeting.path.toList(), premeeting.outcome)
    NavDisplay(
        backStack = keys,
        modifier = Modifier.fillMaxSize(),
        onBack = { premeetingBack(premeeting) },
        entryProvider = { key -> NavEntry(key) { _ -> PremeetingPage(premeeting, key) } },
    )
    if (premeeting.isJoinSheetPresented) {
        JoinCodeSheet(premeeting)
    }
}

/** Back from the top page: the outcome's secondary path, Cancel while connecting or waiting, else a pop. */
private fun premeetingBack(premeeting: PremeetingPresenter) {
    if (premeeting.outcome != null) {
        premeeting.performOutcomeAction(OutcomeAction.backHome)
        return
    }
    val top = premeeting.path.last
    val status = premeeting.lobbyStatus
    if (top != null && top.kind == PremeetingRouteKind.lobby && status != null && status.routeId == top.id &&
        (status.mode == LobbyMode.connecting || status.mode == LobbyMode.waiting)) {
        premeeting.cancelJoin()
        return
    }
    premeeting.setPath(skip.lib.Array(PremeetingBackStack.popped(premeeting.path.toList())))
}

@Composable
private fun PremeetingPage(premeeting: PremeetingPresenter, key: PremeetingKey) {
    when (key) {
        is PremeetingKey.HomeKey -> HomeScreen(premeeting)
        is PremeetingKey.LobbyKey -> LobbyStandInPage(premeeting, key)
        is PremeetingKey.WebinarLandingKey -> WebinarStandInPage(premeeting, key)
        is PremeetingKey.AccountKey -> AccountStandInPage(premeeting)
        is PremeetingKey.PrivacyKey -> AccountStandInPage(premeeting)
        is PremeetingKey.OutcomeKey -> OutcomeStandInPage(premeeting)
    }
}

// MARK: Stand-ins until their slices land (ENT-3 lobby, ENT-6 outcome, ENT-7 account, ENT-9 webinar landing)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StandInScaffold(
    title: String,
    showsBack: Boolean,
    onBack: () -> Unit,
    actions: @Composable () -> Unit = {},
    content: @Composable () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { if (showsBack) ConclaveBackButton(toCall = false, onClick = onBack) },
                actions = { actions() },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = scheme.surface),
            )
        },
        containerColor = scheme.surface,
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            content()
        }
    }
}

/** The lobby stand-in: the room, the 0.4 mode and Cancel while busy. No Start or Join (ENT-3), so no joinRoom. */
@Composable
private fun LobbyStandInPage(premeeting: PremeetingPresenter, key: PremeetingKey.LobbyKey) {
    val status = premeeting.lobbyStatus?.takeIf { it.routeId == key.routeId }
    val busy = status != null && (status.mode == LobbyMode.connecting || status.mode == LobbyMode.waiting)
    StandInScaffold(
        title = key.roomId,
        showsBack = !busy,
        onBack = { premeetingBack(premeeting) },
        actions = {
            if (busy) {
                TextButton(onClick = { premeeting.cancelJoin() }, modifier = Modifier.testTag("lobby.cancel")) {
                    Text(conclaveString("pm_cancel"))
                }
            }
        },
    ) {
        ListItem(
            headlineContent = {
                Text(key.roomId, style = MaterialTheme.typography.bodyLarge)
            },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
            modifier = Modifier.testTag("lobby.room"),
        )
        if (status != null && status.mode != LobbyMode.editing) {
            LobbyStatusItem(status)
        }
    }
}

@Composable
private fun LobbyStatusItem(status: LobbyStatusSnapshot) {
    val scheme = MaterialTheme.colorScheme
    val reconnecting = status.waitingKind == WaitingKind.reconnecting
    val text = when (status.mode) {
        LobbyMode.connecting -> if (reconnecting) conclaveString("pm_subtitle_reconnecting") else conclaveString("pm_subtitle_joining")
        LobbyMode.waiting -> if (reconnecting) conclaveString("pm_subtitle_reconnecting") else conclaveString("pm_asking_to_join")
        LobbyMode.failed -> if (status.intent == LobbyIntent.newMeeting) conclaveString("pm_couldnt_start") else conclaveString("pm_couldnt_join")
        LobbyMode.editing -> ""
    }
    Row(
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp).testTag("lobby.status")
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (status.mode == LobbyMode.failed) {
            Icon(PremeetingIcons.Error, contentDescription = null, tint = scheme.error)
        } else {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        }
        Column {
            Text(text, style = MaterialTheme.typography.bodyLarge)
            if (status.issueServerText.isNotEmpty()) {
                Text(status.issueServerText, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun WebinarStandInPage(premeeting: PremeetingPresenter, key: PremeetingKey.WebinarLandingKey) {
    StandInScaffold(title = key.roomId, showsBack = true, onBack = { premeetingBack(premeeting) }) {
        ListItem(
            headlineContent = { Text(conclaveString("pm_tag_webinar")) },
            supportingContent = { Text(key.roomId) },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
            modifier = Modifier.testTag("webinar.room"),
        )
    }
}

@Composable
private fun AccountStandInPage(premeeting: PremeetingPresenter) {
    val home = premeeting.home
    StandInScaffold(title = conclaveString("pm_account"), showsBack = true, onBack = { premeetingBack(premeeting) }) {
        if (home.isSignedIn) {
            ListItem(
                leadingContent = { ConclaveAvatar(home.accountName, home.accountSeed, ConclaveAvatarSize.row) },
                headlineContent = { Text(home.accountName) },
                colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                modifier = Modifier.semantics(mergeDescendants = true) { },
            )
        }
    }
}

/** The outcome stand-in: C14 with the variant copy and Back to home (Back does the same, S10 10 i). */
@Composable
private fun OutcomeStandInPage(premeeting: PremeetingPresenter) {
    val outcome = premeeting.outcome ?: return
    val title = when (outcome.variant) {
        OutcomeVariant.removed -> conclaveString("pm_removed_title")
        OutcomeVariant.denied -> conclaveString("pm_denied_title")
        OutcomeVariant.connectionLost -> conclaveString("pm_lost_title")
        OutcomeVariant.serverDisconnected -> conclaveString("pm_disconnected_title")
        OutcomeVariant.rejoinFailed -> conclaveString("pm_couldnt_rejoin")
    }
    val body = when (outcome.variant) {
        OutcomeVariant.removed -> conclaveString("pm_removed_body")
        OutcomeVariant.denied -> conclaveString("pm_denied_body")
        OutcomeVariant.connectionLost -> conclaveString("pm_lost_body")
        OutcomeVariant.serverDisconnected -> conclaveString("pm_disconnected_body")
        OutcomeVariant.rejoinFailed -> ""
    }
    val detail = outcome.serverDetail
    val text = if (detail.isEmpty()) body else if (body.isEmpty()) detail else body + "\n\n" + detail
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface), contentAlignment = Alignment.Center) {
        ConclaveErrorStatus(
            title = title,
            body = text,
            icon = PremeetingIcons.Error,
            identifier = "outcome." + outcome.variant.rawValue,
            onRetry = { premeeting.performOutcomeAction(OutcomeAction.backHome) },
            retryTitle = conclaveString("pm_back_home"),
        )
    }
}

// MARK: Dialogs

/** S10 4 d: Stay is the dismiss path (Back and scrim too); Leave and join is the default primary text button. */
@Composable
private fun PremeetingSwitchDialog(premeeting: PremeetingPresenter, prompt: RoomSwitchPrompt) {
    val currentFallback = conclaveString("pm_current_meeting_fallback")
    val targetFallback = conclaveString("pm_other_meeting_fallback")
    val current = if (prompt.currentLabel.isEmpty()) currentFallback else prompt.currentLabel
    val target = if (prompt.targetLabel.isEmpty()) targetFallback else prompt.targetLabel
    AlertDialog(
        onDismissRequest = { premeeting.stay(id = prompt.id) },
        title = { Text(conclaveString("pm_switch_title")) },
        text = { Text(conclaveString("pm_switch_body", current, target)) },
        confirmButton = {
            TextButton(onClick = { premeeting.confirmSwitch(id = prompt.id) }, modifier = Modifier.testTag("premeeting.switch.leave")) {
                Text(conclaveString("pm_switch_leave_and_join"))
            }
        },
        dismissButton = {
            TextButton(onClick = { premeeting.stay(id = prompt.id) }, modifier = Modifier.testTag("premeeting.switch.stay")) {
                Text(conclaveString("pm_switch_stay"))
            }
        },
        modifier = Modifier.testTag("premeeting.switch"),
    )
}

/** R51: the "Update Conclave" explanation entries open instead of the lobby. */
@Composable
private fun PremeetingUpdateDialog(premeeting: PremeetingPresenter) {
    val uriHandler = LocalUriHandler.current
    AlertDialog(
        onDismissRequest = { premeeting.dismissUpdatePrompt() },
        title = { Text(conclaveString("pm_update_title")) },
        text = { Text(conclaveString("pm_update_body")) },
        confirmButton = {
            TextButton(onClick = {
                val storeURL = premeeting.home.storeURL
                premeeting.openStoreListing()
                if (storeURL.isNotEmpty()) {
                    runCatching { uriHandler.openUri(storeURL) }
                }
            }) {
                Text(conclaveString("pm_update_action"))
            }
        },
        dismissButton = {
            TextButton(onClick = { premeeting.dismissUpdatePrompt() }) { Text(conclaveString("ds_cancel")) }
        },
        modifier = Modifier.testTag("premeeting.update"),
    )
}

// MARK: App-module entry points (MainActivity sees only public declarations; the presenters stay internal)

/**
 * PLAN-screens 2 route switches for MainActivity: the Debug intent extras `conclave.nativeRoutes` and
 * `conclave.premeetingFixture`, applied only when the caller passes `debugEligible` (BuildConfig.DEBUG and
 * FLAG_DEBUGGABLE). Release never configures the registry, so the legacy root stays the default.
 */
object NativeRouteLaunch {
    const val ROUTES_EXTRA = "conclave.nativeRoutes"
    const val PREMEETING_FIXTURE_EXTRA = "conclave.premeetingFixture"

    fun configure(routes: String?, premeetingFixture: String?, debugEligible: Boolean) {
        NativeRouteFlags.shared.configure(routes = routes, premeetingFixture = premeetingFixture, debugEligible = debugEligible)
    }

    /** The L9 fixture state name, or "" when no valid fixture was asked for. */
    val premeetingFixture: String
        get() {
            val name = NativeRouteFlags.shared.premeetingFixture
            return if (PremeetingFixtureScript.state(named = name) != null) name else ""
        }

    /** The native premeeting root replaces the legacy root (the flag on, no fixture). */
    val usesNativePremeeting: Boolean
        get() = premeetingFixture.isEmpty() && NativeRouteFlags.shared.isEnabled(NativeRouteKey.premeeting)

    /** S10 1 c and 0.8 C8, C9: identity, recents and the link target before the first frame (once per process). */
    fun installProductionWiring() {
        PremeetingAppWiring.install(appState = AppState.shared, viewModel = MeetingViewModel.shared)
    }
}

/** The production native premeeting root over the view model's presenters; `callContent` is the interim call root. */
@Composable
fun NativePremeetingHost(callContent: @Composable () -> Unit) {
    val viewModel = MeetingViewModel.shared
    PremeetingHost(
        shell = viewModel.shell,
        premeeting = viewModel.premeeting,
        usesNativeCallRoot = NativeRouteFlags.shared.isEnabled(NativeRouteKey.call),
        stage = viewModel.stage,
        callContent = callContent,
    )
}

/** The premeeting feedback delivery over the view model's presenter (MainActivity, behind the flag). */
@Composable
fun NativePremeetingRootFeedback() {
    PremeetingRootFeedback(MeetingViewModel.shared.premeeting)
}

// MARK: Feedback and the L9 fixture

/**
 * ENT-1 (S10 0.5): the premeeting stream as the second production delivery, beside ConclaveRootFeedback. MainActivity
 * composes it once, outside the PiP swap, only behind the `premeeting` flag. It plays only DeliveredTokenKinds.
 */
@Composable
internal fun PremeetingRootFeedback(premeeting: PremeetingPresenter) {
    val view = LocalView.current
    val delivery = remember(premeeting, view) {
        NativeFeedbackDelivery(
            source = { FeedbackSourceState(session = premeeting.feedbackState.session, token = premeeting.feedbackState.token) },
            sink = { ConclaveHaptics.perform(view, it) },
            deliversKind = { DeliveredTokenKinds.delivers(it) },
            records = FeedbackDeliveryRecords.shared,
        )
    }
    NativeFeedbackConsumer(delivery, mount = 0)
}

/**
 * S10 L9 (Debug): the production host over a standalone fixture session. MainActivity mounts it for the intent extra
 * `conclave.premeetingFixture` (BuildConfig.DEBUG and FLAG_DEBUGGABLE). No view model, media, network or device
 * store; the call branch is a dark stand-in; links reach the fixture presenter through the app delegate; the
 * self-check value is exposed under the `premeeting.fixture.selfCheck` test tag.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun PremeetingFixtureHost(stateName: String) {
    val state = PremeetingFixtureScript.state(named = stateName) ?: PremeetingFixtureState.home
    // Bootstrapped before the first frame (S10 1 c).
    val session = remember(state) { PremeetingFixtureSession(state = state).also { it.start() } }
    DisposableEffect(session) {
        ConclaveAppDelegate.shared.registerPremeeting(session.premeeting)
        onDispose {
            session.stop()
            ConclaveAppDelegate.shared.registerPremeeting(null)
        }
    }
    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        PremeetingHost(session.shell, session.premeeting, usesNativeCallRoot = false) {
            HostingTheme(inCall = true) {
                Box(Modifier.fillMaxSize().background(LocalConclaveExtendedColors.current.stage).testTag("premeeting.fixture.call"))
            }
        }
        val readout = state.rawValue + " " + session.selfCheckReadout
        Box(
            Modifier.size(1.dp).align(Alignment.BottomStart).testTag(PremeetingFixtureScript.selfCheckKey)
                .semantics { contentDescription = readout },
        )
    }
}

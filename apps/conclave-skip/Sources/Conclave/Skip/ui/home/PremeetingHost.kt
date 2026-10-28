package conclave.module

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.updateTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
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
 * NavDisplay over keys built from the presenter's path (PremeetingBackStack); the call branch replaces it while
 * the 0.4 table says call. Exactly one system-bar writer is composed at a time: ConclaveSystemBars for the
 * premeeting stack, the call content's own writer while it shows (S10 1 d).
 *
 * ENT-5 (S10 8 d, h, m): the root is one AnimatedContent over the 0.4 root kind, so the premeeting stack leaves
 * composition once the call content covers it and comes back under the fading call content when the call ends. The
 * way into the native CallRoot (and the L9 fixture's stage stand-in) is the card expansion when the lobby card
 * recorded its bounds and animations are on; the interim legacy root (PresentationRootView in its own
 * SaveableStateProvider, SideEffect removeState kept in MainActivity) always cross-fades, and its own bar writer is
 * the only one composed while it is (our writer waits until the transition has settled on the premeeting side).
 */
@Composable
internal fun PremeetingHost(
    shell: MeetingShellPresenter,
    premeeting: PremeetingPresenter,
    usesNativeCallRoot: Boolean,
    // STG-1 (HD request B3-T2 R5): the session's stage presenter for the native call root; null (the L9 fixture)
    // always shows the interim call content.
    stage: StagePresenter? = null,
    // PPL-1 (HD request B4-T7 R6): the session's People presenter for the native Participants page; null keeps the
    // empty native shell (the L9 fixture).
    people: PeoplePresenter? = null,
    // ACT-1, ACT-2, STG-9 (HD request B4-T8 R5c): the session's activity presenters; null in the L9 fixture.
    activitySession: ActivitySession? = null,
    // ENT-5: the interim call content is a stage surface (the L9 fixture's dark stand-in), so it takes the card
    // expansion like the native CallRoot; the production interim (the legacy root) always cross-fades.
    interimIsStage: Boolean = false,
    callContent: @Composable () -> Unit,
) {
    val systemDark = isSystemInDarkTheme()
    val rootKind = premeeting.root.root
    val inCall = rootKind == PremeetingRootKind.call
    val reduceMotion = rememberReduceMotion()
    val anchors = remember { EntryTransitionAnchors() }
    val expandsIntoCall = (usesNativeCallRoot && stage != null) || interimIsStage
    // S10 8 c, d: the card bounds the expansion starts from, read once when the root flips to the call; null
    // cross-fades (Reduce Motion, no recorded card, the interim legacy root).
    val expansionStart: Rect? = remember(rootKind) {
        if (rootKind != PremeetingRootKind.call) {
            null
        } else {
            val bounds = anchors.bounds(forRoute = premeeting.lobbyStatus?.routeId ?: 0)
            val style = EntryTransitionPolicy.style(entersCall = true, expandsIntoCall = expandsIntoCall,
                hasCardFrame = bounds != null, prefersCrossFade = reduceMotion)
            if (style == EntryTransitionStyle.expand) bounds else null
        }
    }
    var expansionDone by remember(rootKind) { mutableStateOf(false) }
    val rootTransition = updateTransition(targetState = rootKind, label = "premeeting.root")
    // The call content is composed while the root is (or is still fading from) the call.
    val callComposed = rootTransition.currentState == PremeetingRootKind.call ||
        rootTransition.targetState == PremeetingRootKind.call
    HostingTheme {
        // SYS-5 (S70 4 a, d): Compose-scoped keep awake while the call presence keeps the screen on (waiting,
        // connecting, live, recovering, on hold); it covers the interim legacy call content hosted here too.
        CallKeepScreenOnEffect()
        Box(Modifier.fillMaxSize().onGloballyPositioned { anchors.hostOrigin = it.positionInRoot() }) {
            rootTransition.AnimatedContent(
                modifier = Modifier.fillMaxSize(),
                transitionSpec = {
                    entryRootTransform(entersCall = targetState == PremeetingRootKind.call,
                        expands = expansionStart != null, reduceMotion = reduceMotion)
                },
            ) { kind ->
                if (kind == PremeetingRootKind.call) {
                    // CALL-ROOT SLOT: B3-T2 (STG-1) mounts its CallRoot here when `usesNativeCallRoot` (the Debug
                    // `call` key) is on (HD request B3-T2 R5); always when the key is off, the interim call content.
                    // The native call root is then the system-bar writer. The control bar reads LocalCallControls
                    // (CTL-1, HD request B4-T6 R9), which NativePremeetingHost provides.
                    if (usesNativeCallRoot && stage != null) {
                        CallRoot(shell = shell, stage = stage, people = people, renderers = StageRenderers.live,
                            activitySession = activitySession, onMinimize = { stageMinimizeToBackground() })
                    } else {
                        callContent()
                    }
                } else {
                    CompositionLocalProvider(LocalEntryTransitionAnchors provides anchors) {
                        PremeetingStack(premeeting)
                    }
                }
            }
            // S50 PH20 (PPL-7, RECONCILE R30): the promotion lobby over the still-playing viewer (native call root only).
            if (inCall && usesNativeCallRoot && stage != null) {
                PromotionLobbyOverlay(premeeting)
            }
            val start = expansionStart
            if (start != null && !expansionDone) {
                EntryExpansionLayer(start = start, hostOrigin = anchors.hostOrigin, onFinished = {
                    expansionDone = true
                    anchors.clear()
                })
            }
        }
        if (!callComposed) {
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
    StopAskingHost(premeeting)
}

/** ENT-5 (S10 9 d): the waiting room's Back confirmation, in its own scope so its flag recomposes nothing else. */
@Composable
private fun StopAskingHost(premeeting: PremeetingPresenter) {
    if (premeeting.isStopAskingPresented) {
        StopAskingDialog(premeeting)
    }
}

/** Back from the top page: the outcome's secondary path, Cancel while connecting, the Stop asking confirmation while
 *  waiting (S10 9 d), else a pop. */
private fun premeetingBack(premeeting: PremeetingPresenter) {
    if (premeeting.outcome != null) {
        premeeting.performOutcomeAction(OutcomeAction.backHome)
        return
    }
    val top = premeeting.path.last
    if (top != null && top.kind == PremeetingRouteKind.account && !premeeting.account.snapshot.canDismiss) {
        // ENT-7 (S10 5 f): Back is disabled while the account is being deleted.
        return
    }
    val status = premeeting.lobbyStatus
    if (top != null && top.kind == PremeetingRouteKind.lobby && status != null && status.routeId == top.id) {
        if (status.mode == LobbyMode.connecting) {
            premeeting.cancelJoin()
            return
        }
        if (status.mode == LobbyMode.waiting) {
            premeeting.requestStopAsking()
            return
        }
    }
    premeeting.setPath(skip.lib.Array(PremeetingBackStack.popped(premeeting.path.toList())))
}

@Composable
private fun PremeetingPage(premeeting: PremeetingPresenter, key: PremeetingKey) {
    when (key) {
        is PremeetingKey.HomeKey -> HomeScreen(premeeting)
        is PremeetingKey.LobbyKey -> LobbyScreen(premeeting, key, onBack = { premeetingBack(premeeting) })
        is PremeetingKey.WebinarLandingKey -> WebinarStandInPage(premeeting, key)
        is PremeetingKey.AccountKey -> AccountScreen(
            account = premeeting.account,
            onBack = { premeetingBack(premeeting) },
            onOpenPrivacy = { premeeting.openPrivacyPolicy() },
            onOpenSettings = { premeeting.openAppSettings() },
        )
        is PremeetingKey.PrivacyKey -> PrivacyPolicyScreen(onBack = { premeetingBack(premeeting) })
        is PremeetingKey.SettingsKey -> AppSettingsScreen(onBack = { premeetingBack(premeeting) })
        is PremeetingKey.OutcomeKey -> OutcomeScreen(premeeting)
    }
}

// MARK: Stand-ins until their slices land (ENT-9 webinar landing; the lobby is ENT-3's LobbyScreen in K/ui/lobby,
// Account and Privacy are ENT-7's AccountScreen and PrivacyPolicyScreen in K/ui/account, the outcome is ENT-6's
// OutcomeScreen in K/ui/outcome)

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
    // CTL-1 (HD request B4-T6 R9): the native call root's control bar reads the controls presenter from here.
    CompositionLocalProvider(LocalCallControls provides viewModel.controls) {
        PremeetingHost(
            shell = viewModel.shell,
            premeeting = viewModel.premeeting,
            usesNativeCallRoot = NativeRouteFlags.shared.isEnabled(NativeRouteKey.call),
            stage = viewModel.stage,
            people = viewModel.people,
            activitySession = viewModel.activitySession,
            callContent = callContent,
        )
    }
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
    // SYS-4 (PS 9.4): PiP (and the API 35 transition into it) suspends delivery; resuming rebaselines, nothing replays.
    val pipSuspended = PipController.feedbackSuspended
    LaunchedEffect(delivery, pipSuspended) { delivery.updateSuspended(pipSuspended) }
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
        // ENT-5: the dark stand-in is a stage surface, so `connecting-to-call` shows the card expansion (S10 8 l2).
        PremeetingHost(session.shell, session.premeeting, usesNativeCallRoot = false, interimIsStage = true) {
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

package conclave.module

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.updateTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.unit.dp
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.ui.NavDisplay

@Composable
internal fun PremeetingHost(
    shell: MeetingShellPresenter,
    premeeting: PremeetingPresenter,
    usesNativeCallRoot: Boolean,
    stage: StagePresenter? = null,
    people: PeoplePresenter? = null,
    activitySession: ActivitySession? = null,
    interimIsStage: Boolean = false,
    callContent: @Composable () -> Unit,
) {
    val systemDark = conclaveUsesDarkAppearance()
    val rootKind = premeeting.root.root
    val inCall = rootKind == PremeetingRootKind.call
    val reduceMotion = rememberReduceMotion()
    val anchors = remember { EntryTransitionAnchors() }
    val expandsIntoCall = (usesNativeCallRoot && stage != null) || interimIsStage
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
    val callComposed = rootTransition.currentState == PremeetingRootKind.call ||
        rootTransition.targetState == PremeetingRootKind.call
    HostingTheme {
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
            if (usesNativeCallRoot && stage != null) {
                StageEntryFinishedEffect(
                    settled = rootTransition.currentState == PremeetingRootKind.call &&
                        rootTransition.targetState == PremeetingRootKind.call &&
                        (expansionStart == null || expansionDone),
                )
            }
        }
        if (!callComposed) {
            ConclaveSystemBars(SystemBarPolicy.resolve(rootDark = systemDark, overlayVisible = false, overlayInCall = false,
                bottomStripInCall = false, systemDark = systemDark))
        }
        val prompt = premeeting.switchPrompt
        if (prompt != null) {
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

@Composable
private fun StopAskingHost(premeeting: PremeetingPresenter) {
    if (premeeting.isStopAskingPresented) {
        StopAskingDialog(premeeting)
    }
}

private fun premeetingBack(premeeting: PremeetingPresenter) {
    if (premeeting.outcome != null) {
        premeeting.performOutcomeAction(OutcomeAction.backHome)
        return
    }
    val top = premeeting.path.last
    if (top != null && top.kind == PremeetingRouteKind.account && !premeeting.account.snapshot.canDismiss) {
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
    val webinar = premeeting.webinar
    if (top != null && top.kind == PremeetingRouteKind.webinarLanding && webinar != null && webinar.routeId == top.id &&
        WebinarLandingPolicy.isJoining(webinar.status)) {
        premeeting.cancelJoin()
        return
    }
    premeeting.setPath(skip.lib.Array(PremeetingBackStack.popped(premeeting.path.toList())))
}

@Composable
private fun PremeetingPage(premeeting: PremeetingPresenter, key: PremeetingKey) {
    when (key) {
        is PremeetingKey.HomeKey -> HomeScreen(premeeting)
        is PremeetingKey.LobbyKey -> LobbyScreen(premeeting, key, onBack = { premeetingBack(premeeting) })
        is PremeetingKey.WebinarLandingKey -> WebinarLandingScreen(premeeting, key, onBack = { premeetingBack(premeeting) })
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

object NativeRouteLaunch {
    const val ROUTES_EXTRA = "conclave.nativeRoutes"
    const val PREMEETING_FIXTURE_EXTRA = "conclave.premeetingFixture"

    fun configure(routes: String?, premeetingFixture: String?, debugEligible: Boolean) {
        NativeRouteFlags.shared.configure(routes = routes, premeetingFixture = premeetingFixture, debugEligible = debugEligible)
    }

    val premeetingFixture: String
        get() {
            val name = NativeRouteFlags.shared.premeetingFixture
            return if (PremeetingFixtureScript.state(named = name) != null) name else ""
        }

    val usesNativePremeeting: Boolean
        get() = premeetingFixture.isEmpty() && NativeRouteFlags.shared.isEnabled(NativeRouteKey.premeeting)

    fun installProductionWiring() {
        PremeetingAppWiring.install(appState = AppState.shared, viewModel = MeetingViewModel.shared)
    }
}

@Composable
fun NativePremeetingHost(callContent: @Composable () -> Unit) {
    val viewModel = MeetingViewModel.shared
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

@Composable
fun NativePremeetingRootFeedback() {
    PremeetingRootFeedback(MeetingViewModel.shared.premeeting)
}

@Composable
internal fun PremeetingRootFeedback(premeeting: PremeetingPresenter) {
    val view = LocalView.current
    val delivery = remember(premeeting, view) {
        NativeFeedbackDelivery(
            source = { FeedbackSourceState(session = premeeting.feedbackState.session, token = premeeting.feedbackState.token) },
            sink = { ConclaveHaptics.perform(view, it) },
            deliversKind = { NativePremeetingFeedbackKinds.delivers(it) },
            records = FeedbackDeliveryRecords.shared,
        )
    }
    val pipSuspended = PipController.feedbackSuspended
    LaunchedEffect(delivery, pipSuspended) { delivery.updateSuspended(pipSuspended) }
    NativeFeedbackConsumer(delivery, mount = 0)
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun PremeetingFixtureHost(stateName: String) {
    val state = PremeetingFixtureScript.state(named = stateName) ?: PremeetingFixtureState.home
    val session = remember(state) { PremeetingFixtureSession(state = state).also { it.start() } }
    DisposableEffect(session) {
        ConclaveAppDelegate.shared.registerPremeeting(session.premeeting)
        onDispose {
            session.stop()
            ConclaveAppDelegate.shared.registerPremeeting(null)
        }
    }
    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
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

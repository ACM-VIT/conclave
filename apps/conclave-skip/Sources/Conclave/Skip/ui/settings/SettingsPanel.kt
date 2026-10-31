package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

@Composable
internal fun SettingsPage(
    settings: SettingsPresenter,
    people: PeoplePresenter?,
    panels: PanelCoordinator,
    request: PanelRequest,
    variant: InCallPageVariant,
    appearance: PanelAppearance,
    miniTile: CallMiniTileModel?,
    onClose: () -> Unit,
    onMounted: () -> Unit,
    onDisposed: () -> Unit,
    miniTileVideo: (@Composable () -> Unit)? = null,
) {
    val pages = LocalPanelPageStack.current
    val top = pages?.top
    val snackbar = remember { SnackbarHostState() }
    val route = settingsRouteForKey(top)
    DisposableEffect(request.presentationID) {
        settings.panelDidOpen()
        onDispose {
            settings.panelDidClose()

            SettingsPreviewRenderers.release(request.presentationID)
        }
    }
    LaunchedEffect(request.presentationID) {

        if (pages != null && !pages.isNested) {
            for (page in SettingsRoutePolicy.initialPath(destination = request.destination)) pages.push(page.rawValue)
        }
    }
    SettingsDestinationLeaf(panels, request.presentationID, pages)
    SettingsRoleLeaf(settings, pages, onClose)
    SettingsBackgroundLeaf(settings)
    InCallPage(
        title = conclaveString(SettingsCopy.pageTitleName(route)),
        variant = variant,
        appearance = appearance,
        hasComposer = false,
        miniTile = miniTile,
        onClose = onClose,
        onMounted = onMounted,
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
        contentMode = InCallPageContent.lazyList,
        snackbarHost = { SnackbarHost(snackbar) },
        hideMiniTileWithIme = true,
        isNested = pages?.isNested == true,
        onBack = { pages?.pop() },
    ) { reservation ->

        CompositionLocalProvider(LocalSettingsPresentationId provides request.presentationID) {
            SettingsPageContent(settings, people, top, reservation, snackbar, onPush = { pages?.push(it) },
                onOpenTranscript = { panels.present(MeetingPanel.transcript, from = PanelInvoker.settings) })
        }
    }
}

@Composable
private fun SettingsDestinationLeaf(panels: PanelCoordinator, presentationID: Int, pages: PanelPageStack?) {
    val sequence = panels.latestDestination(presentationID)?.sequence ?: 0
    LaunchedEffect(sequence) {
        if (sequence == 0) return@LaunchedEffect
        val request = panels.latestDestination(presentationID) ?: return@LaunchedEffect
        val path = SettingsRoutePolicy.initialPath(destination = request.destination)
        if (path.isEmpty || pages == null) return@LaunchedEffect
        pages.popToRoot()
        for (page in path) pages.push(page.rawValue)
    }
}

@Composable
private fun SettingsBackgroundLeaf(settings: SettingsPresenter) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, settings) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) settings.previewSceneBackgrounded()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
}

@Composable
private fun SettingsRoleLeaf(settings: SettingsPresenter, pages: PanelPageStack?, onClose: () -> Unit) {
    val general = settings.general
    val view = LocalView.current
    val closedText = conclaveString("set_closed_announcement")
    LaunchedEffect(general.showsHostSection) {
        if (!general.showsHostSection && pages != null) {
            val top = pages.top
            if (top != null && SettingsRoutePolicy.isHostRoute(settingsRouteForKey(top))) pages.popToRoot()
        }
    }
    LaunchedEffect(general.isAttendee) {
        if (general.isAttendee) {
            @Suppress("DEPRECATION")
            view.announceForAccessibility(closedText)
            onClose()
        }
    }
}

private val settingsStackSaver = listSaver<SnapshotStateList<String>, String>(
    save = { it.toList() },
    restore = { saved -> mutableStateListOf<String>().apply { addAll(saved) } },
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AppSettingsScreen(onBack: () -> Unit, modifier: Modifier = Modifier) {

    val settings = remember {
        SettingsPresenter(scope = SettingsScope.app).also {

            val notifications = SystemNotifications.shared.snapshot
            it.apply(SettingsInputs.make(
                messageNotificationsAvailable = true,
                messageNotificationsOn = notifications.messageNotificationsPreference,
                notificationPermission = notifications.settingsPermission,
                callNotificationStatusAvailable = true,
                callNotificationEnabled = notifications.callNotificationOn,
                canExportDiagnostics = DiagnosticsExportPolicy.isOffered,
            ))
        }
    }
    val stack = rememberSaveable(saver = settingsStackSaver) { mutableStateListOf<String>() }
    val snackbar = remember { SnackbarHostState() }
    val scheme = MaterialTheme.colorScheme
    val layoutDirection = LocalLayoutDirection.current
    val top = stack.lastOrNull()
    val route = settingsRouteForKey(top)
    DisposableEffect(Unit) {
        settings.panelDidOpen()
        onDispose { settings.panelDidClose() }
    }
    BackHandler(enabled = stack.isNotEmpty()) {
        stack.removeAt(stack.size - 1)
    }
    Scaffold(
        modifier = modifier.fillMaxSize().testTag("settings.appScope"),
        topBar = {
            TopAppBar(
                title = {
                    Text(conclaveString(SettingsCopy.pageTitleName(route)), maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.semantics { heading() })
                },
                navigationIcon = {
                    ConclaveIconButton(conclaveString("ds_back"), ConclaveIcons.ArrowBackFill0, "settings.appScope.back",
                        { if (stack.isNotEmpty()) stack.removeAt(stack.size - 1) else onBack() })
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = scheme.surface),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = scheme.surface,
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { padding ->

        val body = PaddingValues(start = padding.calculateStartPadding(layoutDirection), top = padding.calculateTopPadding(),
            end = padding.calculateEndPadding(layoutDirection), bottom = 0.dp)
        val reservation = PaddingValues(bottom = padding.calculateBottomPadding() + 16.dp)
        Box(Modifier.fillMaxSize().padding(body), contentAlignment = Alignment.TopCenter) {
            Box(Modifier.fillMaxSize().widthIn(max = 640.dp)) {
                SettingsPageContent(settings, null, top, reservation, snackbar, onPush = { stack.add(it) })
            }
        }
    }
}

@Composable
internal fun SettingsAttendeeContent(settings: SettingsPresenter, reservation: PaddingValues, snackbar: SnackbarHostState,
                                     onOpenPrivacy: () -> Unit) {
    LaunchedEffect(Unit) { settings.refreshPreferences() }
    SettingsRootList(settings, reservation, snackbar, onPush = { key ->
        if (key == SettingsRoute.privacy.rawValue) onOpenPrivacy()
    })
}

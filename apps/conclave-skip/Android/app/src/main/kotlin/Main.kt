package conclave.module

import skip.lib.*
import skip.model.*
import skip.foundation.*
import skip.ui.*

import android.app.Application
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color as AndroidColor
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.setContent
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.ComponentActivity
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.material3.MaterialTheme

internal val logger: SkipLogger = SkipLogger(subsystem = "conclave.module", category = "Conclave")

private typealias AppRootView = ConclaveRootView
private typealias AppDelegate = ConclaveAppDelegate
private const val FULL_ROOT_SAVEABLE_KEY = "conclave-full-root"

open class AndroidAppMain: Application {
    constructor() {
    }

    override fun onCreate() {
        super.onCreate()
        ProcessInfo.launch(applicationContext)
        AppDelegate.shared.onInit()
        // Prebuild the meeting icon vectors on a background thread now, so the
        // first sheet/controls render reuses the cached vectors instead of
        // building ~12 of them on the main thread mid-open (the sheet-content lag).
        warmMeetingIcons()
    }

    companion object {
    }
}

open class MainActivity: AppCompatActivity {
    constructor() {
    }

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        UIApplication.launch(this)
        // SYS-3 (S70 2 a): a local notification's tap that recreated the activity (a no-op for any other intent).
        LocalNotifications.handleTap(intent)
        // Register the MediaProjection consent launcher (must happen at onCreate
        // before the Activity reaches STARTED) so screen-share can request it.
        ScreenCaptureManager.register(this)
        enableEdgeToEdge()
        // PLAN-screens 2 route switches and S10 L9: Debug-only intent extras, like conclave.hostingPreview. Release
        // builds never configure the registry, so the legacy root stays the default (ENT-FLIP is a later slice).
        val routesDebuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        NativeRouteLaunch.configure(
            routes = intent?.getStringExtra(NativeRouteLaunch.ROUTES_EXTRA),
            premeetingFixture = intent?.getStringExtra(NativeRouteLaunch.PREMEETING_FIXTURE_EXTRA),
            debugEligible = BuildConfig.DEBUG && routesDebuggable,
        )
        val premeetingFixture = NativeRouteLaunch.premeetingFixture
        val nativePremeeting = NativeRouteLaunch.usesNativePremeeting
        if (nativePremeeting) {
            // S10 1 c and 0.8 C8, C9: identity, recents and the link target before the first frame.
            NativeRouteLaunch.installProductionWiring()
        }

        setContent {
            // Launch-only proof route. Release and ordinary launches keep the working root.
            var showsHostingPreview by remember {
                mutableStateOf(BuildConfig.DEBUG && intent?.getBooleanExtra("conclave.hostingPreview", false) == true)
            }
            // S70 SX1: Debug-only system fixture (standalone CallPresence; never WebRTC, audio, capture or network).
            val systemFixture = remember {
                val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
                if (BuildConfig.DEBUG && debuggable) intent?.getStringExtra("conclave.systemFixture") else null
            }
            // S20 SL14: Debug-only stage fixture (standalone presenters; never WebRTC, audio, capture or network).
            val stageFixture = remember {
                val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
                if (BuildConfig.DEBUG && debuggable) intent?.getStringExtra("conclave.stageFixture") else null
            }
            val stageFixturePattern = remember { if (stageFixture != null) intent?.getStringExtra("conclave.stageFixturePattern") else null }
            val stageForceScreenReader = remember {
                stageFixture != null && intent?.getBooleanExtra("conclave.stageForceScreenReader", false) == true
            }
            // S40 0.9 (HD request B4-T1 R3): the chat fixture layers on the stage fixture and opens Chat.
            val chatFixture = remember { if (stageFixture != null) intent?.getStringExtra("conclave.chatFixture") else null }
            // S60 L6-12 (HD request B7-T5 R5): the Transcript fixture layers on the stage fixture and opens Transcript.
            val transcriptFixture = remember { if (stageFixture != null) intent?.getStringExtra("conclave.transcriptFixture") else null }
            // S50 PL12 (HD request B4-T7 R5): Debug-only People fixture over the stage fixture (standalone presenters;
            // never WebRTC, audio, capture or network). The stage fixture's pattern and screen-reader extras apply.
            val peopleFixture = remember {
                val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
                if (BuildConfig.DEBUG && debuggable) intent?.getStringExtra("conclave.peopleFixture") else null
            }
            val peopleFixturePattern = remember { if (peopleFixture != null) intent?.getStringExtra("conclave.stageFixturePattern") else null }
            val peopleForceScreenReader = remember {
                peopleFixture != null && intent?.getBooleanExtra("conclave.stageForceScreenReader", false) == true
            }
            val saveableStateHolder = rememberSaveableStateHolder()
            val legacyRoot: @Composable () -> Unit = {
                saveableStateHolder.SaveableStateProvider(FULL_ROOT_SAVEABLE_KEY) {
                    PresentationRootView(ComposeContext())
                    // Skip app template: never save or restore SkipUI state.
                    // SkipUI's rememberSaveable values are Bundle keys into the
                    // ComposeStateSaver of the ComposeContext that saved them.
                    // The PiP swap (and activity recreation) rebuilds the root
                    // with a fresh ComposeContext, so restored keys resolve to
                    // null and PresentationRoot NPEs on PiP exit or resume.
                    // Dropping the state makes the root recompose fresh; call
                    // state lives in MeetingViewModel, not in view state.
                    SideEffect { saveableStateHolder.removeState(FULL_ROOT_SAVEABLE_KEY) }
                }
            }
            // WP2-S2b (S70 12 d): the single production feedback root, outside the PiP swap and the route switch,
            // so neither remounts it (a rotation recreates it with a baselined cursor). Never for a fixture.
            if (systemFixture == null && stageFixture == null && peopleFixture == null && premeetingFixture.isEmpty()) {
                ConclaveRootFeedback()
            }
            if (nativePremeeting && systemFixture == null && stageFixture == null && peopleFixture == null) {
                // ENT-1: the premeeting stream, the second production delivery (launch-time route, never remounted).
                NativePremeetingRootFeedback()
            }
            // S70 3 d (SYS-4): the legacy PiP surface only while the native call root is not composed; the native root
            // stays composed in PiP and draws its own PiP slot (renderers survive, PS 9.4).
            if (PipController.showsLegacyPipContent) {
                PipContent()
            } else if (systemFixture != null && !PipController.isInCall) {
                SystemFixtureRoot(systemFixture)
            } else if (peopleFixture != null && !PipController.isInCall) {
                PeopleFixtureRoot(peopleFixture, peopleFixturePattern, peopleForceScreenReader)
            } else if (stageFixture != null && !PipController.isInCall) {
                // S30 CL13 (HD request B4-T6 R10): `controls-<state>` values mount the controls fixture.
                if (isControlsFixtureState(stageFixture)) {
                    ControlsFixtureRoot(stageFixture)
                } else {
                    StageFixtureRoot(stageFixture, stageFixturePattern, stageForceScreenReader, chatFixture, transcriptFixture)
                }
            } else if (premeetingFixture.isNotEmpty() && !PipController.isInCall) {
                // S10 L9: standalone presenters; never the view model, a call, media or the network.
                PremeetingFixtureHost(premeetingFixture)
            } else if (showsHostingPreview && !PipController.isInCall) {
                // The library cannot see the app build type; it also checks FLAG_DEBUGGABLE at run time.
                NativeHostingPreviewRoot(fixtureEligible = BuildConfig.DEBUG, onClose = { showsHostingPreview = false })
            } else if (nativePremeeting) {
                // PLAN-screens 2: the native premeeting root (S10 0.4); the legacy root is the interim call content.
                NativePremeetingHost(callContent = legacyRoot)
            } else {
                legacyRoot()
            }
        }

        AppDelegate.shared.onLaunch()
        handleIncomingDeepLink(intent)
    }

    override fun onResume() {
        super.onResume()
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            PipManager.handleActivityResumed(this)
        }
        // S70 SY18: the volume keys change call volume while a call is live, even during silence.
        AudioRouteOwnerBridge.applyVolumeControlStream(this)
        AppDelegate.shared.onResume()
    }

    override fun onPause() {
        super.onPause()
        AppDelegate.shared.onPause()
    }

    override fun onStop() {
        super.onStop()
        AppDelegate.shared.onStop()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (PipManager.consumeAutoEnterSuppression()) {
            return
        }
        // Android 12+ can distinguish the Home gesture from an app-launched
        // chooser itself. Let system auto-enter handle Home so share sheets,
        // browsers, and permission activities never force a fake PiP state.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
            PipManager.configureForActiveCall(PipController.isInCall, PipController.muted)
            return
        }
        if (
            PipController.isInCall &&
            !PipController.inPipMode &&
            !ScreenCaptureManager.isRequestingCapture() &&
            android.os.Build.VERSION.SDK_INT >= 26
        ) {
            PipController.refreshPipContent()
            CallActionDispatcher.pictureInPictureContentRefresh()
            Handler(Looper.getMainLooper()).post {
                if (
                    PipController.isInCall &&
                    !PipController.inPipMode &&
                    !ScreenCaptureManager.isRequestingCapture() &&
                    !isFinishing &&
                    !isDestroyed &&
                    !isInPictureInPictureMode
                ) {
                    PipManager.enterPip(this, PipController.muted)
                } else if (!isInPictureInPictureMode) {
                    PipController.inPipMode = false
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == CallActionDispatcher.ACTION_RETURN_TO_CALL) {
            // The activity is already in front; record returnToCall against the posted presence session.
            CallActionDispatcher.returnToCall(intent.getIntExtra(CallActionDispatcher.EXTRA_PRESENCE_SESSION, -1))
            // SYS-3: an admission or chat notification's tap also carries its kind and room (Chat at the message).
            LocalNotifications.handleTap(intent)
            return
        }
        handleIncomingDeepLink(intent)
    }

    private fun handleIncomingDeepLink(intent: Intent?) {
        val urlString = intent?.dataString?.trim() ?: return
        if (urlString.isEmpty()) return
        AppDelegate.shared.onOpenURL(urlString)
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: android.content.res.Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        PipController.inPipMode = isInPictureInPictureMode
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            PipManager.handlePictureInPictureModeChanged(
                this,
                isInPictureInPictureMode,
                PipController.muted
            )
        }
        if (isInPictureInPictureMode) {
            CallActionDispatcher.pictureInPictureEntered()
        }
    }

    @androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.S)
    override fun onPictureInPictureUiStateChanged(pipState: android.app.PictureInPictureUiState) {
        super.onPictureInPictureUiStateChanged(pipState)
        // S70 3 d (D-13): API 35 reports the transition before the window shrinks, so the native root hides chrome
        // first; API 31 to 34 report stashing only (chrome hides on the mode change there).
        val transitioning = android.os.Build.VERSION.SDK_INT >= 35 && pipState.isTransitioningToPip
        PipManager.handlePictureInPictureUiStateChanged(stashed = pipState.isStashed, transitioningToPip = transitioning)
    }

    override fun onDestroy() {
        if (isFinishing) {
            NativeGoogleSignInBridge.cancel()
        }
        super.onDestroy()
        AppDelegate.shared.onDestroy()
    }

    override fun onLowMemory() {
        super.onLowMemory()
        AppDelegate.shared.onLowMemory()
    }

    override fun onSaveInstanceState(outState: android.os.Bundle): Unit = super.onSaveInstanceState(outState)

    override fun onRequestPermissionsResult(requestCode: Int, permissions: kotlin.Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        PermissionHelper.handleRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    companion object {
    }
}

@Composable
internal fun SyncSystemBarsWithTheme() {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f

    val transparent = AndroidColor.TRANSPARENT
    val style = if (dark) {
        SystemBarStyle.dark(transparent)
    } else {
        SystemBarStyle.light(transparent, transparent)
    }

    val activity = LocalActivity.current as? ComponentActivity
    DisposableEffect(style) {
        activity?.enableEdgeToEdge(
            statusBarStyle = style,
            navigationBarStyle = style
        )
        onDispose { }
    }
}

@Composable
internal fun PresentationRootView(context: ComposeContext) {
    val colorScheme = if (isSystemInDarkTheme()) ColorScheme.dark else ColorScheme.light
    PresentationRoot(defaultColorScheme = colorScheme, context = context) { ctx ->
        SyncSystemBarsWithTheme()
        val contentContext = ctx.content()
        Box(modifier = ctx.modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            AppRootView().Compose(context = contentContext)
        }
    }
}

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

        warmMeetingIcons()
    }

    companion object {
    }
}

open class MainActivity: AppCompatActivity {
    constructor() {
    }

    private var fixtureSelectorRequested = false
    private var hostingPreviewRequested = false
    private var nativePremeetingRequested = false
    private var productionWiringInstalled = false

    private fun updateFixturePresentation() {
        val wasFixture = NativeFixtureLaunch.suppressesProductionLifecycle
        val fixturePresented = NativeFixtureLaunch.androidRootPresented(
            selectorRequested = fixtureSelectorRequested,
            hostingPreviewRequested = hostingPreviewRequested,
            isInCall = PipController.isInCall,
            showsLegacyPipContent = PipController.showsLegacyPipContent,
            debugEligible = BuildConfig.DEBUG,
        )
        NativeFixtureLaunch.configurePresentation(
            selectorPresented = fixturePresented && fixtureSelectorRequested,
            hostingPreviewPresented = fixturePresented && hostingPreviewRequested,
            debugEligible = BuildConfig.DEBUG,
        )
        if (!fixturePresented && nativePremeetingRequested && !productionWiringInstalled) {

            NativeRouteLaunch.installProductionWiring()
            productionWiringInstalled = true
        }
        if (wasFixture && !fixturePresented) {
            AppDelegate.shared.onFixturePresentationEnded()
        }
    }

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        UIApplication.launch(this)

        LocalNotifications.handleTap(intent)

        ScreenCaptureManager.register(this)
        enableEdgeToEdge()

        val routesDebuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        NativeRouteLaunch.configure(
            routes = intent?.getStringExtra(NativeRouteLaunch.ROUTES_EXTRA),
            premeetingFixture = intent?.getStringExtra(NativeRouteLaunch.PREMEETING_FIXTURE_EXTRA),
            debugEligible = BuildConfig.DEBUG && routesDebuggable,
        )
        val premeetingFixture = NativeRouteLaunch.premeetingFixture
        val nativePremeeting = NativeRouteLaunch.usesNativePremeeting

        val systemFixture = if (BuildConfig.DEBUG && routesDebuggable) intent?.getStringExtra("conclave.systemFixture") else null
        val stageFixture = if (BuildConfig.DEBUG && routesDebuggable) intent?.getStringExtra("conclave.stageFixture") else null
        val peopleFixture = if (BuildConfig.DEBUG && routesDebuggable) intent?.getStringExtra("conclave.peopleFixture") else null
        hostingPreviewRequested = BuildConfig.DEBUG && intent?.getBooleanExtra("conclave.hostingPreview", false) == true
        fixtureSelectorRequested = NativeFixtureLaunch.androidSelector(
            system = systemFixture, stage = stageFixture, people = peopleFixture, premeeting = premeetingFixture,
        )
        nativePremeetingRequested = nativePremeeting
        updateFixturePresentation()

        setContent {

            var showsHostingPreview by remember {
                mutableStateOf(hostingPreviewRequested)
            }
            val stageFixturePattern = remember { if (stageFixture != null) intent?.getStringExtra("conclave.stageFixturePattern") else null }
            val stageForceScreenReader = remember {
                stageFixture != null && intent?.getBooleanExtra("conclave.stageForceScreenReader", false) == true
            }

            val chatFixture = remember { if (stageFixture != null) intent?.getStringExtra("conclave.chatFixture") else null }

            val transcriptFixture = remember { if (stageFixture != null) intent?.getStringExtra("conclave.transcriptFixture") else null }

            val peopleFixturePattern = remember { if (peopleFixture != null) intent?.getStringExtra("conclave.stageFixturePattern") else null }
            val peopleForceScreenReader = remember {
                peopleFixture != null && intent?.getBooleanExtra("conclave.stageForceScreenReader", false) == true
            }
            val saveableStateHolder = rememberSaveableStateHolder()
            val legacyRoot: @Composable () -> Unit = {
                saveableStateHolder.SaveableStateProvider(FULL_ROOT_SAVEABLE_KEY) {
                    PresentationRootView(ComposeContext())

                    SideEffect { saveableStateHolder.removeState(FULL_ROOT_SAVEABLE_KEY) }
                }
            }

            val fixturePresented = NativeFixtureLaunch.androidRootPresented(
                selectorRequested = fixtureSelectorRequested,
                hostingPreviewRequested = showsHostingPreview,
                isInCall = PipController.isInCall,
                showsLegacyPipContent = PipController.showsLegacyPipContent,
                debugEligible = BuildConfig.DEBUG,
            )
            SideEffect { updateFixturePresentation() }
            if (!fixturePresented) {
                ConclaveRootFeedback()
            }
            if (nativePremeeting && !fixturePresented) {

                NativePremeetingRootFeedback()
            }

            if (PipController.showsLegacyPipContent) {
                PipContent()
            } else if (systemFixture != null && !PipController.isInCall) {
                SystemFixtureRoot(systemFixture)
            } else if (peopleFixture != null && !PipController.isInCall) {
                PeopleFixtureRoot(peopleFixture, peopleFixturePattern, peopleForceScreenReader)
            } else if (stageFixture != null && !PipController.isInCall) {

                if (isControlsFixtureState(stageFixture)) {
                    ControlsFixtureRoot(stageFixture)
                } else {
                    StageFixtureRoot(stageFixture, stageFixturePattern, stageForceScreenReader, chatFixture, transcriptFixture)
                }
            } else if (premeetingFixture.isNotEmpty() && !PipController.isInCall) {

                PremeetingFixtureHost(premeetingFixture)
            } else if (showsHostingPreview && !PipController.isInCall) {

                NativeHostingPreviewRoot(fixtureEligible = BuildConfig.DEBUG, onClose = {
                    showsHostingPreview = false
                    hostingPreviewRequested = false
                    updateFixturePresentation()
                })
            } else if (nativePremeeting) {

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

        AudioRouteOwnerBridge.applyVolumeControlStream(this)
        updateFixturePresentation()
        AppDelegate.shared.onResume()
    }

    override fun onPause() {
        super.onPause()
        updateFixturePresentation()
        AppDelegate.shared.onPause()
    }

    override fun onStop() {
        super.onStop()
        updateFixturePresentation()
        AppDelegate.shared.onStop()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (PipManager.consumeAutoEnterSuppression()) {
            return
        }

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

            CallActionDispatcher.returnToCall(intent.getIntExtra(CallActionDispatcher.EXTRA_PRESENCE_SESSION, -1))

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

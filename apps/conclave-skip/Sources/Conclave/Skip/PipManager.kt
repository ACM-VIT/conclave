package conclave.module

import android.app.Activity
import android.app.AppOpsManager
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Rect
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Rational
import androidx.annotation.RequiresApi
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

/**
 * Builds PictureInPictureParams and enters PiP (S70 3 d; SYS-4, SY7). The params come from the CallPresence snapshot
 * through the shared PipParamsPolicy: the aspect from the target's decoded frame size (16:9 until the first frame,
 * clamped to 2.39:1 and 1:2.39), the source rect from the target slot's window bounds (PipTargetFrame, R70-10; the
 * activity's own bounds until the slot is laid out), absolute Mute or Unmute and Leave call actions that carry
 * EXTRA_PRESENCE_SESSION and resolve the generated conclave_ drawables by name (SX8), the API 33 title and subtitle,
 * and auto-enter only while the call is eligible. Params are set only when the model changes, coalesced per main-loop
 * turn. RemoteActions go to CallActionReceiver, which hands them to [handleActionIntent].
 *
 * S70 8 (SYS-8): [suppressForExternalHandoff] wraps every external activity Conclave starts, except Settings, so a
 * chooser, browser, picker or system dialog is never mistaken for Home; resuming restores auto-enter.
 *
 * S30 CC15 and S70 10 d (SYS-10): the MediaProjection consent's suppression is recorded on every API level and held
 * until the consent result returns ([restoreAutoEnterAfterExternalActivity] from ScreenCaptureManager), instead of
 * lapsing after the 2 s hand-off window while the dialog may still be up; a capped safety release covers a result
 * that never arrives.
 */
object PipManager {
    private const val ENTER_AFTER_MINIMAL_LAYOUT_FALLBACK_MS = 180L
    private const val ENTER_RESULT_FALLBACK_MS = 900L
    private const val EXTERNAL_ACTIVITY_SUPPRESSION_MS = 2_000L

    /** Absolute PiP actions (S70 0.5): a stale tap after the state changed elsewhere is a no-op, never an inversion. */
    const val ACTION_PIP_MUTE = "conclave.app.action.PIP_MUTE"
    const val ACTION_PIP_UNMUTE = "conclave.app.action.PIP_UNMUTE"
    const val ACTION_PIP_LEAVE = "conclave.app.action.PIP_LEAVE"
    // One request code per action, distinct from the call notification's (10 to 13), so none replaces another.
    private const val REQUEST_PIP_MUTE = 21
    private const val REQUEST_PIP_UNMUTE = 22
    private const val REQUEST_PIP_LEAVE = 23
    private const val PENDING_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingEnterRunnable: Runnable? = null
    private var suppressionResetRunnable: Runnable? = null
    private var enterAttemptGeneration = 0
    @Volatile private var suppressNextAutoEnter = false
    /** SYS-10: the consent dialog is up; auto-enter stays suppressed until its result (ScreenSharePipPolicy). */
    @Volatile private var consentHold = false
    private var consentHoldCapRunnable: Runnable? = null
    @Volatile private var presence: CallPresence? = null
    private var paramsUpdatePending = false
    private var lastAppliedModel: PipParamsModel? = null
    private var reportedActive = false
    private var reportedAvailability: PipAvailability? = null

    // MARK: CallPresence adapter (S70 0.5 fan-out)

    /**
     * The PiP adapter of the Android adapter set (installed with the call notification adapter). It never observes
     * the snapshot: each change re-derives the params model, and the model's equality guard decides whether the
     * params are set again.
     */
    internal fun presenceAdapter(presence: CallPresence): CallPresenceAdapter {
        this.presence = presence
        return CallPresenceAdapter(name = "pictureInPicture", presenceDidChange = { old, new -> presenceDidChange(old, new) })
    }

    @Suppress("UNUSED_PARAMETER")
    internal fun presenceDidChange(old: CallPresenceSnapshot, new: CallPresenceSnapshot) {
        scheduleParamsUpdate()
        reportAvailability()
    }

    private fun attachedPresence(): CallPresence? = presence ?: CallActionDispatcher.attachedPresence()

    /** The availability reads only package and app-op state, so the application context is enough. */
    private fun anyContext(): Context = ProcessInfo.processInfo.androidContext

    /** S70 0.5 PipAvailability as this adapter reads it (PipAvailabilityPolicy). */
    internal fun availability(context: Context): PipAvailability {
        val snapshot = attachedPresence()?.snapshot
        val phase = snapshot?.phase ?: if (PipController.isInCall) CallPresencePhase.live else CallPresencePhase.idle
        return PipAvailabilityPolicy.availability(
            isSupported = isSupported(context),
            isAllowedByUser = isAllowedByUser(context),
            isSuppressed = suppressNextAutoEnter || consentHold,
            isActive = PipController.inPipMode,
            phase = phase,
        )
    }

    private fun isSupported(context: Context): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    /** The person can turn PiP off for Conclave in system settings (the PiP app-op). */
    private fun isAllowedByUser(context: Context): Boolean {
        val ops = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return true
        val mode = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, Process.myUid(), context.packageName)
            } else {
                @Suppress("DEPRECATION")
                ops.checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, Process.myUid(), context.packageName)
            }
        } catch (t: Throwable) {
            AppOpsManager.MODE_ALLOWED
        }
        return mode == AppOpsManager.MODE_ALLOWED || mode == AppOpsManager.MODE_DEFAULT
    }

    private fun reportAvailability() {
        val target = attachedPresence() ?: return
        val availability = availability(anyContext())
        val active = PipController.inPipMode
        if (active == reportedActive && availability == reportedAvailability) return
        reportedActive = active
        reportedAvailability = availability
        target.reportPictureInPicture(active = active, availability = availability)
    }

    // MARK: Params

    /** The params model for the current call; a legacy stand-in (in call, mute state) before a presence is attached. */
    internal fun currentModel(context: Context, autoEnterOverride: Boolean? = null): PipParamsModel {
        val availability = availability(context)
        val snapshot = attachedPresence()?.snapshot
        val model = if (snapshot != null) {
            PipParamsPolicy.params(snapshot = snapshot, availability = availability)
        } else {
            PipParamsModel(
                presenceSession = -1,
                aspect = PipAspect.standard,
                sourceRect = null,
                actions = PipParamsPolicy.actions(isMuted = PipController.muted, isAttendee = false),
                autoEnterEnabled = availability == PipAvailability.eligible,
                title = "",
                subtitle = PipSubtitleKind.none,
            )
        }
        if (autoEnterOverride == null || autoEnterOverride == model.autoEnterEnabled) return model
        return PipParamsModel(
            presenceSession = model.presenceSession,
            aspect = model.aspect,
            sourceRect = model.sourceRect,
            actions = model.actions,
            autoEnterEnabled = autoEnterOverride && model.autoEnterEnabled,
            title = model.title,
            subtitle = model.subtitle,
        )
    }

    /** The platform params for a model (pure apart from the resolver, so Robolectric can read them back). */
    @RequiresApi(Build.VERSION_CODES.O)
    internal fun buildParams(
        context: Context,
        model: PipParamsModel,
        res: ConclaveResourceResolver,
        fallbackRect: Rect? = null,
    ): PictureInPictureParams {
        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(model.aspect.width, model.aspect.height))
            .setActions(model.actions.toList().map { remoteAction(context, it, model.presenceSession, res) })
        val source = model.sourceRect
        val rect = if (source != null) Rect(source.left, source.top, source.right, source.bottom) else fallbackRect
        if (rect != null) builder.setSourceRectHint(rect)
        val autoEnter = model.autoEnterEnabled
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setSeamlessResizeEnabled(true)
            builder.setAutoEnterEnabled(autoEnter)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // "lily-zoro-iris" with "Muted", "Reconnecting…" or "On hold" (S70 3 b, g).
            if (model.title.isNotEmpty()) builder.setTitle(model.title)
            val subtitleName = PipParamsPolicy.subtitleName(model.subtitle)
            builder.setSubtitle(if (subtitleName.isEmpty()) null else res.string(subtitleName))
        }
        return builder.build()
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun buildParams(activity: Activity, autoEnterOverride: Boolean? = null): PictureInPictureParams {
        val model = currentModel(activity, autoEnterOverride)
        lastAppliedModel = model
        PipController.recordParams(PipParamsPolicy.readout(model))
        return buildParams(activity, model, ContextResourceResolver(activity), fallbackRect = sourceRect(activity))
    }

    /** Coalesces snapshot changes into at most one params update per main-loop turn. */
    private fun scheduleParamsUpdate() {
        if (paramsUpdatePending) return
        paramsUpdatePending = true
        mainHandler.post {
            paramsUpdatePending = false
            applyParamsIfChanged()
        }
    }

    private fun applyParamsIfChanged() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val activity = UIApplication.shared.androidActivity ?: return
        if (activity.isFinishing || activity.isDestroyed) return
        val model = currentModel(activity)
        if (model == lastAppliedModel) return
        try {
            activity.setPictureInPictureParams(buildParams(activity))
        } catch (t: Throwable) {
            debugLog("[PiP] Failed to update picture-in-picture params: ${t}")
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun remoteAction(context: Context, kind: PipActionKind, presenceSession: Int, res: ConclaveResourceResolver): RemoteAction {
        val title = res.string(PipParamsPolicy.actionTitleName(kind))
        val drawable = res.drawable(PipParamsPolicy.actionDrawableName(kind))
        val iconRes = if (drawable != 0) drawable else fallbackIcon(kind)
        return RemoteAction(Icon.createWithResource(context, iconRes), title, title, actionIntent(context, kind, presenceSession))
    }

    /** Only when the generated drawable is missing from the build, so the window never loses its action. */
    private fun fallbackIcon(kind: PipActionKind): Int = when (kind) {
        PipActionKind.mute -> android.R.drawable.ic_lock_silent_mode_off
        PipActionKind.unmute -> android.R.drawable.ic_lock_silent_mode
        PipActionKind.leave -> android.R.drawable.ic_menu_close_clear_cancel
    }

    /** The action broadcast: absolute, keyed on the presence session the window was built in. */
    internal fun actionIntent(context: Context, kind: PipActionKind, presenceSession: Int): PendingIntent {
        val action = when (kind) {
            PipActionKind.mute -> ACTION_PIP_MUTE
            PipActionKind.unmute -> ACTION_PIP_UNMUTE
            PipActionKind.leave -> ACTION_PIP_LEAVE
        }
        val requestCode = when (kind) {
            PipActionKind.mute -> REQUEST_PIP_MUTE
            PipActionKind.unmute -> REQUEST_PIP_UNMUTE
            PipActionKind.leave -> REQUEST_PIP_LEAVE
        }
        val intent = Intent(context, CallActionReceiver::class.java).apply {
            this.action = action
            putExtra(CallActionDispatcher.EXTRA_PRESENCE_SESSION, presenceSession)
        }
        return PendingIntent.getBroadcast(context, requestCode, intent, PENDING_FLAGS)
    }

    /**
     * A PiP RemoteAction reached CallActionReceiver. Returns false for any other intent. Leave call closes the window
     * over the app the person is using (task to the back) once the leave was accepted; Conclave is not brought
     * forward (S70 3 d; today's relaunch was CE E13).
     */
    fun handleActionIntent(intent: Intent): Boolean {
        val kind = when (intent.action) {
            ACTION_PIP_MUTE -> SystemCallCommandKind.mute
            ACTION_PIP_UNMUTE -> SystemCallCommandKind.unmute
            ACTION_PIP_LEAVE -> SystemCallCommandKind.leave
            else -> return false
        }
        val session = intent.getIntExtra(CallActionDispatcher.EXTRA_PRESENCE_SESSION, -1)
        if (session < 0) {
            CallActionDispatcher.handleCurrent(kind, SystemCallSource.pictureInPicture)
        } else {
            CallActionDispatcher.handle(kind, SystemCallSource.pictureInPicture, session)
        }
        if (kind == SystemCallCommandKind.leave) {
            mainHandler.post { closeWindowAfterLeave() }
        }
        return true
    }

    private fun closeWindowAfterLeave() {
        if (CallActionDispatcher.lastResult?.fulfillsSystemAction != true) return
        val activity = UIApplication.shared.androidActivity ?: return
        if (activity.isInPictureInPictureMode) activity.moveTaskToBack(true)
    }

    // MARK: External activities (S70 8; SYS-8)

    /** Every external activity Conclave starts goes through here (ExternalHandoffPolicy: never for Settings). */
    internal fun suppressForExternalHandoff(kind: ExternalHandoffKind) {
        if (!ExternalHandoffPolicy.suppressesAutoEnter(kind)) return
        suppressNextAutoEnter(ExternalHandoffPolicy.reason(kind))
        if (ScreenSharePipPolicy.holdsSuppressionUntilResult(kind)) {
            holdSuppressionUntilResult()
        }
    }

    /**
     * SYS-10 (S30 CC15): keeps the suppression past the 2 s window until the consent result returns. Records no second
     * suppression (`sys.pipSuppressions` counts one per consent).
     */
    private fun holdSuppressionUntilResult() {
        consentHold = true
        suppressionResetRunnable?.let { mainHandler.removeCallbacks(it) }
        suppressionResetRunnable = null
        consentHoldCapRunnable?.let { mainHandler.removeCallbacks(it) }
        val cap = Runnable {
            consentHoldCapRunnable = null
            debugLog("[PiP] Consent suppression reached its cap; restoring auto-enter")
            restoreAutoEnterAfterExternalActivity()
        }
        consentHoldCapRunnable = cap
        mainHandler.postDelayed(cap, ScreenSharePipPolicy.consentHoldCapMs.toLong())
        reportAvailability()
    }

    private fun releaseConsentHold() {
        consentHold = false
        consentHoldCapRunnable?.let { mainHandler.removeCallbacks(it) }
        consentHoldCapRunnable = null
    }

    /** True while the MediaProjection consent keeps auto-enter suppressed (Robolectric, fixtures). */
    internal val isHoldingConsentSuppression: Boolean
        get() = consentHold

    /** Prevent an app-launched chooser/browser from being mistaken for Home. */
    fun suppressNextAutoEnter(reason: String) {
        suppressNextAutoEnter = true
        PipController.recordSuppression(reason)
        // Android 12+ can auto-enter PiP without consulting
        // onUserLeaveHint. Disarm that system path before launching an
        // intentional external Activity; handleActivityResumed restores it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            configureForActiveCall(active = false, muted = PipController.muted)
        }
        suppressionResetRunnable?.let { mainHandler.removeCallbacks(it) }
        val reset = Runnable {
            suppressNextAutoEnter = false
            suppressionResetRunnable = null
            reportAvailability()
        }
        suppressionResetRunnable = reset
        mainHandler.postDelayed(reset, EXTERNAL_ACTIVITY_SUPPRESSION_MS)
        reportAvailability()
        debugLog("[PiP] Suppressing next auto-enter: $reason")
    }

    fun consumeAutoEnterSuppression(): Boolean {
        // The consent dialog's leave hint is not Home, and the hold outlives it until the result returns.
        if (consentHold) return true
        if (!suppressNextAutoEnter) return false
        clearAutoEnterSuppression()
        return true
    }

    /** Restore normal Home-gesture PiP if an external launch fails, or once the consent result returned (SYS-10). */
    fun restoreAutoEnterAfterExternalActivity() {
        releaseConsentHold()
        clearAutoEnterSuppression()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            configureForActiveCall(PipController.isInCall, PipController.muted)
        }
    }

    private fun clearAutoEnterSuppression() {
        suppressNextAutoEnter = false
        suppressionResetRunnable?.let { mainHandler.removeCallbacks(it) }
        suppressionResetRunnable = null
        reportAvailability()
    }

    // MARK: Entry

    /**
     * Configure Android 12+'s system Home-gesture auto-enter. `active` false disarms it; true arms it only while the
     * call is eligible (PipParamsPolicy). `muted` is kept for the legacy call sites; the action follows the snapshot.
     */
    @Suppress("UNUSED_PARAMETER")
    fun configureForActiveCall(active: Boolean, muted: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val activity = UIApplication.shared.androidActivity ?: return
        if (activity.isFinishing || activity.isDestroyed) return
        try {
            activity.setPictureInPictureParams(buildParams(activity, autoEnterOverride = if (active) null else false))
        } catch (t: Throwable) {
            debugLog("[PiP] Failed to configure auto-enter: ${t}")
        }
    }

    /**
     * Back at the call root with no panel open, and the Minimize button (S70 D9, S20 1 a): PiP when eligible and
     * allowed, else the task moves to the back. Never a leave. A failed entry also moves the task to the back (3 j).
     */
    fun minimizeCurrent() {
        val activity = UIApplication.shared.androidActivity ?: return
        minimize(activity)
    }

    fun minimize(activity: Activity) {
        val action = PipEntryPolicy.minimize(availability = availability(activity))
        if (action == PipMinimizeAction.enterPictureInPicture && enterDirectly(activity)) return
        activity.moveTaskToBack(true)
    }

    private fun enterDirectly(activity: Activity): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        if (activity.isFinishing || activity.isDestroyed) return false
        return try {
            activity.enterPictureInPictureMode(buildParams(activity))
        } catch (t: Throwable) {
            debugLog("[PiP] Failed to enter picture-in-picture from Back: ${t}")
            false
        }
    }

    // Enter PiP for an active call (API 28 to 30 onUserLeaveHint). Safe to call only on API 26+.
    @RequiresApi(Build.VERSION_CODES.O)
    fun enterPip(activity: Activity, muted: Boolean) {
        cancelPendingEnterPip()
        val generation = enterAttemptGeneration
        if (!PipController.isInCall || activity.isFinishing || activity.isDestroyed) {
            PipController.inPipMode = activity.isInPictureInPictureMode
            return
        }
        if (!isSupported(activity) || !isAllowedByUser(activity)) {
            // Disabled by the person or unsupported: the call stays in the background, audio only.
            PipController.inPipMode = activity.isInPictureInPictureMode
            return
        }

        // Switch Compose to the minimal active-speaker surface before asking
        // Android to snapshot the activity into PiP. Keep the renderer surface
        // stable here; recreating it during entry can produce visible black
        // flashes on some devices. The native call root stays composed instead.
        PipController.inPipMode = true
        refreshPipContent()
        scheduleEnterAfterMinimalLayout(activity, muted, generation)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun scheduleEnterAfterMinimalLayout(activity: Activity, muted: Boolean, generation: Int) {
        val enter = object : Runnable {
            override fun run() {
                if (pendingEnterRunnable !== this) return
                if (generation != enterAttemptGeneration) return
                pendingEnterRunnable = null
                enterPreparedPip(activity, muted, generation)
            }
        }
        pendingEnterRunnable = enter

        val decorView = activity.window?.decorView
        if (decorView != null) {
            decorView.postOnAnimation {
                decorView.postOnAnimation {
                    enter.run()
                }
            }
        }

        mainHandler.postDelayed(enter, ENTER_AFTER_MINIMAL_LAYOUT_FALLBACK_MS)
    }

    @Suppress("UNUSED_PARAMETER")
    @RequiresApi(Build.VERSION_CODES.O)
    private fun enterPreparedPip(activity: Activity, muted: Boolean, generation: Int) {
        cancelPendingEnterPip(invalidateAttempt = false)
        if (generation != enterAttemptGeneration) return
        if (!PipController.isInCall || activity.isFinishing || activity.isDestroyed) {
            PipController.inPipMode = activity.isInPictureInPictureMode
            return
        }
        if (activity.isInPictureInPictureMode) {
            PipController.inPipMode = true
            refreshPipContent()
            return
        }

        try {
            val requested = activity.enterPictureInPictureMode(buildParams(activity))
            if (!requested) {
                PipController.inPipMode = activity.isInPictureInPictureMode
                return
            }
            mainHandler.post {
                if (generation != enterAttemptGeneration) return@post
                if (activity.isInPictureInPictureMode) {
                    PipController.inPipMode = true
                    refreshPipContent()
                }
            }
            mainHandler.postDelayed({
                if (generation != enterAttemptGeneration) return@postDelayed
                if (!PipController.isInCall || activity.isFinishing || activity.isDestroyed) {
                    PipController.inPipMode = activity.isInPictureInPictureMode
                    return@postDelayed
                }
                if (activity.isInPictureInPictureMode) {
                    PipController.inPipMode = true
                    refreshPipContent()
                } else {
                    PipController.inPipMode = false
                }
            }, ENTER_RESULT_FALLBACK_MS)
        } catch (t: Throwable) {
            PipController.inPipMode = activity.isInPictureInPictureMode
            debugLog("[PiP] Failed to enter picture-in-picture: ${t}")
        }
    }

    // Update the PiP RemoteActions while already in PiP. API 26+.
    @Suppress("UNUSED_PARAMETER")
    @RequiresApi(Build.VERSION_CODES.O)
    fun updateActions(activity: Activity, muted: Boolean) {
        try {
            activity.setPictureInPictureParams(buildParams(activity))
        } catch (t: Throwable) {
            debugLog("[PiP] Failed to update picture-in-picture actions: ${t}")
        }
    }

    // Refresh Mute/Unmute while in PiP. No-op without an Activity or on pre-26.
    fun refreshActions(muted: Boolean) {
        if (Build.VERSION.SDK_INT < 26) return
        val activity = UIApplication.shared.androidActivity ?: return
        updateActions(activity, muted)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    fun handleActivityResumed(activity: Activity) {
        if (activity.isInPictureInPictureMode) return
        // A resume while the consent is still up (multi-window) keeps the hold; any other resume ends it.
        if (consentHold && !ScreenCaptureManager.isAwaitingConsent()) {
            releaseConsentHold()
        }
        clearAutoEnterSuppression()
        val wasInPip = PipController.inPipMode
        cancelPendingEnterPip()
        PipController.inPipMode = false
        PipController.setPictureInPictureUiState(stashed = false, transitioningToPip = false)
        if (wasInPip) {
            CallActionDispatcher.pictureInPictureContentRefresh()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            configureForActiveCall(PipController.isInCall, PipController.muted)
        }
        reportAvailability()
    }

    @RequiresApi(Build.VERSION_CODES.O)
    fun handlePictureInPictureModeChanged(activity: Activity, inPip: Boolean, muted: Boolean) {
        PipController.inPipMode = inPip
        if (!inPip) {
            PipController.setPictureInPictureUiState(stashed = false, transitioningToPip = false)
            reportAvailability()
        }
        if (!inPip) {
            cancelPendingEnterPip()
            CallActionDispatcher.pictureInPictureContentRefresh()
            return
        }
        cancelPendingEnterPip()
        updateActions(activity, muted)
        refreshPipContent()
        reportAvailability()
    }

    /**
     * Activity.onPictureInPictureUiStateChanged (API 31; `isTransitioningToPip` is API 35, D-13): the native root
     * hides its chrome as soon as the transition starts; below 35 it hides on the mode change.
     */
    fun handlePictureInPictureUiStateChanged(stashed: Boolean, transitioningToPip: Boolean) {
        PipController.setPictureInPictureUiState(stashed = stashed, transitioningToPip = transitioningToPip)
    }

    // S70 3 d, 3 f: a call that ends in PiP closes the window and moves the
    // task to the back; the outcome or Home waits for the person's return.
    // Android has no direct exit-PiP API, and relaunching the activity would
    // bring Conclave full screen over the app the person is using (CE E13).
    fun exitPip() {
        cancelPendingEnterPip()
        if (Build.VERSION.SDK_INT < 26) return
        val activity = UIApplication.shared.androidActivity ?: return
        if (!activity.isInPictureInPictureMode) return
        try {
            activity.moveTaskToBack(true)
        } catch (t: Throwable) {
            debugLog("[PiP] Failed to close picture-in-picture: ${t}")
        }
    }

    private fun cancelPendingEnterPip(invalidateAttempt: Boolean = true) {
        pendingEnterRunnable?.let { mainHandler.removeCallbacks(it) }
        pendingEnterRunnable = null
        if (invalidateAttempt) {
            enterAttemptGeneration += 1
        }
    }

    private fun refreshPipContentSurface(recreateSurface: Boolean = false) {
        PipController.refreshPipContent(recreateSurface = recreateSurface)
        CallActionDispatcher.pictureInPictureContentRefresh()
    }

    private fun refreshPipContent() {
        refreshPipContentSurface(recreateSurface = false)
    }

    /** The activity's own bounds: the source rect until the target slot is laid out (and for the legacy root). */
    private fun sourceRect(activity: Activity): Rect? {
        val decorView = activity.window?.decorView ?: return null
        val rect = Rect()
        return if (decorView.getGlobalVisibleRect(rect) && !rect.isEmpty) rect else null
    }
}

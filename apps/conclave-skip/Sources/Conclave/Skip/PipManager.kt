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

object PipManager {
    private const val ENTER_AFTER_MINIMAL_LAYOUT_FALLBACK_MS = 180L
    private const val ENTER_RESULT_FALLBACK_MS = 900L
    private const val EXTERNAL_ACTIVITY_SUPPRESSION_MS = 2_000L

    const val ACTION_PIP_MUTE = "conclave.app.action.PIP_MUTE"
    const val ACTION_PIP_UNMUTE = "conclave.app.action.PIP_UNMUTE"
    const val ACTION_PIP_LEAVE = "conclave.app.action.PIP_LEAVE"

    private const val REQUEST_PIP_MUTE = 21
    private const val REQUEST_PIP_UNMUTE = 22
    private const val REQUEST_PIP_LEAVE = 23
    private const val PENDING_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingEnterRunnable: Runnable? = null
    private var suppressionResetRunnable: Runnable? = null
    private var enterAttemptGeneration = 0
    @Volatile private var suppressNextAutoEnter = false

    @Volatile private var consentHold = false
    private var consentHoldCapRunnable: Runnable? = null
    @Volatile private var presence: CallPresence? = null
    private var paramsUpdatePending = false
    private var lastAppliedModel: PipParamsModel? = null
    private var reportedActive = false
    private var reportedAvailability: PipAvailability? = null

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

    private fun anyContext(): Context = ProcessInfo.processInfo.androidContext

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

    private fun fallbackIcon(kind: PipActionKind): Int = when (kind) {
        PipActionKind.mute -> android.R.drawable.ic_lock_silent_mode_off
        PipActionKind.unmute -> android.R.drawable.ic_lock_silent_mode
        PipActionKind.leave -> android.R.drawable.ic_menu_close_clear_cancel
    }

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

    internal fun suppressForExternalHandoff(kind: ExternalHandoffKind) {
        if (!ExternalHandoffPolicy.suppressesAutoEnter(kind)) return
        suppressNextAutoEnter(ExternalHandoffPolicy.reason(kind))
        if (ScreenSharePipPolicy.holdsSuppressionUntilResult(kind)) {
            holdSuppressionUntilResult()
        }
    }

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

    internal val isHoldingConsentSuppression: Boolean
        get() = consentHold

    fun suppressNextAutoEnter(reason: String) {
        suppressNextAutoEnter = true
        PipController.recordSuppression(reason)

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

        if (consentHold) return true
        if (!suppressNextAutoEnter) return false
        clearAutoEnterSuppression()
        return true
    }

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

    @RequiresApi(Build.VERSION_CODES.O)
    fun enterPip(activity: Activity, muted: Boolean) {
        cancelPendingEnterPip()
        val generation = enterAttemptGeneration
        if (!PipController.isInCall || activity.isFinishing || activity.isDestroyed) {
            PipController.inPipMode = activity.isInPictureInPictureMode
            return
        }
        if (!isSupported(activity) || !isAllowedByUser(activity)) {

            PipController.inPipMode = activity.isInPictureInPictureMode
            return
        }

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

    @Suppress("UNUSED_PARAMETER")
    @RequiresApi(Build.VERSION_CODES.O)
    fun updateActions(activity: Activity, muted: Boolean) {
        try {
            activity.setPictureInPictureParams(buildParams(activity))
        } catch (t: Throwable) {
            debugLog("[PiP] Failed to update picture-in-picture actions: ${t}")
        }
    }

    fun refreshActions(muted: Boolean) {
        if (Build.VERSION.SDK_INT < 26) return
        val activity = UIApplication.shared.androidActivity ?: return
        updateActions(activity, muted)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    fun handleActivityResumed(activity: Activity) {
        if (activity.isInPictureInPictureMode) return

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

    fun handlePictureInPictureUiStateChanged(stashed: Boolean, transitioningToPip: Boolean) {
        PipController.setPictureInPictureUiState(stashed = stashed, transitioningToPip = transitioningToPip)
    }

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

    private fun sourceRect(activity: Activity): Rect? {
        val decorView = activity.window?.decorView ?: return null
        val rect = Rect()
        return if (decorView.getGlobalVisibleRect(rect) && !rect.isEmpty) rect else null
    }
}

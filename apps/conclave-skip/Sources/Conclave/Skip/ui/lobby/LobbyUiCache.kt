package conclave.module

internal data class LobbyCardUi(
    val routeId: Int,

    val micOn: Boolean,
    val cameraOn: Boolean,
    val micPermission: MediaPermissionState,
    val cameraPermission: MediaPermissionState,
    val canAskAgain: Boolean,
    val preview: PreviewState,
    val previewSessionId: Int,
    val isFrontCamera: Boolean,
    val showsEffects: Boolean,
    val effectsActive: Boolean,
    val avatarName: String,
    val avatarSeed: String,

    val canAskAgainMicrophone: Boolean,
    val canAskAgainCamera: Boolean,
    val cameraPriming: PermissionPrimingKind,
    val micReason: PermissionPrimingKind,
    val cameraReason: PermissionPrimingKind,
) {
    val showsSurface: Boolean
        get() = preview == PreviewState.live || preview == PreviewState.interrupted || preview == PreviewState.published
    val isCameraBlocked: Boolean
        get() = cameraPermission == MediaPermissionState.denied || cameraPermission == MediaPermissionState.restricted

    val showsCameraOverlay: Boolean
        get() = preview == PreviewState.blocked
}

internal data class LobbyStatusUi(
    val routeId: Int,
    val intent: LobbyIntent,
    val mode: LobbyMode,
    val issue: LobbyIssue,
    val issueServerText: String,
    val isPrimaryEnabled: Boolean,
    val isPrimaryPending: Boolean,
    val reason: LobbyPrimaryReason,
    val isReconnecting: Boolean,

    val showsSlowNotice: Boolean,
    val waitingKind: WaitingKind,
    val waitingText: String,
) {
    val isBusy: Boolean
        get() = mode == LobbyMode.connecting || mode == LobbyMode.waiting
}

internal class LobbyUiCache {
    private var lastMedia: LobbyMediaSnapshot? = null
    private var lastCard: LobbyCardUi? = null
    private var lastStatus: LobbyStatusSnapshot? = null
    private var lastStatusUi: LobbyStatusUi? = null

    var builds: Int = 0
        private set

    fun card(media: LobbyMediaSnapshot): LobbyCardUi {
        val cached = lastCard
        if (cached != null && media == lastMedia) return cached
        val rationale = PermissionPrimingPolicy.platformSupportsRationale
        val next = LobbyCardUi(
            routeId = media.routeId,
            micOn = PermissionPrimingPolicy.displaysOn(intentOn = media.micIntentOn, permission = media.micPermission,
                canAskAgain = media.canAskAgainMicrophone),
            cameraOn = PermissionPrimingPolicy.displaysOn(intentOn = media.cameraIntentOn, permission = media.cameraPermission,
                canAskAgain = media.canAskAgainCamera),
            micPermission = media.micPermission,
            cameraPermission = media.cameraPermission,
            canAskAgain = media.canAskAgainAndroid,
            preview = media.preview,
            previewSessionId = media.previewSessionId,
            isFrontCamera = media.isFrontCamera,
            showsEffects = media.showsEffects,
            effectsActive = media.effectsActive,
            avatarName = media.avatarName,
            avatarSeed = media.avatarSeed,
            canAskAgainMicrophone = media.canAskAgainMicrophone,
            canAskAgainCamera = media.canAskAgainCamera,
            cameraPriming = PermissionPrimingPolicy.priming(permission = media.cameraPermission,
                canAskAgain = media.canAskAgainCamera, supportsRationale = rationale, rationaleDismissed = false),
            micReason = PermissionPrimingPolicy.toggleReason(permission = media.micPermission,
                canAskAgain = media.canAskAgainMicrophone, supportsRationale = rationale),
            cameraReason = PermissionPrimingPolicy.toggleReason(permission = media.cameraPermission,
                canAskAgain = media.canAskAgainCamera, supportsRationale = rationale),
        )
        builds += 1
        lastMedia = media

        val result = if (cached != null && cached == next) cached else next
        lastCard = result
        return result
    }

    fun status(status: LobbyStatusSnapshot): LobbyStatusUi {
        val cached = lastStatusUi
        if (cached != null && status == lastStatus) return cached
        val next = LobbyStatusUi(
            routeId = status.routeId,
            intent = status.intent,
            mode = status.mode,
            issue = status.issue,
            issueServerText = status.issueServerText,
            isPrimaryEnabled = status.isPrimaryEnabled,
            isPrimaryPending = status.isPrimaryPending,
            reason = LobbyPrimaryReason(rawValue = status.primaryReason) ?: LobbyPrimaryReason.none,
            isReconnecting = status.waitingKind == WaitingKind.reconnecting,
            showsSlowNotice = status.showsSlowNotice,
            waitingKind = status.waitingKind,
            waitingText = status.waitingText,
        )
        builds += 1
        lastStatus = status
        val result = if (cached != null && cached == next) cached else next
        lastStatusUi = result
        return result
    }
}

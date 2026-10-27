package conclave.module

/*
 * ENT-3 (S10 0.6 L12, 6 k): plain Kotlin values for the lobby composables, built once per snapshot change and reused
 * while the snapshot is equal (S1C 3.5), so the card and the bottom bar take Kotlin data classes, never the transpiled
 * Swift structs. No @Immutable or @Stable claims (R14): equality and instance reuse do the work.
 */

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
) {
    val showsSurface: Boolean
        get() = preview == PreviewState.live || preview == PreviewState.interrupted || preview == PreviewState.published
    val isCameraBlocked: Boolean
        get() = cameraPermission == MediaPermissionState.denied || cameraPermission == MediaPermissionState.restricted
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
    // ENT-5 (S10 8 c, 9 f): the slow footnote, the waiting body's kind and its clean server sentence.
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

    /** Builds count (Robolectric: an equal snapshot reuses the instance). */
    var builds: Int = 0
        private set

    fun card(media: LobbyMediaSnapshot): LobbyCardUi {
        val cached = lastCard
        if (cached != null && media == lastMedia) return cached
        val next = LobbyCardUi(
            routeId = media.routeId,
            micOn = media.micIntentOn,
            cameraOn = media.cameraIntentOn,
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
        )
        builds += 1
        lastMedia = media
        // Keep the old instance when only fields outside the card changed.
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

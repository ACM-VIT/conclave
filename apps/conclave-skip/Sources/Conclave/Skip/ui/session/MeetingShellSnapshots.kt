package conclave.module

/*
 * WP2-S1 Kotlin DTO boundary (contract-wp2-first-slice 3.5). Plain Kotlin values and caches over the transpiled
 * MeetingShellPresenter for the handwritten Compose shells. No composables, no listeners, and no @Stable or
 * @Immutable on Skip collections (R14): only Kotlin scalars cross into row composables, and the backing list never
 * escapes a snapshot.
 */

/** One control row as Kotlin scalars; enum fields stay their transpiled Swift enums (String raw values). */
internal data class MeetingControlRowUi(
    val id: String,
    val isVisible: Boolean,
    val isOn: Boolean,
    val isEnabled: Boolean,
    val isPending: Boolean,
    val blockedReason: MeetingBlockedReason,
    val hint: MeetingControlHint,
    val badgeCount: Int,
    val failure: MeetingActionFailure,
    /** WP2-S2a (S30 CC3): raise or lower for a hand failure, none otherwise. */
    val failureDirection: MeetingActionDirection,
) {
    fun matches(row: MeetingControlRow): Boolean =
        id == row.id && isVisible == row.isVisible && isOn == row.isOn && isEnabled == row.isEnabled &&
            isPending == row.isPending && blockedReason == row.blockedReason && hint == row.hint &&
            badgeCount == row.badgeCount && failure == row.failure && failureDirection == row.failureDirection

    companion object {
        fun from(row: MeetingControlRow): MeetingControlRowUi = MeetingControlRowUi(
            id = row.id,
            isVisible = row.isVisible,
            isOn = row.isOn,
            isEnabled = row.isEnabled,
            isPending = row.isPending,
            blockedReason = row.blockedReason,
            hint = row.hint,
            badgeCount = row.badgeCount,
            failure = row.failure,
            failureDirection = row.failureDirection,
        )
    }
}

/**
 * Per-row reuse: a row whose Swift value is unchanged keeps the previous snapshot's exact instance, found by id, so
 * only the changed row's composables see a new value under key(id). Ids and order are fixed (S1C ROW).
 */
internal class MeetingControlRows(source: MeetingControlRowsState, previous: MeetingControlRows? = null) {
    val revision: Int = source.revision
    private val rows: List<MeetingControlRowUi> = buildList {
        val prior = previous?.rows?.associateBy { it.id }
        for (row in source.rows) {
            val reused = prior?.get(row.id)
            if (reused != null && reused.matches(row)) {
                add(reused)
            } else {
                add(MeetingControlRowUi.from(row))
            }
        }
    }
    val size: Int get() = rows.size
    operator fun get(index: Int): MeetingControlRowUi = rows[index]

    /** The row for a control id, or null. */
    fun row(id: MeetingControlID): MeetingControlRowUi? = rows.firstOrNull { it.id == id.rawValue }
}

/** One cache per presenter lifetime (remember(presenter)). A cache hit still reads the observed property. */
internal class MeetingControlRowsCache(private val presenter: MeetingShellPresenter) {
    private var cached: MeetingControlRows? = null

    fun current(): MeetingControlRows {
        // Always read the observed property, even on a cache hit, to keep Compose subscribed.
        val state = presenter.controls
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return MeetingControlRows(state, previous).also { cached = it }
    }
}

/** The session snapshot as Kotlin scalars for the shells (phase routing, notice, outcome, role, confirmation). */
internal data class MeetingSessionUi(
    val revision: Int,
    val callSession: Int,
    val attempt: Int,
    val phase: MeetingPhaseKind,
    val notice: MeetingNoticeKind,
    val noticeText: String?,
    val outcomeId: Int,
    val outcomeKind: MeetingTerminalOutcomeKind?,
    val roomLabel: String,
    val isLocalHost: Boolean,
    val isWebinarAttendee: Boolean,
    val canEndForEveryone: Boolean,
    val confirmationId: Int,
    /** A MeetingConfirmationInvoker value (S50 PH17): "call", "more" or "hostControls"; null without a dialog. */
    val confirmationInvoker: String?,
    /** WP2-S2a (S10 R6 c): the root keeps the call root for recovering only while this is true. */
    val hasBeenAdmittedThisSession: Boolean,
    val entryOrigin: MeetingEntryOrigin,
) {
    companion object {
        fun from(snapshot: MeetingSessionSnapshot): MeetingSessionUi = MeetingSessionUi(
            revision = snapshot.revision,
            callSession = snapshot.identity.callSession,
            attempt = snapshot.identity.attempt,
            phase = snapshot.phase,
            notice = snapshot.notice,
            noticeText = snapshot.noticeText,
            outcomeId = snapshot.outcome?.id ?: 0,
            outcomeKind = snapshot.outcome?.kind,
            roomLabel = snapshot.roomLabel,
            isLocalHost = snapshot.isLocalHost,
            isWebinarAttendee = snapshot.isWebinarAttendee,
            canEndForEveryone = snapshot.canEndForEveryone,
            confirmationId = snapshot.confirmation?.id ?: 0,
            confirmationInvoker = snapshot.confirmation?.invoker,
            hasBeenAdmittedThisSession = snapshot.hasBeenAdmittedThisSession,
            entryOrigin = snapshot.entryOrigin,
        )
    }
}

/** One cache per presenter lifetime; rebuilds only when the session revision changes. */
internal class MeetingSessionCache(private val presenter: MeetingShellPresenter) {
    private var cached: MeetingSessionUi? = null

    fun current(): MeetingSessionUi {
        val snapshot = presenter.session
        val previous = cached
        if (previous != null && previous.revision == snapshot.revision) return previous
        return MeetingSessionUi.from(snapshot).also { cached = it }
    }
}

/** The entry snapshot as Kotlin scalars (preserved join input, form error, entry overlay intent). */
internal data class MeetingEntryUi(
    val roomId: String,
    val displayName: String,
    val micIntentOn: Boolean,
    val cameraIntentOn: Boolean,
    val formError: String?,
    val showsEntryOverlayIntent: Boolean,
) {
    companion object {
        fun from(snapshot: MeetingEntrySnapshot): MeetingEntryUi = MeetingEntryUi(
            roomId = snapshot.roomId,
            displayName = snapshot.displayName,
            micIntentOn = snapshot.micIntentOn,
            cameraIntentOn = snapshot.cameraIntentOn,
            formError = snapshot.formError,
            showsEntryOverlayIntent = snapshot.showsEntryOverlayIntent,
        )
    }
}

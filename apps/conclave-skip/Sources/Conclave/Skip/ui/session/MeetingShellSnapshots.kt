package conclave.module

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

    fun row(id: MeetingControlID): MeetingControlRowUi? = rows.firstOrNull { it.id == id.rawValue }
}

internal class MeetingControlRowsCache(private val presenter: MeetingShellPresenter) {
    private var cached: MeetingControlRows? = null

    fun current(): MeetingControlRows {

        val state = presenter.controls
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return MeetingControlRows(state, previous).also { cached = it }
    }
}

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

    val confirmationInvoker: String?,

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

internal class MeetingSessionCache(private val presenter: MeetingShellPresenter) {
    private var cached: MeetingSessionUi? = null

    fun current(): MeetingSessionUi {
        val snapshot = presenter.session
        val previous = cached
        if (previous != null && previous.revision == snapshot.revision) return previous
        return MeetingSessionUi.from(snapshot).also { cached = it }
    }
}

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

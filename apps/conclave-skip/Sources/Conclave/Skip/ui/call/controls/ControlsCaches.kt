package conclave.module

/*
 * S30 CL14 (CTL-1): Kotlin caches over the transpiled CallControlsPresenter, on the NativeHostingRowsCache pattern
 * (K/ui/hosting/NativeHostingRows.kt): one cache per presenter lifetime (remember(controls)); every read goes through
 * the observed property, even on a hit, so Compose stays subscribed; a snapshot rebuilds only on a new revision and an
 * unchanged control keeps its exact CallControlUi instance, so only the changed cell recomposes under key(id). Only
 * Kotlin scalars and transpiled String enums cross into the cell composables; no stability annotations on Skip
 * collections (R14). CTL-2 reads LeaveCache in LeaveControl.kt; CTL-5 and CTL-6 (MoreSheet.kt) read MoreCache and
 * ReactionsCache; CTL-3 adds AudioRouteCache.
 */

/** One bar control as Kotlin scalars. `gesture` is ControlBarPolicy.gestureKind for the model (S30 1 h). */
internal data class CallControlUi(
    val id: String,
    val kind: CallControlKind,
    val isOn: Boolean,
    val visual: CallControlVisual,
    val isBlocked: Boolean,
    val isPending: Boolean,
    val reason: ControlBlockedReason,
    val reasonName: String,
    val appliesAfterReconnect: Boolean,
    val badgeCount: Int,
    val showsDot: Boolean,
    val hasShortcut: Boolean,
    val gesture: FeedbackKind?,
) {
    fun matches(model: CallControlModel): Boolean =
        id == model.id && kind == model.kind && isOn == model.isOn && visual == model.visual && isBlocked == model.isBlocked &&
            isPending == model.isPending && reason == model.reason && reasonName == model.reasonName &&
            appliesAfterReconnect == model.appliesAfterReconnect && badgeCount == model.badgeCount &&
            showsDot == model.showsDot && hasShortcut == model.hasShortcut

    /** The bar's leaving state: every control is disabled, not explained (S30 1 f). */
    val isLeaving: Boolean get() = reason == ControlBlockedReason.leaving

    companion object {
        fun from(model: CallControlModel): CallControlUi = CallControlUi(
            id = model.id,
            kind = model.kind,
            isOn = model.isOn,
            visual = model.visual,
            isBlocked = model.isBlocked,
            isPending = model.isPending,
            reason = model.reason,
            reasonName = model.reasonName,
            appliesAfterReconnect = model.appliesAfterReconnect,
            badgeCount = model.badgeCount,
            showsDot = model.showsDot,
            hasShortcut = model.hasShortcut,
            gesture = ControlBarPolicy.gestureKind(model),
        )
    }
}

/** `controls.bar` as Kotlin values; `snapshot` stays the transpiled value for the shared fit arithmetic. */
internal class ControlBarUi(source: ControlBarSnapshot, previous: ControlBarUi? = null) {
    val snapshot: ControlBarSnapshot = source
    val revision: Int = source.revision
    val composition: ControlBarComposition = source.composition
    val axis: ControlBarAxis = source.axis
    val controls: List<CallControlUi> = buildList {
        val prior = previous?.controls?.associateBy { it.id }
        for (model in source.controls) {
            val reused = prior?.get(model.id)
            if (reused != null && reused.matches(model)) add(reused) else add(CallControlUi.from(model))
        }
    }

    fun control(kind: CallControlKind): CallControlUi? = controls.firstOrNull { it.kind == kind }
}

internal class ControlBarCache(private val presenter: CallControlsPresenter) {
    private var cached: ControlBarUi? = null

    fun current(): ControlBarUi {
        // Always read the observed property, even on a cache hit, to keep Compose subscribed.
        val state = presenter.bar
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return ControlBarUi(state, previous).also { cached = it }
    }
}

/**
 * `controls.leaveState` as Kotlin values (CTL-2's Leave control, host menu and End dialog read it). `snapshot` stays the
 * transpiled value for the shared LeaveControlPolicy (menu rows, the End action, which dialogs this control presents).
 */
internal data class LeaveUi(
    val revision: Int,
    val canEndForEveryone: Boolean,
    val leavePhase: LeavePhase,
    val endPhase: EndPhase,
    val confirmationId: Int,
    val confirmationInvoker: String,
    val offersRecap: Boolean,
    val endFailure: String,
    val showsEndForEveryone: Boolean,
    val endBlockedReason: ControlBlockedReason,
    val snapshot: LeaveSnapshot,
) {
    val isLeaving: Boolean get() = leavePhase == LeavePhase.leaving

    companion object {
        fun from(snapshot: LeaveSnapshot): LeaveUi = LeaveUi(
            revision = snapshot.revision,
            canEndForEveryone = snapshot.canEndForEveryone,
            leavePhase = snapshot.leavePhase,
            endPhase = snapshot.endPhase,
            confirmationId = snapshot.confirmationId,
            confirmationInvoker = snapshot.confirmationInvoker,
            offersRecap = snapshot.offersRecap,
            endFailure = snapshot.endFailure,
            showsEndForEveryone = snapshot.showsEndForEveryone,
            endBlockedReason = snapshot.endBlockedReason,
            snapshot = snapshot,
        )
    }
}

internal class LeaveCache(private val presenter: CallControlsPresenter) {
    private var cached: LeaveUi? = null

    fun current(): LeaveUi {
        val state = presenter.leaveState
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return LeaveUi.from(state).also { cached = it }
    }
}

/**
 * `controls.more` as Kotlin values (CTL-5, CL14): the tiles in the S30 5 d order and the host rows from the shared
 * MoreMenuPolicy, so the sheet never re-derives order or visibility. `snapshot` stays the transpiled value.
 */
internal class MoreUi(source: MoreSnapshot) {
    val snapshot: MoreSnapshot = source
    val revision: Int = source.revision
    val isRecovering: Boolean = source.isRecovering
    val meetingLink: String = source.meetingLink
    val roomLabel: String = source.roomLabel
    val layoutMode: String = source.layoutMode
    val hasHostSection: Boolean = source.hasHostSection
    val tiles: List<MoreItem> = buildList { for (item in MoreMenuPolicy.tiles(source)) add(item) }
    val hostItems: List<MoreItem> = buildList { for (item in MoreMenuPolicy.hostItems(source)) add(item) }

    fun item(id: MoreItemID): MoreItem? = snapshot.item(id)

    fun opensPanel(id: MoreItemID): Boolean = MoreMenuPolicy.opensPanel(id)
}

internal class MoreCache(private val presenter: CallControlsPresenter) {
    private var cached: MoreUi? = null

    fun current(): MoreUi {
        // Always read the observed property, even on a cache hit, to keep Compose subscribed.
        val state = presenter.more
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return MoreUi(state).also { cached = it }
    }
}

/** `controls.reactions` as Kotlin values (CTL-6, CL14): read only by the reaction rows, so sends never touch the tiles. */
internal class ReactionsUi(source: ReactionPaletteSnapshot) {
    val revision: Int = source.revision
    val availability: ReactionAvailability = source.availability
    val isAvailable: Boolean = source.isAvailable
    val emoji: List<ReactionOptionModel> = buildList { for (option in source.emoji) add(option) }
    val art: List<ReactionOptionModel> = buildList { for (option in source.art) add(option) }
}

internal class ReactionsCache(private val presenter: CallControlsPresenter) {
    private var cached: ReactionsUi? = null

    fun current(): ReactionsUi {
        val state = presenter.reactions
        val previous = cached
        if (previous != null && previous.revision == state.revision) return previous
        return ReactionsUi(state).also { cached = it }
    }
}

package conclave.module

/*
 * S60 0.6 L6-14 (TRN-2) on Android: the one exhaustive copy mapping for the Transcript panel. Every typed phase, reason
 * and kind the transpiled TranscriptPresenter publishes resolves here to an app-module string resource name (Material
 * sentence case, prefix trn_; the End dialog recap variant keeps the S30 ctl_ names), which composition resolves
 * through conclaveString. T/Skip/TRN2TranscriptBridgeTests.kt enumerates every case. Provider and model names
 * (OpenAI, Sarvam, GPT-5.6 Terra) are product names and stay verbatim. The iOS twin is
 * S/Features/Meeting/Transcript/TranscriptCopy+iOS.swift.
 */
internal object TranscriptCopy {
    fun tab(tab: TranscriptTab): String = when (tab) {
        TranscriptTab.transcript -> "trn_tab_transcript"
        TranscriptTab.ask -> "trn_tab_ask"
        TranscriptTab.minutes -> "trn_tab_minutes"
    }

    fun startTitle(kind: TranscriptStartKind): String = when (kind) {
        TranscriptStartKind.start -> "trn_turn_on"
        TranscriptStartKind.takeover -> "trn_pick_up"
    }

    fun startButton(kind: TranscriptStartKind): String = when (kind) {
        TranscriptStartKind.start -> "trn_start"
        TranscriptStartKind.takeover -> "trn_resume_notes"
    }

    fun blurb(blurb: TranscriptBlurb): String = when (blurb) {
        TranscriptBlurb.turnOn -> "trn_blurb_turn_on"
        TranscriptBlurb.takeoverCovered -> "trn_blurb_takeover_covered"
        TranscriptBlurb.takeoverBringKey -> "trn_blurb_takeover_key"
        TranscriptBlurb.viewOnly -> "trn_blurb_view_only"
    }

    fun coverage(coverage: KeyCoverage): String = when (coverage) {
        KeyCoverage.unknown -> "trn_checking_keys"
        KeyCoverage.covered -> "trn_coverage_covered"
        KeyCoverage.sarvamNeedsOpenAI -> "trn_coverage_sarvam"
        KeyCoverage.needsKeys -> "trn_coverage_keys"
    }

    /** The status bar's state text; null when the bar shows no state. */
    fun status(status: TranscriptStatusKind): String? = when (status) {
        TranscriptStatusKind.none -> null
        TranscriptStatusKind.starting -> "trn_starting"
        TranscriptStatusKind.live -> "trn_status_live"
        TranscriptStatusKind.paused -> "trn_status_paused"
        TranscriptStatusKind.stopping -> "trn_status_stopping"
        TranscriptStatusKind.reconnecting -> "trn_status_reconnecting"
        TranscriptStatusKind.ended -> "trn_status_ended"
    }

    /** "Hosted by %1$s" takes the controller's name; null when there is no host line. */
    fun host(host: TranscriptHostKind): String? = when (host) {
        TranscriptHostKind.none -> null
        TranscriptHostKind.you -> "trn_hosted_you"
        TranscriptHostKind.named -> "trn_hosted_by"
        TranscriptHostKind.following -> "trn_following"
    }

    /** The issue banner; null for none and for the server case (shown verbatim). */
    fun issue(issue: TranscriptIssue): String? = when (issue) {
        TranscriptIssue.none -> null
        TranscriptIssue.noPermission -> "trn_issue_permission"
        TranscriptIssue.controlsReconnecting -> "trn_issue_reconnecting"
        TranscriptIssue.relayFailed -> "trn_issue_relay"
        TranscriptIssue.server -> null
    }

    /** A settled Ask row's line (the worker text wins for an error when it has some); null for live states. */
    fun askState(state: AskRowState): String? = when (state) {
        AskRowState.thinking -> "trn_thinking"
        AskRowState.streaming -> null
        AskRowState.done -> null
        AskRowState.error -> "trn_ask_error"
        AskRowState.notSent -> "trn_ask_not_sent"
        AskRowState.timedOut -> "trn_ask_timed_out"
    }

    fun section(section: MinutesSection): String = when (section) {
        MinutesSection.summary -> "trn_section_summary"
        MinutesSection.topics -> "trn_section_topics"
        MinutesSection.decisions -> "trn_section_decisions"
        MinutesSection.actionItems -> "trn_section_action_items"
        MinutesSection.openQuestions -> "trn_section_open_questions"
        MinutesSection.followUps -> "trn_section_follow_ups"
    }

    fun emptyTitle(kind: MinutesEmptyKind): String? = when (kind) {
        MinutesEmptyKind.none -> null
        MinutesEmptyKind.buildAsYouTalk -> "trn_minutes_empty_title"
        MinutesEmptyKind.cooking -> "trn_minutes_cooking_title"
    }

    fun emptyBody(kind: MinutesEmptyKind): String? = when (kind) {
        MinutesEmptyKind.none -> null
        MinutesEmptyKind.buildAsYouTalk -> "trn_minutes_empty_body"
        MinutesEmptyKind.cooking -> "trn_minutes_cooking_body"
    }

    /** "Updated %1$s" takes the relative time. */
    fun minutesStatus(kind: MinutesStatusKind): String = when (kind) {
        MinutesStatusKind.automatic -> "trn_minutes_auto"
        MinutesStatusKind.updating -> "trn_minutes_updating"
        MinutesStatusKind.updated -> "trn_minutes_updated"
    }

    /** The Minutes recap item value; failure is the snackbar (D23); null when idle. */
    fun recapValue(phase: RecapPhase): String? = when (phase) {
        RecapPhase.idle -> null
        RecapPhase.posting -> "trn_recap_posting"
        RecapPhase.posted -> "trn_recap_posted_value"
        RecapPhase.failed -> "trn_recap_failed"
    }

    /** Polite announcements; copy and the recap results show as snackbars instead (null), D23. */
    fun announcement(kind: TranscriptAnnouncementKind): String? = when (kind) {
        TranscriptAnnouncementKind.started -> "trn_announce_started"
        TranscriptAnnouncementKind.paused -> "trn_announce_paused"
        TranscriptAnnouncementKind.stopped -> "trn_announce_stopped"
        TranscriptAnnouncementKind.copied -> null
        TranscriptAnnouncementKind.recapPosting -> "trn_recap_posting_announce"
        TranscriptAnnouncementKind.recapPosted -> null
        TranscriptAnnouncementKind.recapFailed -> null
        TranscriptAnnouncementKind.answerReady -> "trn_answer_ready"
    }

    /** Every resource name this file can return (the contract test resolves each one). */
    val allNames: List<String> = listOf(
        "trn_title", "trn_tab_transcript", "trn_tab_ask", "trn_tab_minutes", "trn_more_actions", "trn_export", "trn_copy",
        "trn_post_recap", "trn_stop_menu", "trn_kicker", "trn_beta", "trn_turn_on", "trn_pick_up", "trn_blurb_turn_on",
        "trn_blurb_takeover_covered", "trn_blurb_takeover_key", "trn_blurb_view_only", "trn_view_only", "trn_show_options",
        "trn_hide_options", "trn_provider", "trn_assistant", "trn_provider_key", "trn_assistant_key", "trn_coverage_covered",
        "trn_coverage_sarvam", "trn_coverage_keys", "trn_checking_keys", "trn_start", "trn_resume_notes", "trn_starting",
        "trn_status_live", "trn_status_paused", "trn_status_stopping", "trn_status_reconnecting", "trn_status_ended",
        "trn_hosted_you", "trn_hosted_by", "trn_following", "trn_pause", "trn_resume", "trn_stop", "trn_stop_title",
        "trn_stop_message", "trn_stop_confirm", "trn_listening_title", "trn_listening_body", "trn_resumed_at", "trn_speaker",
        "trn_you", "trn_still_speaking", "trn_ask_empty_title", "trn_ask_empty_body", "trn_ask_suggest_decisions",
        "trn_ask_suggest_summary", "trn_ask_suggest_actions", "trn_ask_placeholder", "trn_ask_send", "trn_ask_private",
        "trn_thinking", "trn_copy_answer", "trn_ask_error", "trn_ask_not_sent", "trn_ask_timed_out", "trn_you_asked",
        "trn_conclave_answered", "trn_answer_ready", "trn_minutes_updating", "trn_minutes_updated", "trn_minutes_auto",
        "trn_refresh_minutes", "trn_post_recap_detail", "trn_section_summary", "trn_section_topics", "trn_section_decisions",
        "trn_section_action_items", "trn_section_open_questions", "trn_section_follow_ups", "trn_owner", "trn_due",
        "trn_minutes_empty_title", "trn_minutes_empty_body", "trn_minutes_cooking_title", "trn_minutes_cooking_body",
        "trn_recap_posting", "trn_recap_posted_value", "trn_recap_posted", "trn_recap_failed", "trn_recap_posting_announce",
        "trn_issue_permission", "trn_issue_reconnecting", "trn_issue_relay", "trn_issue_stop_failed", "trn_share_subject",
        "trn_copied", "trn_export_title", "trn_export_transcript", "trn_unavailable_title", "trn_unavailable_body",
        "trn_relay_unavailable_title", "trn_relay_unavailable_body", "trn_loading", "trn_announce_started",
        "trn_announce_paused", "trn_announce_stopped", "ctl_end_recap_message", "ctl_end_post_recap", "ctl_end_without_recap",
    )
}

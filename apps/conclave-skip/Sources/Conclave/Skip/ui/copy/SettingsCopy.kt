package conclave.module

/*
 * S60 0.6 L6-14 (SET-1, SET-2, SET-4) on Android: the one exhaustive copy mapping for Settings. Every typed reason,
 * phase and raw-value field the transpiled SettingsPresenter publishes resolves here to an app-module string resource
 * name (Material sentence case, prefix set_; the S70 status rows keep their sys_ names), which composition resolves
 * through conclaveString. T/Skip/SettingsTranscriptBridgeTests.kt enumerates every case. The iOS twin is
 * S/Features/Meeting/Settings/SettingsCopy+iOS.swift.
 */
internal object SettingsCopy {
    fun sectionName(section: SettingsSection): String = when (section) {
        SettingsSection.audio -> "set_audio"
        SettingsSection.video -> "set_video"
        SettingsSection.captions -> "set_captions"
        SettingsSection.chat -> "set_chat"
        SettingsSection.host -> "set_host"
        SettingsSection.general -> "set_general"
        SettingsSection.account -> "set_account"
        SettingsSection.about -> "set_about"
    }

    fun rowName(row: SettingsRowID): String = when (row) {
        SettingsRowID.output -> "set_audio_output"
        SettingsRowID.microphone -> "set_test_microphone"
        SettingsRowID.noiseSuppression -> "set_noise_suppression"
        SettingsRowID.testSound -> "set_play_test_sound"
        SettingsRowID.cameraFacing -> "set_camera"
        SettingsRowID.mirror -> "set_mirror"
        SettingsRowID.cameraQuality -> "set_camera_quality"
        SettingsRowID.screenShareQuality -> "set_screen_share_quality"
        SettingsRowID.dataSaver -> "set_data_saver"
        SettingsRowID.effects -> "set_effects"
        SettingsRowID.captions -> "set_captions"
        SettingsRowID.captionStyle -> "set_caption_style"
        SettingsRowID.chatPreviews -> "set_chat_previews"
        SettingsRowID.playVoiceMessages -> "set_play_voice_messages"
        SettingsRowID.voiceMessages -> "set_voice_messages"
        SettingsRowID.hostControls -> "set_host_controls"
        SettingsRowID.knockSound -> "set_knock_sound"
        SettingsRowID.handSound -> "set_hand_sound"
        SettingsRowID.connection -> "set_connection"
        SettingsRowID.messageNotifications -> "set_message_notifications"
        SettingsRowID.callNotification -> "sys_call_notif_title"
        SettingsRowID.openLinks -> "sys_links_title"
        SettingsRowID.alwaysShowControls -> "set_always_show_controls"
        SettingsRowID.haptics -> "set_haptics"
        SettingsRowID.name -> "set_name"
        SettingsRowID.identity -> "set_account"
        SettingsRowID.signOut -> "set_sign_out"
        SettingsRowID.privacy -> "set_privacy_policy"
        SettingsRowID.exportDiagnostics -> "sys_diag_export"
        SettingsRowID.version -> "set_version"
    }

    /** The supporting line a row carries under its headline, or null. */
    fun rowDetailName(row: SettingsRowID): String? = when (row) {
        SettingsRowID.microphone -> "set_test_microphone_detail"
        SettingsRowID.noiseSuppression -> "set_noise_suppression_detail"
        SettingsRowID.captions -> "set_captions_detail"
        SettingsRowID.captionStyle -> "set_caption_style_detail"
        SettingsRowID.alwaysShowControls -> "set_always_show_controls_detail"
        SettingsRowID.messageNotifications -> "set_message_notifications_desc"
        else -> null
    }

    /** App bar titles; pushed page titles stay under 15 characters (S60 2 a). */
    fun pageTitleName(route: SettingsRoute): String = when (route) {
        SettingsRoute.root -> "set_title"
        SettingsRoute.output -> "set_audio_output"
        SettingsRoute.microphone -> "set_microphone_title"
        SettingsRoute.cameraQuality -> "set_camera_quality"
        SettingsRoute.cameraAdvanced -> "set_advanced"
        SettingsRoute.screenShareQuality -> "set_share_quality_title"
        SettingsRoute.screenShareAdvanced -> "set_advanced"
        SettingsRoute.connection -> "set_connection"
        SettingsRoute.voice -> "set_voice_messages"
        SettingsRoute.voiceRecord -> "set_record_voice_title"
        SettingsRoute.privacy -> "set_privacy_policy"
        SettingsRoute.hostControls, SettingsRoute.hostInviteCode, SettingsRoute.hostAccessList, SettingsRoute.hostNotice,
        SettingsRoute.hostWebinar, SettingsRoute.hostAttendeeCode, SettingsRoute.hostCustomLink ->
            hostPageTitleName(SettingsRoutePolicy.peopleRoute(route)?.rawValue)
    }

    /** The visible reason under a disabled row, or null (D10). */
    fun reasonName(reason: SettingsReason): String? = when (reason) {
        SettingsReason.none -> null
        SettingsReason.reconnecting -> "set_available_when_reconnected"
        SettingsReason.audioOnly -> "set_audio_only_reason"
        SettingsReason.systemDataSaver -> "set_system_data_saver"
        SettingsReason.hostQualityCap -> "set_host_quality_cap"
        SettingsReason.unsupportedDevice -> "set_unsupported"
        SettingsReason.appliesNextJoin -> "set_applies_next_join"
        SettingsReason.permissionDenied -> "set_mic_permission_off"
        SettingsReason.cameraInUse, SettingsReason.cameraMultitasking, SettingsReason.cameraInBackground -> "stg_camera_paused"
        SettingsReason.unmuteToTest -> "set_unmute_to_test"
        SettingsReason.guest -> "set_voice_guest"
        SettingsReason.notInAppYet -> "set_voice_not_in_app"
    }

    /** The name field's reason (1 f). */
    fun nameReasonName(reason: SettingsReason): String? =
        if (reason == SettingsReason.reconnecting) "set_name_reconnect" else null

    fun connectionName(label: ConnectionQualityLabel): String = ConnectionQualityLabelPolicy.androidResourceName(label)

    fun facingName(facing: String): String = if (facing == "back") "set_back" else "set_front"

    fun voiceKindName(kind: VoiceKind): String = when (kind) {
        VoiceKind.system -> "set_system_voice"
        VoiceKind.personal -> "set_your_voice"
    }

    fun micPhaseName(phase: MicTestPhase): String? = when (phase) {
        MicTestPhase.idle, MicTestPhase.metering -> null
        MicTestPhase.starting -> "set_mic_starting"
        MicTestPhase.recording -> "set_recording"
        MicTestPhase.replaying -> "set_stop_playback"
        MicTestPhase.unavailable -> "set_mic_unavailable"
    }

    /** "Saving" and "Saved"; a failure resolves through peopleRenameRefusalOf (S50 ppl_rename_ copy, R38). */
    fun nameStatusName(phase: NameSavePhase): String? = when (phase) {
        NameSavePhase.idle, NameSavePhase.failed -> null
        NameSavePhase.saving -> "set_saving"
        NameSavePhase.saved -> "set_saved"
    }

    fun personalVoicePhaseName(phase: PersonalVoicePhase): String? = when (phase) {
        PersonalVoicePhase.unavailable, PersonalVoicePhase.none, PersonalVoicePhase.recording, PersonalVoicePhase.review -> null
        PersonalVoicePhase.creating -> "set_creating"
        PersonalVoicePhase.ready -> "set_voice_ready"
        PersonalVoicePhase.failed -> "set_voice_create_failed"
        PersonalVoicePhase.deleting -> "ds_in_progress"
    }

    fun accountKindName(kind: AccountKind): String? = when (kind) {
        AccountKind.none, AccountKind.signedIn -> null
        AccountKind.guest -> "set_guest"
    }

    fun providerName(provider: String): String? = when (provider) {
        "apple" -> "set_signed_in_apple"
        "google" -> "set_signed_in_google"
        else -> null
    }

    fun notificationPermissionName(permission: NotificationPermission): String = when (permission) {
        NotificationPermission.notDetermined, NotificationPermission.granted -> "set_message_notifications_desc"
        NotificationPermission.denied -> "sys_notif_off"
    }

    fun linkVerificationName(state: LinkVerification): String =
        if (state == LinkVerification.verified) "sys_links_in_app" else "sys_links_in_browser"

    fun callNotificationName(enabled: Boolean): String = if (enabled) "sys_call_notif_on" else "sys_call_notif_off"

    fun signOutMessageName(isHost: Boolean): String = if (isHost) "set_sign_out_host" else "set_sign_out_guest"
}

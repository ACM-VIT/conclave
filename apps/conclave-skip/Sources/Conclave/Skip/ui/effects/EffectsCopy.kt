package conclave.module

/*
 * S60 4 g (SET-6), L6-14 on Android: one exhaustive mapping from the Effects vocabulary to `fx_` resource names
 * (Material sentence case, Q13), resolved at the call sites with conclaveString / conclavePlural. Catalog names stay
 * verbatim. The S60 copy table names `K/ui/copy/SettingsCopy.kt` for Effects too; that file belongs to SET-3 this batch,
 * so the Effects half lives here (HD record B7-T2). Android has no system camera effects (OQ6 default A), so the iOS
 * system effect lines have no names here.
 */
internal object EffectsCopy {
    fun tabName(id: String): String = when (id) {
        EffectsCatalog.filters -> "fx_filters"
        EffectsCatalog.appearance -> "fx_appearance"
        else -> "fx_backgrounds"
    }

    /** A catalog tile's name; personal images use the `fx_personal_image` format with their number instead. */
    fun itemName(id: String): String? = when (id) {
        EffectsCatalog.noBackground -> "fx_none"
        EffectsCatalog.slightBlur -> "fx_slight_blur"
        EffectsCatalog.blur -> "fx_blur"
        "camper-vacation" -> "fx_camper_vacation"
        "coffee-shop" -> "fx_coffee_shop"
        EffectsCatalog.noFilter -> "fx_no_filter"
        "sparkles" -> "fx_sparkles"
        "warm-glow" -> "fx_warm_glow"
        EffectsCatalog.studioLighting -> "fx_studio_lighting"
        EffectsCatalog.studioLook -> "fx_studio_look"
        EffectsCatalog.framing -> "fx_framing"
        else -> null
    }

    fun appearanceDetailName(id: String): String = when (id) {
        EffectsCatalog.studioLighting -> "fx_studio_lighting_detail"
        EffectsCatalog.studioLook -> "fx_studio_look_detail"
        else -> "fx_framing_detail"
    }

    /** The grid section of a Backgrounds tile (4 d): Blur, Backgrounds, Personal. */
    fun sectionName(kind: EffectKind): String = when (kind) {
        EffectKind.none, EffectKind.blur -> "fx_blur"
        EffectKind.personal -> "fx_personal"
        EffectKind.image, EffectKind.filter, EffectKind.style, EffectKind.appearance -> "fx_backgrounds"
    }

    /** The camera line (4 d, f); null while the camera is on. */
    fun cameraName(camera: EffectsCameraState): String? = when (camera) {
        EffectsCameraState.on -> null
        EffectsCameraState.off -> "fx_camera_off"
        EffectsCameraState.audioOnly -> "fx_audio_only_reason"
        EffectsCameraState.blocked -> "fx_camera_blocked"
        EffectsCameraState.interrupted -> "stg_camera_paused"
        EffectsCameraState.disabledByHost -> "fx_host_disabled"
    }

    /** The inline error row (4 f, g); null without an issue. */
    fun issueName(issue: EffectsIssue): String? = when (issue) {
        EffectsIssue.none -> null
        EffectsIssue.format -> "fx_err_format"
        EffectsIssue.size -> "fx_err_size"
        EffectsIssue.decode -> "fx_err_decode"
        EffectsIssue.complex -> "fx_err_complex"
        EffectsIssue.unavailable -> "fx_err_unavailable"
        EffectsIssue.limit -> "fx_err_limit"
    }
}

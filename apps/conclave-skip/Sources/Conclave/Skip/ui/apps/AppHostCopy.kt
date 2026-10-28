package conclave.module

import androidx.compose.runtime.Composable

/*
 * S60 L6-14 and 13 g (ACT-7): the one exhaustive Android copy mapping for the SDK app host. Every typed value maps
 * through a `when` to an app-module string resource resolved by name (Material sentence case, owner decision Q13;
 * prefix app_, plus the shared act_, stg_ and ds_ names reused for the same words). App names are app-owned copy keyed by
 * SDK id (C6-18, activitiesAppName). T/Skip/ACT7AppHostBridgeTests.kt enumerates every case and the Swift twin is
 * AppHostCopy in NativeAppHost+iOS.swift.
 */

internal fun appHostTagResource(tag: AppHostTag): String? = when (tag) {
    AppHostTag.none -> null
    AppHostTag.viewOnly -> "app_view_only"
    AppHostTag.lockedForOthers -> "app_locked_others"
    AppHostTag.reconnecting -> "ds_state_reconnecting"
}

internal fun appHostToolResource(tool: AppWhiteboardTool): String = when (tool) {
    AppWhiteboardTool.select -> "app_wb_select"
    AppWhiteboardTool.pan -> "app_wb_pan"
    AppWhiteboardTool.pen -> "app_wb_pen"
    AppWhiteboardTool.highlighter -> "app_wb_highlighter"
    AppWhiteboardTool.eraser -> "app_wb_eraser"
    AppWhiteboardTool.rect -> "app_wb_rectangle"
    AppWhiteboardTool.ellipse -> "app_wb_ellipse"
    AppWhiteboardTool.line -> "app_wb_line"
    AppWhiteboardTool.arrow -> "app_wb_arrow"
    AppWhiteboardTool.text -> "app_wb_text"
    AppWhiteboardTool.sticky -> "app_wb_sticky"
    AppWhiteboardTool.laser -> "app_wb_laser"
}

internal fun appHostFillResource(fill: AppShapeFill): String = when (fill) {
    AppShapeFill.outline -> "app_wb_outline"
    AppShapeFill.filled -> "app_wb_filled"
}

internal fun appHostCommandResource(kind: AppHostCommandKind): String = when (kind) {
    AppHostCommandKind.setTool -> "app_wb_tools"
    AppHostCommandKind.setColor -> "app_wb_color"
    AppHostCommandKind.setStrokeWidth -> "app_wb_stroke_width"
    AppHostCommandKind.setFill -> "app_wb_shape"
    AppHostCommandKind.undo -> "app_wb_undo"
    AppHostCommandKind.redo -> "app_wb_redo"
    AppHostCommandKind.setPage -> "app_wb_page"
    AppHostCommandKind.addPage -> "app_wb_new_page"
    AppHostCommandKind.renamePage -> "app_wb_rename_page"
    AppHostCommandKind.deletePage -> "app_wb_delete_page"
    AppHostCommandKind.zoomToFit -> "app_wb_zoom_fit"
    AppHostCommandKind.export -> "app_wb_export"
}

internal fun appHostColorResource(color: AppInkColor): String = when (color) {
    AppInkColor.white -> "app_wb_color_white"
    AppInkColor.mist -> "app_wb_color_mist"
    AppInkColor.gray -> "app_wb_color_gray"
    AppInkColor.charcoal -> "app_wb_color_charcoal"
    AppInkColor.lightRed -> "app_wb_color_light_red"
    AppInkColor.red -> "app_wb_color_red"
    AppInkColor.rose -> "app_wb_color_rose"
    AppInkColor.pink -> "app_wb_color_pink"
    AppInkColor.lightOrange -> "app_wb_color_light_orange"
    AppInkColor.orange -> "app_wb_color_orange"
    AppInkColor.yellow -> "app_wb_color_yellow"
    AppInkColor.amber -> "app_wb_color_amber"
    AppInkColor.lightGreen -> "app_wb_color_light_green"
    AppInkColor.green -> "app_wb_color_green"
    AppInkColor.teal -> "app_wb_color_teal"
    AppInkColor.darkTeal -> "app_wb_color_dark_teal"
    AppInkColor.lightBlue -> "app_wb_color_light_blue"
    AppInkColor.blue -> "app_wb_color_blue"
    AppInkColor.lavender -> "app_wb_color_lavender"
    AppInkColor.purple -> "app_wb_color_purple"
}

/** Every resource name the host files ask for (the bridge test checks each against strings.xml after the merge). */
internal val appHostStringResources: List<String> = buildList {
    addAll(listOf("app_view_only", "app_locked_others", "app_more_actions", "app_lock_editing", "app_update_needed",
        "app_wb_canvas", "app_wb_canvas_hint", "app_wb_empty_title", "app_wb_empty_body", "app_wb_rename_title",
        "app_wb_page_name", "app_wb_rename", "app_wb_delete_title", "app_wb_delete_message", "app_wb_delete",
        "app_wb_width_value", "app_wb_export_failed", "app_open_link_title"))
    for (tool in AppWhiteboardTool.allCases) add(appHostToolResource(tool))
    for (fill in AppShapeFill.allCases) add(appHostFillResource(fill))
    for (kind in AppHostCommandKind.allCases) add(appHostCommandResource(kind))
    for (color in AppInkColor.allCases) add(appHostColorResource(color))
}

internal val appHostPluralResources: List<String> = listOf("app_editing")

/** "%1$d editing" or "Editing locked" (sentence case status line, S60 13 g); "" when nothing to say. */
@Composable
internal fun appHostStatus(model: AppHostModel): String {
    if (model.appId.isEmpty()) return ""
    if (model.isLocked) return conclaveString("act_editing_locked")
    if (model.appId == "whiteboard" && model.editorCount > 0) {
        return conclavePlural("app_editing", model.editorCount, model.editorCount)
    }
    return ""
}

@Composable
internal fun appHostTag(tag: AppHostTag): String {
    val name = appHostTagResource(tag) ?: return ""
    return conclaveString(name)
}

@Composable
internal fun appHostName(appId: String): String = activitiesAppName(appId)

@Composable
internal fun appHostTool(tool: AppWhiteboardTool): String = conclaveString(appHostToolResource(tool))

@Composable
internal fun appHostFill(fill: AppShapeFill): String = conclaveString(appHostFillResource(fill))

@Composable
internal fun appHostCommand(kind: AppHostCommandKind): String = conclaveString(appHostCommandResource(kind))

@Composable
internal fun appHostColor(color: AppInkColor): String = conclaveString(appHostColorResource(color))

@Composable
internal fun appHostWidth(width: Int): String = conclaveString("app_wb_width_value", width)

/** "Couldn't open %1$s" and, for a version mismatch, "Update Conclave to use %1$s." */
@Composable
internal fun appHostFailureTitle(model: AppHostModel): String = conclaveString("stg_activity_failed", appHostName(model.appId))

@Composable
internal fun appHostFailureDetail(model: AppHostModel): String? =
    if (model.phase == AppHostPhase.versionMismatch) conclaveString("app_update_needed", appHostName(model.appId)) else null

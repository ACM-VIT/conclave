package conclave.module

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.os.Build
import android.os.Looper
import android.provider.Settings
import android.view.View
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Locale

/*
 * Debug-only semantics exporter (PLAN A15). A uiautomator dump has bounds, labels, text and tags but no
 * stateDescription, heading, pane title, live region or traversal data, which the native screens rely on. This
 * walks the Compose semantics tree of the hosting preview through ViewRootForTest.semanticsOwner (public at
 * the pinned compose-ui) and writes ASCII JSON to the app cache:
 *
 *   adb shell am broadcast -a conclave.debug.EXPORT_SEMANTICS -p com.acmvit.conclave
 *   adb exec-out run-as com.acmvit.conclave cat cache/wp1-semantics/latest.json
 *
 * The receiver exists only while the Debug preview is composed, and only senders that hold DUMP (adb shell)
 * reach it, so an export also works while a panel covers the preview's own button. The newest 20 exports are
 * kept; older ones are deleted after each write. Node order is the
 * semantics tree order, not TalkBack's sorted traversal; bounds, traversal groups and indices are exported so
 * the order can be derived, and TalkBack stays the spoken check.
 *
 * S40 R40-11 (FND-3): nodes also carry their custom accessibility action labels and the long-click label, and every
 * sheet, dialog and dropdown popup root registers its own window through NativeSemanticsPopupRoot (popups are
 * separate Compose roots that the hosting LocalView walk cannot reach). Each registered root is exported as its own
 * merged and unmerged trees; the popup content sets testTagsAsResourceId, which the activity root does not reach.
 */

internal const val NATIVE_SEMANTICS_EXPORT_ACTION = "conclave.debug.EXPORT_SEMANTICS"
internal const val NATIVE_SEMANTICS_EXPORT_DIRECTORY = "wp1-semantics"
/** Exports kept in the cache; older ones are deleted after each write, so a scripted matrix stays bounded. */
internal const val NATIVE_SEMANTICS_EXPORTS_KEPT = 20
private const val SEMANTICS_EXPORT_MAX_NODES = 4_000
private const val SEMANTICS_EXPORT_MAX_BYTES = 8 * 1024 * 1024

/** One exported node. Property order is the JSON key order. Bounds are window pixels. */
internal data class SemanticsExportNode(
    val id: Int,
    val parent: Int,
    val depth: Int,
    val testTag: String?,
    val role: String?,
    val contentDescription: List<String>,
    val text: List<String>,
    val editableText: String?,
    val stateDescription: String?,
    val heading: Boolean,
    val paneTitle: String?,
    val liveRegion: String?,
    val traversalGroup: Boolean,
    val traversalIndex: Float,
    val focusable: Boolean,
    val focused: Boolean,
    val clickable: Boolean,
    val disabled: Boolean,
    val selected: Boolean?,
    val toggleState: String?,
    val hidden: Boolean,
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
    /** Labels of SemanticsActions.CustomActions, in order (S40 R40-11). */
    val customActions: List<String> = emptyList(),
    /** The OnLongClick action's label, null without a long click or a label. */
    val onLongClickLabel: String? = null,
)

/** A deterministic writer: fixed key order, Locale.ROOT numbers, and every non-ASCII character escaped, so
 *  the file stays ASCII and parsable under any locale, Arabic-Indic digits included (icon review M1). */
internal object NativeSemanticsJson {
    fun string(value: String?): String {
        if (value == null) return "null"
        val out = StringBuilder(value.length + 2)
        out.append('"')
        for (c in value) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c.code < 0x20 || c.code > 0x7E -> out.append(String.format(Locale.ROOT, "\\u%04x", c.code))
                else -> out.append(c)
            }
        }
        out.append('"')
        return out.toString()
    }

    fun number(value: Int): String = String.format(Locale.ROOT, "%d", value)

    fun number(value: Long): String = String.format(Locale.ROOT, "%d", value)

    fun number(value: Float): String = if (value.isFinite()) String.format(Locale.ROOT, "%.1f", value) else "null"

    /** Three decimals, so header scales such as font scale 0.85 and 1.15 keep their identity (bounds use one). */
    fun scale(value: Float): String = if (value.isFinite()) String.format(Locale.ROOT, "%.3f", value) else "null"

    fun flag(value: Boolean?): String = when (value) {
        null -> "null"
        true -> "true"
        false -> "false"
    }

    fun strings(values: List<String>): String = values.joinToString(",", "[", "]") { string(it) }

    fun node(n: SemanticsExportNode): String = listOf(
        "id" to number(n.id), "parent" to number(n.parent), "depth" to number(n.depth),
        "testTag" to string(n.testTag), "role" to string(n.role),
        "contentDescription" to strings(n.contentDescription), "text" to strings(n.text),
        "editableText" to string(n.editableText), "stateDescription" to string(n.stateDescription),
        "heading" to flag(n.heading), "paneTitle" to string(n.paneTitle), "liveRegion" to string(n.liveRegion),
        "traversalGroup" to flag(n.traversalGroup), "traversalIndex" to number(n.traversalIndex),
        "focusable" to flag(n.focusable), "focused" to flag(n.focused), "clickable" to flag(n.clickable),
        "disabled" to flag(n.disabled), "selected" to flag(n.selected), "toggleState" to string(n.toggleState),
        "hidden" to flag(n.hidden),
        "customActions" to strings(n.customActions), "onLongClickLabel" to string(n.onLongClickLabel),
        "bounds" to listOf(n.left, n.top, n.right, n.bottom).joinToString(",", "[", "]") { number(it) },
    ).joinToString(",", "{", "}") { (key, value) -> string(key) + ":" + value }

    /** `header` values are already encoded; each tree prints one node per line. */
    fun document(header: List<Pair<String, String>>, trees: List<Pair<String, List<SemanticsExportNode>>>): String {
        val fields = header.map { (key, value) -> string(key) + ": " + value } +
            trees.map { (key, nodes) -> string(key) + ": [" + nodes.joinToString(",\n", "\n", "\n") { node(it) } + "]" }
        return fields.joinToString(",\n", "{\n", "\n}\n")
    }
}

/** Pre-order walk. With merging enabled, merged descendants are not separate nodes, as TalkBack sees it. */
internal fun semanticsExportNodes(root: SemanticsNode, limit: Int = SEMANTICS_EXPORT_MAX_NODES): List<SemanticsExportNode> {
    val out = ArrayList<SemanticsExportNode>()
    fun visit(node: SemanticsNode, parent: Int, depth: Int) {
        if (out.size >= limit) return
        out.add(semanticsExportNode(node, parent, depth))
        for (child in node.children) visit(child, node.id, depth + 1)
    }
    visit(root, -1, 0)
    return out
}

private fun semanticsExportNode(node: SemanticsNode, parent: Int, depth: Int): SemanticsExportNode {
    val config = node.config
    val bounds = node.boundsInWindow
    return SemanticsExportNode(
        id = node.id,
        parent = parent,
        depth = depth,
        testTag = config.getOrNull(SemanticsProperties.TestTag),
        role = config.getOrNull(SemanticsProperties.Role)?.toString(),
        contentDescription = config.getOrNull(SemanticsProperties.ContentDescription) ?: emptyList(),
        text = config.getOrNull(SemanticsProperties.Text)?.map { it.text } ?: emptyList(),
        editableText = config.getOrNull(SemanticsProperties.EditableText)?.text,
        stateDescription = config.getOrNull(SemanticsProperties.StateDescription),
        heading = SemanticsProperties.Heading in config,
        paneTitle = config.getOrNull(SemanticsProperties.PaneTitle),
        liveRegion = config.getOrNull(SemanticsProperties.LiveRegion)?.toString(),
        traversalGroup = config.getOrNull(SemanticsProperties.IsTraversalGroup) == true,
        traversalIndex = config.getOrNull(SemanticsProperties.TraversalIndex) ?: 0f,
        focusable = SemanticsProperties.Focused in config,
        focused = config.getOrNull(SemanticsProperties.Focused) == true,
        clickable = SemanticsActions.OnClick in config,
        disabled = SemanticsProperties.Disabled in config,
        selected = config.getOrNull(SemanticsProperties.Selected),
        toggleState = config.getOrNull(SemanticsProperties.ToggleableState)?.name,
        hidden = SemanticsProperties.HideFromAccessibility in config,
        left = bounds.left,
        top = bounds.top,
        right = bounds.right,
        bottom = bounds.bottom,
        customActions = config.getOrNull(SemanticsActions.CustomActions)?.map { it.label } ?: emptyList(),
        onLongClickLabel = config.getOrNull(SemanticsActions.OnLongClick)?.label,
    )
}

/** One per preview root. The button and the broadcast share it, so the status line shows either. */
internal class NativeSemanticsExporter(context: Context) {
    private val app = context.applicationContext
    private var revision = 0
    var status by mutableStateOf<String?>(null)
        private set

    fun export(view: View, activity: Activity?, reason: String) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "semantics export runs on the main thread" }
        if (!isDebuggableApp(app)) return
        status = try {
            write(view, activity, reason)
        } catch (error: Exception) {
            conclaveStringOf(app, "native_semantics_failed", error.javaClass.simpleName)
        }
    }

    private fun write(view: View, activity: Activity?, reason: String): String {
        val owner = (view as? ViewRootForTest)?.semanticsOwner ?: error("no Compose root")
        val merged = semanticsExportNodes(owner.rootSemanticsNode)
        val unmerged = semanticsExportNodes(owner.unmergedRootSemanticsNode)
        val popups = NativeSemanticsPopupRoots.trees()
        val configuration = app.resources.configuration
        val window = activity?.window
        val bars = window?.let { WindowCompat.getInsetsController(it, it.decorView) }
        val header = listOf(
            "schema" to NativeSemanticsJson.number(1),
            "source" to NativeSemanticsJson.string("ViewRootForTest.semanticsOwner"),
            "reason" to NativeSemanticsJson.string(reason),
            "package" to NativeSemanticsJson.string(app.packageName),
            "api" to NativeSemanticsJson.number(Build.VERSION.SDK_INT),
            "wallClockMs" to NativeSemanticsJson.number(System.currentTimeMillis()),
            "layoutDirection" to NativeSemanticsJson.string(if (view.layoutDirection == View.LAYOUT_DIRECTION_RTL) "rtl" else "ltr"),
            "fontScale" to NativeSemanticsJson.scale(configuration.fontScale),
            "densityDpi" to NativeSemanticsJson.number(configuration.densityDpi),
            "nightMode" to NativeSemanticsJson.flag(
                configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES),
            "navigationMode" to NativeSemanticsJson.number(Settings.Secure.getInt(app.contentResolver, "navigation_mode", -1)),
            "windowLightStatusBars" to NativeSemanticsJson.flag(bars?.isAppearanceLightStatusBars),
            "windowLightNavigationBars" to NativeSemanticsJson.flag(bars?.isAppearanceLightNavigationBars),
            "nodeLimit" to NativeSemanticsJson.number(SEMANTICS_EXPORT_MAX_NODES),
            "mergedCount" to NativeSemanticsJson.number(merged.size),
            "unmergedCount" to NativeSemanticsJson.number(unmerged.size),
            "popupRootCount" to NativeSemanticsJson.number(popups.size / 2),
        )
        val bytes = NativeSemanticsJson.document(header, listOf("merged" to merged, "unmerged" to unmerged) + popups)
            .toByteArray(Charsets.US_ASCII)
        check(bytes.size <= SEMANTICS_EXPORT_MAX_BYTES) { "export larger than the bound" }
        // Canonicalize first: /data/user/0 is itself a symlink to /data/data on Android.
        val base = File(app.cacheDir.canonicalFile, NATIVE_SEMANTICS_EXPORT_DIRECTORY)
        check(base.isDirectory || base.mkdir()) { "cannot create the export directory" }
        check(base.canonicalFile == base) { "symlink in the export directory" }
        revision += 1
        val name = String.format(Locale.ROOT, "export-%d-%02d.json", System.currentTimeMillis(), revision)
        NativeSemanticsExportFiles.write(base, name, bytes)
        return conclaveStringOf(app, "native_semantics_status",
            "cache/$NATIVE_SEMANTICS_EXPORT_DIRECTORY/$name", merged.size, unmerged.size)
    }
}

/**
 * Popup roots (sheets, dialogs, dropdown menus) composed in their own windows, in registration order (S40 R40-11).
 * Main thread only; entries exist only in debuggable apps (NativeSemanticsPopupRoot checks) and leave on dispose.
 */
internal object NativeSemanticsPopupRoots {
    private class Entry(val name: String, var count: Int)

    private val roots = LinkedHashMap<View, Entry>()

    fun register(view: View, name: String) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "popup roots register on the main thread" }
        val entry = roots[view]
        if (entry == null) roots[view] = Entry(name, 1) else entry.count += 1
    }

    fun unregister(view: View) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "popup roots unregister on the main thread" }
        val entry = roots[view] ?: return
        entry.count -= 1
        if (entry.count <= 0) roots.remove(view)
    }

    /** The registered root names, in order. */
    fun names(): List<String> = roots.values.map { it.name }

    /** Two trees per root that has a Compose semantics owner: `popup.<index>.<name>.merged` and `.unmerged`. */
    fun trees(): List<Pair<String, List<SemanticsExportNode>>> {
        val out = ArrayList<Pair<String, List<SemanticsExportNode>>>()
        var index = 0
        for ((view, entry) in roots) {
            val owner = (view as? ViewRootForTest)?.semanticsOwner ?: continue
            val prefix = "popup." + NativeSemanticsJson.number(index) + "." + entry.name
            out.add("$prefix.merged" to semanticsExportNodes(owner.rootSemanticsNode))
            out.add("$prefix.unmerged" to semanticsExportNodes(owner.unmergedRootSemanticsNode))
            index += 1
        }
        return out
    }

    /** Tests only. */
    fun clear() {
        roots.clear()
    }
}

/**
 * Registers the window this composable runs in as a popup root while it is composed. Call it once inside each
 * sheet, dialog and dropdown content (it draws nothing). Release builds never register.
 */
@Composable
internal fun NativeSemanticsPopupRoot(name: String) {
    val view = LocalView.current
    val context = LocalContext.current
    DisposableEffect(view, name) {
        val registered = isDebuggableApp(context)
        if (registered) NativeSemanticsPopupRoots.register(view, name)
        onDispose { if (registered) NativeSemanticsPopupRoots.unregister(view) }
    }
}

/** The export directory: immutable exports, the `latest.json` pointer and pruning. */
internal object NativeSemanticsExportFiles {
    private val exportName = Regex("""export-(\d+)-(\d+)\.json""")

    fun write(base: File, name: String, bytes: ByteArray, keep: Int = NATIVE_SEMANTICS_EXPORTS_KEPT) {
        val file = File(base, name)
        check(file.createNewFile()) { "export already exists" }
        FileOutputStream(file).use { it.write(bytes); it.fd.sync() }
        // The immutable export is complete before the convenience pointer is replaced.
        val pending = File(base, "latest.json.tmp")
        FileOutputStream(pending).use { it.write(bytes); it.fd.sync() }
        Files.move(pending.toPath(), File(base, "latest.json").toPath(),
            StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        prune(base, keep)
    }

    /** Deletes all but the newest `keep` exports, ordered by the time and revision in their names. Other files stay. */
    fun prune(base: File, keep: Int) {
        val exports = base.listFiles().orEmpty().mapNotNull { file ->
            exportName.matchEntire(file.name)?.let { match ->
                Triple(file, match.groupValues[1].toLong(), match.groupValues[2].toInt())
            }
        }.sortedWith(compareBy<Triple<File, Long, Int>> { it.second }.thenBy { it.third })
        for (old in exports.dropLast(keep)) old.first.delete()
    }
}

/** Registers the export broadcast when the app is debuggable and returns the receiver, else null. Only senders
 *  that hold DUMP (adb shell) reach it. */
internal fun registerNativeSemanticsExportReceiver(context: Context, onExport: () -> Unit): BroadcastReceiver? {
    if (!isDebuggableApp(context)) return null
    val receiver = object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context, intent: Intent) {
            onExport()
        }
    }
    ContextCompat.registerReceiver(context, receiver, IntentFilter(NATIVE_SEMANTICS_EXPORT_ACTION),
        Manifest.permission.DUMP, null, ContextCompat.RECEIVER_EXPORTED)
    return receiver
}

/** Registers the Debug-only broadcast for the composition's lifetime. Release builds never register. */
@Composable
internal fun NativeSemanticsExportReceiver(exporter: NativeSemanticsExporter) {
    val view = LocalView.current
    val context = LocalContext.current
    val activity = LocalActivity.current
    DisposableEffect(exporter, view, context, activity) {
        val receiver = registerNativeSemanticsExportReceiver(context) { exporter.export(view, activity, "broadcast") }
        onDispose { if (receiver != null) context.unregisterReceiver(receiver) }
    }
}

@Composable
internal fun NativeSemanticsExportControls(exporter: NativeSemanticsExporter) {
    val view = LocalView.current
    val activity = LocalActivity.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(conclaveString("native_semantics_title"), style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.semantics { heading() })
        TextButton(onClick = { exporter.export(view, activity, "button") },
            modifier = Modifier.heightIn(min = 48.dp).testTag("semantics.export")) {
            Text(conclaveString("native_semantics_export"))
        }
        Text(exporter.status ?: conclaveString("native_semantics_idle"), modifier = Modifier.testTag("semantics.status"))
    }
}

package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.util.Locale

/*
 * Text fields, the composer and its parts, search and segmented controls (F00 C19, C20, C21; S40 6 d, CL3, R40-6;
 * S60 R6-8). The text stays in the caller's local state (keystrokes never reach a presenter until submit, F00 C19
 * k). Single-line fields are OutlinedTextFields with the label, the error as supporting text and isError; the
 * composer is a TextField on surfaceContainerHighest with no indicator, radius 20, growing to six lines with the
 * Send glyph (primary, auto-mirrored in RTL). Hardware Enter sends and Shift+Enter adds a newline. No send haptic
 * (Q11). Android composers are always the opaque field (owner OQ2 changes iOS only). Search is an OutlinedTextField
 * pinned under the app bar, never the SearchBar family (it opens a window over the stage, AND 7.7).
 */

/** What a single-line field holds; picks the keyboard, capitalization and IME action (F00 C19 d). */
internal enum class ConclaveTextFieldKind { Name, Code, Text }

@Composable
internal fun ConclaveTextField(
    label: String, value: String, onValueChange: (String) -> Unit, kind: ConclaveTextFieldKind, identifier: String,
    modifier: Modifier = Modifier, error: String? = null, enabled: Boolean = true, onSubmit: () -> Unit = {},
) {
    val options = when (kind) {
        ConclaveTextFieldKind.Name -> KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done)
        ConclaveTextFieldKind.Code -> KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
            keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go)
        ConclaveTextFieldKind.Text -> KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done)
    }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth().testTag(identifier),
        enabled = enabled,
        label = { ConclaveText(label, line = "$identifier.label") },
        supportingText = if (error == null) null else {
            { ConclaveText(error, line = "$identifier.error") }
        },
        isError = error != null,
        keyboardOptions = options,
        keyboardActions = KeyboardActions(onDone = { onSubmit() }, onGo = { onSubmit() }),
        singleLine = true,
    )
}

/** The near-limit counter ("38/40") with tabular digits and the description "38 of 40 characters", visible from
 *  [visibleFrom] characters (S10 DisplayNamePolicy: cap 40, visible from 30). Composers pass
 *  ConclaveComposerCounterPolicy.visibleFrom (90%), or 0 in voice mode where it always shows. */
@Composable
internal fun ConclaveCharacterCounter(count: Int, limit: Int, visibleFrom: Int, identifier: String, modifier: Modifier = Modifier) {
    if (count < visibleFrom) return
    val scheme = MaterialTheme.colorScheme
    val description = conclaveString("ds_char_count", count, limit)
    ConclaveText(
        conclaveString("ds_char_counter", String.format(Locale.getDefault(), "%d", count), String.format(Locale.getDefault(), "%d", limit)),
        line = identifier,
        style = rememberTabular(MaterialTheme.typography.bodySmall),
        color = if (count > limit) scheme.error else scheme.onSurfaceVariant,
        modifier = modifier.testTag(identifier).semantics { contentDescription = description },
    )
}

// Composer (F00 C19 d; S40 6 d, CL3, R40-6)

/**
 * The composer field row: an optional [attach] control (an IconButton opening a DropdownMenu, the screen's), then
 * a TextField growing to six lines with the Send glyph as its trailing icon (enabled only when [sendEnabled]); IME
 * Send and hardware Enter send, Shift+Enter adds a newline. [sendLabel] replaces "Send" ("Ask", "Send voice
 * message"). The InCallPage composer slot applies imePadding.
 */
@Composable
internal fun ConclaveComposerField(
    placeholder: String, value: String, onValueChange: (String) -> Unit, sendEnabled: Boolean, onSend: () -> Unit,
    identifier: String, modifier: Modifier = Modifier, sendLabel: String? = null, enabled: Boolean = true,
    attach: (@Composable () -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(ConclaveComposerMetrics.clusterSpacing.dp),
        verticalAlignment = Alignment.Bottom) {
        if (attach != null) attach()
        TextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.weight(1f).testTag(identifier).onPreviewKeyEvent { event ->
                if (event.type == KeyEventType.KeyDown && event.key == Key.Enter && !event.isShiftPressed) {
                    if (sendEnabled) onSend()
                    true
                } else {
                    false
                }
            },
            enabled = enabled,
            placeholder = { ConclaveText(placeholder, line = "$identifier.placeholder") },
            trailingIcon = {
                IconButton(onClick = onSend, enabled = sendEnabled, modifier = Modifier.testTag("$identifier.send")) {
                    val tint = if (sendEnabled) scheme.primary else scheme.onSurface.copy(alpha = ConclaveDisabledOpacity.android.toFloat())
                    if (sendLabel == null) {
                        Icon(ConclaveIcons.SendFill1, contentDescription = conclaveString("ds_send"), tint = tint)
                    } else {
                        Icon(ConclaveIcons.SendFill1, contentDescription = sendLabel, tint = tint)
                    }
                }
            },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (sendEnabled) onSend() }),
            maxLines = 6,
            shape = RoundedCornerShape(ConclaveComposerMetrics.androidCornerRadius.dp),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = scheme.surfaceContainerHighest,
                unfocusedContainerColor = scheme.surfaceContainerHighest,
                disabledContainerColor = scheme.surfaceContainerHighest,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                disabledIndicatorColor = Color.Transparent,
            ),
        )
    }
}

/**
 * The composer column (S40 6 d): [accessories] above the field row (suggestions, reply bar, attachment chip, link
 * preview, mode row, notice line), the [field] row, then the [footer] (the counter). 16 by 8 padding, 8 between
 * rows; rows appear without animation (S40 6 h).
 */
@Composable
internal fun ConclaveComposerStack(
    identifier: String, modifier: Modifier = Modifier, accessories: @Composable ColumnScope.() -> Unit = {},
    footer: @Composable ColumnScope.() -> Unit = {}, field: @Composable () -> Unit,
) {
    Column(
        modifier.fillMaxWidth().testTag(identifier).padding(
            horizontal = ConclaveComposerMetrics.stackHorizontalPadding.dp, vertical = ConclaveComposerMetrics.stackVerticalPadding.dp),
        verticalArrangement = Arrangement.spacedBy(ConclaveComposerMetrics.stackSpacing.dp),
        horizontalAlignment = Alignment.End,
    ) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(ConclaveComposerMetrics.stackSpacing.dp)) {
            accessories()
        }
        field()
        footer()
    }
}

/** The reply bar (S40 6 d, CL3): a 3 dp primary rule, the title and a two-line preview read as one polite node,
 *  then Cancel as its own 48 dp button. */
@Composable
internal fun ConclaveComposerReplyBar(
    title: String, preview: String, cancelLabel: String, identifier: String, onCancel: () -> Unit, modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    Row(modifier.fillMaxWidth().testTag(identifier), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.weight(1f).height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.width(ConclaveComposerMetrics.replyBarWidth.dp).fillMaxHeight().background(scheme.primary))
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }) {
                ConclaveText(title, line = "$identifier.title", style = MaterialTheme.typography.labelMedium, color = scheme.onSurface)
                if (preview.isNotEmpty()) {
                    ConclaveText(preview, line = "$identifier.preview", style = MaterialTheme.typography.bodySmall,
                        color = scheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        IconButton(onClick = onCancel, modifier = Modifier.testTag("$identifier.cancel")) {
            Icon(ConclaveIcons.CloseFill0, contentDescription = cancelLabel)
        }
    }
}

/**
 * The attachment chip (S40 6 d, CL3): an optional [thumbnail], the title, a status line ("Uploading 42%", "Ready to
 * send" or the failure reason with the error glyph), the linear indicator while preparing or uploading ([progress]
 * null is indeterminate), Try again after a failure, and Remove. Flat surfaceContainerLow with a 1 dp outlineVariant
 * border.
 */
@Composable
internal fun ConclaveComposerAttachmentChip(
    title: String, status: String, phase: ConclaveAttachmentPhase, removeLabel: String, identifier: String, onRemove: () -> Unit,
    modifier: Modifier = Modifier, progress: Float? = null, onRetry: () -> Unit = {}, thumbnail: (@Composable () -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val failed = phase == ConclaveAttachmentPhase.failed
    Surface(
        modifier = modifier.fillMaxWidth().testTag(identifier),
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerLow,
        border = BorderStroke(1.dp, scheme.outlineVariant),
    ) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (thumbnail != null) {
                Box(Modifier.size(ConclaveComposerMetrics.attachmentThumbnail.dp).clip(MaterialTheme.shapes.small).clearAndSetSemantics { }) {
                    thumbnail()
                }
            }
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) { }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ConclaveText(title, line = "$identifier.title", style = MaterialTheme.typography.titleSmall)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (failed) Icon(ConclaveIcons.ErrorFill1, contentDescription = null, tint = scheme.error, modifier = Modifier.size(16.dp))
                    ConclaveText(status, line = "$identifier.status", style = MaterialTheme.typography.bodySmall,
                        color = if (failed) scheme.error else scheme.onSurfaceVariant)
                }
                if (phase.showsProgress) {
                    if (progress != null) {
                        LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                    } else {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }
            }
            if (phase.offersRetry) {
                TextButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp).testTag("$identifier.retry")) {
                    ConclaveText(conclaveString("ds_try_again"), line = "$identifier.retry")
                }
            }
            IconButton(onClick = onRemove, modifier = Modifier.testTag("$identifier.remove")) {
                Icon(ConclaveIcons.CloseFill0, contentDescription = removeLabel)
            }
        }
    }
}

/** One status or notice line above the field (a blocked-send reason, a gate, an implicit private target), announced
 *  once politely when it appears or changes (S40 6 i). */
@Composable
internal fun ConclaveComposerStatusLine(text: String, identifier: String, modifier: Modifier = Modifier) {
    ConclaveText(text, line = identifier, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.fillMaxWidth().testTag(identifier).semantics { liveRegion = LiveRegionMode.Polite })
}

// Search (F00 C20)

/**
 * The search field pinned under the TopAppBar: a decorative leading search glyph, a clear button while there is a
 * query, a circle shape and the Search IME action. Filter the cached snapshot with ConclaveSearchPolicy as people
 * type; clearing keeps focus in the field. With [resultCount] set, a hidden polite live region speaks the count
 * while searching (TalkBack coalesces fast changes; no timer runs here).
 */
@Composable
internal fun ConclaveSearchField(
    query: String, onQueryChange: (String) -> Unit, identifier: String, modifier: Modifier = Modifier,
    placeholder: String? = null, resultCount: Int? = null, onSearch: () -> Unit = {},
) {
    val prompt = placeholder ?: conclaveString("ds_search")
    Column(modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = query,
            onValueChange = onQueryChange,
            modifier = Modifier.fillMaxWidth().testTag(identifier),
            placeholder = { ConclaveText(prompt, line = "$identifier.placeholder") },
            leadingIcon = { Icon(ConclaveIcons.SearchFill0, contentDescription = null) },
            trailingIcon = if (query.isEmpty()) null else {
                {
                    IconButton(onClick = { onQueryChange("") }, modifier = Modifier.testTag("$identifier.clear")) {
                        Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("ds_clear_search"))
                    }
                }
            },
            singleLine = true,
            shape = CircleShape,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { onSearch() }),
        )
        if (resultCount != null && ConclaveSearchPolicy.isSearching(query)) {
            val announcement = if (resultCount == 0) conclaveString("ds_no_results")
                else conclavePlural("ds_result_count", resultCount, resultCount)
            Box(Modifier.size(1.dp).semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = announcement
            })
        }
    }
}

/** No results (C14 empty): the search glyph and "No results". */
@Composable
internal fun ConclaveSearchNoResults(identifier: String, modifier: Modifier = Modifier) {
    ConclaveEmptyStatus(conclaveString("ds_no_results"), "", ConclaveIcons.SearchFill0, identifier, modifier)
}

// Segmented control (F00 C21; S60 R6-8)

/**
 * Two to four mutually exclusive options: a SingleChoiceSegmentedButtonRow (40 dp, selected secondaryContainer, no
 * coral). A change plays `selectionChanged` through the gesture route. When labels do not fit (font scale 1.5 and up)
 * [fallback] rows become C09 selectable rows and [fallback] menu becomes a dropdown in the same row (setup and
 * settings rows, so a page's Start stays above the fold). Callers pass transpiled arrays as lists (`.toList()`).
 */
@Composable
internal fun ConclaveSegmentedRow(
    options: List<ConclaveSegmentModel>, selectedId: String, identifier: String, onSelect: (String) -> Unit,
    modifier: Modifier = Modifier, fallback: ConclaveSegmentedFallback = ConclaveSegmentedFallback.rows,
    haptics: ConclaveGestureHaptics = rememberConclaveHaptics(),
    onGesture: (FeedbackKind, GestureHapticDecision) -> Unit = { _, _ -> },
) {
    val fontScale = LocalDensity.current.fontScale
    val useFallback = ConclaveSegmentedPolicy.androidUsesFallback(fontScale = fontScale.toDouble(), segmentCount = options.size)
    if (useFallback && fallback == ConclaveSegmentedFallback.rows) {
        ConclaveSelectableRows(options.map { ConclaveSelectableOption(it.id, it.title) }, selectedId, identifier, onSelect, modifier,
            haptics, onGesture)
        return
    }
    if (useFallback) {
        ConclaveSegmentedMenu(options, selectedId, identifier, onSelect, modifier, haptics, onGesture)
        return
    }
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth().testTag(identifier)) {
        options.forEachIndexed { index, option ->
            val isSelected = option.id == selectedId
            SegmentedButton(
                selected = isSelected,
                onClick = {
                    if (!isSelected) {
                        onGesture(FeedbackKind.selectionChanged, haptics.gesture(FeedbackKind.selectionChanged))
                        onSelect(option.id)
                    }
                },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                modifier = Modifier.testTag("$identifier.${option.id}"),
                enabled = option.isEnabled,
            ) {
                ConclaveText(option.title, line = "$identifier.${option.id}")
            }
        }
    }
}

/** The in-row fallback: the current value as a text button opening a flat dropdown of radio items. */
@Composable
private fun ConclaveSegmentedMenu(
    options: List<ConclaveSegmentModel>, selectedId: String, identifier: String, onSelect: (String) -> Unit, modifier: Modifier,
    haptics: ConclaveGestureHaptics, onGesture: (FeedbackKind, GestureHapticDecision) -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    var expanded by remember { mutableStateOf(false) }
    val current = options.firstOrNull { it.id == selectedId }
    Box(modifier.testTag(identifier)) {
        TextButton(onClick = { expanded = true }, modifier = Modifier.heightIn(min = 48.dp).testTag("$identifier.value")) {
            ConclaveText(current?.title ?: "", line = "$identifier.value")
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier.testTag("$identifier.menu").semantics { testTagsAsResourceId = true },
            shape = MaterialTheme.shapes.extraSmall,
            containerColor = scheme.surfaceContainer,
            tonalElevation = 0.dp,
            shadowElevation = 0.dp,
            border = BorderStroke(1.dp, scheme.outlineVariant),
        ) {
            NativeSemanticsPopupRoot("$identifier.menu")
            for (option in options) {
                val isSelected = option.id == selectedId
                DropdownMenuItem(
                    text = { ConclaveText(option.title, line = "$identifier.${option.id}") },
                    onClick = {
                        expanded = false
                        if (!isSelected) {
                            onGesture(FeedbackKind.selectionChanged, haptics.gesture(FeedbackKind.selectionChanged))
                            onSelect(option.id)
                        }
                    },
                    modifier = Modifier.testTag("$identifier.${option.id}").semantics {
                        role = Role.RadioButton
                        selected = isSelected
                    },
                    leadingIcon = { RadioButton(selected = isSelected, onClick = null) },
                    enabled = option.isEnabled,
                )
            }
        }
    }
}

/** A view switch at the top of a panel (the Transcript view switch, S60 R6-8): a PrimaryTabRow. Tab changes play
 *  nothing (S60 6 e). */
@Composable
internal fun ConclaveTabSwitch(
    options: List<ConclaveSegmentModel>, selectedId: String, identifier: String, onSelect: (String) -> Unit, modifier: Modifier = Modifier,
) {
    val index = options.indexOfFirst { it.id == selectedId }.coerceAtLeast(0)
    PrimaryTabRow(selectedTabIndex = index, modifier = modifier.fillMaxWidth().testTag(identifier)) {
        for (option in options) {
            Tab(
                selected = option.id == selectedId,
                onClick = { if (option.id != selectedId) onSelect(option.id) },
                modifier = Modifier.testTag("$identifier.${option.id}"),
                enabled = option.isEnabled,
                text = { ConclaveText(option.title, line = "$identifier.${option.id}") },
            )
        }
    }
}

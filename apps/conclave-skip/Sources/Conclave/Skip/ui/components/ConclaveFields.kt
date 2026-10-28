package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.foundation.text.input.KeyboardActionHandler
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
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
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
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
 * Send glyph (primary, auto-mirrored in RTL), on a String value or on a TextFieldState (T3 borrow P4). Hardware Enter
 * sends once per press (an auto-repeat is consumed) and Shift+Enter adds a newline; a screen's own hardware keys run
 * first. No send haptic (Q11). Android composers are always the opaque field (owner OQ2 changes iOS only). Search is
 * an OutlinedTextField pinned under the app bar, never the SearchBar family (it opens a window over the stage, AND
 * 7.7).
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
 *  ConclaveComposerCounterPolicy.visibleFrom (90%), or 0 in voice mode where it always shows.
 *  [announcesBands] is opt-in (S40 6 i; T3 borrow P9; only the chat composer and the Q&A question pass true): the
 *  counter is spoken once when it appears and at every crossing between near and over, never per character, through
 *  ConclaveCounterBandAnnouncer. Every other caller keeps the silent counter. */
@Composable
internal fun ConclaveCharacterCounter(
    count: Int, limit: Int, visibleFrom: Int, identifier: String, modifier: Modifier = Modifier, announcesBands: Boolean = false,
) {
    val band = ConclaveComposerCounterPolicy.band(count = count, limit = limit, visibleFrom = visibleFrom)
    // Called before the hidden return, so it stays in the composition while the counter is hidden and sees every band
    // change (hidden to near and hidden to over included). It emits no layout node, so it never adds the composer
    // column's 8 dp spacing under the field at rest.
    if (announcesBands) ConclaveCounterBandAnnouncer(count, limit, band)
    if (band == ConclaveCounterBand.hidden) return
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

/**
 * P9 (T3 borrow; S40 6 i): an opted-in counter's band, spoken once per crossing as ConclaveComposerCounterPolicy
 * .announces decides (hidden to near or over, and between near and over; never inside a band and never on the way
 * back to hidden). The band last seen is kept in a plain holder that survives the counter's hidden stretches, so a
 * recomposition never repeats it and a counter composed already in a band (a reopened panel) stays quiet. The text is
 * the one composed at the crossing (the count description, for example 900 of 1000 characters, or the over-limit
 * plural). It is posted from SideEffect through View.announceForAccessibility (as AppPageAnnouncer and AudioPages do):
 * Compose's accessibility delegate reports a live region change only for a node that was already in the previous
 * semantics snapshot, so a polite node that appears with the counter is silent, and a node kept while the counter is
 * hidden would be an extra spaced child of the composer column.
 */
@Composable
private fun ConclaveCounterBandAnnouncer(count: Int, limit: Int, band: ConclaveCounterBand) {
    val view = LocalView.current
    val memory = remember { ConclaveCounterBandMemory(band) }
    val spoken = conclaveCounterAnnouncement(band, count, limit)
    SideEffect {
        val previous = memory.band
        if (previous != band) {
            memory.band = band
            if (ConclaveComposerCounterPolicy.announces(previous = previous, next = band) && spoken.isNotEmpty()) {
                @Suppress("DEPRECATION")
                view.announceForAccessibility(spoken)
            }
        }
    }
}

/** P9: the counter's spoken copy for a band (S40 6 g): the count description near the limit, the over-limit plural past
 *  it, "" while hidden. */
@Composable
private fun conclaveCounterAnnouncement(band: ConclaveCounterBand, count: Int, limit: Int): String = when (band) {
    ConclaveCounterBand.hidden -> ""
    ConclaveCounterBand.near -> conclaveString("ds_char_count", count, limit)
    ConclaveCounterBand.over -> {
        val over = ConclaveComposerCounterPolicy.overflow(count = count, limit = limit)
        conclavePlural("ds_char_over_limit", over, over)
    }
}

/** P9: the band the announcer last saw; a plain field, never Compose state, so writing it recomposes nothing. */
private class ConclaveCounterBandMemory(var band: ConclaveCounterBand)

// Composer (F00 C19 d; S40 6 d, CL3, R40-6)

/**
 * The composer field row: an optional [attach] control (an IconButton opening a DropdownMenu, the screen's) centred on
 * the field's one-line height, then a TextField growing to six lines with Send in its bottom trailing band (enabled
 * only when [sendEnabled]; while disabled, [sendDisabledReason] is its state description, S40 6 i). IME Send sends
 * only when [sendEnabled] (Q13). Hardware keys go through conclaveComposerKey: [onHardwareKey] first (the screen's
 * suggestion keys), then Enter and NumPadEnter send once per press and Shift+Enter adds a newline. [sendLabel]
 * replaces "Send" ("Ask", "Send voice message"). [modifier] is the row's; [fieldModifier] is the TextField's own, for
 * a screen that needs the field itself (a FocusRequester or a focus observer: on the row, a hardware keyboard's
 * focus request lands on the attach control first). The InCallPage composer slot applies imePadding. Transcript Ask
 * and Q&A use this value overload; the chat composer uses the TextFieldState overload below.
 */
@Composable
internal fun ConclaveComposerField(
    placeholder: String, value: String, onValueChange: (String) -> Unit, sendEnabled: Boolean, onSend: () -> Unit,
    identifier: String, modifier: Modifier = Modifier, sendLabel: String? = null, enabled: Boolean = true,
    sendDisabledReason: String = "", onHardwareKey: ((KeyEvent) -> Boolean)? = null, fieldModifier: Modifier = Modifier,
    attach: (@Composable () -> Unit)? = null,
) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(ConclaveComposerMetrics.clusterSpacing.dp),
        verticalAlignment = Alignment.Bottom) {
        if (attach != null) ConclaveComposerAttachSlot(attach)
        Box(Modifier.weight(1f)) {
            TextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.fillMaxWidth().then(fieldModifier).testTag(identifier).onPreviewKeyEvent { event ->
                    conclaveComposerKey(event, sendEnabled, onSend, onHardwareKey)
                },
                enabled = enabled,
                placeholder = { ConclaveText(placeholder, line = "$identifier.placeholder") },
                trailingIcon = { Spacer(Modifier.size(48.dp)) },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { if (sendEnabled) onSend() }),
                maxLines = 6,
                shape = RoundedCornerShape(ConclaveComposerMetrics.androidCornerRadius.dp),
                colors = conclaveComposerColors(),
            )
            ConclaveComposerSendSlot(Modifier.align(Alignment.BottomEnd)) {
                ConclaveComposerSend(identifier, sendEnabled, onSend, sendLabel, sendDisabledReason)
            }
        }
    }
}

/**
 * The same composer row on a [TextFieldState] (T3 borrow P4): the material3 1.4.0 state TextField, so the screen can
 * receive keyboard images, pasted images and drops through one contentReceiver and keep native text paste and undo.
 * Six lines (TextFieldLineLimits.MultiLine), IME Send through onKeyboardAction only when [sendEnabled] (Q13), and the
 * same Send, attach slot, colors, hardware keys and [fieldModifier] as the value overload. While Send is disabled an
 * IME Send calls [onSendBlocked] instead (never onSend), so the screen can say why (S40 6 i; T3 borrow P6).
 */
@Composable
internal fun ConclaveComposerField(
    placeholder: String, state: TextFieldState, sendEnabled: Boolean, onSend: () -> Unit, identifier: String,
    modifier: Modifier = Modifier, sendLabel: String? = null, sendDisabledReason: String = "", enabled: Boolean = true,
    onHardwareKey: ((KeyEvent) -> Boolean)? = null, onSendBlocked: (() -> Unit)? = null, fieldModifier: Modifier = Modifier,
    attach: (@Composable () -> Unit)? = null,
) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(ConclaveComposerMetrics.clusterSpacing.dp),
        verticalAlignment = Alignment.Bottom) {
        if (attach != null) ConclaveComposerAttachSlot(attach)
        Box(Modifier.weight(1f)) {
            TextField(
                state = state,
                modifier = Modifier.fillMaxWidth().then(fieldModifier).testTag(identifier).onPreviewKeyEvent { event ->
                    conclaveComposerKey(event, sendEnabled, onSend, onHardwareKey)
                },
                enabled = enabled,
                placeholder = { ConclaveText(placeholder, line = "$identifier.placeholder") },
                trailingIcon = { Spacer(Modifier.size(48.dp)) },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                onKeyboardAction = conclaveComposerImeSend(sendEnabled, onSendBlocked, onSend),
                lineLimits = TextFieldLineLimits.MultiLine(maxHeightInLines = 6),
                shape = RoundedCornerShape(ConclaveComposerMetrics.androidCornerRadius.dp),
                colors = conclaveComposerColors(),
            )
            ConclaveComposerSendSlot(Modifier.align(Alignment.BottomEnd)) {
                ConclaveComposerSend(identifier, sendEnabled, onSend, sendLabel, sendDisabledReason)
            }
        }
    }
}

/**
 * The composer's hardware keys (S40 6 d and 6 l8; T3 borrow P1 and P2). [onHardwareKey] sees every key event first,
 * KeyDown and KeyUp, so a screen that consumes Escape can consume its KeyUp as well; returning true consumes the event.
 * Then Enter and NumPadEnter on KeyDown without Shift: the first press sends when Send is enabled and an auto-repeat
 * (repeatCount above 0) is consumed without sending, so a held key sends once and never fills the field with newlines.
 * Shift+Enter falls through to the field as a newline. The soft keyboard's Send is an IME action, not a key event.
 */
internal fun conclaveComposerKey(
    event: KeyEvent, sendEnabled: Boolean, onSend: () -> Unit, onHardwareKey: ((KeyEvent) -> Boolean)?,
): Boolean {
    if (onHardwareKey != null && onHardwareKey(event)) return true
    if (event.type != KeyEventType.KeyDown) return false
    if (event.key == Key.Enter && !event.isShiftPressed) {
        if (event.nativeKeyEvent.repeatCount == 0 && sendEnabled) onSend()
        return true
    }
    if (event.key == Key.NumPadEnter && !event.isShiftPressed) {
        if (event.nativeKeyEvent.repeatCount == 0 && sendEnabled) onSend()
        return true
    }
    return false
}

/** IME Send on the state field (Q13): sends only while Send is enabled and runs no default action, so a blocked Send
 *  keeps the draft and the keyboard. A blocked press goes to [onSendBlocked] (the screen posts the reason, P6), never
 *  to [onSend]. */
internal fun conclaveComposerImeSend(
    sendEnabled: Boolean, onSendBlocked: (() -> Unit)? = null, onSend: () -> Unit,
): KeyboardActionHandler = KeyboardActionHandler { if (sendEnabled) onSend() else onSendBlocked?.invoke() }

/** The disabled Send's state description (S40 6 i, AX2): the reason while Send is disabled and one is given. */
internal fun conclaveSendStateDescription(sendEnabled: Boolean, reason: String): String? =
    if (!sendEnabled && reason.isNotEmpty()) reason else null

/** The attach control centred on the field's one-line height (T3 borrow P5): level with a single line of text, then
 *  in the bottom band as the field grows to six lines. */
@Composable
private fun ConclaveComposerAttachSlot(attach: @Composable () -> Unit) {
    Box(Modifier.heightIn(min = TextFieldDefaults.MinHeight), contentAlignment = Alignment.Center) {
        attach()
    }
}

/** Keep Send level with the attach control as the field grows. The native trailing slot above reserves text
 *  space without centring the action halfway up a multiline draft. End alignment also follows RTL. */
@Composable
private fun ConclaveComposerSendSlot(modifier: Modifier, send: @Composable () -> Unit) {
    Box(modifier.width(48.dp).heightIn(min = TextFieldDefaults.MinHeight), contentAlignment = Alignment.Center) {
        send()
    }
}

/** Send: the glyph in primary while enabled and onSurface at the disabled opacity otherwise (auto-mirrored in RTL);
 *  the disabled reason is its state description, so TalkBack never hears a bare disabled Send. */
@Composable
private fun ConclaveComposerSend(identifier: String, sendEnabled: Boolean, onSend: () -> Unit, sendLabel: String?, reason: String) {
    val scheme = MaterialTheme.colorScheme
    val stateText = conclaveSendStateDescription(sendEnabled, reason)
    IconButton(onClick = onSend, enabled = sendEnabled, modifier = Modifier.testTag("$identifier.send").semantics {
        if (stateText != null) stateDescription = stateText
    }) {
        val tint = if (sendEnabled) scheme.primary else scheme.onSurface.copy(alpha = ConclaveDisabledOpacity.android.toFloat())
        if (sendLabel == null) {
            Icon(ConclaveIcons.SendFill1, contentDescription = conclaveString("ds_send"), tint = tint)
        } else {
            Icon(ConclaveIcons.SendFill1, contentDescription = sendLabel, tint = tint)
        }
    }
}

/** The composer container: surfaceContainerHighest in every state and no indicator (S40 6 e). */
@Composable
private fun conclaveComposerColors(): TextFieldColors {
    val scheme = MaterialTheme.colorScheme
    return TextFieldDefaults.colors(
        focusedContainerColor = scheme.surfaceContainerHighest,
        unfocusedContainerColor = scheme.surfaceContainerHighest,
        disabledContainerColor = scheme.surfaceContainerHighest,
        focusedIndicatorColor = Color.Transparent,
        unfocusedIndicatorColor = Color.Transparent,
        disabledIndicatorColor = Color.Transparent,
    )
}

/**
 * The composer column (S40 6 d): [accessories] above the field row (suggestions, reply bar, attachment chip, link
 * preview, mode row, notice line), the [field] row, then the [footer] (the counter). Default 16 by 8 [contentPadding],
 * which a page that already owns the gutter can override; 8 between rows, without animation (S40 6 h).
 */
@Composable
internal fun ConclaveComposerStack(
    identifier: String, modifier: Modifier = Modifier, accessories: @Composable ColumnScope.() -> Unit = {},
    footer: @Composable ColumnScope.() -> Unit = {},
    contentPadding: PaddingValues = PaddingValues(horizontal = ConclaveComposerMetrics.stackHorizontalPadding.dp,
        vertical = ConclaveComposerMetrics.stackVerticalPadding.dp),
    field: @Composable () -> Unit,
) {
    Column(
        modifier.fillMaxWidth().testTag(identifier).padding(contentPadding),
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

package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/*
 * S60 9 d B1 (ACT-3) on Android: the Reaction pad. One button that fills the card's width: pointer-down sends exactly one
 * tap (awaitFirstDown inside awaitEachGesture, latched until the next phase, so a held touch or a second finger never
 * sends twice); the TalkBack click action and the Space and Enter keys call the same action. Arming is
 * surfaceContainerHigh with "Wait for green"; go is ext.success with dark ink (ext.onWarning, the in-call dark text
 * token on bright status fills) "Tap now": text and state, never color alone, never white on green (INM G8). An early
 * tap reads "Too soon" with the warning glyph. Color and text change in one frame (no transition runs, so timing
 * is fair). `tapValid` plays only for a tap sent while the pad showed go; the go transition is announced once in an
 * assertive live region so TalkBack players can play.
 */

@Composable
internal fun ReactionPad(scene: ReactionScene, games: GameStagePresenter) {
    var sent by remember(scene.phaseKey) { mutableStateOf(false) }
    val haptics = rememberConclaveHaptics()
    val state = scene.displayedPadState(sent)
    val isGo = state == ReactionPadState.go
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val shape = MaterialTheme.shapes.medium
    val title = reactionPadTitle(state, scene.reactionMs)
    val tapLabel = conclaveString("gm_reaction_go")
    val latestScene by rememberUpdatedState(scene)
    val fire: () -> Unit = {
        val current = latestScene
        if (!sent && current.canTap) {
            val showedGo = current.displayedPadState(false) == ReactionPadState.go
            if (games.send(GameMoveIntent.tap()) == ActivityTapResult.dispatched) {
                sent = true
                if (showedGo) haptics.gesture(FeedbackKind.tapValid)
            }
        }
    }
    val latestFire by rememberUpdatedState(fire)
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 220.dp)
            .background(if (isGo) ext.success else scheme.surfaceContainerHigh, shape)
            .border(1.dp, if (isGo) ext.success else ext.border, shape)
            .testTag("game.reaction.pad")
            .pointerInput(scene.phaseKey, scene.canTap) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    latestFire()
                }
            }
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = tapLabel
                if (!isGo) stateDescription = title
                onClick(label = tapLabel) {
                    latestFire()
                    true
                }
            }
            .onKeyEvent { event ->
                if (event.type == KeyEventType.KeyDown && (event.key == Key.Spacebar || event.key == Key.Enter)) {
                    latestFire()
                    true
                } else {
                    false
                }
            }
            .focusable(enabled = scene.canTap),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (state == ReactionPadState.early) {
                Icon(ConclaveIcons.WarningFill1, contentDescription = null, tint = ext.warning, modifier = Modifier.size(32.dp))
            }
            Text(
                title,
                style = MaterialTheme.typography.displaySmall,
                color = if (isGo) ext.onWarning else scheme.onSurface,
                textAlign = TextAlign.Center,
            )
        }
    }
    PromptAnnouncement(games, PromptScenePolicy.reactionGoKey(scene), tapLabel, assertive = true)
}

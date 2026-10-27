package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/*
 * S40 3 d (CL6) and 6 d (link preview), CHT-5 on Android. A card reads one ready ChatEmbedEntry (the presenter adds a
 * URL to a row only once its card is ready, CH16), so it appears once with fixed geometry (240 dp, a 16:9 image box or
 * a 64 dp thumbnail, fixed line counts) and never resizes. Each card is one clickable node that opens the link through
 * the chat's link policy (Custom Tabs in the call task, D23, Q16), so YouTube and X stay in front; the installed app is
 * not launched directly. Views never start a fetch: the composer preview asks the presenter after its 450 ms debounce.
 */

internal object ChatEmbedLayoutAndroid {
    val cardWidth = 240.dp
    val largeImageHeight = 135.dp
    val thumbSize = 64.dp
    val previewThumb = 40.dp
}

/** One link card: large page or image, thumbnail page, YouTube, or an X post with up to four media cells. */
@Composable
internal fun LinkEmbedCard(entry: ChatEmbedEntry, rowId: String, index: Int, onOpen: (String) -> Unit) {
    if (entry.phase != ChatEmbedPhase.ready) return
    val model = entry.model ?: return
    val scheme = MaterialTheme.colorScheme
    val label = chatEmbedLabel(model)
    OutlinedCard(
        onClick = { onOpen(model.url) },
        modifier = Modifier.width(ChatEmbedLayoutAndroid.cardWidth).testTag("chat.row.$rowId.embed.$index")
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
                // The cleared node keeps one explicit activation, so TalkBack opens the card like a tap.
                onClick {
                    onOpen(model.url)
                    true
                }
            },
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.outlinedCardColors(containerColor = scheme.surfaceContainerLow),
        border = BorderStroke(1.dp, scheme.outlineVariant),
    ) {
        when (model.kind) {
            ChatEmbedKind.youtube -> {
                ChatEmbedLargeImage(model.imageURL, showsPlay = true)
                ChatEmbedText(chatEmbedSite(model), model.title.ifEmpty { conclaveString("chat_embed_youtube") }, "")
            }
            ChatEmbedKind.tweet -> ChatEmbedPost(model)
            ChatEmbedKind.image -> ChatEmbedLargeImage(model.imageURL, showsPlay = false)
            else -> {
                if (model.isLargeImage && model.imageURL.isNotEmpty()) {
                    ChatEmbedLargeImage(model.imageURL, showsPlay = false)
                    ChatEmbedText(chatEmbedSite(model), model.title, model.summary)
                } else {
                    Row(verticalAlignment = Alignment.Top) {
                        Box(Modifier.weight(1f)) { ChatEmbedText(chatEmbedSite(model), model.title, model.summary) }
                        if (model.imageURL.isNotEmpty()) {
                            ChatImageBox(model.imageURL, ChatEmbedLayoutAndroid.thumbSize, ChatEmbedLayoutAndroid.thumbSize,
                                modifier = Modifier.padding(top = 12.dp, end = 12.dp))
                        }
                    }
                }
            }
        }
    }
}

/** The card's spoken label (3 g): "Play video: <title>" or "Watch on YouTube", "Linked image", the post, the page. */
@Composable
internal fun chatEmbedLabel(model: ChatEmbedModel): String = when (model.kind) {
    ChatEmbedKind.youtube -> if (model.title.isEmpty()) conclaveString("chat_embed_youtube") else conclaveString("chat_embed_play", model.title)
    ChatEmbedKind.image -> conclaveString("chat_embed_image")
    ChatEmbedKind.tweet -> listOf(model.authorName.ifEmpty { model.siteName }, model.postText).filter { it.isNotEmpty() }.joinToString(", ")
    else -> listOf(model.siteName, model.title, model.summary).filter { it.isNotEmpty() }.joinToString(", ")
}

internal fun chatEmbedSite(model: ChatEmbedModel): String =
    model.siteName.ifEmpty { LinkEmbedPolicy.displayHost(model.url) }

@Composable
private fun ChatEmbedLargeImage(url: String, showsPlay: Boolean) {
    Box(contentAlignment = Alignment.Center) {
        ChatImageBox(url, ChatEmbedLayoutAndroid.cardWidth, ChatEmbedLayoutAndroid.largeImageHeight, shape = RoundedCornerShape(0.dp))
        if (showsPlay) {
            Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surface) {
                Icon(ConclaveIcons.VideocamFill1, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(12.dp).size(24.dp))
            }
        }
    }
}

@Composable
private fun ChatEmbedText(site: String, title: String, summary: String) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (site.isNotEmpty()) {
            ConclaveText(site, line = "chat.embed.site", style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (title.isNotEmpty()) {
            ConclaveText(title, line = "chat.embed.title", style = MaterialTheme.typography.titleSmall, color = scheme.onSurface,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (summary.isNotEmpty()) {
            ConclaveText(summary, line = "chat.embed.summary", style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** An X post: author and handle, the text (4 lines) and a grid of 1 to 4 fixed cells. */
@Composable
private fun ChatEmbedPost(model: ChatEmbedModel) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column {
            ConclaveText(model.authorName.ifEmpty { chatEmbedSite(model) }, line = "chat.embed.author",
                style = MaterialTheme.typography.titleSmall, color = scheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (model.authorHandle.isNotEmpty()) {
                ConclaveText("@" + model.authorHandle, line = "chat.embed.handle", style = MaterialTheme.typography.labelSmall,
                    color = scheme.onSurfaceVariant, maxLines = 1)
            }
        }
        if (model.postText.isNotEmpty()) {
            ConclaveText(model.postText, line = "chat.embed.post", style = MaterialTheme.typography.bodySmall, color = scheme.onSurface,
                maxLines = 4, overflow = TextOverflow.Ellipsis)
        }
        val media = model.media.toList()
        if (media.isNotEmpty()) {
            val inner = ChatEmbedLayoutAndroid.cardWidth - 24.dp
            val gap = 4.dp
            if (media.size == 1) {
                ChatImageBox(media[0].url, inner, inner * 9 / 16)
            } else {
                val cell = (inner - gap) / 2
                Column(verticalArrangement = Arrangement.spacedBy(gap)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                        ChatImageBox(media[0].url, cell, cell)
                        ChatImageBox(media[1].url, cell, cell)
                    }
                    if (media.size > 2) {
                        Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                            ChatImageBox(media[2].url, cell, cell)
                            if (media.size > 3) ChatImageBox(media[3].url, cell, cell) else Spacer(Modifier.size(cell))
                        }
                    }
                }
            }
        }
    }
}

/**
 * S40 6 d link preview above the field: the draft's first embeddable URL after a 450 ms pause, shown once its card is
 * ready, with Remove (the send then carries suppressEmbeds). The entry comes from the presenter, never a fetch here.
 */
@Composable
internal fun ChatComposerLinkPreview(presenter: ChatPresenter, draft: String, dismissedUrl: String, onDismiss: (String) -> Unit) {
    val url = ChatComposerPolicy.linkPreviewURL(draft)
    var entry by remember { mutableStateOf<ChatEmbedEntry?>(null) }
    LaunchedEffect(url) {
        if (url.isEmpty()) return@LaunchedEffect
        delay(450)
        entry = presenter.requestLinkPreview(url)
    }
    val current = entry ?: return
    if (current.url != url || url == dismissedUrl || current.phase != ChatEmbedPhase.ready) return
    val model = current.model ?: return
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier.fillMaxWidth().testTag("chat.composer.linkPreview"),
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerLow,
        border = BorderStroke(1.dp, scheme.outlineVariant),
    ) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (model.imageURL.isEmpty()) {
                Box(Modifier.size(ChatEmbedLayoutAndroid.previewThumb).background(scheme.surfaceContainerHighest, MaterialTheme.shapes.small)
                    .clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
                    Icon(ConclaveIcons.PublicFill0, contentDescription = null, tint = scheme.onSurfaceVariant)
                }
            } else {
                ChatImageBox(model.imageURL, ChatEmbedLayoutAndroid.previewThumb, ChatEmbedLayoutAndroid.previewThumb,
                    modifier = Modifier.clearAndSetSemantics { })
            }
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) { }) {
                ConclaveText(conclaveString("chat_link_preview") + " · " + chatEmbedSite(model), line = "chat.composer.linkPreview.site",
                    style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                ConclaveText(model.title.ifEmpty { model.url }, line = "chat.composer.linkPreview.title",
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold), color = scheme.onSurface,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(onClick = { onDismiss(current.url) }, modifier = Modifier.testTag("chat.composer.linkPreview.remove")) {
                Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("chat_link_preview_remove"))
            }
        }
    }
}

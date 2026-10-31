package conclave.module

import android.content.Context
import coil3.size.Dimension
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CHT4CHT5BridgeTests {
    private val local = "jordan@example.com#s1"
    private val avery = "avery@example.com#w1"
    private val base = 1_800_014_400_000.0

    private fun roster() = skip.lib.Array(listOf(
        ChatRosterEntry(userId = local, name = "Jordan Lee", isPresent = true),
        ChatRosterEntry(userId = avery, name = "Avery Lee", isPresent = true),
    ))

    private fun inputs(attachment: ChatAttachmentState = ChatAttachmentState.none, photosEnabled: Boolean = true) =
        ChatInputs.make(callSession = 1, roomId = "room-a", localUserId = local, localName = "Jordan Lee",
            photosEnabled = photosEnabled, gate = ChatSendGate.allowed, roster = roster(), assistant = AssistantAvailability.available,
            attachment = attachment)

    private fun presenter(attachment: ChatAttachmentState = ChatAttachmentState.none, log: MutableList<ChatCommandRequest>): ChatPresenter {
        val chat = ChatPresenter()
        chat.now = { base + 600_000.0 }
        chat.apply(inputs(attachment), ChatInputChange.messages)
        chat.onCommand = { log.add(it) }
        return chat
    }

    private fun bytes(vararg values: Int): skip.lib.Array<UByte> {
        val list = values.map { it.toUByte() }.toMutableList()
        while (list.size < 12) list.add(0u)
        return skip.lib.Array(list)
    }

    private fun ascii(prefix: List<Int>, text: String): skip.lib.Array<UByte> =
        skip.lib.Array((prefix + text.map { it.code }).map { it.toUByte() })

    @Test
    fun sniffingAndThePlanMatchSwift() {
        assertEquals("image/png", ChatPhotoPolicy.sniff(bytes(0x89, 0x50, 0x4E, 0x47)))
        assertEquals("image/jpeg", ChatPhotoPolicy.sniff(bytes(0xFF, 0xD8, 0xFF, 0xE0)))
        assertEquals("image/heic", ChatPhotoPolicy.sniff(ascii(listOf(0, 0, 0, 0x18), "ftypheic")))
        assertEquals("image/avif", ChatPhotoPolicy.sniff(ascii(listOf(0, 0, 0, 0x1C), "ftypavif")))
        assertEquals("", ChatPhotoPolicy.sniff(ascii(listOf(), "%PDF-1.7 abc")))
        val six = ChatPhotoPolicy.maxBytes
        assertEquals(ChatPhotoPlanKind.upload, ChatPhotoPolicy.plan("image/jpeg", six).kind)
        assertEquals(ChatPhotoPlanKind.transcode, ChatPhotoPolicy.plan("image/jpeg", six + 1).kind)
        assertEquals(ChatPhotoPlanKind.transcode, ChatPhotoPolicy.plan("image/heic", 1000).kind)
        assertEquals(ChatFailure.photoTooLarge, ChatPhotoPolicy.plan("image/gif", six + 1).failure)
        assertEquals(ChatFailure.photoBlocked, ChatPhotoFailurePolicy.failure("", "chat_image_moderation_blocked"))
        assertEquals(ChatFailure.photosDisabled, ChatPhotoFailurePolicy.failure("Image attachments are disabled by the host.", ""))
    }

    @Test
    fun theAttachmentFlowAndThePhotoSendRulesMatchSwift() {
        val log = mutableListOf<ChatCommandRequest>()
        val chat = presenter(log = log)
        assertEquals(listOf("photo", "gif", "voice"), chat.composer.attachKinds.toList())
        chat.attachPhoto("file:///cache/chat-photos/a.jpg", "image/jpeg", "a.jpg")
        assertEquals(ChatAttachmentPhase.preparing, chat.composer.attachment.phase)
        assertEquals(ChatCommandKind.attachPhoto, log.last().kind)
        assertEquals(ChatSendResult.blocked, chat.send("caption", ""))
        val ready = ChatAttachmentState(phase = ChatAttachmentPhase.ready, progress = 1.0, thumbnailKey = "file:///cache/chat-photos/a.jpg",
            failure = ChatFailure.none)
        chat.apply(inputs(ready), ChatInputChange.attachment)
        assertTrue(ChatComposerPolicy.canSend("", ChatSendGate.allowed, false, chat.composer.attachment))
        assertEquals(ChatSendResult.blocked, chat.send("@Conclave what is this?", ""))
        assertEquals(ChatFailure.oneAttachment, chat.composer.inlineNotice)
        assertEquals(ChatSendResult.dispatched, chat.send("", ""))
        assertEquals("file:///cache/chat-photos/a.jpg", log.last().fileURL)
        assertEquals(ChatAttachmentPhase.none, chat.composer.attachment.phase)
        val off = presenter(log = log).also { it.apply(inputs(photosEnabled = false), ChatInputChange.policy) }
        val count = log.size
        off.attachPhoto("file:///x.jpg", "image/jpeg", "x.jpg")
        assertEquals(count, log.size)
        assertEquals(ChatFailure.photosDisabled, off.composer.inlineNotice)
    }

    @Test
    fun embedRulesAndYouTubeIdsMatchTheWebLikeSwift() {
        fun urls(text: String): List<String> = LinkEmbedPolicy.embedURLs(text, 2).toList()
        assertEquals(listOf("https://docs.example.com/agenda"), urls("see https://docs.example.com/agenda."))
        assertEquals(listOf<String>(), urls("bare docs.example.com links but never embeds"))
        assertEquals(listOf<String>(), urls("quiet <https://docs.example.com/agenda> please"))
        assertEquals(listOf("https://a.example/", "https://b.example/"), urls("https://a.example https://b.example https://c.example"))
        assertEquals(listOf("https://a.example/x"), urls("https://a.example/x again https://a.example/x"))
        assertEquals(listOf<String>(), urls("https://user@host.example/secret"))
        assertEquals(listOf("https://x.io/y"), urls("(see https://x.io/y)"))

        assertEquals(listOf("https://a.example/x?y=1&z=2#top"), urls("https://A.example/x?y=1&z=2#top"))
        assertEquals("https://conclave.acmvit.in/api/unfurl?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ%26t%3D4%23c",
            LinkEmbedService.unfurlURLString("https://youtube.com/watch?v=dQw4w9WgXcQ&t=4#c", "https://conclave.acmvit.in"))
        assertEquals("dQw4w9WgXcQ", LinkEmbedPolicy.youTubeVideoId("https://youtu.be/dQw4w9WgXcQ"))
        assertEquals("dQw4w9WgXcQ", LinkEmbedPolicy.youTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
        assertEquals("", LinkEmbedPolicy.youTubeVideoId("https://vimeo.com/1"))
        assertEquals("https://conclave.acmvit.in/api/unfurl/asset?url=a",
            LinkEmbedPolicy.resolvedAssetURL("/api/unfurl/asset?url=a", "https://conclave.acmvit.in/"))
    }

    @Test
    fun stalePickerResponsesAreDroppedLikeSwift() {
        fun gif(id: String) = ChatGifAttachment(id = id, title = id, url = "https://m.example/$id.gif", previewUrl = null, pageUrl = null,
            width = 1.0, height = 1.0, kind = "gif", videoUrl = null, source = "klipy")
        val first = ChatGifPickerState.initial.starting(ChatGifKind.gif, "c")
        val second = first.starting(ChatGifKind.gif, "ca")
        val page = ChatGifPage(items = skip.lib.Array(listOf(gif("1"), gif("2"))), hasNext = true, failed = false)
        assertEquals(second, second.acceptingFirst(page, first.generation))
        val shown = second.acceptingFirst(page, second.generation)
        assertEquals(ChatGifPickerPhase.results, shown.phase)
        val more = shown.startingMore().acceptingMore(ChatGifPage(items = skip.lib.Array(listOf(gif("2"), gif("3"))), hasNext = false,
            failed = false), shown.generation)
        assertEquals(3, more.items.count)
        val failed = shown.startingMore().acceptingMore(ChatGifPage.failure, shown.generation)
        assertTrue(failed.loadMoreFailed && failed.hasNext)
    }

    @Test
    fun suppressEmbedsAndTheGifSendTravelInTheRequest() {
        val log = mutableListOf<ChatCommandRequest>()
        val chat = presenter(log = log)
        chat.send("look https://a.example/x", "https://a.example/x")
        assertTrue(log.last().flag)
        chat.send("look https://b.example/y", "https://a.example/x")
        assertFalse(log.last().flag)
        val gif = ChatGifAttachment(id = "g1", title = "Party", url = "https://m.example/g1.gif", previewUrl = null, pageUrl = null,
            width = 2.0, height = 1.0, kind = "gif", videoUrl = null, source = "klipy")
        chat.sendGif(gif)
        assertEquals(ChatCommandKind.sendGif, log.last().kind)
        assertEquals("g1", log.last().text)
        assertNotNull(chat.takeSentGif("g1"))
        assertNull(chat.takeSentGif("g1"))
    }

    @Test
    fun coilRequestsAreBoundedToTheBoxSize() {
        val context: Context = RuntimeEnvironment.getApplication()
        val animated = ChatImageRequests.request(context, "file:///cache/a.gif", 720, 540, true, 150)
        val size = runBlocking { animated.sizeResolver.size() }
        assertEquals(720, (size.width as Dimension.Pixels).px)
        assertEquals(540, (size.height as Dimension.Pixels).px)
        val still = ChatImageRequests.request(context, "file:///cache/a.gif", 720, 540, false, 0)
        assertTrue(still.decoderFactory is coil3.decode.BitmapFactoryDecoder.Factory)
        assertEquals(240.0, ChatMediaGeometry.photoWidth, 0.0)
        assertEquals(180.0, ChatMediaGeometry.photoHeight, 0.0)
    }

    @Test
    fun theFileProviderDirectoryAndAuthorityMatchTheManifest() {
        val context: Context = RuntimeEnvironment.getApplication()
        assertEquals(context.packageName + ".fileprovider", ChatPhotoFiles.authority(context))
        val folder = ChatPhotoFiles.directory(context)
        assertEquals("chat-photos", folder.name)
        assertEquals(context.cacheDir.absolutePath, folder.parentFile?.absolutePath)
    }

    @Test
    fun webLinksFallBackToTheConfirmationWithoutACustomTabsActivity() {
        val context: Context = RuntimeEnvironment.getApplication()
        val actions = ChatRowActions(ChatPresenter(), context)
        assertFalse(ChatLinkLauncher.openInCustomTab(context, "https://docs.example.com/agenda"))
        actions.openLink("https://docs.example.com/agenda")
        assertEquals("https://docs.example.com/agenda", actions.pendingExternalUrl)
        assertTrue(actions.pendingExternalIsWeb)
        actions.openLink("mailto:avery@example.com")
        assertFalse(actions.pendingExternalIsWeb)
        actions.openPhoto("s-9")
        assertEquals("s-9", actions.photoRowId)
        actions.closePhoto()
        actions.openGifs()
        assertTrue(actions.showsGifs)
    }
}

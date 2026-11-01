package conclave.module

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
class CHT8PreviewBridgeTests {
    private fun host(isAttendee: Boolean = false): StageNoticeInputs = StageNoticeInputs.make(
        callSession = 1, isAttendee = isAttendee, isHost = !isAttendee, localUserId = "you", participantCount = 4,
        hasInitialPresenceSnapshot = true,
    )

    private fun message(id: String, content: String, userId: String = "r1", name: String = "Avery Lee", isDirect: Boolean = false,
                        image: ChatImageAttachment? = null, isTts: Boolean = false): ChatMessage =
        ChatMessage(id = id, userId = userId, displayName = name, content = content, image = image, isDirect = isDirect, isTts = isTts)

    private fun preview(id: String, content: String, userId: String = "r1", name: String = "Avery Lee",
                        isDirect: Boolean = false): StageEvent =
        ChatPreviewPolicy.event(message = message(id, content, userId, name, isDirect), canonicalSenderId = userId)

    private fun center(isAttendee: Boolean = false): MeetingNoticeCenter {
        val center = MeetingNoticeCenter(platform = NoticePlatform.android)
        center.applyState(host(isAttendee), nowMillis = 0.0)
        return center
    }

    private fun presenter(previews: Boolean = true): StagePresenter {
        val stage = StagePresenter(shell = MeetingShellPresenter())
        stage.chatPreviewsEnabled = { previews }
        stage.apply(StageFixtureScript.base(count = 4))
        stage.applyNotices(host())
        return stage
    }

    @Test fun unreadRulesMatchSwift() {
        assertTrue(ChatPreviewPolicy.countsUnread(isOwn = false, isHiddenSender = false, isEmptyAssistantStart = false,
            isChatCurrent = false, isAttendee = false))
        assertFalse(ChatPreviewPolicy.countsUnread(isOwn = true, isHiddenSender = false, isEmptyAssistantStart = false,
            isChatCurrent = false, isAttendee = false))
        assertFalse(ChatPreviewPolicy.countsUnread(isOwn = false, isHiddenSender = true, isEmptyAssistantStart = false,
            isChatCurrent = false, isAttendee = false))
        assertFalse(ChatPreviewPolicy.countsUnread(isOwn = false, isHiddenSender = false, isEmptyAssistantStart = true,
            isChatCurrent = false, isAttendee = false))
        assertFalse(ChatPreviewPolicy.countsUnread(isOwn = false, isHiddenSender = false, isEmptyAssistantStart = false,
            isChatCurrent = true, isAttendee = false))
        assertFalse(ChatPreviewPolicy.countsUnread(isOwn = false, isHiddenSender = false, isEmptyAssistantStart = false,
            isChatCurrent = false, isAttendee = true))
        assertTrue(ChatPreviewPolicy.postsPreview(isOwn = false, isHiddenSender = false, isEmptyAssistantStart = false, isAttendee = false))
        assertFalse(ChatPreviewPolicy.postsPreview(isOwn = false, isHiddenSender = false, isEmptyAssistantStart = true, isAttendee = false))
        assertFalse(ChatPreviewPolicy.postsPreview(isOwn = false, isHiddenSender = false, isEmptyAssistantStart = false, isAttendee = true))
    }

    @Test fun bodiesMatchSwiftAndNeverShowAFileName() {
        assertEquals(ChatPreviewBody(kind = ChatPreviewBodyKind.text, text = "Can you share the deck?"),
            ChatPreviewPolicy.body(message = message("m1", "Can you share the deck?\nThe one from Tuesday")))
        val photo = ChatImageAttachment(id = "i1", url = "https://assets.example/IMG_2041.jpg", fileName = "IMG_2041.jpg",
            mimeType = "image/jpeg", size = 1_000)
        assertEquals(ChatPreviewBody(kind = ChatPreviewBodyKind.photo, text = ""),
            ChatPreviewPolicy.body(message = message("m2", "IMG_2041.jpg", image = photo)))
        assertEquals("Whiteboard from today", ChatPreviewPolicy.body(message = message("m3", "Whiteboard from today", image = photo)).text)
        assertEquals(ChatPreviewBody(kind = ChatPreviewBodyKind.voice, text = "Welcome everyone"),
            ChatPreviewPolicy.body(message = message("m4", "TTS: Welcome everyone\nto the call", isTts = true)))
        assertEquals("Avery Lee waves", ChatPreviewPolicy.body(message = message("m5", "/me waves")).text)
        val answer = message("m6", "Sure. Here is the plan.", userId = ConclaveAssistantChatIdentity.userId,
            name = ConclaveAssistantChatIdentity.displayName)
        assertEquals("Sure.", ChatPreviewPolicy.body(message = answer).text)
        assertEquals(ChatPreviewBodyKind.sticker, ChatPreviewPolicy.gifKind("sticker"))
        assertEquals(ChatPreviewBodyKind.clip, ChatPreviewPolicy.gifKind("clip"))
        assertEquals(ChatPreviewBodyKind.gif, ChatPreviewPolicy.gifKind(null))
        val long = "a".repeat(400)
        assertEquals(ChatPreviewPolicy.maxDetailCharacters, ChatPreviewPolicy.body(message = message("m7", long)).text.length)
    }

    @Test fun theEventCarriesTheR404Fields() {
        val event = preview("srv-7", "Are you free?", isDirect = true)
        assertEquals(StageEventKind.chatPreview, event.kind)
        assertEquals("srv-7", event.messageId)
        assertEquals("Are you free?", event.detail)
        assertTrue(event.isPrivate)
        assertEquals("text", event.serverText)
        val answer = message("a1", "Done! I opened the issue.", userId = ConclaveAssistantChatIdentity.userId,
            name = ConclaveAssistantChatIdentity.displayName)
        val assistant = ChatPreviewPolicy.event(message = answer, canonicalSenderId = "")
        assertEquals(ConclaveAssistantChatIdentity.userId, assistant.userId)
        val notice = MeetingNoticePolicy.toast(fromEvent = assistant)
        assertNotNull(notice)
        assertTrue(ChatPreviewPolicy.isAssistant(notice!!))
        assertEquals(ChatPreviewBodyKind.text, ChatPreviewPolicy.bodyKind(notice))
    }

    @Test fun oneSenderUpdatesTheShownPreviewInPlace() {
        val center = center()
        center.post(preview("m1", "Can you share the deck?"), nowMillis = 100.0)
        val first = center.toast
        center.post(preview("m2", "The one from Tuesday"), nowMillis = 900.0)
        center.post(preview("m3", "Thanks!"), nowMillis = 1_700.0)
        val shown = center.toast
        assertEquals(first?.id, shown?.id)
        assertEquals(3, shown?.count)
        assertEquals(1, shown?.senderCount)
        assertEquals("Thanks!", shown?.detail)
        assertEquals("m3", shown?.messageId)
        assertTrue(ChatPreviewPolicy.showsCountLine(shown!!))
        assertEquals(0, center.queue.count)
    }

    @Test fun severalSendersReadAsTheNewestNameAndOthers() {
        val center = center()
        center.post(preview("m1", "I can take notes", userId = "r2", name = "Ben Ortiz"), nowMillis = 0.0)
        center.post(preview("m2", "Same here", userId = "r3", name = "Cai Moreno", isDirect = true), nowMillis = 300.0)
        assertEquals(true, center.toast?.isPrivate)
        center.post(preview("m3", "Can you share the deck?"), nowMillis = 600.0)
        val shown = center.toast!!
        assertEquals("Avery Lee", shown.name)
        assertEquals(3, shown.senderCount)
        assertEquals(2, ChatPreviewPolicy.othersCount(shown))
        assertFalse(ChatPreviewPolicy.showsCountLine(shown))
        assertFalse(shown.isPrivate)
        val people = mutableListOf<String>()
        for (id in center.previewSenders(noticeId = shown.id)) people.add(id)
        assertEquals(listOf("r2", "r3", "r1"), people)
    }

    @Test fun suspensionPreferenceChatAndAttendeesDropPreviews() {
        val suspended = center()
        suspended.post(preview("m1", "Hi"), nowMillis = 0.0)
        suspended.setToastLaneSuspended(true)
        assertNull(suspended.toast)
        suspended.post(preview("m2", "Again"), nowMillis = 10.0)
        suspended.post(StageEvent.make(kind = StageEventKind.userJoined, userId = "j1", name = "Dev"), nowMillis = 20.0)
        assertEquals(1, suspended.queue.count)
        assertEquals(NoticeKind.joined, suspended.queue[0].kind)
        val off = center()
        off.post(preview("m1", "Hi"), nowMillis = 0.0, showsChatPreviews = false)
        assertNull(off.toast)
        val open = center()
        open.setCurrentPanel(MeetingPanel.chat.rawValue, nowMillis = 0.0)
        open.post(preview("m1", "Hi"), nowMillis = 10.0)
        assertNull(open.toast)
        val attendee = center(isAttendee = true)
        attendee.post(preview("m1", "Hi"), nowMillis = 10.0)
        assertNull(attendee.toast)
        val own = center()
        own.post(preview("m1", "Mine", userId = "you", name = "You"), nowMillis = 0.0)
        assertNull(own.toast)
    }

    @Test fun presenterClearsHidesAndOpensChatAtTheNewestMessage() {
        val off = presenter(previews = false)
        off.post(preview("m1", "Hi"))
        assertNull(off.toast)
        val stage = presenter()
        stage.post(StageEvent.make(kind = StageEventKind.userJoined, userId = "j1", name = "Dev"))
        stage.post(preview("m1", "Hi"))
        assertEquals(1, stage.queuedToasts)
        stage.clearChatPreviews()
        assertEquals(NoticeKind.joined, stage.toast?.kind)
        assertEquals(0, stage.queuedToasts)
        val hide = presenter()
        hide.post(preview("m1", "Hi", userId = "r2", name = "Ben Ortiz"))
        hide.post(preview("m2", "Hello"))
        hide.dropChatPreviews(fromUserId = "r2")
        assertNull(hide.toast)
        val tap = presenter()
        tap.post(preview("m1", "Can you share the deck?"))
        tap.post(preview("m2", "Thanks!"))
        tap.performNoticeAction(noticeId = tap.toast?.id ?: "", actionId = NoticeAction.view)
        val current = tap.shell.panels.snapshot.current
        assertEquals(MeetingPanel.chat, current?.panel)
        assertEquals(PanelDestination.chatMessage, current?.destination)
        assertEquals("m2", current?.targetId)
        assertNull(tap.toast)
    }

    @Test fun chatPreviewFixturesMatchSwift() {
        val same = StageFixtureSession(state = StageFixtureState.chatPreviewsSameSender3)
        assertEquals(3, same.stage.toast?.count)
        assertEquals(3, same.unreadChatCount)
        assertTrue(same.chatPreviewReadout().startsWith("count=3 senders=1 name=Avery Lee private=0 body=text message=cp-s3 unread=3"))
        val mixed = StageFixtureSession(state = StageFixtureState.chatPreviewsMixed3)
        assertEquals(3, mixed.stage.toast?.senderCount)
        assertEquals("Avery Lee", mixed.stage.toast?.name)
        assertEquals(true, StageFixtureSession(state = StageFixtureState.chatPreviewsPrivate).stage.toast?.isPrivate)
        val photo = StageFixtureSession(state = StageFixtureState.chatPreviewsPhoto).stage.toast!!
        assertEquals(ChatPreviewBodyKind.photo, ChatPreviewPolicy.bodyKind(photo))
        assertEquals("Whiteboard from today", photo.detail)
        val off = StageFixtureSession(state = StageFixtureState.chatPreviewsOff)
        assertNull(off.stage.toast)
        assertEquals(1, off.unreadChatCount)
        val attendee = StageFixtureSession(state = StageFixtureState.chatPreviewsAttendee)
        assertNull(attendee.stage.toast)
        assertEquals(0, attendee.unreadChatCount)
        same.stage.performNoticeAction(noticeId = same.stage.toast?.id ?: "", actionId = NoticeAction.view)
        assertEquals("panel=chat invoker=call destination=chatMessage", same.panelReadout())
        assertEquals(0, same.unreadChatCount)
        assertNull(same.stage.toast)
    }

    @Test fun displayTimeIsFourSecondsOnApi28() {
        assertEquals(4_000.0, ChatPreviewPolicy.displayMillis(isScreenReaderRunning = false), 0.0)
        assertEquals(0.0, ChatPreviewPolicy.displayMillis(isScreenReaderRunning = true), 0.0)
        assertEquals(4_000L, chatPreviewTimeoutMillis(RuntimeEnvironment.getApplication()))
    }
}

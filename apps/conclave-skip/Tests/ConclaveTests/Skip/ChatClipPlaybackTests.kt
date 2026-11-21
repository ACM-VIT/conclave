package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatClipPlaybackTests {
    private class Clip(override val id: String, private val events: MutableList<String>) : ChatClipPlayback {
        var playing = false
        override fun play() {
            if (!playing) events.add("play:$id")
            playing = true
        }
        override fun stop() {
            if (playing) events.add("stop:$id")
            playing = false
        }
    }

    @Test fun scrollingReleasesSlotsBeforeStartingAnotherPlayer() {
        val events = mutableListOf<String>()
        val pool = ChatClipPool()
        val clips = listOf("a", "b", "c").map { id ->
            Clip(id, events).also {
                pool.register(it)
                pool.attachmentVisibility(id, true)
            }
        }
        pool.lifecycle(true, false)
        pool.visibility(listOf("a", "b", "c"))
        assertEquals(listOf("play:a", "play:b"), events)
        pool.visibility(listOf("b", "c"))
        assertEquals(listOf("play:a", "play:b", "stop:a", "play:c"), events)
        assertFalse(clips[0].playing)
        assertTrue(clips[1].playing && clips[2].playing)
        clips.forEach(pool::remove)
        assertTrue(clips.none { it.playing })
    }

    @Test fun reducedMotionRequiresATapAndBackgroundingClearsThatRequest() {
        val events = mutableListOf<String>()
        val pool = ChatClipPool()
        val clip = Clip("a", events)
        pool.register(clip)
        pool.attachmentVisibility(clip.id, true)
        pool.visibility(listOf("a"))
        pool.lifecycle(true, true)
        assertFalse(clip.playing)
        pool.request("a")
        assertTrue(clip.playing)
        pool.lifecycle(false, true)
        assertFalse(clip.playing)
        pool.lifecycle(true, true)
        assertFalse(clip.playing)
        pool.request("a")
        pool.visibility(emptyList())
        assertFalse(clip.playing)
        pool.visibility(listOf("a"))
        assertFalse(clip.playing)
        pool.request("a")
        assertTrue(clip.playing)
        pool.attachmentVisibility("a", false)
        assertFalse(clip.playing)
        pool.attachmentVisibility("a", true)
        assertFalse(clip.playing)
    }

    @Test fun aVisibleRowCannotPlayAnOffscreenAttachment() {
        val pool = ChatClipPool()
        val clip = Clip("a", mutableListOf())
        pool.register(clip)
        pool.visibility(listOf("a"))
        pool.lifecycle(true, false)
        assertFalse(clip.playing)
        pool.attachmentVisibility("a", true)
        assertTrue(clip.playing)
        pool.attachmentVisibility("a", false)
        assertFalse(clip.playing)
    }

    @Test fun replacingAClipReleasesTheOldPlayerAndItsLateDisposeKeepsTheReplacement() {
        val pool = ChatClipPool()
        val events = mutableListOf<String>()
        val old = Clip("a", events)
        pool.register(old)
        pool.attachmentVisibility("a", true)
        pool.visibility(listOf("a"))
        pool.lifecycle(true, false)
        val replacement = Clip("a", events)
        pool.register(replacement)
        assertFalse(old.playing)
        assertTrue(replacement.playing)
        assertEquals(listOf("play:a", "stop:a", "play:a"), events)
        pool.remove(old)
        assertTrue(replacement.playing)
        pool.remove(replacement)
        assertFalse(replacement.playing)
    }

    @Test fun closingAndReopeningReleasesEverythingAndOnlyAutoplaysWhenAllowed() {
        val pool = ChatClipPool()
        val events = mutableListOf<String>()
        val clip = Clip("a", events)
        pool.register(clip)
        pool.attachmentVisibility(clip.id, true)
        pool.visibility(listOf("a"))
        pool.lifecycle(true, false)
        assertTrue(clip.playing)
        pool.lifecycle(false, false)
        assertFalse(clip.playing)
        pool.remove(clip)
        pool.lifecycle(true, false)
        assertFalse(clip.playing)
    }
}

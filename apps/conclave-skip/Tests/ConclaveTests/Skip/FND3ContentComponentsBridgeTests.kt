package conclave.module

import android.content.Context
import android.view.View
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class FND3ContentComponentsBridgeTests {
    @Test fun composerPoliciesMatchSwift() {
        assertEquals(ConclaveComposerMaterial.glass, ConclaveComposerMaterialPolicy.material(glassAvailable = true,
            reduceTransparency = false, forceOpaque = false, prefersReducedResourceUsage = false))
        assertEquals(ConclaveComposerMaterial.opaque, ConclaveComposerMaterialPolicy.material(glassAvailable = true,
            reduceTransparency = true, forceOpaque = false, prefersReducedResourceUsage = false))
        assertEquals(ConclaveComposerMaterial.opaque, ConclaveComposerMaterialPolicy.material(glassAvailable = false,
            reduceTransparency = false, forceOpaque = false, prefersReducedResourceUsage = false))
        assertEquals(900, ConclaveComposerCounterPolicy.visibleFrom(limit = 1000))
        assertEquals(450, ConclaveComposerCounterPolicy.visibleFrom(limit = 500))
        assertTrue(ConclaveComposerCounterPolicy.isVisible(count = 0, limit = 500, alwaysVisible = true))
        assertEquals(200, ConclaveComposerCounterPolicy.overflow(count = 1200, limit = 1000))

        assertEquals(20.0, ConclaveComposerMetrics.androidCornerRadius, 0.0)
        assertEquals(6, ConclaveComposerMetrics.maximumLines)
        assertTrue(ConclaveAttachmentPhase.uploading.showsProgress && ConclaveAttachmentPhase.uploading.blocksSend)
        assertTrue(ConclaveAttachmentPhase.failed.offersRetry)
        assertFalse(ConclaveAttachmentPhase.ready.blocksSend)
        assertEquals(0.38f, ConclaveDisabledOpacity.android.toFloat(), 0.0001f)
    }

    @Test fun searchFiltersInSnapshotOrder() {
        val items = skip.lib.arrayOf(
            ConclaveSearchItem(id = "a", text = "Avery Lee"),
            ConclaveSearchItem(id = "b", text = "Sam Ortiz"),
            ConclaveSearchItem(id = "c", text = "Lee Chen"),
        )
        val lee = ConclaveSearchPolicy.filter(items, query = "lee")
        assertEquals(2, lee.count)
        assertEquals("a", lee[0])
        assertEquals("c", lee[1])
        assertEquals(3, ConclaveSearchPolicy.filter(items, query = "   ").count)
        val narrowed = ConclaveSearchPolicy.filter(items, query = "  LEE  av ")
        assertEquals(1, narrowed.count)
        assertEquals("a", narrowed[0])
        assertEquals(2, ConclaveSearchPolicy.terms("  Avery   Lee ").count)
        assertTrue(ConclaveSearchPolicy.matches("Avery Lee", query = "ver"))
        assertFalse(ConclaveSearchPolicy.isSearching(" \n"))
        assertEquals(1000, ConclaveSearchPolicy.announcementDelayMillis)
    }

    @Test fun segmentedFallbackFollowsFontScale() {
        assertFalse(ConclaveSegmentedPolicy.androidUsesFallback(fontScale = 1.49, segmentCount = 3))
        assertTrue(ConclaveSegmentedPolicy.androidUsesFallback(fontScale = 1.5, segmentCount = 3))
        assertTrue(ConclaveSegmentedPolicy.androidUsesFallback(fontScale = 1.0, segmentCount = 5))
        assertEquals(1.5, ConclaveSegmentedPolicy.androidFallbackFontScale, 0.0)
    }

    @Test fun bubbleShapeTightensTheSenderSide() {
        assertEquals(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomEnd = 20.dp, bottomStart = 20.dp),
            conclaveBubbleShape(isOwn = true, isFollowUp = false, hasFollower = false))

        assertEquals(RoundedCornerShape(topStart = 20.dp, topEnd = 4.dp, bottomEnd = 4.dp, bottomStart = 20.dp),
            conclaveBubbleShape(isOwn = true, isFollowUp = true, hasFollower = true))

        assertEquals(RoundedCornerShape(topStart = 4.dp, topEnd = 20.dp, bottomEnd = 20.dp, bottomStart = 20.dp),
            conclaveBubbleShape(isOwn = false, isFollowUp = true, hasFollower = false))
        assertEquals(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomEnd = 20.dp, bottomStart = 4.dp),
            conclaveBubbleShape(isOwn = false, isFollowUp = false, hasFollower = true))
        assertTrue(ConclaveBubbleTone.own.usesCoralFill)
        assertTrue(ConclaveBubbleTone.privateMessage.hasBorder)
        assertFalse(ConclaveBubbleTone.peer.hasBorder || ConclaveBubbleTone.answer.usesCoralFill)
    }

    @Test fun reactionChipPlaysOnlyWhenAdding() {
        fun chip(mine: Boolean, canToggle: Boolean) = ConclaveReactionChipModel(id = "x", emoji = "x", count = 2, isMine = mine,
            canToggle = canToggle, accessibilityLabel = "label")
        assertEquals(FeedbackKind.reactionSent, ConclaveReactionChipPolicy.feedback(chip(mine = false, canToggle = true)))
        assertEquals(FeedbackKind.none, ConclaveReactionChipPolicy.feedback(chip(mine = true, canToggle = true)))
        assertEquals(FeedbackKind.none, ConclaveReactionChipPolicy.feedback(chip(mine = false, canToggle = false)))
        assertEquals(32.0, ConclaveReactionChipPolicy.androidVisualHeight, 0.0)
        assertEquals(48.0, ConclaveReactionChipPolicy.androidTarget, 0.0)

        val haptics = ConclaveGestureHaptics(view = null, debuggable = false)
        assertEquals(GestureHapticDecision.Recorded, haptics.decide(FeedbackKind.reactionSent, api = 34))
    }

    @Test fun tipDismissalIsStoredOncePerId() {
        val app = RuntimeEnvironment.getApplication()
        val id = OneTimeTipID.gifPicker.rawValue
        ConclaveTipStore.reset(app)
        assertFalse(ConclaveTipStore.isDismissed(app, id))
        ConclaveTipStore.dismiss(app, id)
        assertTrue(ConclaveTipStore.isDismissed(app, id))

        val preferences = app.getSharedPreferences("conclave.tips", Context.MODE_PRIVATE)
        assertTrue(preferences.getBoolean("conclave.tip.gifPicker", false))
        assertEquals("conclave.tip.gifPicker", OneTimeTipPolicy.storeKey(id))
        assertTrue(OneTimeTipPolicy.isEligible(isDismissed = false, isPanelPresented = true, isOtherTipShown = false,
            contentState = OneTimeTipContentState.ready))
        assertFalse(OneTimeTipPolicy.isEligible(isDismissed = false, isPanelPresented = true, isOtherTipShown = false,
            contentState = OneTimeTipContentState.loading))
        ConclaveTipStore.reset(app)
        assertFalse(ConclaveTipStore.isDismissed(app, id))
    }

    @Test fun textEntryCapsAndConfirms() {
        assertEquals(40, ConclaveTextEntryPolicy.capped("a".repeat(45), limit = 40).length)
        assertEquals(45, ConclaveTextEntryPolicy.capped("a".repeat(45), limit = 0).length)
        assertFalse(ConclaveTextEntryPolicy.canConfirm("   ", isPending = false))
        assertFalse(ConclaveTextEntryPolicy.canConfirm("Avery", isPending = true))
        assertTrue(ConclaveTextEntryPolicy.canConfirm(" Avery ", isPending = false))
        val model = ConclaveTextEntryDialogModel(kind = ConclaveTextEntryKind.multiline, title = "Answer", message = "",
            fieldLabel = "Answer", confirmTitle = "Send", limit = 1000, counterFrom = 900)
        assertFalse(ConclaveTextEntryPolicy.showsCounter(count = 899, model = model))
        assertTrue(ConclaveTextEntryPolicy.showsCounter(count = 900, model = model))
        assertEquals(4, ConclaveTextEntryPolicy.multilineMinLines)
        assertEquals(8, ConclaveTextEntryPolicy.multilineMaxLines)
    }

    @Test fun exporterWritesActionsAndLongClickLabels() {
        val node = SemanticsExportNode(
            id = 3, parent = 1, depth = 2, testTag = "chat.row.m1", role = null, contentDescription = listOf("Avery Lee, Hi"),
            text = emptyList(), editableText = null, stateDescription = null, heading = false, paneTitle = null, liveRegion = null,
            traversalGroup = false, traversalIndex = 0f, focusable = false, focused = false, clickable = false, disabled = false,
            selected = null, toggleState = null, hidden = false, left = 0f, top = 0f, right = 100f, bottom = 40f,
            customActions = listOf("Reply", "Copy"), onLongClickLabel = "Message actions",
        )
        val json = JSONObject(NativeSemanticsJson.node(node))
        assertEquals(2, json.getJSONArray("customActions").length())
        assertEquals("Reply", json.getJSONArray("customActions").getString(0))
        assertEquals("Message actions", json.getString("onLongClickLabel"))
        val plain = JSONObject(NativeSemanticsJson.node(node.copy(customActions = emptyList(), onLongClickLabel = null)))
        assertEquals(0, plain.getJSONArray("customActions").length())
        assertTrue(plain.isNull("onLongClickLabel"))
        val text = NativeSemanticsJson.node(node)
        assertTrue(text.indexOf("\"hidden\"") < text.indexOf("\"customActions\"") && text.indexOf("\"onLongClickLabel\"") < text.indexOf("\"bounds\""))
    }

    @Test fun popupRootsRegisterUntilTheLastOwnerLeaves() {
        val app = RuntimeEnvironment.getApplication()
        NativeSemanticsPopupRoots.clear()
        try {
            val dialog = View(app)
            val menu = View(app)
            NativeSemanticsPopupRoots.register(dialog, "dialog.end")
            NativeSemanticsPopupRoots.register(menu, "menu.more")
            NativeSemanticsPopupRoots.register(dialog, "dialog.end")
            assertEquals(listOf("dialog.end", "menu.more"), NativeSemanticsPopupRoots.names())
            NativeSemanticsPopupRoots.unregister(dialog)
            assertEquals(listOf("dialog.end", "menu.more"), NativeSemanticsPopupRoots.names())
            NativeSemanticsPopupRoots.unregister(dialog)
            assertEquals(listOf("menu.more"), NativeSemanticsPopupRoots.names())

            assertTrue(NativeSemanticsPopupRoots.trees().isEmpty())
            NativeSemanticsPopupRoots.unregister(menu)
            NativeSemanticsPopupRoots.unregister(menu)
            assertTrue(NativeSemanticsPopupRoots.names().isEmpty())
            assertNotEquals(dialog, menu)
        } finally {
            NativeSemanticsPopupRoots.clear()
        }
    }
}

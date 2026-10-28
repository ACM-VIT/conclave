package conclave.module

import android.graphics.Bitmap
import android.graphics.ColorSpace
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.VectorPath
import androidx.compose.ui.unit.LayoutDirection
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.ByteBuffer
import java.util.concurrent.Executors

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class NativeIconContractTests {
    @Test fun realCatalogIsLazyThreadSafeAndStructurallyComplete() {
        // Test classes share one Robolectric sandbox, and bridge tests that run earlier (route and menu icons in
        // FND1FND2BridgeTests, camera menu icons in CTL3CTL4BridgeTests) may already have loaded a few accessors,
        // so the contract starts from whatever is loaded now. Metadata never evaluates an accessor.
        val baseline = ConclaveIcons.initializedCount()
        assertEquals(115, NativeIconCatalog.artwork.size)
        assertEquals(134, NativeIconCatalog.bindings.size)
        assertEquals(baseline, ConclaveIcons.initializedCount())
        assertEquals(setOf("arrow_back.fill0", "send.fill1", "backspace.fill0", "reply.fill0"), NativeIconCatalog.artwork.filter { it.mirrors }.map { it.id }.toSet())
        assertEquals(baseline, ConclaveIcons.initializedCount())
        val pool = Executors.newFixedThreadPool(4)
        try {
            for (a in NativeIconCatalog.artwork) {
                val before = ConclaveIcons.initializedCount()
                val futures = (1..8).map { pool.submit<ImageVector> { a.vector() } }
                val first = futures.first().get()
                futures.forEach { assertSame(first, it.get()) }
                // Each accessor is its own lazy: evaluating one loads at most that one icon.
                assertTrue(a.id, (ConclaveIcons.initializedCount() - before) in 0..1)
                requireIconStructure(first, a.mirrors)
                assertEquals(a.id, first.name)
            }
        } finally { pool.shutdown() }
        assertEquals(115, ConclaveIcons.initializedCount())
        assertEquals(115, NativeIconCatalog.artwork.map { it.id }.toSet().size)
        assertEquals(134, NativeIconCatalog.bindings.map { it.id }.toSet().size)
        val bindings = NativeIconCatalog.bindings.associateBy { it.id }
        assertSame(bindings.getValue("admit.action").vector(), bindings.getValue("copy_link.copied").vector())
        assertSame(bindings.getValue("host.host_badge").vector(), bindings.getValue("host.host_controls_action").vector())
        assertSame(ConclaveIcons.CheckFill0, bindings.getValue("admit.action").vector())
        assertFalse(ConclaveIcons.CheckFill0.autoMirror)
        // Every mapped People action resolves on Android; section completeness cannot mask a missing resolver.
        for (action in PersonActionID.allCases) {
            val concept = PeopleActionPolicy.concept(action)
            assertTrue(action.rawValue, concept.isNotEmpty())
            assertNotNull(concept, conclaveMenuIcon(concept))
        }
        assertSame(ConclaveIcons.VisibilityOffFill0, conclaveMenuIcon("hide_sender"))
        assertSame(ConclaveIcons.FitScreenFill0, conclaveMenuIcon("fit_video"))
        // Base identities remain stable; new meanings use canonical artwork rather than stand-ins.
        assertSame(ConclaveIcons.ReplyFill0, bindings.getValue("reply.action").vector())
        assertSame(ConclaveIcons.PlayArrowFill1, VoiceIcons.play)
        assertSame(ConclaveIcons.StopFill1, VoiceIcons.stop)
        assertSame(ConclaveIcons.RecordVoiceOverFill0, VoiceIcons.voiceMessage)
        assertSame(ConclaveIcons.BackspaceFill0, WordleIcons.backspace)
        assertSame(ConclaveIcons.AutoAwesomeFill0, bindings.getValue("assistant.decorative_mark").vector())
        assertSame(ConclaveIcons.AutoAwesomeFill0, bindings.getValue("effects.action").vector())
        assertSame(ConclaveIcons.ArrowUpwardFill0, bindings.getValue("upvote.unselected").vector())
        assertSame(ConclaveIcons.ArrowUpwardFill1, bindings.getValue("upvote.selected").vector())
    }

    @Test fun bindingSemanticsAreCallerOwnedAndMatchTheArchivedRecords() {
        val b = NativeIconCatalog.bindings.associateBy { it.id }
        fun semantics(id: String) = b.getValue(id).let { Triple(it.label, it.value, it.role) }
        assertEquals(Triple("Microphone", "Muted", "switch"), semantics("microphone.muted"))
        assertEquals(Triple("Camera", "On", "switch"), semantics("camera.on"))
        assertEquals(Triple("Raise hand", "Raised", "switch"), semantics("raise_hand.raised"))
        assertEquals(Triple("Captions", "Off", "switch"), semantics("captions.off"))
        assertEquals("Open", semantics("reactions.open").second)
        assertEquals(Triple("Share screen", "Sharing", "switch"), semantics("share_screen.sharing_toggle"))
        assertEquals(Triple<String?, String?, String>("Stop sharing", null, "button"), semantics("share_screen.stop_sharing_action"))
        assertEquals("status", semantics("host.host_badge").third)
        assertEquals(Triple<String?, String?, String>("Host controls", null, "button"), semantics("host.host_controls_action"))
        assertEquals(Triple<String?, String?, String>(null, null, "decorative"), semantics("search.decorative_field_leading"))
        assertEquals(Triple<String?, String?, String>("Search", null, "button"), semantics("search.search_action"))
        assertEquals(Triple("Lock meeting", "On", "checkbox"), semantics("lock_meeting.locked"))
        assertEquals(Triple("Audio output", "current route name", "button"), semantics("audio_output.bluetooth"))
        for (binding in NativeIconCatalog.bindings) {
            assertEquals(binding.id, binding.label != null, binding.role in setOf("button", "switch", "checkbox"))
            assertTrue(binding.id, binding.role in setOf("button", "switch", "checkbox", "status", "decorative"))
            assertEquals(binding.id, binding.fillBasis == "requirement", binding.decisionId == null)
            assertFalse(binding.id, NativeIconCatalog.artwork.any { it.id == binding.label || it.property == binding.label })
        }
        assertEquals("switch; label Microphone; value Muted; requirement", b.getValue("microphone.muted").summary)
        assertEquals("status; value pinned; recommendation D04", b.getValue("pin.pinned_badge").summary)
    }

    @Test fun convertedFixturesMatchIndependentNativeCoordinatesAndWinding() {
        val hand = NativeIconGeometryFixtures.hand
        val converted = NativeIconGeometryFixtures.converted
        assertEquals(4, hand.size); assertEquals(4, converted.size)
        for (i in hand.indices) {
            requireIconStructure(hand[i].vector(), false); requireIconStructure(converted[i].vector(), false)
            val a = hand[i].vector().root[0] as VectorPath
            val b = converted[i].vector().root[0] as VectorPath
            assertEquals(a.pathData, b.pathData)
        }
        val smooth = (converted[3].vector().root[0] as VectorPath).pathData
        assertEquals(PathNode.MoveTo(160f, 480f), smooth[0])
        assertEquals(PathNode.QuadTo(320f, 160f, 480f, 480f), smooth[1])
        assertEquals(PathNode.QuadTo(640f, 800f, 800f, 480f), smooth[2])
        // Independent literal contour order catches EvenOdd/subpath reversal regressions.
        val opposite = (converted[0].vector().root[0] as VectorPath).pathData
        val same = (converted[1].vector().root[0] as VectorPath).pathData
        assertEquals(PathNode.LineTo(320f, 640f), opposite[6])
        assertEquals(PathNode.LineTo(640f, 320f), same[6])
        val relative = (converted[2].vector().root[0] as VectorPath).pathData
        assertEquals(PathNode.MoveTo(480f, 480f), relative[5])
        assertEquals(10, relative.size)
    }

    @Test fun finiteCaptureMatrixUsesNativeDirectionAndBoundedDimensions() {
        val cases = iconRasterCases(IconRasterPlan.Artwork)
        assertEquals(ICON_RASTER_MAX_CASES, cases.size)
        val primary = cases.filter { it.repetition == "primary" }
        assertEquals(920, primary.size)
        assertTrue(primary.all { it.direction == LayoutDirection.Ltr })
        assertEquals(115, primary.filter { it.pixels == 72 }.size)
        assertEquals(32, cases.count { it.repetition == "cycle-rtl" && it.direction == LayoutDirection.Rtl && it.artwork.mirrors })
        assertEquals(32, cases.count { it.repetition == "cycle-before" && it.direction == LayoutDirection.Ltr })
        assertEquals(32, cases.count { it.repetition == "cycle-after" && it.direction == LayoutDirection.Ltr })
        val controls = cases.filter { it.repetition == "nonmirror-control" }
        assertEquals(111, controls.count { !it.artwork.mirrors && it.pixels == 72 && it.direction == LayoutDirection.Rtl })
        assertTrue(controls.any { it.artwork.id == "check.fill0" })
        assertTrue(cases.all { it.pixels in 18..ICON_RASTER_MAX_PIXELS })
        assertEquals(cases.indices.toList(), cases.map { it.ordinal })
        assertEquals(cases.size, cases.map { it.key }.toSet().size)
        assertEquals(8, iconRasterCases(IconRasterPlan.Geometry).size)
        assertEquals(1, iconRasterCases(IconRasterPlan.ReadinessFailure).size)
        assertEquals(1, iconRasterCases(IconRasterPlan.ExportFailure).size)
    }

    @Test fun normalizedProtocolIsStraightRgbaWithTransparentRgbZero() {
        val bitmap = Bitmap.createBitmap(2, 1, Bitmap.Config.ARGB_8888, true, ColorSpace.get(ColorSpace.Named.SRGB))
        try {
            bitmap.setPixels(intArrayOf(0x80102030.toInt(), 0), 0, 2, 0, 0, 2, 1)
            // Precondition: storage is premultiplied, about (8, 16, 24) at alpha 128 in either byte order,
            // so reading storage bytes instead of straight pixels would fail below.
            val storage = ByteBuffer.allocate(8).also { bitmap.copyPixelsToBuffer(it) }.array()
            assertEquals(128, storage[3].toInt() and 255)
            assertEquals(48.0, (0..2).sumOf { storage[it].toInt() and 255 }.toDouble(), 2.0)
            val rgba = iconPixels(bitmap)
            // Read through the production normalization: straight (16, 32, 48), unpremultiply may round by one.
            assertEquals(128, rgba[3].toInt() and 255)
            listOf(16, 32, 48).forEachIndexed { i, straight ->
                assertEquals("channel $i", straight.toDouble(), (rgba[i].toInt() and 255).toDouble(), 1.0)
            }
            assertTrue(rgba.copyOfRange(4, 8).all { it == 0.toByte() })
            assertEquals(64, iconSHA256(rgba).length)
        } finally { bitmap.recycle() }
        // Unpremultiplied storage, as in the PNG round-trip decode, keeps RGB under alpha zero; the protocol zeroes it.
        val unpremultiplied = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888, true, ColorSpace.get(ColorSpace.Named.SRGB))
        try {
            unpremultiplied.setPremultiplied(false)
            unpremultiplied.setPixels(intArrayOf(0x00FFFFFF), 0, 1, 0, 0, 1, 1)
            assertEquals(0x00FFFFFF, unpremultiplied.getPixel(0, 0))
            assertArrayEquals(ByteArray(4), iconPixels(unpremultiplied))
        } finally { unpremultiplied.recycle() }
    }
}

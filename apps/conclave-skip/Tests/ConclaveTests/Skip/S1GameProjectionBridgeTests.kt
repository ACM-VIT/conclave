package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1GameProjectionBridgeTests {
    private fun rect(x: Double, y: Double, width: Double, height: Double) = GameShellRect(x = x, y = y, width = width, height = height)

    @Test fun epochMillisecondsKeepEveryDigitOnTheAndroidNumberPath() {
        assertEquals("1761700000123", GameProjectionJSON.numberText(1761700000123.0))
        assertEquals("-1761700000123", GameProjectionJSON.numberText(-1761700000123.0))
        assertEquals("3.5", GameProjectionJSON.numberText(3.5))
        assertEquals("42", GameProjectionJSON.numberText(42.0))
        assertEquals("0", GameProjectionJSON.numberText(0.0))
        assertEquals("7", GameProjectionJSON.numberText(7.00001))
    }

    @Test fun epochMillisecondsRoundTripThroughTheProjectionReader() {
        val dict = GameProjectionJSON.object_("{\"at\":1761700000123,\"half\":3.5,\"round\":2}")
        assertEquals("1761700000123", GameProjectionJSON.string(dict, "at"))
        assertEquals("3.5", GameProjectionJSON.string(dict, "half"))
        assertEquals("2", GameProjectionJSON.string(dict, "round"))
        assertEquals(1761700000123.0, GameProjectionJSON.double(dict, "at"), 0.0)
    }

    @Test fun theNoticeRevealPolicyMatchesSwiftOnAndroid() {
        assertFalse(GameNoticeRevealPolicy.hasNotices(isReconnecting = false, failure = GameFailure.none, endFailed = false))
        assertTrue(GameNoticeRevealPolicy.hasNotices(isReconnecting = false, failure = GameFailure.server, endFailed = false))
        assertTrue(GameNoticeRevealPolicy.hasNotices(isReconnecting = true, failure = GameFailure.none, endFailed = false))
        assertTrue(GameNoticeRevealPolicy.hasNotices(isReconnecting = false, failure = GameFailure.none, endFailed = true))
        assertEquals(200.0, GameNoticeRevealPolicy.pinnedMaxHeight(bodyHeight = 500.0)!!, 0.000001)
        assertNull(GameNoticeRevealPolicy.pinnedMaxHeight(bodyHeight = Double.POSITIVE_INFINITY))
        assertNull(GameNoticeRevealPolicy.pinnedMaxHeight(bodyHeight = 0.0))
        assertEquals(210.0, GameNoticeRevealPolicy.scrollTarget(scrollOffset = 120.0, previousNoticeHeight = 0.0, nextNoticeHeight = 90.0), 0.0)
        assertEquals(120.0, GameNoticeRevealPolicy.scrollTarget(scrollOffset = 210.0, previousNoticeHeight = 90.0, nextNoticeHeight = 0.0), 0.0)
        assertEquals(0.0, GameNoticeRevealPolicy.scrollTarget(scrollOffset = 50.0, previousNoticeHeight = 90.0, nextNoticeHeight = 0.0), 0.0)
        assertEquals(0.0, GameNoticeRevealPolicy.scrollTarget(scrollOffset = 0.0, previousNoticeHeight = 0.0, nextNoticeHeight = 90.0), 0.0)
        assertEquals(120.0, GameNoticeRevealPolicy.scrollTarget(scrollOffset = 120.0, previousNoticeHeight = Double.NaN, nextNoticeHeight = 90.0), 0.0)
    }

    @Test fun theFailureRevealTargetMatchesSwiftOnAndroid() {
        assertEquals(72.0, GameNoticeRevealPolicy.failureScrollTarget(scrollOffset = 0.0, viewportHeight = 80.0, noticeTop = 88.0,
            noticeHeight = 172.0, leading = 16.0), 0.0)
        assertEquals(74.0, GameNoticeRevealPolicy.failureScrollTarget(scrollOffset = 150.0, viewportHeight = 80.0, noticeTop = -60.0,
            noticeHeight = 172.0, leading = 16.0), 0.0)
        assertEquals(8.0, GameNoticeRevealPolicy.failureScrollTarget(scrollOffset = 0.0, viewportHeight = 80.0, noticeTop = 58.0,
            noticeHeight = 30.0, leading = 16.0), 0.0)
        assertEquals(0.0, GameNoticeRevealPolicy.failureScrollTarget(scrollOffset = 5.0, viewportHeight = 80.0, noticeTop = -10.0,
            noticeHeight = 172.0, leading = 16.0), 0.0)
        assertEquals(0.0, GameNoticeRevealPolicy.failureScrollTarget(scrollOffset = 0.0, viewportHeight = 80.0, noticeTop = 16.0,
            noticeHeight = 172.0, leading = 16.0), 0.0)
        assertEquals(40.0, GameNoticeRevealPolicy.failureScrollTarget(scrollOffset = 40.0, viewportHeight = 200.0, noticeTop = 60.0,
            noticeHeight = 100.0, leading = 16.0), 0.0)
        assertEquals(30.0, GameNoticeRevealPolicy.failureScrollTarget(scrollOffset = 30.0, viewportHeight = 80.0, noticeTop = Double.NaN,
            noticeHeight = 172.0, leading = 16.0), 0.0)
        assertEquals(30.0, GameNoticeRevealPolicy.failureScrollTarget(scrollOffset = 30.0, viewportHeight = 0.0, noticeTop = 88.0,
            noticeHeight = 172.0, leading = 16.0), 0.0)
    }

    @Test fun theInsetPolicyAndReadoutMatchSwiftOnAndroid() {
        val viewport = rect(0.0, 100.0, 390.0, 400.0)
        assertEquals(60.0, GameShellInsetPolicy.requiredBottomInset(viewport = viewport, bar = rect(0.0, 440.0, 390.0, 60.0)), 0.0)
        assertEquals(0.0, GameShellInsetPolicy.requiredBottomInset(viewport = viewport, bar = rect(0.0, 500.0, 390.0, 68.0)), 0.0)
        assertEquals(30.0, GameShellInsetPolicy.hiddenTail(viewport = viewport, content = rect(0.0, -400.0, 390.0, 870.0),
            bar = rect(0.0, 440.0, 390.0, 60.0)), 0.0)
        assertEquals(0.0, GameShellInsetPolicy.tailAtEnd(contentHeight = 900.0, viewportHeight = 400.0, appliedInset = 60.0, requiredInset = 60.0), 0.0)
        assertEquals(60.0, GameShellInsetPolicy.tailAtEnd(contentHeight = 900.0, viewportHeight = 400.0, appliedInset = 0.0, requiredInset = 60.0), 0.0)
        val text = GameShellInsetPolicy.readout(body = rect(0.0, 0.0, 390.0, 500.0), viewport = rect(0.0, 60.4, 390.0, 439.6),
            content = rect(0.0, 60.4, 390.0, 899.6), bar = rect(0.0, 436.0, 390.0, 64.0))
        assertEquals("body=0,0,390,500 viewport=0,60,390,440 content=0,60,390,900 bar=0,436,390,64 inset=64 tail=524", text)
    }

    @Test fun chessAtFontScaleTwoOnA360DpPhoneFitsOrStacks() {
        val details = ChessCardLayoutPolicy.minimumDetailsWidth * 2.0
        val wide = ChessCardLayoutPolicy.resolve(width = 1917.0 / 2.625, height = 555.0 / 2.625, detailsWidth = details)
        assertTrue(wide.usesColumns)
        assertEquals(195.42857142857142, wide.boardSide, 0.000001)
        assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 640.0, height = 211.0, detailsWidth = details))
        assertEquals(ChessCardLayout.stacked, ChessCardLayoutPolicy.resolve(width = 699.0, height = 298.0, detailsWidth = details))
        assertEquals(192.0, ChessCardLayoutPolicy.resolve(width = 700.0, height = 298.0, detailsWidth = details).boardSide, 0.0)
    }
}

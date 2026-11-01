package conclave.module

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class RouterCodecSendOrderTests {
    private val productionRouterCapabilities = """{"codecs":[{"kind":"audio","mimeType":"audio/opus","clockRate":48000,"channels":2,"rtcpFeedback":[{"type":"nack","parameter":""},{"type":"transport-cc","parameter":""}],"parameters":{},"preferredPayloadType":100},{"kind":"video","mimeType":"video/H264","clockRate":90000,"parameters":{"level-asymmetry-allowed":1,"packetization-mode":1,"profile-level-id":"42e01f"},"rtcpFeedback":[{"type":"nack","parameter":""},{"type":"nack","parameter":"pli"},{"type":"ccm","parameter":"fir"},{"type":"goog-remb","parameter":""},{"type":"transport-cc","parameter":""}],"preferredPayloadType":101},{"kind":"video","mimeType":"video/rtx","preferredPayloadType":102,"clockRate":90000,"parameters":{"apt":101},"rtcpFeedback":[]},{"kind":"video","mimeType":"video/VP8","clockRate":90000,"rtcpFeedback":[{"type":"nack","parameter":""},{"type":"nack","parameter":"pli"},{"type":"ccm","parameter":"fir"},{"type":"goog-remb","parameter":""},{"type":"transport-cc","parameter":""}],"parameters":{},"preferredPayloadType":103},{"kind":"video","mimeType":"video/rtx","preferredPayloadType":104,"clockRate":90000,"parameters":{"apt":103},"rtcpFeedback":[]},{"kind":"video","mimeType":"video/VP9","clockRate":90000,"rtcpFeedback":[{"type":"nack","parameter":""},{"type":"nack","parameter":"pli"},{"type":"ccm","parameter":"fir"},{"type":"goog-remb","parameter":""},{"type":"transport-cc","parameter":""}],"parameters":{"profile-id":0},"preferredPayloadType":105},{"kind":"video","mimeType":"video/rtx","preferredPayloadType":106,"clockRate":90000,"parameters":{"apt":105},"rtcpFeedback":[]}],"headerExtensions":[{"kind":"audio","uri":"urn:ietf:params:rtp-hdrext:sdes:mid","preferredId":1,"preferredEncrypt":false,"direction":"sendrecv"},{"kind":"video","uri":"urn:ietf:params:rtp-hdrext:sdes:mid","preferredId":1,"preferredEncrypt":false,"direction":"sendrecv"}]}"""

    private fun codecSummary(json: String): List<String> {
        val codecs = JSONObject(json).getJSONArray("codecs")
        return (0 until codecs.length()).map { index ->
            val codec = codecs.getJSONObject(index)
            "${codec.getString("mimeType")}:${codec.getInt("preferredPayloadType")}"
        }
    }

    @Test
    fun productionOrderPutsVp8FirstAmongVideoCodecsWithPayloadTypesIntact() {
        val reordered = RouterCodecSendOrder.preferringVp8(productionRouterCapabilities)

        assertEquals(
            listOf(
                "audio/opus:100",
                "video/VP8:103",
                "video/H264:101",
                "video/rtx:102",
                "video/rtx:104",
                "video/VP9:105",
                "video/rtx:106",
            ),
            codecSummary(reordered),
        )
        val vp8 = JSONObject(reordered).getJSONArray("codecs").getJSONObject(1)
        assertEquals(5, vp8.getJSONArray("rtcpFeedback").length())
        assertEquals(103, JSONObject(reordered).getJSONArray("codecs").getJSONObject(4).getJSONObject("parameters").getInt("apt"))
        assertEquals(2, JSONObject(reordered).getJSONArray("headerExtensions").length())
    }

    @Test
    fun capabilitiesThatAlreadySendVp8FirstAreReturnedUnchanged() {
        val once = RouterCodecSendOrder.preferringVp8(productionRouterCapabilities)
        assertSame(once, RouterCodecSendOrder.preferringVp8(once))
    }

    @Test
    fun capabilitiesWithoutVp8OrUnreadableJsonAreReturnedUnchanged() {
        val root = JSONObject(productionRouterCapabilities)
        val codecs = root.getJSONArray("codecs")
        codecs.remove(4)
        codecs.remove(3)
        val withoutVp8 = root.toString()

        assertSame(withoutVp8, RouterCodecSendOrder.preferringVp8(withoutVp8))
        assertSame("not json", RouterCodecSendOrder.preferringVp8("not json"))
    }
}

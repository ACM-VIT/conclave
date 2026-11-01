package conclave.module

import org.json.JSONArray
import org.json.JSONObject

internal object RouterCodecSendOrder {
    fun preferringVp8(routerRtpCapabilitiesJson: String): String {
        return try {
            val root = JSONObject(routerRtpCapabilitiesJson)
            val codecs = root.optJSONArray("codecs") ?: return routerRtpCapabilitiesJson
            var firstVideoIndex = -1
            var vp8Index = -1
            for (index in 0 until codecs.length()) {
                val codec = codecs.optJSONObject(index) ?: continue
                if (!codec.optString("kind").equals("video", ignoreCase = true)) continue
                val mimeType = codec.optString("mimeType")
                if (mimeType.equals("video/rtx", ignoreCase = true)) continue
                if (firstVideoIndex < 0) firstVideoIndex = index
                if (mimeType.equals("video/VP8", ignoreCase = true)) {
                    vp8Index = index
                    break
                }
            }
            if (vp8Index < 0 || vp8Index == firstVideoIndex) return routerRtpCapabilitiesJson
            val reordered = JSONArray()
            for (index in 0 until codecs.length()) {
                if (index == firstVideoIndex) reordered.put(codecs.get(vp8Index))
                if (index != vp8Index) reordered.put(codecs.get(index))
            }
            root.put("codecs", reordered)
            root.toString()
        } catch (_: Throwable) {
            routerRtpCapabilitiesJson
        }
    }
}

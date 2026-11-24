package conclave.module

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class WheelDraftBridgeTests {
    private val call = "call-7-3f2a9c1e"

    private class Wheel(val presenter: AppHostPresenter, val relay: ActiveAppSession, val delivered: MutableList<String>)

    private fun message(relay: ActiveAppSession, type: String, requestId: String, payload: JSONObject): String =
        JSONObject().put("v", 1).put("type", type).put("callSessionId", call).put("appSessionId", relay.appSessionId)
            .put("requestId", requestId).put("payload", payload).toString()

    private fun receive(wheel: Wheel, type: String, requestId: String, payload: JSONObject) {
        wheel.relay.receiveFromEmbed(raw = message(wheel.relay, type, requestId, payload), origin = AppBridgeProtocol.androidOrigin, isMainFrame = true)
    }

    private fun readyWheel(): Wheel {
        val presenter = AppHostPresenter()
        val relay = ActiveAppSession()
        val delivered = mutableListOf<String>()
        relay.bundleOrigin = AppBridgeProtocol.androidOrigin
        presenter.bind(session = relay)
        relay.begin(appId = "wheel", callSessionId = call, isReadOnly = false)
        presenter.apply(AppHostInputs.make(callSession = 1, appId = "wheel", isHost = true))
        relay.attachBridge(appSessionId = relay.appSessionId) { json -> delivered.add(json) }
        relay.acceptPrimedSnapshot(AppsSyncResponse(syncMessage = skip.foundation.Data(), stateVector = null, awarenessUpdate = null), appSessionId = relay.appSessionId)
        val wheel = Wheel(presenter, relay, delivered)
        receive(wheel, "ready", "e-1", JSONObject().put("bundleVersion", "1.0.0").put("appId", "wheel").put("stateVector", "AA=="))
        val app = JSONObject().put("kind", "wheel").put("entries", JSONArray().put(JSONObject().put("id", "e0").put("label", "Ada")))
            .put("results", JSONArray()).put("removeWinner", false).put("sounds", true).put("spinning", false)
            .put("winnerSpinId", "").put("winnerLabel", "")
        receive(wheel, "status", "e-2", JSONObject().put("app", app))
        return wheel
    }

    private fun adds(wheel: Wheel): List<Pair<String, List<String>>> =
        wheel.delivered.map { JSONObject(it) }.filter { it.getString("type") == "addEntries" }.map { sent ->
            val labels = sent.getJSONObject("payload").getJSONArray("labels")
            sent.getString("requestId") to (0 until labels.length()).map { labels.getString(it) }
        }

    @Test fun aSentNameLeavesTheDraftSoTypingCannotSendItAgain() {
        val wheel = readyWheel()
        wheel.presenter.editWheelDraft("Ada\n")
        assertEquals(listOf(listOf("Ada")), adds(wheel).map { it.second })
        assertEquals("", wheel.presenter.wheelDraft.text)
        wheel.presenter.editWheelDraft("B")
        wheel.presenter.editWheelDraft("Bo")
        assertEquals(1, adds(wheel).size)
        receive(wheel, "ack", adds(wheel)[0].first, JSONObject().put("ok", true))
        assertEquals("Bo", wheel.presenter.wheelDraft.text)
    }

    @Test fun aRefusedNameReturnsAheadOfLaterTyping() {
        val wheel = readyWheel()
        wheel.presenter.editWheelDraft("Cy\n")
        wheel.presenter.editWheelDraft("De")
        receive(wheel, "ack", adds(wheel)[0].first, JSONObject().put("ok", false))
        assertEquals("Cy\nDe", wheel.presenter.wheelDraft.text)
    }

    @Test fun theDraftNeverRepeatsOrLosesALetterInAnyOrder() {
        var seed = 20261124L
        fun random(limit: Int): Int {
            seed = (seed * 1103515245L + 12345L) % 2147483648L
            return (seed % limit).toInt()
        }
        for (run in 0 until 200) {
            var draft = WheelNameDraft()
            var entered = ""
            val open = mutableListOf<Pair<String, String>>()
            var accepted = ""
            var next = 0
            for (step in 0 until 60) {
                when (random(7)) {
                    0, 1 -> {
                        val letter = ('a' + random(26)).toString()
                        entered += letter
                        draft.edit(draft.text + letter)
                    }
                    2 -> {
                        val name = ('a' + random(26)).toString() + ('a' + random(26)).toString()
                        entered += name
                        if (draft.edit(draft.text + name + "\n")) {
                            next += 1
                            open.add("h-$next" to draft.text)
                            draft.didSend(requestId = "h-$next")
                        }
                    }
                    3 -> if (draft.text.isNotBlank()) {
                        next += 1
                        open.add("h-$next" to draft.text)
                        draft.didSend(requestId = "h-$next")
                    }
                    else -> if (open.isNotEmpty()) {
                        val request = open.removeAt(random(open.size))
                        val ok = random(3) > 0
                        if (ok) accepted += request.second
                        draft.reply(requestId = request.first, accepted = ok)
                    }
                }
                val held = accepted + open.joinToString("") { it.second } + draft.text
                assertEquals("run $run step $step", entered.toList().sorted(), held.filter { it.isLetter() }.toList().sorted())
            }
        }
    }
}

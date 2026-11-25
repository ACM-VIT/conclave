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
        JSONObject().put("v", 1).put("type", type).put("callSessionId", relay.callSessionId).put("appSessionId", relay.appSessionId)
            .put("requestId", requestId).put("payload", payload).toString()

    private fun receive(wheel: Wheel, type: String, requestId: String, payload: JSONObject) {
        wheel.relay.receiveFromEmbed(raw = message(wheel.relay, type, requestId, payload), origin = AppBridgeProtocol.androidOrigin, isMainFrame = true)
    }

    private fun readyWheel(): Wheel {
        val presenter = AppHostPresenter()
        val relay = ActiveAppSession()
        relay.bundleOrigin = AppBridgeProtocol.androidOrigin
        presenter.bind(session = relay)
        val wheel = Wheel(presenter, relay, mutableListOf())
        open(wheel, 1, call)
        return wheel
    }

    private fun open(wheel: Wheel, callSession: Int, callId: String, appId: String = "wheel") {
        wheel.relay.begin(appId = appId, callSessionId = callId, isReadOnly = false)
        wheel.presenter.apply(AppHostInputs.make(callSession = callSession, appId = appId, isHost = true))
        if (appId != "wheel") return
        wheel.relay.attachBridge(appSessionId = wheel.relay.appSessionId) { json -> wheel.delivered.add(json) }
        wheel.relay.acceptPrimedSnapshot(AppsSyncResponse(syncMessage = skip.foundation.Data(), stateVector = null, awarenessUpdate = null), appSessionId = wheel.relay.appSessionId)
        receive(wheel, "ready", "e-1", JSONObject().put("bundleVersion", "1.0.0").put("appId", "wheel").put("stateVector", "AA=="))
        val app = JSONObject().put("kind", "wheel").put("entries", JSONArray().put(JSONObject().put("id", "e0").put("label", "Ada")))
            .put("results", JSONArray()).put("removeWinner", false).put("sounds", true).put("spinning", false)
            .put("winnerSpinId", "").put("winnerLabel", "")
        receive(wheel, "status", "e-2", JSONObject().put("app", app))
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

    @Test fun aDraftNeverOutlivesItsCallOrItsWheel() {
        for (exit in listOf("leave and join another call", "new call without a leave", "wheel closed and reopened", "another app then the wheel")) {
            val wheel = readyWheel()
            wheel.presenter.editWheelDraft("Grace\n")
            wheel.presenter.editWheelDraft("Lin")
            val unanswered = adds(wheel).map { it.first }
            assertEquals(exit, 1, unanswered.size)
            when (exit) {
                "leave and join another call" -> {
                    wheel.presenter.reset()
                    wheel.relay.reset()
                    open(wheel, 2, "call-9-next")
                }
                "new call without a leave" -> open(wheel, 2, "call-9-next")
                "wheel closed and reopened" -> {
                    wheel.relay.end()
                    wheel.presenter.apply(AppHostInputs.make(callSession = 1, appId = "", isHost = true))
                    open(wheel, 1, call)
                }
                else -> {
                    open(wheel, 1, call, "whiteboard")
                    open(wheel, 1, call)
                }
            }
            assertEquals(exit, true, wheel.presenter.wheel.isReady)
            assertEquals(exit, "", wheel.presenter.wheelDraft.text)
            assertEquals(exit, 0, wheel.presenter.wheelDraft.sent.count)
            wheel.presenter.fireCommandTimeout(requestId = unanswered[0])
            assertEquals(exit, "", wheel.presenter.wheelDraft.text)
            wheel.presenter.editWheelDraft("Mo\n")
            assertEquals(exit, listOf(listOf("Grace"), listOf("Mo")), adds(wheel).map { it.second })
        }
    }

    private fun outcomeQueries(wheel: Wheel): List<Pair<String, String>> =
        wheel.delivered.map { JSONObject(it) }.filter { it.getString("type") == "addOutcome" }.map { sent ->
            sent.getString("requestId") to sent.getJSONObject("payload").getString("requestId")
        }

    private fun reload(wheel: Wheel) {
        wheel.relay.releaseEmbed()
        wheel.relay.acceptPrimedSnapshot(AppsSyncResponse(syncMessage = skip.foundation.Data(), stateVector = null, awarenessUpdate = null), appSessionId = wheel.relay.appSessionId)
        wheel.relay.attachBridge(appSessionId = wheel.relay.appSessionId) { json -> wheel.delivered.add(json) }
        receive(wheel, "ready", "e-reload", JSONObject().put("bundleVersion", "1.0.0").put("appId", "wheel").put("stateVector", "AA=="))
    }

    @Test fun aRetryOrAFailureAsksTheWheelBeforeReturningAName() {
        for (reset in listOf("retry", "failure", "hidden")) {
            for (applied in listOf(false, true)) {
                val wheel = readyWheel()
                wheel.presenter.editWheelDraft("Grace\n")
                wheel.presenter.editWheelDraft("Lin")
                when (reset) {
                    "retry" -> wheel.presenter.retry()
                    "failure" -> wheel.presenter.apply(event = ActiveAppEvent.make(kind = ActiveAppEventKind.failed,
                        appSessionId = wheel.relay.appSessionId, issue = AppHostIssue.rendererGone))
                    else -> {
                        wheel.presenter.setHiddenLocally(true)
                        wheel.presenter.setHiddenLocally(false)
                    }
                }
                assertEquals(reset, "Lin", wheel.presenter.wheelDraft.text)
                assertEquals(reset, 1, wheel.presenter.wheelDraft.sent.count)
                reload(wheel)
                val query = outcomeQueries(wheel).last()
                assertEquals(reset, adds(wheel)[0].first, query.second)
                if (applied) {
                    receive(wheel, "ack", query.first, JSONObject().put("ok", true).put("added", JSONArray().put(0)))
                    assertEquals(reset, "Lin", wheel.presenter.wheelDraft.text)
                } else {
                    receive(wheel, "ack", query.first, JSONObject().put("ok", false).put("error", "notApplied"))
                    assertEquals(reset, "Grace\nLin", wheel.presenter.wheelDraft.text)
                }
                assertEquals(reset, 0, wheel.presenter.wheelDraft.sent.count)
                assertEquals(reset, 1, adds(wheel).size)
            }
        }
    }

    private fun status(wheel: Wheel, labels: List<String>, spinning: Boolean = false, requestId: String = "e-9") {
        val entries = JSONArray()
        labels.forEachIndexed { index, label -> entries.put(JSONObject().put("id", "e$index").put("label", label)) }
        val app = JSONObject().put("kind", "wheel").put("entries", entries).put("results", JSONArray()).put("removeWinner", false)
            .put("sounds", true).put("spinning", spinning).put("winnerSpinId", "").put("winnerLabel", "")
        receive(wheel, "status", requestId, JSONObject().put("app", app))
    }

    private fun ack(wheel: Wheel, requestId: String, ok: Boolean, added: List<Int>) {
        val list = JSONArray()
        added.forEach { list.put(it) }
        receive(wheel, "ack", requestId, JSONObject().put("ok", ok).put("added", list))
    }

    @Test fun aPasteLargerThanTheRoomLeftKeepsTheNamesTheWheelDidNotAdd() {
        val wheel = readyWheel()
        status(wheel, (1..63).map { "N$it" })
        wheel.presenter.editWheelDraft("Cy\nDe\n")
        assertEquals(listOf(listOf("Cy", "De")), adds(wheel).map { it.second })
        ack(wheel, adds(wheel)[0].first, true, listOf(0))
        assertEquals("De", wheel.presenter.wheelDraft.text)
        assertEquals(0, wheel.presenter.wheelDraft.sent.count)
    }

    @Test fun aLostAckIsRetriedUnderTheSameRequestIdAndAddsTheNameOnce() {
        val wheel = readyWheel()
        wheel.presenter.editWheelDraft("Ada\n")
        val first = adds(wheel)[0].first
        wheel.presenter.fireCommandTimeout(requestId = first)
        assertEquals(listOf(first, first), adds(wheel).map { it.first })
        assertEquals("", wheel.presenter.wheelDraft.text)
        ack(wheel, first, true, listOf(0))
        assertEquals("", wheel.presenter.wheelDraft.text)
        assertEquals(0, wheel.presenter.wheelDraft.sent.count)
    }

    @Test fun reorderingIsRefusedWhileTheWheelSpins() {
        val wheel = readyWheel()
        status(wheel, listOf("Ada", "Bo", "Cy"), spinning = true)
        assertEquals(ActivityTapResult.explained, wheel.presenter.sortWheel())
        assertEquals(ActivityTapResult.explained, wheel.presenter.shuffleWheel())
        assertEquals(ActivityTapResult.explained, wheel.presenter.removeWheelEntry("e0"))
        assertEquals(ActivityTapResult.explained, wheel.presenter.clearWheelNames())
        status(wheel, listOf("Ada", "Bo", "Cy"), requestId = "e-10")
        assertEquals(ActivityTapResult.dispatched, wheel.presenter.sortWheel())
    }

    @Test fun theDraftNeverRepeatsOrLosesALetterInAnyOrder() {
        var seed = 20261124L
        fun random(limit: Int): Int {
            seed = (seed * 1103515245L + 12345L) % 2147483648L
            return (seed % limit).toInt()
        }
        fun lines(text: String): List<String> = text.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        for (run in 0 until 200) {
            var draft = WheelNameDraft()
            var entered = ""
            val open = mutableListOf<Pair<String, List<String>>>()
            var accepted = ""
            var next = 0
            fun send() {
                next += 1
                val sent = lines(draft.text)
                open.add("h-$next" to sent)
                draft.didSend(requestId = "h-$next", lines = skip.lib.Array(sent))
            }
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
                        if (draft.edit(draft.text + name + "\n")) send()
                    }
                    3 -> if (draft.text.isNotBlank()) send()
                    4 -> if (open.isNotEmpty()) {
                        val request = open.removeAt(random(open.size))
                        val ok = random(3) > 0
                        if (ok) accepted += request.second.joinToString("")
                        draft.reply(requestId = request.first, accepted = ok, added = null)
                    }
                    else -> if (open.isNotEmpty()) {
                        val request = open.removeAt(random(open.size))
                        val added = request.second.indices.filter { random(2) == 0 }
                        added.forEach { accepted += request.second[it] }
                        draft.reply(requestId = request.first, accepted = added.isNotEmpty(), added = skip.lib.Array(added))
                    }
                }
                val held = accepted + open.joinToString("") { it.second.joinToString("") } + draft.text
                assertEquals("run $run step $step", entered.toList().sorted(), held.filter { it.isLetter() }.toList().sorted())
            }
        }
    }
}

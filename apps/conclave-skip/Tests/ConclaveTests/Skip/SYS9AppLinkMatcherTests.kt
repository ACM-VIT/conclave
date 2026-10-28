package conclave.module

import android.content.IntentFilter
import android.net.Uri
import android.os.PatternMatcher
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.w3c.dom.Element

/** SYS-9: use Android's real forward-only matcher on the paths read from the shipped manifest.
 * The library test has no app resources: versioned enabled resources are read from source here;
 * packaged alias resolution and cold/warm singleTask delivery still require the app runtime gate.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [31])
class SYS9AppLinkMatcherTests {
    private val androidNamespace = "http://schemas.android.com/apk/res/android"
    private val hosts = listOf("conclave.acmvit.in", "www.conclave.acmvit.in")
    private val accepted = listOf(
        "/rose-sora-luffy", "/brave-otter-4821", "/A1-b2-C3", "/sched-ule-room",
        "/w/abc123", "/w/team-all-hands", "/w/a", "/w/" + "a".repeat(32),
        "/sched-1a2b3c4d", "/sched-Ab12Cd34",
    )
    private val rejected = listOf(
        "/book/ishaan/30-min-chat", "/schedule/team-sync-call",
        "/_next/static/chunks/main-app-1a2b.js", "/transcript-pcm-processor.js",
        "/", "/acme", "/standup", "/rose-sora", "/w", "/sign-in", "/schedule", "/delete-account",
        "/a-b-c/d", "/a/b-c-d", "/a-b-c.js", "/a-b-c/", "/a--c", "/-b-c", "/a-b-", "/a-b-c-d",
        "/w/", "/w/a/b", "/w/a.js", "/w/-", "/w/" + "a".repeat(33),
        "/sched-", "/sched-1234567", "/sched-123456789", "/sched-ghijklmn", "/sched-12345678/file",
        "/a-b-c%2Fd", "/a-b-c%2Ejs", "/w/a%2Fb", "/w/a%2Ejs",
    )

    @Test fun frameworkIntentFiltersAcceptOnlyIntendedShapesOnBothHosts() {
        val filters = manifestFilters()
        assertEquals(2, filters.size)
        for (host in hosts) {
            for (path in accepted) {
                assertTrue("$host$path", captures(filters, "https://$host$path"))
                // Query and fragment stay outside the path matcher.
                assertTrue("$host$path with invite", captures(filters, "https://$host$path?invite=abc#join"))
                val target = NativeJoinLinkParser.parse("https://$host$path", allowRoomCreationForURLs = true)
                assertFalse("parser rejects $path", target.roomId.isEmpty())
                assertEquals(if (path.startsWith("/w/")) JoinMode.webinarAttendee else JoinMode.meeting, target.joinMode)
            }
            for (path in rejected) assertFalse("$host$path", captures(filters, "https://$host$path"))
        }
        assertFalse(captures(filters, "https://example.com/rose-sora-luffy"))
        assertFalse(captures(filters, "http://conclave.acmvit.in/rose-sora-luffy"))
        assertTrue(captures(filters, "https://conclave.acmvit.in/rose%2Dsora%2Dluffy"))
    }

    @Test fun frameworkAdvancedGlobIsGreedyWithoutRegexBacktracking() {
        assertFalse(PatternMatcher("[a-z]+b", PatternMatcher.PATTERN_ADVANCED_GLOB).match("ab"))
        assertFalse(PatternMatcher("[a-z]{1,3}b", PatternMatcher.PATTERN_ADVANCED_GLOB).match("ab"))
        assertTrue(PatternMatcher("[a-z]+-[a-z]+", PatternMatcher.PATTERN_ADVANCED_GLOB).match("ab-cd"))
        for (filter in manifestFilters()) {
            for (index in 0 until filter.countDataPaths()) {
                assertEquals(PatternMatcher.PATTERN_ADVANCED_GLOB, filter.getDataPath(index).type)
            }
        }
    }

    @Test fun oldAndroidCannotEnableTheHttpsAliasButMainActivityKeepsItsIntake() {
        val manifest = manifest()
        val alias = manifest.getElementsByTagName("activity-alias").item(0) as Element
        assertEquals(".MeetingAppLinks", alias.android("name"))
        assertEquals(".MainActivity", alias.android("targetActivity"))
        assertEquals("@bool/conclave_verified_app_links_enabled", alias.android("enabled"))
        assertEquals("true", alias.android("exported"))
        assertFalse(alias.hasAttributeNS(androidNamespace, "launchMode"))
        val main = manifest.getElementsByTagName("activity").item(0) as Element
        assertEquals(".MainActivity", main.android("name"))
        assertEquals("singleTask", main.android("launchMode"))
        assertEquals(0, main.getElementsByTagName("data").elements().count { it.android("scheme") == "https" })
        assertEquals(1, main.getElementsByTagName("data").elements().count { it.android("scheme") == "conclave" })
        assertEquals(1, main.getElementsByTagName("category").elements().count { it.android("name") == "android.intent.category.LAUNCHER" })
        val baseEnabled = enabledResource("values")
        val modernEnabled = enabledResource("values-v31")
        assertFalse(baseEnabled)
        assertTrue(modernEnabled)
        for (api in 28..30) {
            for (path in accepted + rejected) {
                assertFalse("API $api must retain browser fallback: $path", baseEnabled && captures(manifestFilters(), "https://${hosts[0]}$path"))
            }
        }
    }

    @Test fun placeholderWebinarPathsStillFailClosedAtParserIntake() {
        // Manifest matching validates shape, not whether a webinar code was issued. No regex lookahead is
        // available to exclude reserved words; retain the parser's explicit invalid-link behavior.
        for (path in listOf("/w/null", "/w/undefined")) {
            assertTrue(captures(manifestFilters(), "https://${hosts[0]}$path"))
            assertEquals("", NativeJoinLinkParser.parse("https://${hosts[0]}$path").roomId)
        }
    }

    private fun captures(filters: List<IntentFilter>, url: String): Boolean {
        val uri = Uri.parse(url)
        return filters.any { it.matchData(null, uri.scheme, uri) >= 0 }
    }

    private fun manifestFilters(): List<IntentFilter> {
        val alias = manifest().getElementsByTagName("activity-alias").item(0) as Element
        return alias.getElementsByTagName("intent-filter").elements().map { element ->
            assertEquals("true", element.android("autoVerify"))
            IntentFilter().apply {
                element.getElementsByTagName("action").elements().forEach { addAction(it.android("name")) }
                element.getElementsByTagName("category").elements().forEach { addCategory(it.android("name")) }
                element.getElementsByTagName("data").elements().forEach {
                    assertTrue(it.hasAttributeNS(androidNamespace, "pathAdvancedPattern"))
                    assertFalse(it.hasAttributeNS(androidNamespace, "pathPrefix"))
                    assertFalse(it.hasAttributeNS(androidNamespace, "pathPattern"))
                    addDataScheme(it.android("scheme"))
                    addDataAuthority(it.android("host"), null)
                    addDataPath(it.android("pathAdvancedPattern"), PatternMatcher.PATTERN_ADVANCED_GLOB)
                }
            }
        }
    }

    private fun manifest() = xml("Android/app/src/main/AndroidManifest.xml")

    private fun enabledResource(qualifier: String): Boolean {
        val values = xml("Android/app/src/main/res/$qualifier/app_links.xml").getElementsByTagName("bool").elements()
        return values.single { it.getAttribute("name") == "conclave_verified_app_links_enabled" }.textContent.trim().toBooleanStrict()
    }

    private fun xml(relative: String) = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        .newDocumentBuilder().parse(File(packageRoot(), relative))

    private fun packageRoot(): File {
        for (directory in generateSequence(File(System.getProperty("user.dir")).canonicalFile) { it.parentFile }) {
            for (candidate in listOf(directory, File(directory, "apps/conclave-skip"))) {
                if (File(candidate, "Android/app/src/main/AndroidManifest.xml").isFile) return candidate
            }
        }
        error("Cannot locate Conclave package from test working directory")
    }

    private fun Element.android(name: String): String = getAttributeNS(androidNamespace, name)
    private fun org.w3c.dom.NodeList.elements(): List<Element> = (0 until length).mapNotNull { item(it) as? Element }
}

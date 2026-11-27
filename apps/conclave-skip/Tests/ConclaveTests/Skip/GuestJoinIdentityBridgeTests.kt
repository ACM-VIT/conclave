package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class GuestJoinIdentityBridgeTests {
    private val sessionId = "native-session"
    private val issuedUserKey = "guest-gp_AAAAAAAAAAAAAAAAAAAAAA.native-session"
    private val issuedUserId = "guest-gp_AAAAAAAAAAAAAAAAAAAAAA.native-session#native-session"

    @Test fun aGuestGoesByItsSessionIdUntilATokenNamesIt() {
        assertEquals(
            "guest-native-session",
            GuestJoinIdentityPolicy.provisionalUserKey(
                sessionId = sessionId, currentUserKey = null, currentUserId = "5F0B6C1E-0000-4000-8000-000000000000",
            ),
        )
    }

    @Test fun aGuestKeepsTheKeyATokenNamedForThisSession() {
        assertEquals(
            issuedUserKey,
            GuestJoinIdentityPolicy.provisionalUserKey(
                sessionId = sessionId, currentUserKey = issuedUserKey, currentUserId = issuedUserId,
            ),
        )
    }

    @Test fun aKeyIssuedForAnotherSessionIsNotCarriedOver() {
        assertEquals(
            "guest-next-session",
            GuestJoinIdentityPolicy.provisionalUserKey(
                sessionId = "next-session", currentUserKey = issuedUserKey, currentUserId = issuedUserId,
            ),
        )
    }

    @Test fun anAccountKeyIsNeverTakenForAGuestKey() {
        assertEquals(
            "guest-native-session",
            GuestJoinIdentityPolicy.provisionalUserKey(
                sessionId = sessionId, currentUserKey = "alex@example.com", currentUserId = "alex@example.com#native-session",
            ),
        )
    }
}

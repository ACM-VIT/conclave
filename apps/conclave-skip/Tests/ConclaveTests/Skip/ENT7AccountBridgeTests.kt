package conclave.module

import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.NoCredentialException
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
class ENT7AccountBridgeTests {
    private class Recorder {
        val requests = mutableListOf<AccountRequest>()
        val feedback = mutableListOf<FeedbackKind>()
        val signingIn = mutableListOf<Boolean>()

        fun count(kind: AccountRequestKind): Int = requests.count { it.kind == kind }
    }

    private fun signedInInputs(provider: String = "google"): AccountPresenterInputs =
        AccountPresenterInputs.make(isSignedIn = true, userId = "u1", name = "Avery Lee", email = "avery@example.com",
            provider = provider, platform = AccountPlatform.android)

    private fun presenter(recorder: Recorder, signedIn: Boolean = false): AccountPresenter {
        val presenter = AccountPresenter()
        presenter.onRequest = { request -> recorder.requests.add(request) }
        presenter.onFeedback = { kind -> recorder.feedback.add(kind) }
        presenter.onSigningInChanged = { value -> recorder.signingIn.add(value) }
        presenter.apply(if (signedIn) signedInInputs() else AccountPresenterInputs.make(platform = AccountPlatform.android))
        return presenter
    }

    private fun loadProviders(presenter: AccountPresenter, recorder: Recorder, apple: Boolean, google: Boolean) {
        presenter.didPresent()
        val request = recorder.requests.last { it.kind == AccountRequestKind.loadProviders }
        presenter.providersLoaded(generation = request.generation, listsApple = apple, listsGoogle = google)
    }

    @Test fun androidShowsGoogleAloneWithTheAppleFootnote() {
        assertEquals(AccountPlatform.android, AccountPlatform.current)
        assertEquals(AccountProviderOffer(offersApple = false, offersGoogle = true),
            AccountProvidersPolicy.offer(listsApple = true, listsGoogle = true, googleConfigured = true, platform = AccountPlatform.android))
        assertEquals(AccountProviderOffer(offersApple = false, offersGoogle = false),
            AccountProvidersPolicy.offer(listsApple = false, listsGoogle = true, googleConfigured = true, platform = AccountPlatform.ios))
        val recorder = Recorder()
        val account = presenter(recorder)
        assertEquals(ProvidersState.loading, account.snapshot.providersState)
        loadProviders(account, recorder, apple = false, google = true)
        assertEquals(ProvidersState.ready, account.snapshot.providersState)
        assertTrue(account.snapshot.offersGoogle)
        assertFalse(account.snapshot.offersApple)
        assertTrue(account.snapshot.showsAppleFootnote)
        assertFalse(account.beginAppleSignIn())

        val appleOnly = Recorder()
        val other = presenter(appleOnly)
        loadProviders(other, appleOnly, apple = true, google = false)
        assertEquals(ProvidersState.none, other.snapshot.providersState)
        assertTrue(other.snapshot.showsAppleFootnote)
    }

    @Test fun googleSignInCancelIsSilentAndSuccessPublishesOneToken() {
        val recorder = Recorder()
        val account = presenter(recorder)
        loadProviders(account, recorder, apple = false, google = true)
        account.signInWithGoogle()
        assertEquals("google", account.snapshot.pendingProvider)
        assertTrue(account.snapshot.isBusy)
        account.finishSignIn(generation = recorder.requests.last().generation, outcome = AccountSignInOutcome.cancelled)
        assertEquals(AccountErrorKind.none, account.snapshot.errorKind)
        assertTrue(recorder.feedback.isEmpty())

        account.signInWithGoogle()
        val generation = recorder.requests.last().generation
        account.apply(signedInInputs())
        account.finishSignIn(generation = generation, outcome = AccountSignInOutcome.succeeded)
        assertTrue(account.snapshot.isSignedIn)
        assertEquals(listOf(FeedbackKind.signInSucceeded), recorder.feedback)
        assertEquals(listOf(true, false, true, false), recorder.signingIn)
        account.finishSignIn(generation = generation, outcome = AccountSignInOutcome.succeeded)
        assertEquals(1, recorder.feedback.size)
    }

    @Test fun backDuringASignInCancelsItThroughTheGenerationGuard() {
        val recorder = Recorder()
        val account = presenter(recorder)
        loadProviders(account, recorder, apple = false, google = true)
        account.signInWithGoogle()
        val generation = recorder.requests.last().generation
        account.didDismiss()
        assertEquals(AccountRequestKind.cancelSignIn, recorder.requests.last().kind)
        assertFalse(account.isCurrent(generation = generation))
        account.finishSignIn(generation = generation, outcome = AccountSignInOutcome.succeeded)
        assertTrue(recorder.feedback.isEmpty())
        assertTrue(account.snapshot.pendingProvider.isEmpty())
    }

    @Test fun deletionBlocksBackAndEachOutcomeShowsOnce() {
        val recorder = Recorder()
        val account = presenter(recorder, signedIn = true)
        account.deleteAccount()
        assertTrue(account.snapshot.isDeleting)
        assertFalse(account.snapshot.canDismiss)
        account.didDismiss()
        assertTrue(account.snapshot.isDeleting)
        account.finishDelete(generation = recorder.requests.last().generation, succeeded = false)
        assertEquals(AccountErrorKind.deleteFailed, account.snapshot.errorKind)
        assertEquals(AccountOutcomeKind.deleteFailed, account.snapshot.outcome)
        assertTrue(account.needsOutcomeNotice(id = 1))
        account.acknowledgeOutcome(id = 1)
        assertFalse(account.needsOutcomeNotice(id = 1))
        account.deleteAccount()
        val generation = recorder.requests.last().generation
        account.apply(AccountPresenterInputs.make(platform = AccountPlatform.android))
        account.finishDelete(generation = generation, succeeded = true)
        assertEquals(AccountOutcomeKind.deleted, account.snapshot.outcome)
        assertEquals(2, account.snapshot.outcomeId)
        assertEquals(AccountContext.accountDeleted, account.snapshot.context)
        assertTrue(account.snapshot.canDismiss)
    }

    @Test fun identityAndGuestNamePoliciesMatchSwift() {
        val user = AccountIdentityPolicy.signedInUser(id = null, email = " avery@example.com ", name = null, fallbackName = null,
            fallbackEmail = null, provider = AppState.AuthProvider.google, fallbackId = "google-1")
        assertEquals("avery@example.com", user.id)
        assertEquals("avery", user.name)
        val guest = AccountIdentityPolicy.guestUser(name = "Avery", existing = null, newGuestId = "guest-new")
        assertEquals("guest-new@guest.conclave", guest.email)
        assertEquals(AppState.AuthProvider.guest, guest.provider)
        assertEquals("Avery Lee", AccountIdentityPolicy.appleDisplayName(givenName = "Avery", familyName = "Lee"))
        assertEquals(40, AccountGuestNamePolicy.capped("a".repeat(45)).length)
        assertTrue(AccountGuestNamePolicy.isCounterVisible(count = 30))
        assertFalse(AccountGuestNamePolicy.isCounterVisible(count = 29))
        val recorder = Recorder()
        val account = presenter(recorder)
        account.setGuestName("  Avery   Lee ")
        assertEquals("Avery Lee", recorder.requests.last().guestName)
    }

    @Test fun googleBridgeCodesMapToTypedKinds() {
        assertEquals(NativeAuthErrorKind.cancelled, NativeAuthService.kind(forGoogleBridgeCode = NativeGoogleSignInBridge.ERROR_CANCELLED))
        assertEquals(NativeAuthErrorKind.notConfigured, NativeAuthService.kind(forGoogleBridgeCode = NativeGoogleSignInBridge.ERROR_NOT_CONFIGURED))
        assertEquals(NativeAuthErrorKind.unavailable, NativeAuthService.kind(forGoogleBridgeCode = NativeGoogleSignInBridge.ERROR_UNAVAILABLE))
        assertEquals(NativeAuthErrorKind.inProgress, NativeAuthService.kind(forGoogleBridgeCode = NativeGoogleSignInBridge.ERROR_IN_PROGRESS))
        assertEquals(NativeAuthErrorKind.timedOut, NativeAuthService.kind(forGoogleBridgeCode = NativeGoogleSignInBridge.ERROR_TIMED_OUT))
        assertEquals(NativeAuthErrorKind.noCredential, NativeAuthService.kind(forGoogleBridgeCode = NativeGoogleSignInBridge.ERROR_NO_CREDENTIAL))
        assertEquals(NativeAuthErrorKind.invalidResponse, NativeAuthService.kind(forGoogleBridgeCode = NativeGoogleSignInBridge.ERROR_INVALID_RESPONSE))
        assertEquals(NativeAuthErrorKind.providerFailed, NativeAuthService.kind(forGoogleBridgeCode = NativeGoogleSignInBridge.ERROR_FAILED))
        assertEquals(NativeGoogleSignInBridge.ERROR_CANCELLED, NativeGoogleSignInBridge.errorCode(GetCredentialCancellationException()))
        assertEquals(NativeGoogleSignInBridge.ERROR_NO_CREDENTIAL, NativeGoogleSignInBridge.errorCode(NoCredentialException()))
        assertEquals(NativeGoogleSignInBridge.ERROR_FAILED, NativeGoogleSignInBridge.errorCode(GetCredentialUnknownException()))
        assertEquals(NativeAuthErrorKind.cancelled,
            NativeAuthService.errorKind(NativeAuthError(message = "Google Sign-In was cancelled.", kind = NativeAuthErrorKind.cancelled)))
    }

    @Test fun accountFixturesOpenThePushedPageWithoutTheNetwork() {
        val premeeting = PremeetingPresenter()
        val account = AccountPresenter()
        val responder = AccountFixtureScript.install(fixtureState = "account-signed-in", account = account,
            premeeting = premeeting, answerDelayMillis = 0)
        val top = premeeting.path.last
        assertEquals(PremeetingRouteKind.account, top?.kind)
        if (top != null) {
            assertTrue(PremeetingBackStack.key(top) is PremeetingKey.AccountKey)
        }
        assertTrue(account.snapshot.isSignedIn)
        account.deleteAccount()
        assertFalse(account.snapshot.isSignedIn)
        assertEquals(AccountContext.accountDeleted, account.snapshot.context)
        assertFalse(responder.handledRequests.contains(AccountRequestKind.refreshSession))

        val googleOnly = AccountPresenter()
        AccountFixtureScript.install(fixtureState = "account-google-only", account = googleOnly, premeeting = PremeetingPresenter(),
            answerDelayMillis = 0)
        assertEquals(ProvidersState.ready, googleOnly.snapshot.providersState)
        assertTrue(googleOnly.snapshot.offersGoogle)

        val expiredHome = PremeetingPresenter()
        val expired = AccountPresenter()
        AccountFixtureScript.install(fixtureState = "account-expired", account = expired, premeeting = expiredHome,
            answerDelayMillis = 0)
        assertEquals(AccountContext.sessionExpired, expired.snapshot.context)
        assertEquals(HomeNoticeKind.sessionExpired, expiredHome.home.noticeKind)
        assertNull(expiredHome.path.last)
    }

    @Test fun privacyDocumentIsTheVerbatimText() {
        val blocks = PrivacyPolicyDocument.blocks.toList()
        assertEquals(29, blocks.size)
        assertEquals(PrivacyPolicyBlockKind.heading, blocks[1].kind)
        assertEquals("Information Collection and Use", blocks[1].text)
        assertTrue(blocks[0].text.contains("the c0nclav3 app"))
    }

    @Test fun hookTheAccountPageAndPrivacyPageLiveOnThePremeetingBackStack() {
        val premeeting = PremeetingPresenter()
        val recorder = Recorder()
        premeeting.account.onRequest = { request -> recorder.requests.add(request) }
        premeeting.openAccount()
        assertTrue(premeeting.account.isPresented)
        assertEquals(1, recorder.count(AccountRequestKind.loadProviders))
        premeeting.openPrivacyPolicy()
        val keys = PremeetingBackStack.from(premeeting.path.toList(), premeeting.outcome)
        assertTrue(keys[1] is PremeetingKey.AccountKey)
        assertTrue(keys[2] is PremeetingKey.PrivacyKey)

        premeeting.setPath(skip.lib.Array(PremeetingBackStack.popped(premeeting.path.toList())))
        assertTrue(premeeting.account.isPresented)
        premeeting.setPath(skip.lib.Array(PremeetingBackStack.popped(premeeting.path.toList())))
        assertFalse(premeeting.account.isPresented)
    }
}

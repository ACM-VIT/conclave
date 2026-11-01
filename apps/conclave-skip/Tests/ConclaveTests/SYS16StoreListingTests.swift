#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SYS16StoreListingTests {
    @Test func theListingsPointAtTheRealStores() {
        #expect(StoreListing.appStoreURL == "https://apps.apple.com/app/id6758411334")
        #expect(StoreListing.playStoreURL == "https://play.google.com/store/apps/details?id=com.acmvit.conclave")
        #expect(StoreListing.platformURL == StoreListing.appStoreURL)
    }

    @Test func openingTheListingUsesTheInstalledOpenerThenDismissesThePrompt() {
        let presenter = PremeetingPresenter()
        var opened: [String] = []
        presenter.storeOpener = { opened.append($0) }
        presenter.apply(PremeetingInputs.make(updateRequired: true, storeURL: StoreListing.platformURL))
        presenter.newMeeting()
        #expect(presenter.isUpdatePromptPresented)

        presenter.openStoreListing()
        #expect(opened == [StoreListing.appStoreURL])
        #expect(!presenter.isUpdatePromptPresented)
    }

    @Test func withoutAListingNothingOpens() {
        let presenter = PremeetingPresenter()
        var opened: [String] = []
        presenter.storeOpener = { opened.append($0) }
        presenter.apply(PremeetingInputs.make(updateRequired: true, storeURL: ""))
        presenter.openStoreListing()
        #expect(opened.isEmpty)
    }

    @Test func theUpdateFixtureShowsTheBannerAndRecordsTheStoreIntentWithoutAJoin() {
        let session = PremeetingFixtureSession(state: .updateRequired)
        var commands: [PremeetingCommand] = []
        session.start()
        let answer = session.premeeting.onCommand
        session.premeeting.onCommand = { command in
            commands.append(command)
            answer?(command)
        }
        defer { session.stop() }
        #expect(session.premeeting.home.updateRequired)
        #expect(session.premeeting.home.storeURL == StoreListing.platformURL)

        session.premeeting.newMeeting()
        #expect(session.premeeting.isUpdatePromptPresented)
        #expect(session.premeeting.path.isEmpty)
        session.premeeting.openStoreListing()
        #expect(session.storeOpenRequests == [StoreListing.platformURL])
        #expect(commands.isEmpty)
    }
}
#endif

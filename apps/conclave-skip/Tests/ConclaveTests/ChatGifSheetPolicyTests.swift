#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct ChatGifSheetPolicyTests {
    @Test func theGifSheetTakesItsShareOfAPhoneWindow() {
        let phone = ChatGifSheetPolicy.height(windowHeight: 800, keyboardHeight: 0)
        #expect(phone == 800 * ChatGifSheetPolicy.heightFraction)
        #expect(phone > ChatGifSheetPolicy.minimumHeight && phone < 800 - ChatGifSheetPolicy.topClearance)
    }

    @Test func theGifSheetNeverDropsBelowAUsableGridOrRunsUnderTheStatusBar() {
        #expect(ChatGifSheetPolicy.height(windowHeight: 500, keyboardHeight: 0) == ChatGifSheetPolicy.minimumHeight)
        let landscape = ChatGifSheetPolicy.height(windowHeight: 400, keyboardHeight: 0)
        #expect(landscape == 400 - ChatGifSheetPolicy.topClearance)
        #expect(ChatGifSheetPolicy.height(windowHeight: 40, keyboardHeight: 0) == 0)
    }

    @Test func typingKeepsTheSheetsOverallHeightAndShrinksTheGrid() {
        let resting = ChatGifSheetPolicy.height(windowHeight: 900, keyboardHeight: 0)
        let short = ChatGifSheetPolicy.height(windowHeight: 900, keyboardHeight: 200)
        #expect(short + 200 == resting, "the sheet does not climb when the keyboard rises")
        let tall = ChatGifSheetPolicy.height(windowHeight: 900, keyboardHeight: 380)
        #expect(tall == ChatGifSheetPolicy.minimumTypingHeight, "the grid keeps a usable floor")
        #expect(tall + 380 < 900 - ChatGifSheetPolicy.topClearance, "and the sheet stays well below the status bar")
        let cramped = ChatGifSheetPolicy.height(windowHeight: 600, keyboardHeight: 340)
        #expect(cramped == 600 - 340 - ChatGifSheetPolicy.topClearance, "only a cramped window lets it reach the top clearance")
        #expect(ChatGifSheetPolicy.height(windowHeight: 300, keyboardHeight: 400) == 0)
    }
}
#endif

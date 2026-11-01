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

    @Test func theGifSheetShrinksOnlyAsFarAsTheKeyboardNeeds() {
        let resting = ChatGifSheetPolicy.height(windowHeight: 900, keyboardHeight: 0)
        #expect(ChatGifSheetPolicy.height(windowHeight: 900, keyboardHeight: 200) == resting, "a short keyboard leaves the sheet alone")
        let typing = ChatGifSheetPolicy.height(windowHeight: 900, keyboardHeight: 380)
        #expect(typing == 900 - 380 - ChatGifSheetPolicy.topClearance, "the sheet plus the keyboard still clears the status bar")
        #expect(typing < resting)
        #expect(ChatGifSheetPolicy.height(windowHeight: 300, keyboardHeight: 400) == 0)
    }
}
#endif

#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct ChatImageContractTests {
    @Test func theAuthorizeAckWithoutASafetyKeyParsesIntoAnUploadCapability() throws {
        let json = #"{"token":"t.abc","uploadUrl":"https://sfu.example/chat-images","maxBytes":6291456,"timeoutMs":45000}"#
        let ack = try JSONDecoder().decode(ChatImageUploadAuthorizationAck.self, from: Data(json.utf8))
        let authorization = try ack.authorization()
        #expect(authorization.token == "t.abc")
        #expect(authorization.uploadUrl == "https://sfu.example/chat-images")
        #expect(authorization.maxBytes == ChatImageSendPolicy.maxBytes)
    }

    @Test func anAcceptedUploadReturnsTheAttachmentToSend() throws {
        let json = #"{"image":{"id":"a1","url":"https://sfu.example/chat-images/a1?room=r&signature=s","fileName":"photo.jpg","mimeType":"image/jpeg","size":1024}}"#
        let result = try JSONDecoder().decode(ChatImageUploadResult.self, from: Data(json.utf8))
        #expect(result.image == ChatImageAttachment(id: "a1", url: "https://sfu.example/chat-images/a1?room=r&signature=s",
                                                    fileName: "photo.jpg", mimeType: "image/jpeg", size: 1024))
    }

    @Test func serverRejectionsKeepTheirMeaning() throws {
        let blocked = try JSONDecoder().decode(ChatImageUploadResult.self, from: Data(
            #"{"code":"chat_image_moderation_blocked","error":"Image not sent. Our safety check flagged it as potentially harmful."}"#.utf8))
        #expect(ChatPhotoFailurePolicy.failure(serverMessage: blocked.error ?? "", code: blocked.code ?? "") == .photoBlocked)

        let unavailable = ChatPhotoFailurePolicy.failure(serverMessage: "Image safety check is temporarily unavailable. Try again.",
                                                         code: "")
        #expect(unavailable == .photoUnavailable)
        #expect(ChatPhotoFailurePolicy.isRetryable(unavailable))
    }
}
#endif

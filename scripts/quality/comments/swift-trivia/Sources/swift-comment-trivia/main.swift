import Foundation
import SwiftParser
import SwiftSyntax

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let source = String(data: input, encoding: .utf8) else {
    FileHandle.standardError.write(Data("swift-comment-trivia: input is not UTF-8\n".utf8))
    exit(1)
}

func isComment(_ piece: TriviaPiece) -> Bool {
    switch piece {
    case .lineComment, .blockComment, .docLineComment, .docBlockComment:
        return true
    default:
        return false
    }
}

var ranges: [[Int]] = []
func collect(_ trivia: Trivia, from start: AbsolutePosition) {
    var offset = start.utf8Offset
    for piece in trivia {
        let length = piece.sourceLength.utf8Length
        if isComment(piece) { ranges.append([offset, offset + length]) }
        offset += length
    }
}

let tree = Parser.parse(source: source)
for token in tree.tokens(viewMode: .sourceAccurate) {
    collect(token.leadingTrivia, from: token.position)
    collect(token.trailingTrivia, from: token.endPositionBeforeTrailingTrivia)
}
let output = try JSONSerialization.data(withJSONObject: ranges)
FileHandle.standardOutput.write(output)

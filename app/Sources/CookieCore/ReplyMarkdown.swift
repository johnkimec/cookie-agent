import Foundation

/// Prepares model text for SwiftStreamingMarkdown.
///
/// Textual (gonzalezreal/textual) is the preferred renderer, and it understands
/// `$...$` and `$$...$$` math. Textual 0.5.0 requires macOS 15. This app's
/// deployment target is macOS 14, so the popup uses SwiftStreamingMarkdown 0.7.0
/// (commit 5f7c04e; a version pin cannot resolve because that tag depends on
/// revision pins). That library already renders `\( ... \)` and `$$ ... $$`. This
/// function rewrites a complete `\[ ... \]` into `$$ ... $$`, including a block
/// that spans lines, and it leaves `\( ... \)` alone. An unclosed delimiter is
/// left as the model wrote it. Fenced code is not rewritten, and a fence between
/// `\[` and `\]` keeps the opener as written.
public func prepareReplyMarkdown(_ text: String) -> String {
    let normalized = text
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
    return replaceDisplayMath(normalized)
}

private func replaceDisplayMath(_ text: String) -> String {
    let chars = Array(text)
    var result = ""
    result.reserveCapacity(chars.count)
    var index = 0
    var inFence = false
    while index < chars.count {
        if isLineStart(chars, index), hasPrefix(chars, index, "```") {
            inFence.toggle()
            let end = lineEnd(chars, index)
            result.append(contentsOf: chars[index..<end])
            index = end
            continue
        }
        if !inFence,
           hasPrefix(chars, index, "\\["),
           let close = displayMathClose(chars, from: index + 2) {
            result += "$$"
            result.append(contentsOf: chars[(index + 2)..<close])
            result += "$$"
            index = close + 2
            continue
        }
        result.append(chars[index])
        index += 1
    }
    return result
}

private func isLineStart(_ chars: [Character], _ index: Int) -> Bool {
    index == 0 || chars[index - 1] == "\n"
}

private func hasPrefix(_ chars: [Character], _ index: Int, _ prefix: String) -> Bool {
    let prefixChars = Array(prefix)
    guard index + prefixChars.count <= chars.count else { return false }
    for offset in prefixChars.indices {
        if chars[index + offset] != prefixChars[offset] {
            return false
        }
    }
    return true
}

private func lineEnd(_ chars: [Character], _ index: Int) -> Int {
    var cursor = index
    while cursor < chars.count, chars[cursor] != "\n" {
        cursor += 1
    }
    if cursor < chars.count {
        cursor += 1
    }
    return cursor
}

/// Index of `\]`, or nil when the block is unclosed or a fence line comes first.
private func displayMathClose(_ chars: [Character], from start: Int) -> Int? {
    var index = start
    while index + 1 < chars.count {
        if isLineStart(chars, index), hasPrefix(chars, index, "```") {
            return nil
        }
        if chars[index] == "\\", chars[index + 1] == "]" {
            return index
        }
        index += 1
    }
    return nil
}

import Foundation

/// Prepares model text for SwiftStreamingMarkdown.
///
/// Textual (gonzalezreal/textual) is the preferred renderer, and it understands
/// `$...$` and `$$...$$` math. Textual 0.5.0 requires macOS 15. This app's
/// deployment target is macOS 14, so the popup uses SwiftStreamingMarkdown 0.7.0
/// instead. That library already renders `\( ... \)` and `$$ ... $$`. This
/// function only rewrites a complete `\[ ... \]` into `$$ ... $$`, and it leaves
/// `\( ... \)` alone. An unclosed delimiter is left as the model wrote it.
/// Fenced code is not rewritten.
public func prepareReplyMarkdown(_ text: String) -> String {
    let normalized = text
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
    var inFence = false
    var output: [String] = []
    output.reserveCapacity(normalized.count / 8)
    for line in normalized.split(separator: "\n", omittingEmptySubsequences: false) {
        let raw = String(line)
        if raw.hasPrefix("```") {
            inFence.toggle()
            output.append(raw)
            continue
        }
        if inFence {
            output.append(raw)
        } else {
            output.append(replaceDisplayMath(raw))
        }
    }
    return output.joined(separator: "\n")
}

private func replaceDisplayMath(_ line: String) -> String {
    let chars = Array(line)
    var result = ""
    result.reserveCapacity(chars.count)
    var index = 0
    while index < chars.count {
        if chars[index] == "\\",
           index + 1 < chars.count,
           chars[index + 1] == "[",
           let close = displayMathClose(chars, from: index + 2) {
            let body = String(chars[(index + 2)..<close])
            if !body.contains("```") {
                result += "$$"
                result += body
                result += "$$"
                index = close + 2
                continue
            }
        }
        result.append(chars[index])
        index += 1
    }
    return result
}

private func displayMathClose(_ chars: [Character], from start: Int) -> Int? {
    var index = start
    while index + 1 < chars.count {
        if chars[index] == "\\", chars[index + 1] == "]" {
            return index
        }
        index += 1
    }
    return nil
}

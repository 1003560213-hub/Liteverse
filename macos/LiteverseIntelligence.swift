// LiteverseIntelligence — on-device summaries with Apple's Foundation Models.
//
// A short-lived helper launched by Liteverse.app. It reads one JSON request on
// standard input and prints one JSON object on standard output:
//
//   {"task":"status"}
//     -> {"available":true,"model":"..."} | {"available":false,"reason":"..."}
//   {"task":"digest","title":"...","quotes":[{"id":"q-..","kind":"result","text":"..."}]}
//     -> {"gist":"...","keyPoints":[{"text":"...","quoteIds":["q-.."]}],"model":"..."}
//     |  {"error":"..."}
//
// The helper sees only verbatim key points already extracted from the paper,
// never files. It runs entirely on this Mac. Its output is a draft summary for
// reading; Liteverse never treats it as evidence.
//
// Requires the macOS 26 SDK to build and macOS 26 with Apple Intelligence
// enabled to run. The main app checks the OS version before launching it.

import Foundation
import FoundationModels

private struct Quote: Decodable {
    let id: String
    let kind: String?
    let text: String
}

private struct Request: Decodable {
    let task: String
    let title: String?
    let quotes: [Quote]?
}

@available(macOS 26.0, *)
@Generable
private struct Takeaway {
    @Guide(description: "One short takeaway sentence restating what the quotes say.")
    var text: String

    @Guide(description: "Identifiers of the quotes that support this takeaway, copied exactly from the brackets.")
    var quoteIds: [String]
}

@available(macOS 26.0, *)
@Generable
private struct PaperDigest {
    @Guide(description: "Two or three plain sentences: what the paper studies, how, and what it finds. Use only information in the quotes.")
    var gist: String

    @Guide(description: "At most four takeaways, each supported by specific quotes.")
    var keyPoints: [Takeaway]
}

private func emit(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    exit(0)
}

private let instructions = """
You help a researcher skim scientific papers. You receive the paper title and \
numbered quotations copied verbatim from the paper. Summarize only what the \
quotations state. Never add facts, numbers, equations, citations, or claims \
that are not present in the quotations. Keep technical terms, symbols, and \
units exactly as written. If the quotations do not support a clear summary, \
say that the extracted text is insufficient.
"""

@available(macOS 26.0, *)
private func availabilityReason(_ model: SystemLanguageModel) -> String? {
    switch model.availability {
    case .available:
        return nil
    case .unavailable(.deviceNotEligible):
        return "This Mac does not support Apple Intelligence."
    case .unavailable(.appleIntelligenceNotEnabled):
        return "Turn on Apple Intelligence in System Settings to use on-device summaries."
    case .unavailable(.modelNotReady):
        return "The on-device model is still being prepared. Try again later."
    default:
        return "Apple Intelligence is unavailable on this Mac."
    }
}

@available(macOS 26.0, *)
private func run(_ request: Request) async -> Never {
    let model = SystemLanguageModel.default
    if request.task == "status" {
        if let reason = availabilityReason(model) {
            emit(["available": false, "reason": reason])
        }
        emit(["available": true, "reason": "", "model": "Apple on-device foundation model"])
    }
    guard request.task == "digest" else { emit(["error": "Unsupported request."]) }
    if let reason = availabilityReason(model) { emit(["error": reason]) }
    let quotes = (request.quotes ?? []).prefix(9)
    guard !quotes.isEmpty else { emit(["error": "No quotations were provided."]) }

    var prompt = "Paper title: \(request.title ?? "Untitled")\n\nQuotations:\n"
    for quote in quotes {
        let kind = quote.kind.map { " (\($0))" } ?? ""
        prompt += "[\(quote.id)]\(kind) \(quote.text.prefix(1400))\n"
    }
    prompt += "\nSummarize the paper from these quotations only."

    do {
        let session = LanguageModelSession(model: model, instructions: instructions)
        let response = try await session.respond(
            to: prompt,
            generating: PaperDigest.self,
            options: GenerationOptions(temperature: 0.2)
        )
        let digest = response.content
        let validIDs = Set(quotes.map(\.id))
        let points: [[String: Any]] = digest.keyPoints.prefix(4).map { point in
            ["text": point.text, "quoteIds": point.quoteIds.filter { validIDs.contains($0) }]
        }
        emit([
            "gist": digest.gist,
            "keyPoints": points,
            "model": "Apple on-device foundation model",
        ])
    } catch {
        emit(["error": "Apple Intelligence could not summarize this paper: \(error.localizedDescription)"])
    }
}

@main
struct LiteverseIntelligence {
    static func main() async {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard let request = try? JSONDecoder().decode(Request.self, from: input) else {
            emit(["error": "The request could not be read."])
        }
        if #available(macOS 26.0, *) {
            await run(request)
        } else {
            emit(request.task == "status"
                ? ["available": false, "reason": "Apple Intelligence summaries need macOS 26 or later."]
                : ["error": "Apple Intelligence summaries need macOS 26 or later."])
        }
    }
}

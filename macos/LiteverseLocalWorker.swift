import CryptoKit
import Darwin
import Foundation
import PDFKit

private let jobSchemaVersion = "liteverse-local-job-v1"
private let resultSchemaVersion = "liteverse-local-result-v1"
private let workerVersion = "0.4.0"

private enum WorkerFailure: Error, CustomStringConvertible {
    case invalidRequest(String)
    case invalidSource(String)
    case busy
    case network(String)
    case filesystem(String)

    var description: String {
        switch self {
        case .invalidRequest(let message), .invalidSource(let message), .network(let message), .filesystem(let message):
            return message
        case .busy:
            return "another Liteverse local preparation job is already running"
        }
    }
}

private struct SourceRequest {
    let kind: String
    let path: String?
    let arxiv: String?
    let title: String?
    let authors: [String]
    let doi: String?
}

private struct JobRequest {
    let jobID: String
    let supportDirectory: URL
    let requestedPaperID: String?
    let source: SourceRequest
    let itemID: String
    let itemRevision: Int
    let catalogFingerprint: String
    let timeoutSeconds: TimeInterval
    let requestData: Data
}

private struct SourceMetadata {
    var title: String
    var authors: [String]
    var arxivID: String?
    var doi: String?
    var officialURL: String?
    var published: String?
    var updated: String?
    var metadataStatus: String
}

private struct ExistingPaper {
    let paperID: String
    let title: String
    let authors: [String]
    let sha256: String?
    let arxivBase: String?
    let doi: String?
}

private struct ArtifactRecord {
    let role: String
    let relativePath: String
    let sha256: String
    let size: UInt64

    var json: [String: Any] {
        [
            "role": role,
            "path": relativePath,
            "sha256": sha256,
            "size": size,
        ]
    }
}

private struct RoutingCandidate {
    let page: Int
    let text: String
    let signals: [String]

    var json: [String: Any] {
        [
            "page": page,
            "text": text,
            "signals": signals,
            "status": "provisional",
            "purpose": "routing_only",
        ]
    }
}

private struct ExtractionSummary {
    let pageCount: Int
    let meaningfulCharacters: Int
    let sectionHeadings: [RoutingCandidate]
    let equationLikeLines: [RoutingCandidate]
    let methodSentences: [RoutingCandidate]
    let resultSentences: [RoutingCandidate]
    let limitationSentences: [RoutingCandidate]
}

private let routingCaps = (
    sectionHeadings: 32,
    equationLikeLines: 24,
    methodSentences: 16,
    resultSentences: 16,
    limitationSentences: 16
)

private let numberedHeadingExpression = try! NSRegularExpression(
    pattern: #"^(?:(?:\d+(?:\.\d+)*)|(?:[IVXLC]+))[.)]?\s+\S+"#,
    options: [.caseInsensitive]
)

private let commonSectionHeadings: Set<String> = [
    "abstract",
    "acknowledgments",
    "appendix",
    "conclusion",
    "conclusions",
    "discussion",
    "introduction",
    "limitations",
    "materials and methods",
    "method",
    "methods",
    "references",
    "results",
]

private let methodRoutingSignals = [
    "algorithm",
    "dataset",
    "experiment",
    "method",
    "model",
    "numerical",
    "simulation",
    "we compute",
    "we employ",
    "we measure",
    "we solve",
    "we use",
]

private let resultRoutingSignals = [
    "consistent with",
    "demonstrate",
    "decreases",
    "indicate",
    "increases",
    "our results",
    "we find",
    "we observe",
    "we show",
]

private let limitationRoutingSignals = [
    "approximation",
    "assume",
    "cannot",
    "caveat",
    "does not",
    "future work",
    "however",
    "limitation",
    "restricted",
    "uncertain",
]

private final class WorkerLock {
    private var descriptor: Int32 = -1

    init(at url: URL) throws {
        descriptor = Darwin.open(url.path, O_RDWR | O_CREAT | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            throw WorkerFailure.filesystem("could not open the local worker lock: \(String(cString: strerror(errno)))")
        }
        guard Darwin.lockf(descriptor, F_TLOCK, 0) == 0 else {
            Darwin.close(descriptor)
            descriptor = -1
            throw WorkerFailure.busy
        }
    }

    deinit {
        if descriptor >= 0 {
            _ = Darwin.lockf(descriptor, F_ULOCK, 0)
            Darwin.close(descriptor)
        }
    }
}

private final class ArxivFeedParser: NSObject, XMLParserDelegate {
    private var inEntry = false
    private var inAuthor = false
    private var capture: String?
    private var buffer = ""

    var canonicalURL: String?
    var title: String?
    var authors: [String] = []
    var doi: String?
    var published: String?
    var updated: String?

    func parser(
        _ parser: XMLParser,
        didStartElement elementName: String,
        namespaceURI: String?,
        qualifiedName qName: String?,
        attributes attributeDict: [String: String] = [:]
    ) {
        let name = normalizedElementName(elementName)
        if name == "entry" {
            inEntry = true
            return
        }
        guard inEntry else { return }
        if name == "author" {
            inAuthor = true
            return
        }
        if ["id", "title", "name", "doi", "published", "updated"].contains(name) {
            capture = name
            buffer = ""
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if capture != nil { buffer.append(string) }
    }

    func parser(
        _ parser: XMLParser,
        didEndElement elementName: String,
        namespaceURI: String?,
        qualifiedName qName: String?
    ) {
        let name = normalizedElementName(elementName)
        if name == "entry" {
            inEntry = false
            return
        }
        if name == "author" {
            inAuthor = false
            return
        }
        guard capture == name else { return }
        let value = collapsedWhitespace(buffer)
        switch name {
        case "id":
            if canonicalURL == nil { canonicalURL = value }
        case "title":
            title = value
        case "name":
            if inAuthor && !value.isEmpty { authors.append(value) }
        case "doi":
            doi = normalizeDOI(value)
        case "published":
            published = value
        case "updated":
            updated = value
        default:
            break
        }
        capture = nil
        buffer = ""
    }

    private func normalizedElementName(_ value: String) -> String {
        value.split(separator: ":").last.map(String.init)?.lowercased() ?? value.lowercased()
    }
}

private func utcTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

private func collapsedWhitespace(_ value: String) -> String {
    value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func normalizedText(_ value: String?) -> String {
    guard let value else { return "" }
    let lowered = value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    let normalized = lowered.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? String($0) : " " }.joined()
    return collapsedWhitespace(normalized)
}

private func normalizeDOI(_ value: String?) -> String? {
    guard var value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
    value = value.replacingOccurrences(of: #"^https?://(?:dx\.)?doi\.org/"#, with: "", options: [.regularExpression, .caseInsensitive])
    value = value.lowercased()
    guard value.range(of: #"^10\.\d{4,9}/\S+$"#, options: .regularExpression) != nil else { return nil }
    return value
}

private func arxivBase(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value.replacingOccurrences(of: #"v\d+$"#, with: "", options: [.regularExpression, .caseInsensitive]).lowercased()
}

private func parseArxiv(_ raw: String) throws -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let pattern = #"^(?:https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/)?((?:\d{4}\.\d{4,5}|[A-Za-z.\-]+/\d{7})(?:v\d+)?)(?:\.pdf)?/?$"#
    let expression = try NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
    guard let match = expression.firstMatch(in: trimmed, range: range), match.range.location != NSNotFound,
          let identifierRange = Range(match.range(at: 1), in: trimmed) else {
        throw WorkerFailure.invalidRequest("invalid explicit arXiv ID or URL")
    }
    return String(trimmed[identifierRange])
}

private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func sha256File(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
        let data = try handle.read(upToCount: 1_048_576) ?? Data()
        if data.isEmpty { break }
        hasher.update(data: data)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

private func writeAll(_ data: Data, descriptor: Int32) throws {
    try data.withUnsafeBytes { rawBuffer in
        guard var pointer = rawBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
        var remaining = rawBuffer.count
        while remaining > 0 {
            let written = Darwin.write(descriptor, pointer, remaining)
            if written < 0 {
                if errno == EINTR { continue }
                throw WorkerFailure.filesystem("write failed: \(String(cString: strerror(errno)))")
            }
            if written == 0 { throw WorkerFailure.filesystem("write made no forward progress") }
            remaining -= written
            pointer = pointer.advanced(by: written)
        }
    }
}

private func syncDirectory(_ url: URL) throws {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard descriptor >= 0 else {
        throw WorkerFailure.filesystem("could not open directory for sync: \(String(cString: strerror(errno)))")
    }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else {
        throw WorkerFailure.filesystem("could not sync directory: \(String(cString: strerror(errno)))")
    }
}

private func atomicWrite(_ data: Data, to destination: URL) throws {
    let fileManager = FileManager.default
    let directory = destination.deletingLastPathComponent()
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    let temporary = directory.appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).tmp")
    let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else {
        throw WorkerFailure.filesystem("could not create atomic temporary file: \(String(cString: strerror(errno)))")
    }
    var descriptorIsOpen = true
    do {
        try writeAll(data, descriptor: descriptor)
        guard Darwin.fsync(descriptor) == 0 else {
            throw WorkerFailure.filesystem("could not sync atomic temporary file: \(String(cString: strerror(errno)))")
        }
        Darwin.close(descriptor)
        descriptorIsOpen = false
        if Darwin.rename(temporary.path, destination.path) != 0 {
            throw WorkerFailure.filesystem("could not publish atomic file: \(String(cString: strerror(errno)))")
        }
        try syncDirectory(directory)
    } catch {
        if descriptorIsOpen { Darwin.close(descriptor) }
        try? fileManager.removeItem(at: temporary)
        throw error
    }
}

private func durableCopy(from source: URL, to destination: URL) throws {
    let fileManager = FileManager.default
    let directory = destination.deletingLastPathComponent()
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    let temporary = directory.appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).tmp")
    do {
        try fileManager.copyItem(at: source, to: temporary)
        let descriptor = Darwin.open(temporary.path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else {
            throw WorkerFailure.filesystem("could not open copied PDF for sync")
        }
        guard Darwin.fsync(descriptor) == 0 else {
            Darwin.close(descriptor)
            throw WorkerFailure.filesystem("could not sync copied PDF")
        }
        Darwin.close(descriptor)
        if Darwin.rename(temporary.path, destination.path) != 0 {
            throw WorkerFailure.filesystem("could not publish copied PDF: \(String(cString: strerror(errno)))")
        }
        try syncDirectory(directory)
    } catch {
        try? fileManager.removeItem(at: temporary)
        throw error
    }
}

private func jsonData(_ value: Any) throws -> Data {
    guard JSONSerialization.isValidJSONObject(value) else {
        throw WorkerFailure.filesystem("worker attempted to create invalid JSON")
    }
    var data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    data.append(0x0A)
    return data
}

private func nullable<T>(_ value: T?) -> Any {
    if let value { return value }
    return NSNull()
}

private func parseJob(data: Data) throws -> JobRequest {
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw WorkerFailure.invalidRequest("job request must be a JSON object")
    }
    guard root["schemaVersion"] as? String == jobSchemaVersion else {
        throw WorkerFailure.invalidRequest("unsupported job schema; expected \(jobSchemaVersion)")
    }
    guard root["operation"] as? String == "materialize" else {
        throw WorkerFailure.invalidRequest("the local worker only accepts the materialize operation")
    }
    guard let jobID = root["jobId"] as? String,
          jobID.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"#, options: .regularExpression) != nil else {
        throw WorkerFailure.invalidRequest("jobId must contain 1-64 lowercase letters, digits, or internal hyphens")
    }
    guard let supportPath = root["supportDir"] as? String, supportPath.hasPrefix("/") else {
        throw WorkerFailure.invalidRequest("supportDir must be an absolute path")
    }
    guard let sourceObject = root["source"] as? [String: Any], let kind = sourceObject["kind"] as? String,
          kind == "pdf" || kind == "arxiv" else {
        throw WorkerFailure.invalidRequest("source.kind must be pdf or arxiv")
    }
    let path = sourceObject["pdfPath"] as? String
    let arxiv = sourceObject["arxivId"] as? String
    if kind == "pdf" && (path == nil || !(path?.hasPrefix("/") ?? false)) {
        throw WorkerFailure.invalidRequest("a local PDF source requires an absolute source.pdfPath")
    }
    if kind == "arxiv" && arxiv == nil {
        throw WorkerFailure.invalidRequest("an arXiv source requires source.arxivId")
    }
    if kind == "pdf" && arxiv != nil {
        throw WorkerFailure.invalidRequest("a PDF source may not include source.arxivId")
    }
    if kind == "arxiv" && path != nil {
        throw WorkerFailure.invalidRequest("an arXiv source may not include source.pdfPath")
    }
    if let requestedPaperID = root["paperId"] as? String,
       requestedPaperID.range(of: #"^[a-z0-9]+(?:-[a-z0-9]+)*$"#, options: .regularExpression) == nil {
        throw WorkerFailure.invalidRequest("paperId must contain lowercase letters, digits, and single hyphen separators")
    }
    let authors = (sourceObject["authors"] as? [Any] ?? []).compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    guard let itemID = root["itemId"] as? String, !itemID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw WorkerFailure.invalidRequest("itemId is required")
    }
    guard let itemRevision = (root["itemRevision"] as? NSNumber)?.intValue, itemRevision > 0 else {
        throw WorkerFailure.invalidRequest("itemRevision must be positive")
    }
    guard let catalogFingerprint = root["catalogFingerprint"] as? String,
          catalogFingerprint == "absent" || catalogFingerprint.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil else {
        throw WorkerFailure.invalidRequest("catalogFingerprint must be a lowercase SHA-256 or absent")
    }
    let timeout = (root["timeoutSeconds"] as? NSNumber)?.doubleValue ?? 30
    if timeout < 2 || timeout > 120 {
        throw WorkerFailure.invalidRequest("timeoutSeconds must be between 2 and 120")
    }
    let supportURL = URL(fileURLWithPath: supportPath, isDirectory: true).standardizedFileURL
    if let path, kind == "pdf" {
        let sourceURL = URL(fileURLWithPath: path).standardizedFileURL
        let pipelinePath = supportURL.appendingPathComponent("Work/LocalPipeline", isDirectory: true).path
        if sourceURL.path == pipelinePath || sourceURL.path.hasPrefix(pipelinePath + "/") {
            throw WorkerFailure.invalidRequest("source.pdfPath may not point inside Work/LocalPipeline")
        }
    }
    return JobRequest(
        jobID: jobID,
        supportDirectory: supportURL,
        requestedPaperID: root["paperId"] as? String,
        source: SourceRequest(
            kind: kind,
            path: path,
            arxiv: arxiv,
            title: (sourceObject["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
            authors: authors,
            doi: normalizeDOI(sourceObject["doi"] as? String)
        ),
        itemID: itemID,
        itemRevision: itemRevision,
        catalogFingerprint: catalogFingerprint,
        timeoutSeconds: timeout,
        requestData: data
    )
}

private func validatePDF(_ url: URL) throws {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
        throw WorkerFailure.invalidSource("PDF source does not exist")
    }
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard (attributes[.size] as? NSNumber)?.uint64Value ?? 0 >= 8 else {
        throw WorkerFailure.invalidSource("PDF source is empty or truncated")
    }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let prefix = try handle.read(upToCount: 1024) ?? Data()
    guard String(decoding: prefix, as: UTF8.self).contains("%PDF-") else {
        throw WorkerFailure.invalidSource("source is not a PDF")
    }
}

private func synchronousDataRequest(_ request: URLRequest, timeout: TimeInterval) throws -> (Data, HTTPURLResponse) {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = timeout
    configuration.timeoutIntervalForResource = timeout
    let session = URLSession(configuration: configuration)
    let semaphore = DispatchSemaphore(value: 0)
    var responseData: Data?
    var responseValue: HTTPURLResponse?
    var responseError: Error?
    let task = session.dataTask(with: request) { data, response, error in
        responseData = data
        responseValue = response as? HTTPURLResponse
        responseError = error
        semaphore.signal()
    }
    task.resume()
    guard semaphore.wait(timeout: .now() + timeout + 1) == .success else {
        task.cancel()
        throw WorkerFailure.network("network request timed out")
    }
    if let responseError { throw WorkerFailure.network("network request failed: \(responseError.localizedDescription)") }
    guard let responseData, let responseValue, (200..<300).contains(responseValue.statusCode) else {
        throw WorkerFailure.network("network request returned a non-success HTTP status")
    }
    guard responseData.count <= 10 * 1_024 * 1_024 else {
        throw WorkerFailure.network("metadata response exceeded the local worker limit")
    }
    return (responseData, responseValue)
}

private func synchronousDownload(_ request: URLRequest, to destination: URL, timeout: TimeInterval) throws -> HTTPURLResponse {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = timeout
    configuration.timeoutIntervalForResource = timeout
    let session = URLSession(configuration: configuration)
    let semaphore = DispatchSemaphore(value: 0)
    var responseValue: HTTPURLResponse?
    var responseError: Error?
    let task = session.downloadTask(with: request) { temporary, response, error in
        responseValue = response as? HTTPURLResponse
        responseError = error
        if let temporary, error == nil {
            do {
                try FileManager.default.copyItem(at: temporary, to: destination)
            } catch {
                responseError = error
            }
        }
        semaphore.signal()
    }
    task.resume()
    guard semaphore.wait(timeout: .now() + timeout + 1) == .success else {
        task.cancel()
        throw WorkerFailure.network("arXiv PDF download timed out")
    }
    if let responseError { throw WorkerFailure.network("arXiv PDF download failed: \(responseError.localizedDescription)") }
    guard let responseValue, (200..<300).contains(responseValue.statusCode) else {
        throw WorkerFailure.network("arXiv PDF download returned a non-success HTTP status")
    }
    return responseValue
}

private func fetchArxiv(_ identifier: String, timeout: TimeInterval, into directory: URL) throws -> (URL, SourceMetadata) {
    var components = URLComponents(string: "https://export.arxiv.org/api/query")!
    components.queryItems = [URLQueryItem(name: "id_list", value: identifier)]
    var metadataRequest = URLRequest(url: components.url!)
    metadataRequest.setValue("LiteverseLocalWorker/\(workerVersion)", forHTTPHeaderField: "User-Agent")
    metadataRequest.setValue("application/atom+xml", forHTTPHeaderField: "Accept")
    let (metadataData, _) = try synchronousDataRequest(metadataRequest, timeout: timeout)
    let delegate = ArxivFeedParser()
    let parser = XMLParser(data: metadataData)
    parser.delegate = delegate
    guard parser.parse(), let canonicalURL = delegate.canonicalURL, let title = delegate.title,
          !title.isEmpty, !delegate.authors.isEmpty else {
        throw WorkerFailure.network("official arXiv metadata was invalid or incomplete")
    }
    let canonicalID = canonicalURL.split(separator: "/").last.map(String.init) ?? identifier
    guard arxivBase(canonicalID) == arxivBase(identifier) else {
        throw WorkerFailure.network("official arXiv metadata identity did not match the requested paper")
    }

    var pdfComponents = URLComponents()
    pdfComponents.scheme = "https"
    pdfComponents.host = "arxiv.org"
    pdfComponents.path = "/pdf/\(identifier).pdf"
    guard let pdfURL = pdfComponents.url else { throw WorkerFailure.invalidRequest("invalid arXiv identifier") }
    var pdfRequest = URLRequest(url: pdfURL)
    pdfRequest.setValue("LiteverseLocalWorker/\(workerVersion)", forHTTPHeaderField: "User-Agent")
    pdfRequest.setValue("application/pdf", forHTTPHeaderField: "Accept")
    let downloaded = directory.appendingPathComponent("downloaded-source.pdf")
    let response = try synchronousDownload(pdfRequest, to: downloaded, timeout: timeout)
    try validatePDF(downloaded)
    let downloadedAttributes = try FileManager.default.attributesOfItem(atPath: downloaded.path)
    guard (downloadedAttributes[.size] as? NSNumber)?.uint64Value ?? 0 <= 512 * 1_024 * 1_024 else {
        throw WorkerFailure.network("arXiv PDF exceeded the local worker size limit")
    }
    if let contentType = response.value(forHTTPHeaderField: "Content-Type"),
       !contentType.lowercased().contains("pdf") && !contentType.lowercased().contains("octet-stream") {
        throw WorkerFailure.network("arXiv download did not advertise PDF content")
    }
    return (
        downloaded,
        SourceMetadata(
            title: title,
            authors: delegate.authors,
            arxivID: canonicalID,
            doi: delegate.doi,
            officialURL: canonicalURL,
            published: delegate.published,
            updated: delegate.updated,
            metadataStatus: "official_verified"
        )
    )
}

private func localMetadata(from document: PDFDocument, request: SourceRequest, url: URL) -> SourceMetadata {
    let attributes = document.documentAttributes ?? [:]
    let embeddedTitle = attributes[PDFDocumentAttribute.titleAttribute] as? String
    let embeddedAuthor = attributes[PDFDocumentAttribute.authorAttribute] as? String
    let title = [request.title, embeddedTitle]
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first(where: { !$0.isEmpty }) ?? url.deletingPathExtension().lastPathComponent
    var authors = request.authors
    if authors.isEmpty, let embeddedAuthor, !embeddedAuthor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        authors = embeddedAuthor.contains(";")
            ? embeddedAuthor.split(separator: ";").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            : [embeddedAuthor.trimmingCharacters(in: .whitespacesAndNewlines)]
    }
    return SourceMetadata(
        title: title,
        authors: authors,
        arxivID: nil,
        doi: request.doi,
        officialURL: nil,
        published: nil,
        updated: nil,
        metadataStatus: "provisional"
    )
}

private func readExistingPapers(at supportDirectory: URL) throws -> [ExistingPaper] {
    let indexURL = supportDirectory.appendingPathComponent("Knowledge/papers.json")
    guard FileManager.default.fileExists(atPath: indexURL.path) else { return [] }
    let data = try Data(contentsOf: indexURL, options: [.mappedIfSafe])
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let entries = root["papers"] as? [[String: Any]] else {
        throw WorkerFailure.invalidSource("refusing an invalid Knowledge/papers.json index")
    }
    return entries.compactMap { raw in
        let source = raw["source"] as? [String: Any]
        guard let paperID = (raw["paperId"] ?? raw["id"]) as? String, !paperID.isEmpty else { return nil }
        let authors = (raw["authors"] as? [Any] ?? []).compactMap { $0 as? String }
        return ExistingPaper(
            paperID: paperID,
            title: raw["title"] as? String ?? "",
            authors: authors,
            sha256: (raw["sha256"] as? String) ?? (source?["sha256"] as? String),
            arxivBase: arxivBase((raw["arxivBase"] as? String) ?? (raw["arxivId"] as? String) ?? (source?["arxivId"] as? String)),
            doi: normalizeDOI((raw["doi"] as? String) ?? (source?["doi"] as? String))
        )
    }
}

private func catalogFingerprint(at supportDirectory: URL) throws -> String {
    let indexURL = supportDirectory.appendingPathComponent("Knowledge/papers.json")
    guard FileManager.default.fileExists(atPath: indexURL.path) else { return "absent" }
    return try sha256File(indexURL)
}

private func duplicateSummary(_ paper: ExistingPaper) -> [String: Any] {
    [
        "paperId": paper.paperID,
        "title": paper.title,
        "authors": paper.authors,
        "sha256": nullable(paper.sha256),
        "arxivBase": nullable(paper.arxivBase),
        "doi": nullable(paper.doi),
    ]
}

private func titleAuthorKey(title: String, authors: [String]) -> String? {
    let titleKey = normalizedText(title)
    let authorKey = authors.map { normalizedText($0) }.filter { !$0.isEmpty }.sorted().joined(separator: "|")
    guard !titleKey.isEmpty, !authorKey.isEmpty else { return nil }
    return "\(titleKey)::\(authorKey)"
}

private func slug(_ value: String) -> String {
    let transliterated = value.applyingTransform(.toLatin, reverse: false)?.applyingTransform(.stripDiacritics, reverse: false) ?? value
    let lowered = transliterated.lowercased()
    let candidate = lowered.replacingOccurrences(of: #"[^a-z0-9]+"#, with: "-", options: .regularExpression)
        .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    let limited = String(candidate.prefix(72)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return limited.isEmpty ? "paper" : limited
}

private func choosePaperID(requested: String?, metadata: SourceMetadata, sourceHash: String, existing: [ExistingPaper]) -> String {
    let base: String
    if let requested {
        base = requested
    } else if let arxiv = arxivBase(metadata.arxivID) {
        base = slug("arxiv-\(arxiv)")
    } else {
        base = slug(metadata.title)
    }
    let existingIDs = Set(existing.map(\.paperID))
    if !existingIDs.contains(base) { return base }
    return "\(base)-\(sourceHash.prefix(8))"
}

private func yaml(_ value: Any?) -> String {
    guard let value else { return "null" }
    if value is NSNull { return "null" }
    if let string = value as? String {
        let data = try? JSONSerialization.data(withJSONObject: [string])
        let encoded = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(encoded.dropFirst().dropLast())
    }
    if JSONSerialization.isValidJSONObject(value),
       let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]),
       let encoded = String(data: data, encoding: .utf8) {
        return encoded
    }
    if let number = value as? NSNumber { return number.stringValue }
    return "null"
}

private func fulltextHeader(
    paperID: String,
    metadata: SourceMetadata,
    sourceKind: String,
    sourceHash: String,
    extractionStatus: String,
    verificationStatus: String,
    libraryItemID: String?,
    libraryItemRevision: Int?
) -> String {
    [
        "---",
        "paper_id: \(yaml(paperID))",
        "title: \(yaml(metadata.title))",
        "authors: \(yaml(metadata.authors))",
        "metadata_status: \(yaml(metadata.metadataStatus))",
        "source_type: \(yaml(sourceKind))",
        "source_sha256: \(yaml(sourceHash))",
        "arxiv_id: \(yaml(metadata.arxivID))",
        "doi: \(yaml(metadata.doi))",
        "extraction_status: \(yaml(extractionStatus))",
        "extraction_engine: \(yaml("pdfkit"))",
        "extraction_warning_count: 0",
        "verification_status: \(yaml(verificationStatus))",
        "library_item_id: \(yaml(libraryItemID))",
        "library_item_revision: \(yaml(libraryItemRevision))",
        "annotation_revisions: []",
        "---",
        "",
        "# \(metadata.title)",
        "",
        "",
    ].joined(separator: "\n")
}

private func cardMarkdown(
    paperID: String,
    metadata: SourceMetadata,
    sourceKind: String,
    sourceHash: String,
    extractionStatus: String,
    verificationStatus: String,
    libraryItemID: String?,
    libraryItemRevision: Int?
) -> String {
    var lines = [
        "---",
        "paper_id: \(yaml(paperID))",
        "title: \(yaml(metadata.title))",
        "authors: \(yaml(metadata.authors))",
        "metadata_status: \(yaml(metadata.metadataStatus))",
        "source_type: \(yaml(sourceKind))",
        "source_sha256: \(yaml(sourceHash))",
        "arxiv_id: \(yaml(metadata.arxivID))",
        "doi: \(yaml(metadata.doi))",
        "pdf_path: \(yaml("Library/PDFs/\(paperID).pdf"))",
        "fulltext_path: \(yaml("Knowledge/fulltext/\(paperID).md"))",
        "extraction_status: \(yaml(extractionStatus))",
        "extraction_engine: \(yaml("pdfkit"))",
        "extraction_warning_count: 0",
        "verification_status: \(yaml(verificationStatus))",
        "card_schema_version: liteverse-card-v1",
        "evidence_count: 0",
        "library_item_id: \(yaml(libraryItemID))",
        "library_item_revision: \(yaml(libraryItemRevision))",
        "annotation_revisions: []",
        "primary_category: null",
        "secondary_category: null",
        "classification_status: provisional",
        "tags: []",
        "---",
        "",
        "# \(metadata.title)",
        "",
        "## Research question",
        "",
        "- TODO: Read the original text and add evidence-backed content.",
        "",
        "## Methods",
        "",
        "- TODO: Identify methods with evidence locators.",
        "",
        "## Equations and conventions",
        "",
        "- TODO: Record definitions, units, and conventions before comparing papers.",
        "",
        "## Main results",
        "",
        "- TODO: Record only results supported by the original text.",
        "",
        "## Limitations",
        "",
        "- TODO: Record stated and evidence-backed limitations.",
        "",
        "## Project role",
        "",
        "- TODO: Keep project relevance separate from scientific relationship strength.",
        "",
        "## Evidence index",
        "",
        "- TODO: Add entries such as `E1 — p. 3, Sec. 2 — faithful paraphrase`.",
        "",
        "## Annotation provenance",
        "",
        "- Integrated annotations: none.",
        "- On integration, append `<!-- liteverse-annotation-provenance: {\"annotationId\":\"<id>\",\"sourceRevision\":<positive-integer>} -->`.",
    ]
    if extractionStatus == "needs_ocr" {
        lines.append(contentsOf: ["", "> Extraction status: needs OCR. Do not complete this card from the filename or title alone."])
    }
    return lines.joined(separator: "\n") + "\n"
}

private func appendFile(_ source: URL, to handle: FileHandle) throws {
    let input = try FileHandle(forReadingFrom: source)
    defer { try? input.close() }
    while true {
        let data = try input.read(upToCount: 1_048_576) ?? Data()
        if data.isEmpty { break }
        try handle.write(contentsOf: data)
    }
}

private func writeFulltext(prefix: String, body: URL, destination: URL) throws {
    let directory = destination.deletingLastPathComponent()
    let temporary = directory.appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).tmp")
    FileManager.default.createFile(atPath: temporary.path, contents: nil)
    let handle = try FileHandle(forWritingTo: temporary)
    do {
        try handle.write(contentsOf: Data(prefix.utf8))
        try appendFile(body, to: handle)
        try handle.synchronize()
        try handle.close()
        if Darwin.rename(temporary.path, destination.path) != 0 {
            throw WorkerFailure.filesystem("could not publish full-text Markdown")
        }
        try syncDirectory(directory)
    } catch {
        try? handle.close()
        try? FileManager.default.removeItem(at: temporary)
        throw error
    }
}

private func appendRoutingCandidate(_ candidate: RoutingCandidate, to values: inout [RoutingCandidate], cap: Int) {
    guard values.count < cap else { return }
    let key = normalizedText(candidate.text)
    guard !key.isEmpty, !values.contains(where: { normalizedText($0.text) == key }) else { return }
    values.append(candidate)
}

private func headingCandidate(_ line: String, page: Int) -> RoutingCandidate? {
    let text = collapsedWhitespace(line)
    guard text.count >= 3, text.count <= 120 else { return nil }
    let words = text.split(whereSeparator: { $0.isWhitespace })
    guard words.count <= 14 else { return nil }
    let punctuation = CharacterSet(charactersIn: ".?!;")
    if let last = text.unicodeScalars.last, punctuation.contains(last) { return nil }

    let canonical = text.trimmingCharacters(in: CharacterSet(charactersIn: ":")).lowercased()
    var signals: [String] = []
    if commonSectionHeadings.contains(canonical) { signals.append("common_section_heading") }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    if numberedHeadingExpression.firstMatch(in: text, range: range) != nil { signals.append("numbered_heading") }
    let letters = text.unicodeScalars.filter { CharacterSet.letters.contains($0) }
    let uppercaseLetters = letters.filter { CharacterSet.uppercaseLetters.contains($0) }
    if letters.count >= 3 && letters.count == uppercaseLetters.count { signals.append("uppercase_heading") }
    guard !signals.isEmpty else { return nil }
    return RoutingCandidate(page: page, text: text, signals: signals.sorted())
}

private func equationCandidate(_ line: String, page: Int) -> RoutingCandidate? {
    let text = collapsedWhitespace(line)
    guard text.count >= 3, text.count <= 180, !text.lowercased().contains("http") else { return nil }
    let operators = ["=", "≈", "∝", "≤", "≥", "∫", "∑", "∇", "±"]
    let signals = operators.filter { text.contains($0) }.map { "operator:\($0)" }
    guard !signals.isEmpty,
          text.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) else { return nil }
    return RoutingCandidate(page: page, text: text, signals: signals.sorted())
}

private func routingSentences(_ text: String) -> [String] {
    var values: [String] = []
    var buffer = ""
    func flush() {
        let candidate = collapsedWhitespace(buffer)
        if !candidate.isEmpty { values.append(candidate) }
        buffer = ""
    }
    for character in text {
        if character == "\n" || character == "\r" {
            if !buffer.isEmpty && !(buffer.last?.isWhitespace ?? false) { buffer.append(" ") }
            continue
        }
        buffer.append(character)
        if character == "." || character == "!" || character == "?" { flush() }
    }
    flush()
    return values
}

private func routingSignals(in sentence: String, from vocabulary: [String]) -> [String] {
    let lowered = sentence.lowercased()
    return vocabulary.filter { lowered.contains($0) }.sorted()
}

private func collectRoutingCandidates(
    from pageText: String,
    page: Int,
    sectionHeadings: inout [RoutingCandidate],
    equationLikeLines: inout [RoutingCandidate],
    methodSentences: inout [RoutingCandidate],
    resultSentences: inout [RoutingCandidate],
    limitationSentences: inout [RoutingCandidate]
) {
    for rawLine in pageText.components(separatedBy: .newlines) {
        if let candidate = headingCandidate(rawLine, page: page) {
            appendRoutingCandidate(candidate, to: &sectionHeadings, cap: routingCaps.sectionHeadings)
        }
        if let candidate = equationCandidate(rawLine, page: page) {
            appendRoutingCandidate(candidate, to: &equationLikeLines, cap: routingCaps.equationLikeLines)
        }
    }

    for sentence in routingSentences(pageText) {
        guard sentence.count >= 40, sentence.count <= 360 else { continue }
        let wordCount = sentence.split(whereSeparator: { $0.isWhitespace }).count
        guard wordCount >= 6, wordCount <= 60 else { continue }
        let methodSignals = routingSignals(in: sentence, from: methodRoutingSignals)
        if !methodSignals.isEmpty {
            appendRoutingCandidate(
                RoutingCandidate(page: page, text: sentence, signals: methodSignals),
                to: &methodSentences,
                cap: routingCaps.methodSentences
            )
        }
        let resultSignals = routingSignals(in: sentence, from: resultRoutingSignals)
        if !resultSignals.isEmpty {
            appendRoutingCandidate(
                RoutingCandidate(page: page, text: sentence, signals: resultSignals),
                to: &resultSentences,
                cap: routingCaps.resultSentences
            )
        }
        let limitationSignals = routingSignals(in: sentence, from: limitationRoutingSignals)
        if !limitationSignals.isEmpty {
            appendRoutingCandidate(
                RoutingCandidate(page: page, text: sentence, signals: limitationSignals),
                to: &limitationSentences,
                cap: routingCaps.limitationSentences
            )
        }
    }
}

private func extractPages(from document: PDFDocument, bodyURL: URL) throws -> ExtractionSummary {
    guard document.pageCount > 0 else { throw WorkerFailure.invalidSource("PDF contains no pages") }
    FileManager.default.createFile(atPath: bodyURL.path, contents: nil)
    let handle = try FileHandle(forWritingTo: bodyURL)
    var meaningfulCharacters = 0
    var sectionHeadings: [RoutingCandidate] = []
    var equationLikeLines: [RoutingCandidate] = []
    var methodSentences: [RoutingCandidate] = []
    var resultSentences: [RoutingCandidate] = []
    var limitationSentences: [RoutingCandidate] = []
    do {
        for pageIndex in 0..<document.pageCount {
            let text: String = autoreleasepool {
                (document.page(at: pageIndex)?.string ?? "").replacingOccurrences(of: "\0", with: "")
            }
            meaningfulCharacters += text.unicodeScalars.reduce(0) { count, scalar in
                CharacterSet.whitespacesAndNewlines.contains(scalar) ? count : count + 1
            }
            collectRoutingCandidates(
                from: text,
                page: pageIndex + 1,
                sectionHeadings: &sectionHeadings,
                equationLikeLines: &equationLikeLines,
                methodSentences: &methodSentences,
                resultSentences: &resultSentences,
                limitationSentences: &limitationSentences
            )
            let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let pageBody = cleaned.isEmpty ? "[No extractable text on this page.]" : cleaned
            let section = "<!-- page: \(pageIndex + 1) -->\n\n\(pageBody)\n\n"
            try handle.write(contentsOf: Data(section.utf8))
        }
        try handle.synchronize()
        try handle.close()
    } catch {
        try? handle.close()
        throw error
    }
    return ExtractionSummary(
        pageCount: document.pageCount,
        meaningfulCharacters: meaningfulCharacters,
        sectionHeadings: sectionHeadings,
        equationLikeLines: equationLikeLines,
        methodSentences: methodSentences,
        resultSentences: resultSentences,
        limitationSentences: limitationSentences
    )
}

private func reviewPacket(
    paperID: String,
    metadata: SourceMetadata,
    sourceHash: String,
    itemID: String,
    itemRevision: Int,
    extractionStatus: String,
    extraction: ExtractionSummary
) -> [String: Any] {
    [
        "schemaVersion": "liteverse-review-packet-v1",
        "paperId": paperID,
        "itemId": itemID,
        "itemRevision": itemRevision,
        "sourceSha256": sourceHash,
        "status": "provisional",
        "purpose": "routing_only",
        "canonicalMetadata": [
            "title": metadata.title,
            "authors": metadata.authors,
            "arxivId": nullable(metadata.arxivID),
            "doi": nullable(metadata.doi),
            "metadataStatus": metadata.metadataStatus,
        ],
        "pageCount": extraction.pageCount,
        "extractionStatus": extractionStatus,
        "sectionHeadingCandidates": extraction.sectionHeadings.map(\.json),
        "equationLikeLineCandidates": extraction.equationLikeLines.map(\.json),
        "sentenceCandidates": [
            "methods": extraction.methodSentences.map(\.json),
            "results": extraction.resultSentences.map(\.json),
            "limitations": extraction.limitationSentences.map(\.json),
        ],
        "caps": [
            "sectionHeadings": routingCaps.sectionHeadings,
            "equationLikeLines": routingCaps.equationLikeLines,
            "methodSentences": routingCaps.methodSentences,
            "resultSentences": routingCaps.resultSentences,
            "limitationSentences": routingCaps.limitationSentences,
        ],
        "guardrails": [
            "originalSourceEvidence": false,
            "verifiedClaims": false,
            "relationStrength": false,
            "classification": false,
            "writesGraph": false,
            "writesUsage": false,
            "writesResearchMemory": false,
        ],
    ]
}

private func artifact(role: String, relativePath: String, in directory: URL) throws -> ArtifactRecord {
    let url = directory.appendingPathComponent(relativePath)
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return ArtifactRecord(
        role: role,
        relativePath: relativePath,
        sha256: try sha256File(url),
        size: (attributes[.size] as? NSNumber)?.uint64Value ?? 0
    )
}

private func publishResult(directory: URL, pipeline: URL, manifest: [String: Any]) throws -> [String: Any] {
    let manifestURL = directory.appendingPathComponent("manifest.json")
    let manifestData = try jsonData(manifest)
    try atomicWrite(manifestData, to: manifestURL)
    try syncDirectory(directory)
    try syncDirectory(pipeline)
    return manifest
}

private func runMaterialize(_ job: JobRequest) throws -> [String: Any] {
    let fileManager = FileManager.default
    let pipeline = job.supportDirectory.appendingPathComponent("Work/LocalPipeline", isDirectory: true)
    try fileManager.createDirectory(at: pipeline, withIntermediateDirectories: true)
    let lock = try WorkerLock(at: pipeline.appendingPathComponent(".worker.lock"))
    defer { withExtendedLifetime(lock) {} }

    let liveCatalogFingerprint = try catalogFingerprint(at: job.supportDirectory)
    guard liveCatalogFingerprint == job.catalogFingerprint else {
        throw WorkerFailure.invalidRequest("catalogFingerprint does not match the current Knowledge/papers.json bytes")
    }
    let existing = try readExistingPapers(at: job.supportDirectory)

    let final = pipeline.appendingPathComponent(job.jobID, isDirectory: true)
    if fileManager.fileExists(atPath: final.path) {
        let publishedManifest = final.appendingPathComponent("manifest.json")
        if fileManager.fileExists(atPath: publishedManifest.path) {
            throw WorkerFailure.invalidRequest("jobId already has an immutable local pipeline result")
        }
        try fileManager.removeItem(at: final)
    }
    try fileManager.createDirectory(at: final, withIntermediateDirectories: false)
    var shouldRemoveResult = true
    defer {
        if shouldRemoveResult { try? fileManager.removeItem(at: final) }
    }

    let sourceURL: URL
    var metadata: SourceMetadata
    if job.source.kind == "arxiv" {
        let identifier = try parseArxiv(job.source.arxiv ?? "")
        (sourceURL, metadata) = try fetchArxiv(identifier, timeout: job.timeoutSeconds, into: final)
    } else {
        sourceURL = URL(fileURLWithPath: job.source.path ?? "").standardizedFileURL
        try validatePDF(sourceURL)
        guard let document = PDFDocument(url: sourceURL) else {
            throw WorkerFailure.invalidSource("PDFKit could not open the local PDF")
        }
        metadata = localMetadata(from: document, request: job.source, url: sourceURL)
    }
    try validatePDF(sourceURL)
    let sourceHash = try sha256File(sourceURL)
    guard let document = PDFDocument(url: sourceURL) else {
        throw WorkerFailure.invalidSource("PDFKit could not open the PDF")
    }

    let identityArxiv = arxivBase(metadata.arxivID)
    let identityDOI = normalizeDOI(metadata.doi)
    var matched: [String: Set<String>] = [:]
    for paper in existing {
        if paper.sha256?.lowercased() == sourceHash { matched[paper.paperID, default: []].insert("sha256") }
        if let identityArxiv, paper.arxivBase == identityArxiv { matched[paper.paperID, default: []].insert("arxiv_id") }
        if let identityDOI, paper.doi == identityDOI { matched[paper.paperID, default: []].insert("doi") }
    }
    let possibleKey = titleAuthorKey(title: metadata.title, authors: metadata.authors)
    let possibleDuplicates = existing.filter { paper in
        guard let possibleKey else { return false }
        return titleAuthorKey(title: paper.title, authors: paper.authors) == possibleKey && matched[paper.paperID] == nil
    }
    let requestHash = sha256(job.requestData)
    let strictKeys: [String: Any] = [
        "sha256": sourceHash,
        "arxivBase": nullable(identityArxiv),
        "doi": nullable(identityDOI),
    ]
    let baseManifest: [String: Any] = [
        "schemaVersion": resultSchemaVersion,
        "jobSchemaVersion": jobSchemaVersion,
        "workerVersion": workerVersion,
        "jobId": job.jobID,
        "itemId": job.itemID,
        "itemRevision": job.itemRevision,
        "catalogFingerprint": job.catalogFingerprint,
        "operation": "materialize",
        "createdAt": utcTimestamp(),
        "requestSha256": requestHash,
        "sourceSha256": sourceHash,
        "canonicalMetadata": [
            "kind": job.source.kind,
            "title": metadata.title,
            "authors": metadata.authors,
            "arxivId": nullable(metadata.arxivID),
            "doi": nullable(identityDOI),
            "officialUrl": nullable(metadata.officialURL),
            "published": nullable(metadata.published),
            "updated": nullable(metadata.updated),
            "metadataStatus": metadata.metadataStatus,
        ],
        "duplicateOf": NSNull(),
        "extractionStatus": NSNull(),
        "outputs": [],
        "screeningCandidates": [],
        "deduplication": [
            "strictKeys": strictKeys,
            "possibleTitleAuthorMatches": possibleDuplicates.map(duplicateSummary),
        ],
        "guardrails": [
            "writesGraphCurrent": false,
            "writesUsage": false,
            "writesResearchMemory": false,
            "promotesKnowledgeArtifacts": false,
            "downloadsSuggestedLiterature": false,
        ],
    ]

    if matched.count > 1 {
        if sourceURL.deletingLastPathComponent().standardizedFileURL == final.standardizedFileURL {
            try? fileManager.removeItem(at: sourceURL)
        }
        var manifest = baseManifest
        manifest["state"] = "needs_attention"
        manifest["preparation"] = ["state": "needs_attention", "reason": "conflicting_duplicate_keys"]
        manifest["deduplication"] = [
            "strictKeys": strictKeys,
            "conflicts": matched.keys.sorted().map { paperID in
                ["paperId": paperID, "matchedBy": Array(matched[paperID] ?? []).sorted()]
            },
            "possibleTitleAuthorMatches": possibleDuplicates.map(duplicateSummary),
        ]
        let response = try publishResult(directory: final, pipeline: pipeline, manifest: manifest)
        shouldRemoveResult = false
        return response
    }

    if let duplicateID = matched.keys.first, let duplicate = existing.first(where: { $0.paperID == duplicateID }) {
        if sourceURL.deletingLastPathComponent().standardizedFileURL == final.standardizedFileURL {
            try? fileManager.removeItem(at: sourceURL)
        }
        var manifest = baseManifest
        manifest["state"] = "duplicate"
        manifest["preparation"] = ["state": "ready", "disposition": "duplicate"]
        manifest["duplicateOf"] = duplicateSummary(duplicate)
        manifest["deduplication"] = [
            "strictKeys": strictKeys,
            "duplicate": duplicateSummary(duplicate),
            "matchedBy": Array(matched[duplicateID] ?? []).sorted(),
            "possibleTitleAuthorMatches": possibleDuplicates.map(duplicateSummary),
        ]
        let response = try publishResult(directory: final, pipeline: pipeline, manifest: manifest)
        shouldRemoveResult = false
        return response
    }

    let paperID = choosePaperID(requested: job.requestedPaperID, metadata: metadata, sourceHash: sourceHash, existing: existing)
    let preservedSource = final.appendingPathComponent("source.pdf")
    if sourceURL.standardizedFileURL != preservedSource.standardizedFileURL {
        try durableCopy(from: sourceURL, to: preservedSource)
    }
    if sourceURL.deletingLastPathComponent().standardizedFileURL == final.standardizedFileURL,
       sourceURL.standardizedFileURL != preservedSource.standardizedFileURL {
        try fileManager.removeItem(at: sourceURL)
    }
    let bodyURL = final.appendingPathComponent(".fulltext-body.tmp")
    let extraction = try extractPages(from: document, bodyURL: bodyURL)
    let extractionStatus = extraction.meaningfulCharacters >= max(80, extraction.pageCount * 10) ? "extracted" : "needs_ocr"
    let verificationStatus = extractionStatus == "needs_ocr" ? "needs_ocr" : "card_draft"
    let fulltextURL = final.appendingPathComponent("fulltext.md")
    try writeFulltext(
        prefix: fulltextHeader(
            paperID: paperID,
            metadata: metadata,
            sourceKind: job.source.kind,
            sourceHash: sourceHash,
            extractionStatus: extractionStatus,
            verificationStatus: verificationStatus,
            libraryItemID: job.itemID,
            libraryItemRevision: job.itemRevision
        ),
        body: bodyURL,
        destination: fulltextURL
    )
    try fileManager.removeItem(at: bodyURL)
    let cardURL = final.appendingPathComponent("card.md")
    try atomicWrite(Data(cardMarkdown(
        paperID: paperID,
        metadata: metadata,
        sourceKind: job.source.kind,
        sourceHash: sourceHash,
        extractionStatus: extractionStatus,
        verificationStatus: verificationStatus,
        libraryItemID: job.itemID,
        libraryItemRevision: job.itemRevision
    ).utf8), to: cardURL)
    let reviewPacketURL = final.appendingPathComponent("review-packet.json")
    try atomicWrite(try jsonData(reviewPacket(
        paperID: paperID,
        metadata: metadata,
        sourceHash: sourceHash,
        itemID: job.itemID,
        itemRevision: job.itemRevision,
        extractionStatus: extractionStatus,
        extraction: extraction
    )), to: reviewPacketURL)
    let artifacts = try [
        artifact(role: "pdf", relativePath: "source.pdf", in: final),
        artifact(role: "fulltext", relativePath: "fulltext.md", in: final),
        artifact(role: "card", relativePath: "card.md", in: final),
        artifact(role: "review_packet", relativePath: "review-packet.json", in: final),
    ]
    var manifest = baseManifest
    manifest["state"] = extractionStatus == "needs_ocr" ? "needs_attention" : "ready"
    manifest["extractionStatus"] = extractionStatus
    manifest["preparation"] = [
        "state": extractionStatus == "needs_ocr" ? "needs_attention" : "ready",
        "reason": extractionStatus == "needs_ocr" ? "needs_ocr" : nullable(Optional<String>.none),
    ]
    manifest["paper"] = [
        "paperId": paperID,
        "title": metadata.title,
        "authors": metadata.authors,
        "sourceType": job.source.kind,
        "metadataStatus": metadata.metadataStatus,
        "sha256": sourceHash,
        "arxivId": nullable(metadata.arxivID),
        "arxivBase": nullable(identityArxiv),
        "doi": nullable(identityDOI),
        "pdfPath": "Library/PDFs/\(paperID).pdf",
        "fulltextPath": "Knowledge/fulltext/\(paperID).md",
        "cardPath": "Knowledge/cards/\(paperID).md",
        "extractionStatus": extractionStatus,
        "extractionEngine": "pdfkit",
        "pageCount": extraction.pageCount,
        "verificationStatus": verificationStatus,
        "classificationStatus": "provisional",
        "cardSchemaVersion": "liteverse-card-v1",
        "evidenceCount": 0,
        "libraryItemId": job.itemID,
        "libraryItemRevision": job.itemRevision,
    ]
    manifest["outputs"] = artifacts.map(\.json)
    manifest["suggestedDestinations"] = [
        "source.pdf": "Library/PDFs/\(paperID).pdf",
        "fulltext.md": "Knowledge/fulltext/\(paperID).md",
        "card.md": "Knowledge/cards/\(paperID).md",
    ]
    let response = try publishResult(directory: final, pipeline: pipeline, manifest: manifest)
    shouldRemoveResult = false
    return response
}

private func writeResponse(_ value: [String: Any], to handle: FileHandle) {
    if let data = try? jsonData(value) { try? handle.write(contentsOf: data) }
}

@main
private struct LiteverseLocalWorker {
    static func main() {
        let arguments = CommandLine.arguments
        if arguments.count == 2 && arguments[1] == "--version" {
            print("LiteverseLocalWorker \(workerVersion)")
            return
        }
        do {
            let requestData: Data
            if arguments.count == 1 {
                requestData = FileHandle.standardInput.readDataToEndOfFile()
            } else if arguments.count == 3, arguments[1] == "--request" {
                requestData = try Data(contentsOf: URL(fileURLWithPath: arguments[2]), options: [.mappedIfSafe])
            } else {
                throw WorkerFailure.invalidRequest("usage: send one liteverse-local-job-v1 object on stdin")
            }
            guard !requestData.isEmpty else {
                throw WorkerFailure.invalidRequest("stdin did not contain a job request")
            }
            guard requestData.count <= 1_024 * 1_024 else {
                throw WorkerFailure.invalidRequest("job request exceeded the one-megabyte limit")
            }
            let job = try parseJob(data: requestData)
            let response = try runMaterialize(job)
            writeResponse(response, to: .standardOutput)
        } catch {
            writeResponse([
                "schemaVersion": "liteverse-local-error-v1",
                "state": "error",
                "error": String(describing: error),
            ], to: .standardError)
            Darwin.exit(2)
        }
    }
}

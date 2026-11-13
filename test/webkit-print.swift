// Prints HTML files through WebKit's print path, the one Safari's print dialog uses, and writes the
// text a reader copies from each PDF. Used by test/run.js; macOS only.
// Usage: swiftc -O webkit-print.swift -o webkit-print && ./webkit-print <file.html>...
//   writes <file>.webkit.pdf and <file>.webkit.txt beside each file; exits non-zero on any failure.
import AppKit
import PDFKit
import WebKit

let files = CommandLine.arguments.dropFirst().map { URL(fileURLWithPath: $0) }

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

class Printer: NSObject, WKNavigationDelegate {
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 1000), styleMask: [.titled], backing: .buffered, defer: false)
  let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 1000))
  var index = 0
  var deadline: DispatchWorkItem?

  override init() {
    super.init()
    window.contentView = web
    web.navigationDelegate = self
  }

  var current: URL { files[index] }
  func output(_ ext: String) -> URL { current.deletingPathExtension().appendingPathExtension("webkit.\(ext)") }

  func next() {
    guard index < files.count else { exit(0) }
    deadline?.cancel()
    let item = DispatchWorkItem { fail("timed out printing \(self.current.path)") }
    deadline = item
    DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: item)
    web.loadFileURL(current, allowingReadAccessTo: URL(fileURLWithPath: "/"))
  }

  func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
    // Start every font loading and wait, as a page printing a document should.
    let js = "await Promise.allSettled([...document.fonts].map((f) => f.load())); await document.fonts.ready; return true"
    web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { _ in self.print() }
  }

  func webView(_ web: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("\(current.path): \(error)") }
  func webView(_ web: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("\(current.path): \(error)") }
  func webViewWebContentProcessDidTerminate(_ web: WKWebView) { fail("WebKit crashed printing \(current.path)") }

  func print() {
    let info = NSPrintInfo.shared.copy() as! NSPrintInfo
    info.jobDisposition = .save
    info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = output("pdf")
    let operation = web.printOperation(with: info)
    operation.showsPrintPanel = false
    operation.showsProgressPanel = false
    operation.view?.frame = web.bounds
    operation.runModal(for: window, delegate: self, didRun: #selector(printed(_:success:contextInfo:)), contextInfo: nil)
  }

  @objc func printed(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
    guard success, let pdf = PDFDocument(url: output("pdf")) else { fail("could not print \(current.path)") }
    do { try (pdf.string ?? "").write(to: output("txt"), atomically: true, encoding: .utf8) } catch { fail("\(error)") }
    index += 1
    next()
  }
}

let app = NSApplication.shared
let printer = Printer()
printer.next()
app.run()

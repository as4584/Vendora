import ExpoModulesCore
import UIKit
import VisionKit

/// Live box scanner: Apple VisionKit DataScannerViewController reading the
/// barcode and the printed label text at the same time, streaming what it
/// sees to JS. Everything runs on the phone: no network, no outside service.
///
/// Needs iOS 16+ and an A12 chip or newer (iPhone XS/XR and later). JS must
/// call `isLiveScanAvailable()` first and fall back to tap-to-read when false.
/// UIView subclasses are main-actor isolated, so every method here runs on
/// the main thread.
@available(iOS 16.0, *)
final class LiveScannerView: ExpoView, DataScannerViewControllerDelegate {
  /// `{ lines: [String], barcodes: [String] }`, top-to-bottom reading order.
  let onLines = EventDispatcher()
  /// `{ code: "unsupported" | "permission" | "unavailable" | "start_failed", message: String }`
  let onScanError = EventDispatcher()

  private var scanner: DataScannerViewController?
  private var active = true
  private var lastEmit = Date.distantPast
  private static let minEmitInterval: TimeInterval = 0.12

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
  }

  func setActive(_ value: Bool) {
    active = value
    if value {
      startIfPossible()
    } else {
      stop()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scanner?.view.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      // Dismissed: stop the camera and detach.
      stop()
      detach()
    } else {
      startIfPossible()
    }
  }

  // MARK: - Scanner lifecycle

  private func startIfPossible() {
    guard active, window != nil else { return }
    guard DataScannerViewController.isSupported else {
      onScanError(["code": "unsupported", "message": "Live scanning needs an iPhone XS/XR or newer."])
      return
    }
    guard DataScannerViewController.isAvailable else {
      // False when camera access is denied or restricted.
      onScanError(["code": "permission", "message": "Allow camera access in Settings to scan boxes."])
      return
    }
    let controller = scanner ?? makeScanner()
    if controller.isScanning { return }
    do {
      try controller.startScanning()
    } catch {
      onScanError(["code": "start_failed", "message": error.localizedDescription])
    }
  }

  private func makeScanner() -> DataScannerViewController {
    let controller = DataScannerViewController(
      recognizedDataTypes: [.barcode(), .text()],
      qualityLevel: .accurate,
      recognizesMultipleItems: true,
      isHighFrameRateTrackingEnabled: false,
      isPinchToZoomEnabled: true,
      isGuidanceEnabled: false,
      isHighlightingEnabled: true
    )
    controller.delegate = self
    if let parent = LiveScannerView.parentViewController(of: self) {
      parent.addChild(controller)
      controller.view.frame = bounds
      addSubview(controller.view)
      controller.didMove(toParent: parent)
    } else {
      controller.view.frame = bounds
      addSubview(controller.view)
    }
    scanner = controller
    return controller
  }

  private func stop() {
    if let controller = scanner, controller.isScanning {
      controller.stopScanning()
    }
  }

  private func detach() {
    guard let controller = scanner else { return }
    controller.delegate = nil
    controller.willMove(toParent: nil)
    controller.view.removeFromSuperview()
    controller.removeFromParent()
    scanner = nil
  }

  private static func parentViewController(of view: UIView) -> UIViewController? {
    var responder: UIResponder? = view
    while let next = responder?.next {
      if let controller = next as? UIViewController {
        return controller
      }
      responder = next
    }
    return nil
  }

  // MARK: - Streaming results

  private func emit(_ allItems: [RecognizedItem], force: Bool) {
    let now = Date()
    if !force && now.timeIntervalSince(lastEmit) < LiveScannerView.minEmitInterval { return }
    lastEmit = now

    // Reading order: top-to-bottom, then left-to-right (view coordinates,
    // origin top-left).
    let sorted = allItems.sorted { a, b in
      let pa = a.bounds.topLeft
      let pb = b.bounds.topLeft
      if abs(pa.y - pb.y) > 12 { return pa.y < pb.y }
      return pa.x < pb.x
    }
    var lines: [String] = []
    var barcodes: [String] = []
    for item in sorted {
      switch item {
      case .text(let text):
        let transcript = text.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if !transcript.isEmpty {
          // A text item can span several printed lines.
          lines.append(contentsOf: transcript.components(separatedBy: .newlines))
        }
      case .barcode(let barcode):
        if let payload = barcode.payloadStringValue, !payload.isEmpty {
          barcodes.append(payload)
        }
      @unknown default:
        break
      }
    }
    onLines(["lines": lines, "barcodes": barcodes])
  }

  func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    emit(allItems, force: true)
  }

  func dataScanner(_ dataScanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    emit(allItems, force: false)
  }

  func dataScanner(_ dataScanner: DataScannerViewController, didRemove removedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    emit(allItems, force: false)
  }

  func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
    onScanError(["code": "unavailable", "message": "Live scanning stopped. Use Read label instead."])
  }
}

import ExpoModulesCore
import UIKit
import Vision
import VisionKit

/// Reads the printed text on a shoebox / product label with Apple Vision.
/// Everything runs on the phone: no network, no outside service.
public class LabelReaderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LabelReader")

    Constant("isAvailable") { true }

    /// True when the live VisionKit scanner can run: A12+ chip and camera
    /// access not denied. DataScannerViewController is main-actor isolated,
    /// so its class properties are read on the main actor.
    AsyncFunction("isLiveScanAvailable") { () async -> Bool in
      return await MainActor.run {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
      }
    }

    /// Live scanner view (see LiveScannerView.swift).
    View(LiveScannerView.self) {
      Events("onLines", "onScanError")

      Prop("active") { (view: LiveScannerView, active: Bool) in
        view.setActive(active)
      }
    }

    AsyncFunction("recognize") { (uri: String, promise: Promise) in
      guard let image = LabelReaderModule.loadImage(uri), let cgImage = image.cgImage else {
        promise.reject("E_IMAGE", "Could not open the label photo.")
        return
      }

      let request = VNRecognizeTextRequest { request, error in
        if let error = error {
          promise.reject("E_VISION", error.localizedDescription)
          return
        }
        let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
        // Top-to-bottom, then left-to-right (Vision's origin is bottom-left).
        let sorted = observations.sorted { a, b in
          if abs(a.boundingBox.midY - b.boundingBox.midY) > 0.02 {
            return a.boundingBox.midY > b.boundingBox.midY
          }
          return a.boundingBox.minX < b.boundingBox.minX
        }
        let lines: [String] = sorted.compactMap { $0.topCandidates(1).first?.string }
        promise.resolve(lines)
      }
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = false

      let handler = VNImageRequestHandler(
        cgImage: cgImage,
        orientation: LabelReaderModule.orientation(image.imageOrientation),
        options: [:]
      )
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          try handler.perform([request])
        } catch {
          promise.reject("E_VISION", error.localizedDescription)
        }
      }
    }
  }

  private static func loadImage(_ uri: String) -> UIImage? {
    let url: URL?
    if uri.hasPrefix("file://") {
      url = URL(string: uri)
    } else {
      url = URL(fileURLWithPath: uri)
    }
    guard let fileUrl = url, let data = try? Data(contentsOf: fileUrl) else { return nil }
    return UIImage(data: data)
  }

  private static func orientation(_ o: UIImage.Orientation) -> CGImagePropertyOrientation {
    switch o {
    case .up: return .up
    case .down: return .down
    case .left: return .left
    case .right: return .right
    case .upMirrored: return .upMirrored
    case .downMirrored: return .downMirrored
    case .leftMirrored: return .leftMirrored
    case .rightMirrored: return .rightMirrored
    @unknown default: return .up
    }
  }
}

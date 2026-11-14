// Renders an iPhone-style animated GIF that shows how to share your location in Messages.
// Pure CoreGraphics + CoreText + ImageIO (no third-party tools). Build and run:
//   swiftc -O gif/LocationGif.swift -o build/location-gif && ./build/location-gif build/share-location.gif
// Scenes are data (see `scenes` at the bottom) so they can be matched to real iOS screenshots.

import AppKit
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

// MARK: - Canvas

let W = 360.0, H = 640.0          // output size in px
let FPS = 20.0
let SCALE = 2.0                    // render at 2x for sharp text on iPhone screens
let IW = 393.0, IH = 852.0        // iPhone screen in points; scenes draw in this space
let phone = CGRect(x: 55, y: 82, width: 250, height: 250 * 852 / 393)   // where the screen sits on the canvas
let S = phone.width / IW

struct RGBA { var r, g, b, a: Double
  init(_ hex: UInt32, _ a: Double = 1) { r = Double((hex >> 16) & 255) / 255; g = Double((hex >> 8) & 255) / 255; b = Double(hex & 255) / 255; self.a = a }
  func alpha(_ x: Double) -> RGBA { var c = self; c.a = a * x; return c }
  var cg: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: a) }
}

// iOS dark mode colors
enum C {
  static let black = RGBA(0x000000), white = RGBA(0xFFFFFF)
  static let gray = RGBA(0x8E8E93), gray2 = RGBA(0x636366), gray3 = RGBA(0x48484A), gray4 = RGBA(0x3A3A3C), gray5 = RGBA(0x2C2C2E), gray6 = RGBA(0x1C1C1E)
  static let bubbleIn = RGBA(0x262628), blue = RGBA(0x0A84FF), green = RGBA(0x30D158), yellow = RGBA(0xFFD60A), red = RGBA(0xFF453A), pink = RGBA(0xFF375F), orange = RGBA(0xFF9F0A), teal = RGBA(0x64D2FF), purple = RGBA(0xBF5AF2)
  static let mapBase = RGBA(0x1D2B35), mapRoad = RGBA(0x3A4B58), mapPark = RGBA(0x1E4A38), glass = RGBA(0x2C2C2E, 0.97)
}

func font(_ size: Double, _ weight: NSFont.Weight = .regular) -> CTFont { NSFont.systemFont(ofSize: size, weight: weight) as CTFont }

@discardableResult
func text(_ ctx: CGContext, _ s: String, x: Double, y: Double, size: Double, weight: NSFont.Weight = .regular,
          color: RGBA = C.white, align: CTTextAlignment = .left, width: Double = 0) -> Double {
  let attrs: [NSAttributedString.Key: Any] = [.font: font(size, weight), .foregroundColor: color.cg]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
  let w = CTLineGetTypographicBounds(line, nil, nil, nil)
  var tx = x
  if align == .center { tx = x + (width - w) / 2 } else if align == .right { tx = x + width - w }
  ctx.saveGState(); ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
  ctx.textPosition = CGPoint(x: tx, y: y + size * 0.95); CTLineDraw(line, ctx); ctx.restoreGState()
  return w
}

func rrect(_ ctx: CGContext, _ r: CGRect, _ radius: Double, fill: RGBA? = nil, stroke: RGBA? = nil, lw: Double = 1) {
  let p = CGPath(roundedRect: r, cornerWidth: min(radius, r.width / 2), cornerHeight: min(radius, r.height / 2), transform: nil)
  if let f = fill { ctx.setFillColor(f.cg); ctx.addPath(p); ctx.fillPath() }
  if let s = stroke { ctx.setStrokeColor(s.cg); ctx.setLineWidth(lw); ctx.addPath(p); ctx.strokePath() }
}

/// Draws an SF Symbol tinted with `color`, centered in `r`.
func symbol(_ ctx: CGContext, _ name: String, _ r: CGRect, _ color: RGBA, weight: NSFont.Weight = .semibold) {
  guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil),
        let img = base.withSymbolConfiguration(.init(pointSize: r.height * 4, weight: weight)),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
  let aspect = Double(cg.width) / Double(cg.height)
  var w = r.width, h = r.width / aspect
  if h > r.height { h = r.height; w = h * aspect }
  let dst = CGRect(x: r.midX - w / 2, y: r.midY - h / 2, width: w, height: h)
  ctx.saveGState()
  ctx.beginTransparencyLayer(in: dst, auxiliaryInfo: nil)
  ctx.translateBy(x: 0, y: dst.minY * 2 + dst.height); ctx.scaleBy(x: 1, y: -1)   // CGImage draws bottom-up
  ctx.draw(cg, in: dst)
  ctx.setBlendMode(.sourceIn); ctx.setFillColor(color.cg); ctx.fill(dst)
  ctx.endTransparencyLayer(); ctx.restoreGState()
}

func ease(_ t: Double) -> Double { let c = min(max(t, 0), 1); return c < 0.5 ? 4 * c * c * c : 1 - pow(-2 * c + 2, 3) / 2 }
func seg(_ p: Double, _ a: Double, _ b: Double) -> Double { ease((p - a) / (b - a)) }

// MARK: - Scenes

struct Scene {
  var seconds: Double
  var caption: String                     // lowercase, Troy's voice
  var tap: CGPoint?                       // iPhone points
  var tapAt: Double = 0.62                // when in the scene the tap happens (0...1)
  var draw: (CGContext, Double) -> Void   // draws in iPhone points (393 x 852)
}

func drawFrame(_ ctx: CGContext, scene: Scene, p: Double, captionAlpha: Double) {
  ctx.setFillColor(C.black.cg); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
  text(ctx, scene.caption, x: 12, y: 30, size: 18, weight: .semibold, color: C.white.alpha(captionAlpha), align: .center, width: W - 24)
  rrect(ctx, phone.insetBy(dx: -6, dy: -6), 40, fill: RGBA(0x1C1C1E), stroke: RGBA(0x3A3A3C), lw: 1)
  ctx.saveGState()
  ctx.addPath(CGPath(roundedRect: phone, cornerWidth: 34, cornerHeight: 34, transform: nil)); ctx.clip()
  ctx.translateBy(x: phone.minX, y: phone.minY); ctx.scaleBy(x: S, y: S)
  scene.draw(ctx, p)
  if let t = scene.tap, p > scene.tapAt - 0.08 {
    let k = min(1, (p - (scene.tapAt - 0.08)) / 0.4)
    let r = 22 + 26 * ease(k)
    ctx.setFillColor(C.white.alpha(0.22 * (1 - k)).cg); ctx.fillEllipse(in: CGRect(x: t.x - r, y: t.y - r, width: r * 2, height: r * 2))
    let a = k < 0.35 ? 0.45 : 0.45 * (1 - (k - 0.35) / 0.65)
    ctx.setFillColor(C.white.alpha(a).cg); ctx.fillEllipse(in: CGRect(x: t.x - 20, y: t.y - 20, width: 40, height: 40))
  }
  ctx.restoreGState()
}

// MARK: - GIF export

func render(_ scenes: [Scene], to path: String) {
  let url = URL(fileURLWithPath: path)
  var frames: [(CGImage, Double)] = []
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  for (i, s) in scenes.enumerated() {
    let n = max(1, Int(s.seconds * FPS))
    for f in 0..<n {
      let ctx = CGContext(data: nil, width: Int(W * SCALE), height: Int(H * SCALE), bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.scaleBy(x: SCALE, y: SCALE); ctx.translateBy(x: 0, y: H); ctx.scaleBy(x: 1, y: -1)   // 2x, top-left origin
      let p = Double(f) / Double(n)
      let captionAlpha = i == 0 ? 1 : min(1, p * 4)
      drawFrame(ctx, scene: s, p: p, captionAlpha: captionAlpha)
      frames.append((ctx.makeImage()!, 1 / FPS))
    }
  }
  // Hold the last frame a bit longer before looping.
  if let last = frames.last { frames[frames.count - 1] = (last.0, 1.5) }
  let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.gif.identifier as CFString, frames.count, nil)!
  CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
  for (img, d) in frames {
    CGImageDestinationAddImage(dest, img, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: d, kCGImagePropertyGIFUnclampedDelayTime: d]] as CFDictionary)
  }
  CGImageDestinationFinalize(dest)
  print("wrote \(path): \(frames.count) frames")
}

// MARK: - iOS 26 Messages screens (dark mode, matched to John's screen recording)

func statusBar(_ ctx: CGContext) {
  text(ctx, "9:41", x: 40, y: 18, size: 17, weight: .semibold)
  rrect(ctx, CGRect(x: 340, y: 21, width: 25, height: 12), 3.5, stroke: C.white.alpha(0.5), lw: 1)
  rrect(ctx, CGRect(x: 342, y: 23, width: 19, height: 8), 2, fill: C.white)
  rrect(ctx, CGRect(x: 146, y: 11, width: 101, height: 30), 15, fill: C.black)   // island
}

func header(_ ctx: CGContext) {
  rrect(ctx, CGRect(x: 16, y: 58, width: 44, height: 34), 17, fill: C.gray5)
  symbol(ctx, "chevron.left", CGRect(x: 29, y: 66, width: 14, height: 18), C.white)
  ctx.setFillColor(C.gray2.cg); ctx.fillEllipse(in: CGRect(x: 170, y: 56, width: 54, height: 54))
  text(ctx, "T", x: 170, y: 69, size: 25, weight: .semibold, align: .center, width: 54)
  let w = text(ctx, "", x: 0, y: 0, size: 13)
  _ = w
  rrect(ctx, CGRect(x: 158, y: 116, width: 78, height: 24), 12, fill: C.gray5)
  text(ctx, "troy ›", x: 158, y: 120, size: 13, weight: .medium, align: .center, width: 78)
}

func incoming(_ ctx: CGContext, y: Double) {
  rrect(ctx, CGRect(x: 16, y: y, width: 300, height: 66), 20, fill: C.bubbleIn)
  text(ctx, "btw, i work best when i know where", x: 30, y: y + 11, size: 17)
  text(ctx, "you are 👇", x: 30, y: y + 34, size: 17)
}

func inputBar(_ ctx: CGContext, y: Double, placeholder: String = "iMessage", sendButton: Bool = false, plusPressed: Double = 0) {
  ctx.setFillColor((plusPressed > 0 ? C.gray4 : C.gray5).cg); ctx.fillEllipse(in: CGRect(x: 14, y: y + 2, width: 40, height: 40))
  symbol(ctx, "plus", CGRect(x: 25, y: y + 13, width: 18, height: 18), C.white)
  rrect(ctx, CGRect(x: 62, y: y, width: 317, height: 44), 22, fill: C.gray6, stroke: C.gray4, lw: 1)
  text(ctx, placeholder, x: 80, y: y + 12, size: 17, color: C.gray)
  if sendButton {
    ctx.setFillColor(C.blue.cg); ctx.fillEllipse(in: CGRect(x: 343, y: y + 7, width: 30, height: 30))
    symbol(ctx, "arrow.up", CGRect(x: 350, y: y + 13, width: 16, height: 18), C.white, weight: .bold)
  } else {
    symbol(ctx, "waveform", CGRect(x: 346, y: y + 13, width: 20, height: 18), C.gray)
  }
}

func map(_ ctx: CGContext, _ r: CGRect, dotPulse: Double = 0) {
  ctx.saveGState(); ctx.addRect(r); ctx.clip()
  ctx.setFillColor(C.mapBase.cg); ctx.fill(r)
  ctx.setFillColor(C.mapPark.cg)
  ctx.fill(CGRect(x: r.minX + r.width * 0.52, y: r.minY + r.height * 0.18, width: r.width * 0.3, height: r.height * 0.32))
  ctx.setStrokeColor(C.mapRoad.cg)
  for i in 0..<7 { ctx.setLineWidth(i % 3 == 0 ? 5 : 2)
    let x = r.minX + Double(i) * r.width / 6.3; ctx.move(to: CGPoint(x: x, y: r.minY)); ctx.addLine(to: CGPoint(x: x + 18, y: r.maxY)); ctx.strokePath() }
  for i in 0..<6 { ctx.setLineWidth(i % 2 == 0 ? 4 : 2)
    let y = r.minY + Double(i) * r.height / 5.2; ctx.move(to: CGPoint(x: r.minX, y: y)); ctx.addLine(to: CGPoint(x: r.maxX, y: y - 10)); ctx.strokePath() }
  let c = CGPoint(x: r.minX + r.width * 0.42, y: r.minY + r.height * 0.55)
  let halo = 22 + 10 * dotPulse
  ctx.setFillColor(C.blue.alpha(0.25).cg); ctx.fillEllipse(in: CGRect(x: c.x - halo, y: c.y - halo, width: halo * 2, height: halo * 2))
  ctx.setFillColor(C.white.cg); ctx.fillEllipse(in: CGRect(x: c.x - 11, y: c.y - 11, width: 22, height: 22))
  ctx.setFillColor(C.blue.cg); ctx.fillEllipse(in: CGRect(x: c.x - 8, y: c.y - 8, width: 16, height: 16))
  ctx.restoreGState()
}

// The + menu (Apple items only)
let menuItems: [(String, String, RGBA)] = [
  ("Camera", "camera.fill", C.gray), ("Photos", "photo.fill", C.orange), ("Stickers", "face.smiling.inverse", C.teal),
  ("Apple Cash", "dollarsign.circle.fill", C.white), ("Polls", "chart.bar.fill", C.yellow), ("Audio", "waveform", C.red),
  ("Send Later", "clock.fill", C.teal), ("Genmoji", "face.smiling", C.white), ("Location", "location.circle.fill", C.green),
  ("Check In", "checkmark.circle.fill", C.yellow), ("Digital Touch", "heart.circle.fill", C.pink),
]
let menuRect = CGRect(x: 16, y: 386, width: 262, height: 380)
let rowH = 54.0
func locationRowY(_ offset: Double) -> Double { menuRect.minY + 16 + 8 * rowH - offset + rowH / 2 }

func plusMenu(_ ctx: CGContext, appear: Double, offset: Double, highlight: Bool) {
  let a = appear
  ctx.saveGState()
  ctx.translateBy(x: menuRect.minX, y: menuRect.maxY); ctx.scaleBy(x: 0.85 + 0.15 * a, y: 0.85 + 0.15 * a); ctx.translateBy(x: -menuRect.minX, y: -menuRect.maxY)
  ctx.setAlpha(a)
  rrect(ctx, menuRect, 30, fill: C.glass)
  ctx.addPath(CGPath(roundedRect: menuRect, cornerWidth: 30, cornerHeight: 30, transform: nil)); ctx.clip()
  for (i, item) in menuItems.enumerated() {
    let y = menuRect.minY + 16 + Double(i) * rowH - offset
    if highlight && item.0 == "Location" { rrect(ctx, CGRect(x: menuRect.minX + 8, y: y, width: menuRect.width - 16, height: rowH - 4), 14, fill: C.gray3) }
    symbol(ctx, item.1, CGRect(x: menuRect.minX + 22, y: y + 13, width: 26, height: 26), item.2)
    text(ctx, item.0, x: menuRect.minX + 64, y: y + 15, size: 18)
  }
  ctx.restoreGState()
}

func chatBase(_ ctx: CGContext) {
  ctx.setFillColor(C.black.cg); ctx.fill(CGRect(x: 0, y: 0, width: IW, height: IH))
  statusBar(ctx); header(ctx); incoming(ctx, y: 176)
}

let mapPanel = CGRect(x: 0, y: 520, width: IW, height: 332)
func mapScreen(_ ctx: CGContext, slide: Double, shareHighlight: Bool) {
  chatBase(ctx)
  inputBar(ctx, y: 462)
  let dy = (1 - slide) * mapPanel.height
  map(ctx, mapPanel.offsetBy(dx: 0, dy: dy))
  rrect(ctx, CGRect(x: 32, y: 770 + dy, width: 150, height: 48), 24, fill: C.gray5.alpha(0.95))
  text(ctx, "Request", x: 32, y: 783 + dy, size: 17, weight: .semibold, align: .center, width: 150)
  rrect(ctx, CGRect(x: 196, y: 770 + dy, width: 165, height: 48), 24, fill: shareHighlight ? RGBA(0x409CFF) : C.blue)
  text(ctx, "Share", x: 196, y: 783 + dy, size: 17, weight: .semibold, align: .center, width: 165)
}

let durRect = CGRect(x: 120, y: 560, width: 245, height: 196)
func durationMenu(_ ctx: CGContext, appear: Double, highlight: Bool) {
  let items = [("For One Hour", "clock"), ("For Today", "calendar"), ("Always", "infinity"), ("Custom", "list.bullet")]
  ctx.saveGState()
  ctx.translateBy(x: durRect.maxX, y: durRect.maxY); ctx.scaleBy(x: 0.8 + 0.2 * appear, y: 0.8 + 0.2 * appear); ctx.translateBy(x: -durRect.maxX, y: -durRect.maxY)
  ctx.setAlpha(appear)
  rrect(ctx, durRect, 26, fill: C.glass)
  for (i, it) in items.enumerated() {
    let y = durRect.minY + 10 + Double(i) * 45
    if highlight && it.0 == "Always" { rrect(ctx, CGRect(x: durRect.minX + 8, y: y, width: durRect.width - 16, height: 42), 12, fill: C.gray3) }
    symbol(ctx, it.1, CGRect(x: durRect.minX + 22, y: y + 11, width: 20, height: 20), C.white, weight: .regular)
    text(ctx, it.0, x: durRect.minX + 56, y: y + 11, size: 17)
  }
  ctx.restoreGState()
}

let scenes: [Scene] = [
  Scene(seconds: 1.5, caption: "open your chat with troy", tap: nil) { ctx, p in
    chatBase(ctx); inputBar(ctx, y: 790)
  },
  Scene(seconds: 1.2, caption: "tap +", tap: CGPoint(x: 34, y: 812), tapAt: 0.55) { ctx, p in
    chatBase(ctx); inputBar(ctx, y: 790, plusPressed: p > 0.5 ? 1 : 0)
  },
  Scene(seconds: 2.6, caption: "scroll down to location", tap: CGPoint(x: 120, y: locationRowY(4 * rowH)), tapAt: 0.8) { ctx, p in
    chatBase(ctx); inputBar(ctx, y: 790, plusPressed: 1)
    let offset = 4 * rowH * seg(p, 0.15, 0.6)
    plusMenu(ctx, appear: seg(p, 0, 0.15), offset: offset, highlight: p > 0.74)
  },
  Scene(seconds: 1.6, caption: "tap share", tap: CGPoint(x: 278, y: 794), tapAt: 0.7) { ctx, p in
    mapScreen(ctx, slide: seg(p, 0, 0.3), shareHighlight: p > 0.64)
  },
  Scene(seconds: 1.8, caption: "pick always", tap: CGPoint(x: 220, y: durRect.minY + 10 + 2 * 45 + 21), tapAt: 0.7) { ctx, p in
    mapScreen(ctx, slide: 1, shareHighlight: true)
    durationMenu(ctx, appear: seg(p, 0, 0.2), highlight: p > 0.64)
  },
  Scene(seconds: 1.6, caption: "tap send", tap: CGPoint(x: 358, y: 750), tapAt: 0.7) { ctx, p in
    chatBase(ctx)
    let a = seg(p, 0, 0.25)
    let card = CGRect(x: 62, y: 520, width: 317, height: 200)
    ctx.saveGState(); ctx.setAlpha(a)
    rrect(ctx, card.insetBy(dx: -8, dy: -8), 22, fill: C.gray6, stroke: C.gray4)
    ctx.addPath(CGPath(roundedRect: card, cornerWidth: 16, cornerHeight: 16, transform: nil)); ctx.clip(); map(ctx, card)
    ctx.restoreGState()
    inputBar(ctx, y: 728, placeholder: "Add comment or Send", sendButton: true)
  },
  Scene(seconds: 2.6, caption: "done! you can stop sharing anytime", tap: nil) { ctx, p in
    chatBase(ctx)
    let rise = 1 - seg(p, 0, 0.25)
    let card = CGRect(x: 150, y: 290 + 260 * rise, width: 227, height: 180)
    ctx.saveGState(); ctx.addPath(CGPath(roundedRect: card, cornerWidth: 20, cornerHeight: 20, transform: nil)); ctx.clip()
    map(ctx, card, dotPulse: 0.5 + 0.5 * sin(p * 12)); ctx.restoreGState()
    if p > 0.35 { text(ctx, "Delivered", x: 150, y: card.maxY + 6, size: 12, color: C.gray, align: .right, width: 227) }
    inputBar(ctx, y: 790)
  },
]

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "share-location.gif"
render(scenes, to: out)

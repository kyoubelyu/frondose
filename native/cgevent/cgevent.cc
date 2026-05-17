// P-32: in-house macOS CGEvent N-API addon. Posts real OS-level mouse/keyboard
// events (CoreGraphics Quartz `CGEvent`) so input is indistinguishable from
// physical hardware. 8 exported functions. No dynamic allocation beyond the
// CGEventRef/CGEventSourceRef objects (each CFRelease'd). No network, no
// filesystem, no system()/exec*.
//
// CONCERN-2: every function that indexes `info[]` guards `info.Length()` first
// and throws a catchable JS TypeError — `NAPI_DISABLE_CPP_EXCEPTIONS` means an
// out-of-bounds `info[N]` access is C++ UB (process crash), not a JS error.
// CONCERN-1: `unicodeType` extracts UTF-16 via `Napi::String::Utf16Value` and
// iterates per UTF-16 code unit (correct for BMP + SMP surrogate pairs).
#include <napi.h>
#include <ApplicationServices/ApplicationServices.h>
#include <string>

// moveMouse(x, y) — absolute logical-point cursor position.
Napi::Value MoveMouse(const Napi::CallbackInfo& info) {
  if (info.Length() < 2) {
    Napi::TypeError::New(info.Env(), "moveMouse(x, y): expected 2 args")
      .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  double x = info[0].As<Napi::Number>().DoubleValue();
  double y = info[1].As<Napi::Number>().DoubleValue();
  CGEventRef ev = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGPointMake(x, y), kCGMouseButtonLeft);
  CGEventPost(kCGSessionEventTap, ev);
  CFRelease(ev);
  return info.Env().Undefined();
}

// mouseClick() — left down + up at the current cursor location.
Napi::Value MouseClick(const Napi::CallbackInfo& info) {
  CGEventRef cur = CGEventCreate(NULL);
  CGPoint pos = CGEventGetLocation(cur);
  CFRelease(cur);
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, pos, kCGMouseButtonLeft);
  CGEventPost(kCGSessionEventTap, down);
  CFRelease(down);
  CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, pos, kCGMouseButtonLeft);
  CGEventPost(kCGSessionEventTap, up);
  CFRelease(up);
  return info.Env().Undefined();
}

// scrollWheel(dx, dy) — pixel-unit scroll; dy is the vertical axis (axis 1).
Napi::Value ScrollWheel(const Napi::CallbackInfo& info) {
  if (info.Length() < 2) {
    Napi::TypeError::New(info.Env(), "scrollWheel(dx, dy): expected 2 args")
      .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  int32_t dx = info[0].As<Napi::Number>().Int32Value();
  int32_t dy = info[1].As<Napi::Number>().Int32Value();
  CGEventRef ev = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, dy, dx);
  CGEventPost(kCGSessionEventTap, ev);
  CFRelease(ev);
  return info.Env().Undefined();
}

// keyEvent(keyCode, down, flags) — a single key-down or key-up with modifiers.
Napi::Value KeyEvent(const Napi::CallbackInfo& info) {
  if (info.Length() < 3) {
    Napi::TypeError::New(info.Env(), "keyEvent(keyCode, down, flags): expected 3 args")
      .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  CGKeyCode keyCode = (CGKeyCode)info[0].As<Napi::Number>().Uint32Value();
  bool down = info[1].As<Napi::Boolean>().Value();
  uint64_t flags = (uint64_t)info[2].As<Napi::Number>().Int64Value();
  CGEventRef ev = CGEventCreateKeyboardEvent(NULL, keyCode, down);
  CGEventSetFlags(ev, (CGEventFlags)flags);
  CGEventPost(kCGSessionEventTap, ev);
  CFRelease(ev);
  return info.Env().Undefined();
}

// unicodeType(text) — type a string by posting one keyboard event per UTF-16
// code unit. CONCERN-1: UTF-16 extraction; `len` is the UniChar count.
// Consecutive surrogate code units are posted in order — macOS text input
// combines a high+low surrogate pair into the SMP glyph.
Napi::Value UnicodeType(const Napi::CallbackInfo& info) {
  if (info.Length() < 1) {
    Napi::TypeError::New(info.Env(), "unicodeType(text): expected 1 arg")
      .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  // CONCERN-1: extract the UTF-16 representation (NOT UTF-8); `str.size()` is
  // the UniChar / UTF-16 code-unit count. Iterating per char16_t posts a
  // high+low surrogate pair in order for SMP code points.
  std::u16string str = info[0].As<Napi::String>().Utf16Value();
  for (size_t i = 0; i < str.size(); i++) {
    UniChar ch = (UniChar)str[i];
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
    CGEventKeyboardSetUnicodeString(down, 1, &ch);
    CGEventPost(kCGSessionEventTap, down);
    CFRelease(down);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
    CGEventKeyboardSetUnicodeString(up, 1, &ch);
    CGEventPost(kCGSessionEventTap, up);
    CFRelease(up);
  }
  return info.Env().Undefined();
}

// getMousePos() — current cursor location → { x, y }.
Napi::Value GetMousePos(const Napi::CallbackInfo& info) {
  CGEventRef cur = CGEventCreate(NULL);
  CGPoint pos = CGEventGetLocation(cur);
  CFRelease(cur);
  Napi::Object out = Napi::Object::New(info.Env());
  out.Set("x", Napi::Number::New(info.Env(), pos.x));
  out.Set("y", Napi::Number::New(info.Env(), pos.y));
  return out;
}

// getScreenSize() — main display pixel dimensions → { width, height }.
Napi::Value GetScreenSize(const Napi::CallbackInfo& info) {
  CGDirectDisplayID main = CGMainDisplayID();
  Napi::Object out = Napi::Object::New(info.Env());
  out.Set("width", Napi::Number::New(info.Env(), (double)CGDisplayPixelsWide(main)));
  out.Set("height", Napi::Number::New(info.Env(), (double)CGDisplayPixelsHigh(main)));
  return out;
}

// isAccessibilityTrusted() — AXIsProcessTrusted(); the OQ-3 permission check.
Napi::Value IsAccessibilityTrusted(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), AXIsProcessTrusted());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("moveMouse", Napi::Function::New(env, MoveMouse));
  exports.Set("mouseClick", Napi::Function::New(env, MouseClick));
  exports.Set("scrollWheel", Napi::Function::New(env, ScrollWheel));
  exports.Set("keyEvent", Napi::Function::New(env, KeyEvent));
  exports.Set("unicodeType", Napi::Function::New(env, UnicodeType));
  exports.Set("getMousePos", Napi::Function::New(env, GetMousePos));
  exports.Set("getScreenSize", Napi::Function::New(env, GetScreenSize));
  exports.Set("isAccessibilityTrusted", Napi::Function::New(env, IsAccessibilityTrusted));
  return exports;
}

NODE_API_MODULE(cgevent, Init)

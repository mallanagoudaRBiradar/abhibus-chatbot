# Trip chat in the AbhiBus apps: WebView plan

For the **iOS team (Swift)**, the **Android team (React Native)**, the **AbhiBus backend team** and us (the chat team).

**Decision:** the chat UI is a web app we host. Both apps show it full-screen in a WebView: `WKWebView` on iOS and `react-native-webview` on Android. There's one UI for both platforms, and fixes go live without an app store release.

> **Status: the web chat is built and tested.** `mobile/` runs in embedded mode inside a WebView, ships as a container (`mobile/Dockerfile.web`), and includes a test harness at `/harness/`. 14 end-to-end checks pass in headless Chrome against both bridge transports. The backend APIs are ready ([API_CURL.md](API_CURL.md)). What's left is the native screens on iOS and Android (sections 4–5).

## 1. How it fits together

```
 AbhiBus app (iOS Swift / Android React Native)
 ┌───────────────────────────────────────────────┐
 │ Booking screen ─ "Trip chat" button / push tap │
 │        │                                       │
 │        ▼  (1) ask AbhiBus backend for session  │──▶ AbhiBus backend ──▶ POST /v1/partner/chat-sessions
 │ Chat screen = full-screen WebView              │◀── { token, journey, me } ◀──────────┘
 │   (2) inject session + device info             │
 │   (3) load https://chat.abhibus.com            │──▶ static web chat (CDN)
 │   (4) web chat opens WebSocket ────────────────┼──▶ Journey Chat server (wss://…/ws)
 │   ◀── bridge messages (close, call, voice…) ──▶│
 └───────────────────────────────────────────────┘
```

The session token is **injected by the app before the page loads, never put in the URL**, so it stays out of logs and history.

## 2. Who builds what

| Team | Builds | Size |
|---|---|---|
| **Chat team (us)** | ✅ Done: embedded web build, bridge, container, harness. Left: deploy to staging/production and keep the harness on staging | — |
| **AbhiBus backend** | Push bookings, cancellations and modifications ([API_CURL.md](API_CURL.md) §1–5); an endpoint the app calls to open the chat (checks the user owns the PNR, calls `chat-sessions`); the `room.opened` push notification | ~1 week |
| **iOS (Swift)** | A chat screen with `WKWebView`, session injection, bridge handlers, the entry point and the deep link | ~1 week |
| **Android (React Native)** | A chat screen with `react-native-webview`, session injection, bridge handlers, hardware back, the entry point and the deep link | ~1 week |

All teams can work in parallel once the bridge contract (section 4) is agreed.

## 3. The embedded web build (done)

| Item | How it works |
|---|---|
| **Embedded mode** | `mobile/src/services/host.ts` detects the WebView (`window.webkit.messageHandlers.tripChat` on iOS, `window.ReactNativeWebView` on Android). There's no PNR join screen: the chat reads `window.__TRIPCHAT_BOOT__`, and back / chat ended hand control back with `close`. Nothing is stored in WebView storage; the app owns the session. |
| **Hosting** | `docker build -f mobile/Dockerfile.web`, then run with `API_URL=https://<chat API>` (nginx, port 8080). `/config.js` is written at start-up, so **one image serves every environment**. Bundle and assets are content-hashed and cached for a year; `index.html` is never cached, so a deploy reaches phones on the next open. |
| **Size** | First open is **710 KB** (was 1.25 MB): icon fonts subset to the icons used (1.6 MB → ~40 KB), text fonts subset to Latin, emoji keyboard loaded only when opened, everything pre-compressed. Measured: **8.9 s on a throttled ~750 kbps link**, about 1 s on 4G, then instant from cache. Preloading the WebView on the booking screen hides even the first open. |
| **Native features** | Voice, haptics, own-location share, calls and outside links go over the bridge. Each appears only if the app lists that capability: with no `voice`, the mic button is hidden; with no `call`, the `tel:` link is tried directly. |
| **Theme** | `theme` in the boot payload and the `theme` message. |
| **Safe areas** | Put the WebView **inside the safe area** (recommended). For an edge-to-edge WebView on iOS, the page uses `viewport-fit=cover` and CSS `env()` insets. |
| **Security** | A strict Content Security Policy (scripts only from the chat origin, connections only to the chat API), `Referrer-Policy: no-referrer`, and no third-party scripts. The harness is removed from the image unless `ENABLE_HARNESS=true`. |
| **QR guests** | The same build, opened in a normal browser, shows the guest join flow. |
| **Server** | Add the web origin (e.g. `https://chat.abhibus.com`) to the chat API's `CORS_ORIGINS`. |

**Test harness (staging):** `https://<web host>/harness/` plays the app. It mints a session with the partner key, loads the chat in a phone frame, logs every bridge message, answers `locationRequest` / `voiceStart` / `sessionExpired` the way the app should, and has buttons for back, theme and background/foreground. **Use it as the reference implementation of the native side.**

## 4. Bridge contract (agree this first)

Every message: `{ "v": 1, "type": "...", "data": {...} }`

- **App to web:** iOS calls `webView.evaluateJavaScript("window.TripChat.receive(…)")`; Android calls `webViewRef.injectJavaScript("window.TripChat.receive(…)")`.
- **Web to app:** iOS uses `window.webkit.messageHandlers.tripChat.postMessage(msg)`; Android uses `window.ReactNativeWebView.postMessage(JSON.stringify(msg))`.

**Injected before the page loads:**
```js
window.__TRIPCHAT_BOOT__ = {
  v: 1,
  session: { token, journey, me, supportPhone },   // the chat-sessions response, unchanged
  deviceId,                                         // stable per install (same one sent to chat-sessions)
  platform: "ios" | "android", appVersion: "8.4.0",
  theme: "dark" | "light", locale: "en-IN",
  capabilities: ["call", "openExternal", "location", "voice", "haptics"]   // only what this app version supports
}
```

| Direction | `type` | `data` | When / what the other side does |
|---|---|---|---|
| web → app | `ready` | `{ hasSession }` | Page is up: hide the native spinner |
| web → app | `close` | `{ reason }`: `back` · `left` · `ended` · `removed` · `unauthorized` · `no_session` | Pop the chat screen |
| web → app | `call` | `{ number }` | Open the dialer (SOS 112, support). Needs `call` |
| web → app | `openExternal` | `{ url }` | Open in the system browser or Maps (location cards). Needs `openExternal` |
| web → app | `locationRequest` | `{}` | Reply with `location`. Needs `location`; repeated every ~10 s during a live share |
| web → app | `voiceStart` | `{ locale }`: `en-IN` · `hi-IN` · `te-IN` | Start speech-to-text. Needs `voice` |
| web → app | `voiceStop` | `{ cancel }` | `cancel:false` = finish and send the final text; `cancel:true` = discard |
| web → app | `haptic` | `{ style }`: `light` · `medium` · `heavy` · `success` · `warning` · `error` | Play haptic feedback. Needs `haptics` |
| web → app | `sessionExpired` | `{}` | Call chat-sessions again and reply with `session` within 10 s, or the chat shows "ended" |
| app → web | `session` | the chat-sessions response | Fresh session (after `sessionExpired`, or any time) |
| app → web | `location` | `{ lat, lng, accuracyM }` or `{ denied: true }` | Answer to `locationRequest` (within 15 s) |
| app → web | `voiceResult` | `{ text, final }` | Interim results (`final:false`) as you get them, then one `final:true` |
| app → web | `voiceEnd` | `{}` | Recognition stopped without a final result |
| app → web | `voiceError` | `{ error }`: `not-allowed` · `no-speech` · `language-not-supported` · `aborted` · other | The chat shows friendly copy |
| app → web | `appState` | `{ state: "active" \| "background" }` | Send on foreground/background; the chat reconnects immediately on `active` |
| app → web | `back` | `{}` | **Android hardware back:** the chat closes an open sheet or menu, or replies `close {reason:"back"}` |
| app → web | `theme` | `{ theme: "dark" \| "light" }` | System theme changed |

Unknown message types are ignored on both sides, so new ones can be added without breaking older apps.

## 5. Native checklist

| Topic | iOS (Swift, `WKWebView`) | Android (React Native, `react-native-webview`) |
| Layout | WebView inside the safe area | WebView inside the safe area |
|---|---|---|
| Inject the session | `WKUserScript`, `.atDocumentStart` | `injectedJavaScriptBeforeContentLoaded` |
| Receive messages | `WKScriptMessageHandler` named `tripChat` | `onMessage` |
| Navigation lock | `decidePolicyFor`: only `chat.abhibus.com`; anything else is cancelled | `originWhitelist` + `onShouldStartLoadWithRequest`: only `chat.abhibus.com` |
| Calls / links | `call` → `UIApplication.open(tel:)`; `openExternal` → `UIApplication.open(url)` | `call` → `Linking.openURL('tel:…')`; `openExternal` → `Linking.openURL(url)` |
| Back | Nav bar / swipe sends `back` | `BackHandler` sends `back` (don't pop directly) |
| Voice | `SFSpeechRecognizer` + mic/speech usage strings | A voice library (e.g. `@react-native-voice/voice`) + `RECORD_AUDIO` |
| Location | `CoreLocation` (When In Use) | `react-native-geolocation-service` + `ACCESS_FINE_LOCATION` |
| Keyboard | No zoom on input focus; check content insets | `android:windowSoftInputMode="adjustResize"` |
| Storage | Default persistent `WKWebsiteDataStore` | `domStorageEnabled`, cache on |
| **Device ID** | `identifierForVendor`, stored in the Keychain | A UUID in secure storage, created on first launch |
| Security | No file access; inspectable in debug only | `allowFileAccess={false}`; debugging in debug only |
| Lifecycle | `scenePhase` sends `appState` | `AppState` sends `appState` |
| Entry / push | Deep link `abhibus://trip-chat?pnr=&seat=` opens the chat screen | Same |

The **`deviceId` must come from the app, not web storage.** Seats are bound to the device, and WebView storage can be cleared. If it is, the passenger is locked out with `SEAT_CLAIMED`, and support has to release the seat.

## 5b. Reference code

Starting points that implement the contract. Fill in the `TODO`s with your app's own services. `CHAT_URL` is the web chat for the environment, e.g. `https://chat.abhibus.com/`.

**iOS (Swift, `WKWebView`)**
```swift
import UIKit
import WebKit

final class TripChatViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    private let chatURL = URL(string: "https://chat.abhibus.com/")!
    private let session: [String: Any]          // the chat-sessions response from your backend
    private var webView: WKWebView!

    init(session: [String: Any]) { self.session = session; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        let boot: [String: Any] = [
            "v": 1, "session": session, "deviceId": DeviceID.value,          // TODO: Keychain-backed id
            "platform": "ios", "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "",
            "theme": traitCollection.userInterfaceStyle == .dark ? "dark" : "light", "locale": "en-IN",
            "capabilities": ["call", "openExternal", "location", "haptics"], // add "voice" once wired
        ]
        let json = String(data: try! JSONSerialization.data(withJSONObject: boot), encoding: .utf8)!
        let config = WKWebViewConfiguration()
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__TRIPCHAT_BOOT__ = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "tripChat")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([                                       // inside the safe area
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        webView.load(URLRequest(url: chatURL))
    }

    /// chat → app
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.request.url?.host == chatURL.host,
              let msg = message.body as? [String: Any], let type = msg["type"] as? String else { return }
        let data = msg["data"] as? [String: Any] ?? [:]
        switch type {
        case "close": navigationController?.popViewController(animated: true)
        case "call":
            if let n = (data["number"] as? String)?.filter({ !$0.isWhitespace }), let url = URL(string: "tel:\(n)") { UIApplication.shared.open(url) }
        case "openExternal":
            if let s = data["url"] as? String, let url = URL(string: s) { UIApplication.shared.open(url) }
        case "haptic": UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case "locationRequest": break   // TODO: CoreLocation one-shot → send("location", ["lat":…, "lng":…, "accuracyM":…]) or ["denied": true]
        case "sessionExpired": break    // TODO: call your backend again → send("session", fresh)
        default: break                  // ready: hide your spinner
        }
    }

    /// app → chat
    func send(_ type: String, _ data: [String: Any] = [:]) {
        let json = String(data: try! JSONSerialization.data(withJSONObject: ["v": 1, "type": type, "data": data]), encoding: .utf8)!
        webView.evaluateJavaScript("window.TripChat && window.TripChat.receive(\(json))")
    }

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.host == chatURL.host ? .allow : .cancel)   // navigation lock
    }
}
```
Also send `appState` from `sceneDidBecomeActive` / `sceneWillResignActive`, and `theme` from `traitCollectionDidChange`.

**Android (React Native, `react-native-webview`)**
```tsx
import React, { useEffect, useRef } from 'react';
import { AppState, BackHandler, Linking, Vibration } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

const CHAT_URL = 'https://chat.abhibus.com/';

export function TripChatScreen({ session, deviceId, theme, onClose, renewSession }: {
  session: unknown; deviceId: string; theme: 'dark' | 'light'; onClose: () => void; renewSession: () => Promise<unknown>;
}) {
  const ref = useRef<WebView>(null);
  const boot = { v: 1, session, deviceId, platform: 'android', appVersion: '8.4.0', theme, locale: 'en-IN',
                 capabilities: ['call', 'openExternal', 'location', 'haptics'] };   // add 'voice' once wired
  const send = (type: string, data: object = {}) =>
    ref.current?.injectJavaScript(`window.TripChat && window.TripChat.receive(${JSON.stringify({ v: 1, type, data })}); true;`);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => { send('back'); return true; }); // the chat decides
    const app = AppState.addEventListener('change', (s) => send('appState', { state: s === 'active' ? 'active' : 'background' }));
    return () => { back.remove(); app.remove(); };
  }, []);

  const onMessage = async (e: WebViewMessageEvent) => {
    if (!e.nativeEvent.url.startsWith(CHAT_URL)) return;
    const { type, data = {} } = JSON.parse(e.nativeEvent.data);
    switch (type) {
      case 'close': onClose(); break;
      case 'call': Linking.openURL(`tel:${String(data.number).replace(/\s/g, '')}`); break;
      case 'openExternal': Linking.openURL(String(data.url)); break;
      case 'haptic': Vibration.vibrate(10); break;
      case 'locationRequest': /* TODO: one-shot GPS → send('location', { lat, lng, accuracyM }) or send('location', { denied: true }) */ break;
      case 'sessionExpired': send('session', await renewSession()); break;
    }
  };

  return (
    <WebView
      ref={ref}
      source={{ uri: CHAT_URL }}
      injectedJavaScriptBeforeContentLoaded={`window.__TRIPCHAT_BOOT__ = ${JSON.stringify(boot)}; true;`}
      onMessage={onMessage}
      originWhitelist={[CHAT_URL]}
      onShouldStartLoadWithRequest={(r) => r.url.startsWith(CHAT_URL)}   // navigation lock
      domStorageEnabled
      allowFileAccess={false}
      setSupportMultipleWindows={false}
    />
  );
}
```

## 6. Security rules

- The token is injected, never put in the URL. The partner API key lives on the AbhiBus backend only.
- The bridge accepts messages only from the `chat.abhibus.com` origin; the WebView can't navigate elsewhere.
- A Content Security Policy on the web chat: only our own scripts and API/WebSocket hosts.
- No third-party scripts or analytics SDKs inside the chat.

## 7. Decisions needed before starting

| # | Question | Suggestion |
|---|---|---|
| 1 | Where do the display name and avatar come from? (`chat-sessions` requires a profile) | The app sends the account's **first name**, with avatar `null`, at launch. In-chat editing later needs a small server addition. |
| 2 | Web domain | `chat.abhibus.com` (separate subdomain) |
| 3 | Room opening time | `CHAT_OPEN_BEFORE_START_MIN` = **30 or 45**. Pick one for launch (it's one server setting) |
| 4 | Minimum OS versions | Match the AbhiBus app (e.g. iOS 15+, Android 8+) |
| 5 | Voice-to-text at launch | Hide it in v1 if it would delay launch; the capability flag makes that free |

## 8. Timeline (about 5 weeks from here)

| Week | Chat team | Backend | iOS / Android |
|---|---|---|---|
| 1 | Deploy web chat + harness to staging; walk the mobile teams through the harness | Booking push (book/cancel/modify) on staging | Review the contract, try the harness |
| 2 | Support integration, fixes | Session endpoint, `room.opened` push | Build the WebView screen against staging |
| 3 | Device testing with the teams | GPS feed, deep links | Bridge handlers, back, voice, location, deep link |
| 4 | Device integration, fixes | End-to-end on staging | Device integration |
| 5 | **QA:** low-end Android, iOS 15–18, 2G, keyboard, background/foreground, SOS call, close flows | Monitoring | Fixes, release builds |
| 6 | **Pilot:** staff, then ~50 buses/day on 2–3 routes | Watch webhooks and support | Store release |

Then scale to all routes (2,000 a day) once these targets hold:
- crash-free sessions
- over 99% of sessions open without error
- chat visible in under 3 s on 4G and under 8 s on 2G

## 9. Test checklist (sign-off before the pilot)

- **Devices:** one low-end Android (2–3 GB RAM), one mid-range Android, an iPhone SE class, a recent iPhone.
- **Network:** 2G/3G throttled, airplane mode mid-chat, 30 s offline (tunnel), switching between Wi-Fi and mobile data.
- **Flows:** join and chat, women-only room (female and male seats), rest-stop timer, SOS calling 112, removed and chat-ended screens, app killed and reopened, push tap with the app closed, Android back in every sheet, seat released by support.

## 10. Risks

| Risk | Mitigation |
|---|---|
| WebView feels less smooth than native | Test on low-end Android in week 2; keep the size budget |
| The web updates but an old app lacks a bridge feature | Versioned bridge + capability flags |
| Slow first open on 2G | 710 KB first open (measured 8.9 s at ~750 kbps); preload the WebView on the booking screen; assets cached for a year |
| Seat lock-out after storage is cleared | Device ID from app secure storage; the support release endpoint |
| iOS and Android behave differently | One shared checklist; the test harness page is the reference |

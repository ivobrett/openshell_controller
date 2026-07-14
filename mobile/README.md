# OpenShell Control — Mobile App

A [Capacitor](https://capacitorjs.com) companion app for **Android** and **iOS**
that lets you control a self-hosted OpenShell Control server from your phone.

The app is a thin native shell around a mobile-first UI (`www/`). It does **not**
run the OpenShell backend — it connects over HTTPS to your existing dashboard
server (the Next.js app in the repository root) and drives it through the same
API the web dashboard uses.

## How it connects

Two connection modes, chosen on the first "Connect" screen:

| Mode | When to use | What you enter |
| --- | --- | --- |
| **Pangolin** | Server is exposed through a [Pangolin](https://fossorial.io) tunnel (recommended for remote access) | Server URL + Pangolin **access token** (the `?token=…` value from your resource share link) + operator password |
| **Direct URL** | Server is reachable directly (LAN, VPN, or your own reverse proxy) | Server URL + operator password |

### Security model

- The app authenticates with the dashboard's **operator password**
  (`OPENSHELL_CONTROL_PASSWORD`) and receives a signed **session token**.
- That token is stored on-device using
  [`@capacitor/preferences`](https://capacitorjs.com/docs/apis/preferences) and
  sent on every request as `Authorization: Bearer <token>` — the app never
  relies on browser cookies, which a native WebView cannot share cross-origin.
- In **Pangolin** mode the Pangolin access token is added as the `?token=`
  query parameter so Pangolin authorizes the request at the edge before it ever
  reaches your server.
- "Open full web console" hands the session token to an in-app browser via the
  server's `/api/auth/handoff` endpoint, so the full dashboard/terminal loads
  already signed in.

The server side of this (Bearer-token auth, CORS for the app's WebView origins,
and the handoff route) is implemented in the repository root — see
`middleware.ts`, `app/lib/controlAuth.ts`, and `app/api/auth/*`.

## Prerequisites

- **Node.js 20+** and npm
- **Android:** [Android Studio](https://developer.android.com/studio) (with an
  SDK + emulator or a device)
- **iOS:** a **Mac** with [Xcode](https://developer.apple.com/xcode/) and
  [CocoaPods](https://cocoapods.org) (`sudo gem install cocoapods` or
  `brew install cocoapods`)

## First-time setup

From this `mobile/` directory:

```bash
npm install

# Create the native projects (safe to re-run; skips ones that already exist)
npx cap add android
npx cap add ios      # macOS only

# Copy the web app into both native projects
npx cap sync
```

Or run the bundled shortcut, which does all of the above:

```bash
npm run setup
```

> The `android/` and `ios/` folders are generated and are **git-ignored** — they
> are recreated by `cap add`. Everything that defines the app lives in `www/`,
> `capacitor.config.json`, and `package.json`.

## Run it

### Android Studio

```bash
npm run open:android      # opens the android/ project in Android Studio
```

Then press **Run ▶** with an emulator or a connected device selected.

### Xcode (macOS)

```bash
npm run open:ios          # opens ios/App/App.xcworkspace in Xcode
```

Select a simulator or device and press **Run ▶**. Set your signing team under
**Signing & Capabilities** the first time.

> If Xcode complains about missing pods, run `npx cap sync ios` (which runs
> `pod install`) and open the `.xcworkspace`, not the `.xcodeproj`.

## Developing the UI

The UI is plain HTML/CSS/JS in `www/` — no build step. Edit the files, then:

```bash
npx cap copy            # push www/ changes into the native projects
```

For fast iteration you can also open `www/index.html` in a desktop browser; it
falls back to `localStorage` and `window.open` when the Capacitor plugins aren't
present. (Cross-origin API calls to your server require the server to allow your
browser origin — the native app origins are allowed by default.)

## App icons & splash

An `assets/logo.svg` source is included. To regenerate all icon/splash sizes:

```bash
npm run icons           # uses @capacitor/assets (downloaded on demand)
```

This needs network access to fetch the `sharp` image library. If you're behind a
restrictive proxy, generate the icons on an unrestricted machine, or set the
icons manually in Android Studio / Xcode.

## Configuration reference

`capacitor.config.json`:

- `appId` — `com.openshell.control` (change before publishing to a store)
- `appName` — display name
- `server.androidScheme: "https"` — Android WebView serves the app from
  `https://localhost`, one of the origins the server trusts by default

If you customize the WebView scheme/host, add the resulting origin to the server
via `OPENSHELL_CONTROL_ALLOWED_APP_ORIGINS` (comma-separated).

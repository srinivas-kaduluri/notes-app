# Minimal Secure Notes (Expo)

A minimalist notes/task app with hierarchy, metadata, completion workflow, search, attachments, optional location metadata, and numeric table totals.

## Implemented MVP

- Quick add note with optional parent (existing or new by title)
- Start/end dates for sorting and planning
- Complete note with completion note and optional follow-up link/create
- Parent-child hierarchy view and flat list view
- Search across title, body, status, and parent path
- Photo/video attachment support
- Optional location metadata capture for alerts
- Tabular numeric columns with number pad input and totals
- Optional biometric lock on app open (native)

## Security baseline in this MVP

- Local storage only (no server yet)
- Optional biometric gate using device authentication
- Principle of least data collection (only note metadata + optional fields)

## Important security note

This MVP does **not** yet implement end-to-end encrypted sync. For production-grade secure multi-device sync, add:

1. Authenticated backend (per-user isolation)
2. TLS everywhere
3. At-rest encryption on backend + key management
4. Optional client-side encryption keys stored in secure enclaves
5. Audit logging and session/device management

## Run

```bash
npm install
npm run start
```

Then press:
- `i` for iOS simulator
- `a` for Android emulator
- `w` for web

To test on iPhone without publishing:
1. Install Expo Go from App Store.
2. Run `npm run start` on Mac.
3. Scan the QR with iPhone camera (or Expo Go scanner).
4. If scan/network fails, run `npx expo start --tunnel`.

If you do not see a scanner in Expo Go:
- On iOS, open the iPhone Camera app and scan the terminal QR.
- Or in Expo Go use `Home` -> `Enter URL manually` and paste the `exp://...` URL from terminal.

## Development Build (Recommended Over Expo Go)

1. Install EAS CLI and log in:

```bash
npx eas-cli@latest login
```

2. Build iOS development client (TestFlight-like internal install):

```bash
npx eas-cli@latest build --platform ios --profile development
```

3. Build Android development client (optional):

```bash
npx eas-cli@latest build --platform android --profile development
```

4. After install on device, start dev server for dev client:

```bash
npx expo start --dev-client
```

5. Open your installed development build app on phone and connect to the project.

Notes:
- iOS bundle id is set to `com.skaduluri.minimalsecurenotes`
- Android package is set to `com.skaduluri.minimalsecurenotes`
- EAS config is in `eas.json`

## Cloud Sync (same account on phone + Mac)

Set env vars before start:

```bash
export EXPO_PUBLIC_SUPABASE_URL=\"https://YOUR_PROJECT.supabase.co\"
export EXPO_PUBLIC_SUPABASE_ANON_KEY=\"YOUR_ANON_KEY\"
```

Then create schema and RLS in Supabase SQL editor using:

`supabase/schema.sql`

## Privacy Lockdown Defaults

- Notifications: OFF by default
- Media access: OFF by default
- Location services: OFF by default
- Background geofence: OFF by default

Features only request permissions when corresponding setting/toggle is enabled.

## Platform targets

- iOS
- Android
- Web

Desktop strategy options:
- Package web in Tauri/Electron for macOS/Windows
- Or use React Native macOS/Windows with additional setup

## Host the web app (finish deployment)

This repo is ready for static hosting from `dist/`.

### 1) Build locally

```bash
npm run build:web
```

### 2) Deploy to Vercel (fastest)

1. Push this repo to GitHub.
2. In Vercel: `Add New Project` -> import repo.
3. Framework preset: `Other`.
4. Build command: `npm run build:web`.
5. Output directory: `dist`.
6. Add environment variables in Vercel Project Settings:
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   - `EXPO_PUBLIC_GOOGLE_PLACES_API_KEY` (optional)
7. Deploy.

`vercel.json` is included for SPA routing (`/* -> /index.html`).

### 3) Deploy to Netlify (alternative)

1. Push repo to GitHub.
2. In Netlify: `Add new site` -> import repo.
3. Build command: `npm run build:web`.
4. Publish directory: `dist`.
5. Add same environment variables in Netlify UI.
6. Deploy.

`netlify.toml` is included for SPA routing.

## Mobile builds (App Store / Play later)

- Internal testing build:
```bash
npx eas-cli@latest build --platform ios --profile preview
npx eas-cli@latest build --platform android --profile preview
```
- Store build:
```bash
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest build --platform android --profile production
```

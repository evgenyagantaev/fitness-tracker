# Fitness tracker

Personal fitness tracker: a FastAPI + SQLite server, a shared web UI, and a Capacitor Android app (`tech.agantay.fitness`) that talks to a Polar H10 over Bluetooth LE.

The UI language is Russian. Server URL and API token are entered in Settings (or the login screen); they are not baked into the client.

## Features

- Daily board for strength work (pull-ups, push-ups, …) and distance activities (run, walk)
- Workout recording with heart rate, RR intervals, steps, GPS, cadence, pace, and stop detection
- Polar H10: BLE Heart Rate (0x180D), HRV, ECG (PMD, 130 Hz), and raw chest accelerometer (200 Hz) during the run itself
- Offline running-dynamics analysis after the workout: cadence, vertical oscillation, lateral sway, landing impact, ground-contact and flight time, left/right balance, stride length
- Recovery stats (HRR, baseline, tau) and pre/post HRV (RMSSD, SDNN, pNN50)
- Signal-quality masking when the strap double-counts cadence as HR; auto-end when the strap is taken off
- GPS stride calibration (good fixes only; running stretches)
- Run segmentation (v1.7, pause-start timing v1.8.2): the run is found from the data, not from the Start/Stop taps — approach, run, pauses (dog stops), cooldown. A live pause is announced ~15 s after the real stop (the detector needs a still window); the recorded pause starts at that real stop (back-search of cadence/speed inside the detection window). Resume is left unshifted. A stored `pause_override` (or `run_override` for the start/finish) always wins over the auto markers, so a later manual edit is not moved by re-analysis. Pace, distance, cadence, stride calibration, dynamics and the HR peak/recovery anchor use the run only; boundaries are shown on the charts and can be adjusted by hand
- Runs without a strap: phone step counter + GPS + the phone's own accelerometer (50 Hz magnitude profile, used for run start, pauses and a fallback cadence); no HR/recovery blocks
- Forgotten Stop: the service detects that the run is over (cadence/GPS, and with a strap the falling HR), notifies, and closes the workout by itself; the raw tail is kept with the record
- Voice announcements during runs (v1.8.1, runs only): bundled offline neural Russian female voice (Silero TTS v5.1 `xenia` with manual stress marks and radio-filter + continuous radio bed, Opus clips stitched seamlessly in PCM) with Android TextToSpeech as fallback. Short ATC-radio style: start / stop detected / resumed, «пульс превысил сто двадцать» (every 20 bpm), every 2 min the current pulse, cadence and pace, distance every 500 m, and the rounded result at Stop. Works with the screen off (`AudioTrack` on navigation-guidance stream with ducking audio focus). Items never overlap; regular ones are ≥ 20 s apart; events have priority but never cut a phrase; stale ones are dropped. Categories can be switched off and the voice tested in Settings. Russian numerals with full agreement (`RuNum`) are unit-tested against an independent oracle
- Two-way sync with the server (chunked uploads; last-write-wins per day)
- Battery percentage of the strap, with a coarse “drain per hour” estimate once enough samples exist

## Layout

| Path | What |
|---|---|
| `server/` | FastAPI app, SQLite, stats and dynamics, Docker files, pytest tests |
| `server/app/static/` | Shared web UI (also copied into the Android bundle) |
| `android/` | Capacitor 8 project; Gradle app lives in `android/native/` |
| `e2e/` | Playwright checks against a local server / a mocked native bridge |
| `deploy/` | nginx snippet and an installer script for a `/fitness/` reverse proxy |

## Configure

**Server** — copy `server/.env.example` to `server/.env` (the file is gitignored) and set a strong token:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

```
FITNESS_API_TOKEN=change-me
```

Other useful variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `FITNESS_API_TOKEN` | (empty, server refuses auth) | Bearer token for the API and web UI |
| `FITNESS_DB` | `/data/fitness.db` | SQLite path |
| `FITNESS_TZ` | `Europe/Moscow` | Timezone for “today” |
| `FITNESS_ROOT_PATH` | empty | Set to `/fitness` behind a reverse proxy |
| `FITNESS_CORS_ORIGINS` | localhost / Capacitor origins | Comma-separated |

**Client** — open the web UI or the app, enter the server URL (for example `https://example.com/fitness/` or `http://127.0.0.1:8010/`) and the same token, then save. Nothing in the source tree points at a production host.

## Run the server locally

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q
FITNESS_API_TOKEN=dev FITNESS_DB=./dev.db uvicorn app.main:app --port 8010
# http://127.0.0.1:8010/
```

Docker (listens on `127.0.0.1:8010`, data in the `fitness-data` volume):

```bash
cd server
cp .env.example .env   # then edit FITNESS_API_TOKEN
./run-docker.sh        # or: docker compose up -d --build
```

Deploying behind nginx is described in [DEPLOY.md](DEPLOY.md).

## Build the Android app

```bash
cd android
npm ci
export ANDROID_HOME=/path/to/android-sdk
export JAVA_HOME=/path/to/jdk21
npm run build:debug    # APK: native/app/build/outputs/apk/debug/app-debug.apk
```

`npm run build:debug` copies `server/app/static/` into `android/www/` and then runs Gradle.

To bundle the offline neural voice clips (optional — without them the app falls back to Android TTS; Silero `v5_1_ru` weights are CC BY-NC-SA 4.0 so neither weights nor generated `.ogg` clips are committed):

```bash
python3 android/voice-gen/generate.py --model /path/to/v5_1_ru.pt
```

This writes Opus `.ogg` clips into the gitignored `android/native/app/src/main/assets/voice/` before building.

To install a new debug build *over* an already installed app without losing local data, reuse the same signing key. This repo does not ship a keystore. Put the following gitignored files in `android/keystore/`:

- `debug.keystore` — a JKS keystore
- `keystore.properties` — `storeFile`, `storePassword`, `keyAlias`, `keyPassword`

If those files are absent, Gradle falls back to the default Android debug key (fine for a fresh install, but it will not upgrade an app signed with another key). To create a local keystore:

```bash
keytool -genkeypair -keystore android/keystore/debug.keystore -storetype JKS \
  -alias androiddebugkey -storepass android -keypass android \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Android Debug,O=Android,C=US"
```

```
# android/keystore/keystore.properties
storeFile=debug.keystore
storePassword=android
keyAlias=androiddebugkey
keyPassword=android
```

The application id is `tech.agantay.fitness`.

### Choosing the voice

A debug build has an extra activity that lists the TTS engines and Russian voices and renders a sample with each into the app's private `files/probe/` (`adb shell am start -n tech.agantay.fitness/.VoiceProbeActivity`, read with `adb exec-out run-as tech.agantay.fitness cat files/probe/<voice>.wav`). The gender of Google's `ru-ru-x-*` voices was measured from the median pitch of these samples: dfc / ruc / rue are female, rud / ruf are male. The default is the first installed of dfc-local, ruc-local, rue-local, then the network variants.

## Tests

```bash
cd server && pytest -q
cd e2e && npm ci
# scripts expect a local server (often at http://127.0.0.1:8090/fitness/)
# and Chrome; override with SERVER and CHROME_PATH if needed
```

## API (Bearer token required except `/api/health`)

- `GET /api/health`, `GET /api/auth/check`
- `GET/PUT /api/exercises`, `GET/PUT /api/days/{YYYY-MM-DD}`, `GET /api/days?from=&to=`
- `POST /api/sync` — offline-first, last-write-wins on a day
- Workouts, recovery, calibration, ECG, accelerometer upload
- `GET /api/stats/streaks`, `/api/stats/summary`, `/api/stats/daily`, `/api/stats/totals`, `/api/stats/runs`, `/api/stats/recovery`
- Swagger: `/docs` (behind nginx: `/fitness/docs`)

## License

MIT. See [LICENSE](LICENSE).

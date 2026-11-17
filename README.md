# Rewatch

Personal League of Legends recorder and review tool for Windows. Records every game
automatically with game sound, Discord and microphone as separate tracks, logs the
mouse, reads kills, objectives and item buys from Riot's live-game feed, and gives
you a review player with a timeline, notes and drawing.

Design and the reasoning behind it: [docs/design.md](docs/design.md).

## Licence and legal

MIT, see [LICENSE](LICENSE). The installer bundles FFmpeg, which has its own licence
(`src-tauri/bin/FFMPEG-LICENSE.txt`).

Rewatch isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot
Games or anyone officially involved in producing or managing Riot Games properties.
Riot Games, and all associated properties are trademarks or registered trademarks of
Riot Games, Inc.

The rank emblems in `src/assets/ranks` are Riot's, from the ranked emblems download in
the Riot Developer Portal's League of Legends docs
(static.developer.riotgames.com/docs/lol/ranked-emblems-latest.zip), cropped to the art
and made smaller.

Rewatch records the Discord call. Tell the people you play with that calls are being
recorded.

## Run

Optimized build (no dev server needed):

```
npm run tauri build -- --no-bundle
src-tauri\target\release\rewatch.exe
```

While developing:

```
npm run tauri dev
```

Closing the window keeps the app in the tray so it can keep recording. Quit from the
tray icon. With "Start with Windows" on (the default) it launches hidden in the tray at
sign-in, so a game is recorded without opening the app first.

## Installer

```
npm run tauri build
```

writes `src-tauri\target\release\bundle\nsis\Rewatch_0.1.0_x64-setup.exe`. It installs
for the current user, includes FFmpeg, and fetches Microsoft's WebView2 runtime if the
PC lacks it. It is not code-signed, so Windows SmartScreen shows a warning the first
time: "More info", then "Run anyway".

Friends get it from https://rewatch.ggwp.no (the button there always gives the newest
installer). They install once; after that the app updates itself.

## Updates

```
node scripts/release.mjs --version 0.2.1 "What is new, in a sentence"
```

sets the version number, builds the installer, signs it, uploads it and announces it.
Installed apps look at `https://rewatch.ggwp.no/latest.json` shortly after start and
every six hours (or on Settings, Updates, Check now). With "Update by itself" on (the
default) they download a newer version straight away, while no game is running or
being recorded, and check its signature. What happens then depends on what changed:

- **Only the interface** (nothing in `src-tauri/` changed since the version the app
  has): the app takes the new interface on its own, about 1 MB, and keeps running.
  `ui.rs` serves it in place of the built-in one and keeps it in
  `%APPDATA%\Rewatch\interface\` for the next start. The window reloads to show it: at
  once if it is closed, otherwise a few seconds after it is next closed, or on
  "Reload" in the top bar. The screen that was open comes back, and the reload waits
  while a clip is being cut or an Undo is on offer. Recording, the tray and
  everything else carry on.
- **Anything in `src-tauri/`**: the installer, which has to replace the program and
  so restarts it. It is downloaded ahead and runs silently once the window is closed
  and no game is on, and the app comes back hidden in the tray seconds later. With
  the window open, "Update now" in the top bar runs it at once.

With the setting off nothing is downloaded until "Update now" is pressed.

- What counts as "only the interface" is decided by a fingerprint of everything in
  `src-tauri/` (minus the version number) and the `@tauri-apps` packages, worked out
  by `release.mjs` and built into the program (`node scripts/release.mjs --native-id`
  prints it). Each release also publishes `Rewatch_<version>_ui.json`, every file of
  the interface in one file, written by the program just built
  (`rewatch.exe --ui-bundle <file>`) and signed like the installer; `latest.json`
  names it under `ui` with the fingerprint. Apps with the same fingerprint take it.
  Any other app, a build made by hand (it has no fingerprint), and every version
  before this feature take the installer, as does an app that can't use the
  interface file for some reason.
- The site is a small Cloudflare Worker (`updates-site/`, deployed as
  `rewatch-updates`) in front of the R2 bucket `rewatch-releases`, in the same
  Cloudflare account as the rest of ggwp.no. It serves `/` (landing page, not indexed), `/latest.json`,
  `/download/latest`, `/download/<installer>`, `/download/<interface>`, `/fonts/*` and
  `/media/*`. `release.mjs` stops before announcing a version whose interface file the
  site doesn't serve, so deploy the Worker after changing it.
- The landing page is `updates-site/page.html`, bundled into the Worker as text. It is
  built from one real recorded game (Ranked Flex, 2026-11-13_00-42-08): `demo.json`
  holds that game's timeline, cursor, review drawings, who-talked-when and AI review,
  and is put into the page as JSON. The version line is filled from `latest.json`;
  before any version is published the `<!--cta-->` buttons become a note. The fonts
  (Archivo for headlines, Geist for text) are served by the Worker itself
  (`updates-site/fonts/`), and the icons are Phosphor, inlined, so the page loads
  nothing from other sites.
- The footage and pictures live in the bucket under `media/` (served at `/media/`, with
  range requests so Safari can play the videos). They are made by
  `updates-site/build_media.py <recording folder>` (needs ffmpeg with libsvtav1,
  libx264 and libwebp) and are kept out of git (`updates-site/media/`). Every video is
  written without sound, but the picture shows other players' names and chat as
  recorded. Upload them with
  `npx wrangler r2 object put rewatch-releases/media/<name> --file=media/<name> --remote`.
- Preview locally with the `rewatch-site` entry in `.claude/launch.json` (`wrangler dev`
  on port 8787). Seed the local bucket the same way with `--local`, for `latest.json`
  and each file in `media/`.
- The Cloudflare account id is not in the repository: `release.mjs` reads it from
  `.secrets/cloudflare-account-id` (or the `CLOUDFLARE_ACCOUNT_ID` environment variable);
  set the same variable before `npx wrangler deploy` in `updates-site/`.
- The signing key is `.secrets/updater.key` (no password; never commit it, and keep a
  copy somewhere safe). Its public half is `src-tauri/updater.pub`, built into the
  app. Lose the key and installed apps can no longer be updated: everyone would have
  to install by hand once more.
- The updater is the app's own (`update.rs`, `ui.rs`), not Tauri's plugin, so it can
  be tried from the command line: `rewatch.exe --update-check --download` says how the
  newest version would be taken, fetches what the app would (the interface file and
  the installer) and checks their signatures, without putting anything in place.
  `REWATCH_UPDATE_URL` points it at another announcement, such as a local
  `wrangler dev`; files are then also taken from there over plain http.
- Version 0.1.0 has no updater. Everyone installs 0.2.0 by hand once.

The installer needs `src-tauri\bin\ffmpeg.exe` (not kept in git). Copy in the
"essentials" build from https://www.gyan.dev/ffmpeg/builds/ along with its licence;
see `src-tauri\bin\FFMPEG-NOTICE.txt`.

## Watching a teammate's view

Every recording stores the in-game clock, and Riot's game id when the League client
could be asked, so two players' recordings of the same game can be lined up exactly.

- Settings, Teammates shows your friend code. Send it to a teammate and paste theirs
  in. Once both have added each other, their view appears in the player (top right
  of the video) for every game you both recorded. `V` cycles through views.
- Choosing a view plays their video from their PC at the same moment of the game.
  Your timeline, notes and your own Discord and microphone tracks stay in place.
- A PC only answers people on its own teammates list, and only hands out the video
  with game sound, never the Discord or microphone tracks.
- Connections are made with iroh (https://iroh.computer): encrypted end to end,
  direct between the two PCs when possible. iroh's public servers help the PCs find
  each other and relay the encrypted traffic when no direct path exists. The app goes
  online for this only once at least one teammate is listed.
- For this feature's lookups the app uses Cloudflare's public DNS (1.1.1.1) instead of
  the PC's. Reason: some ISP content filters redirect iroh's relay servers to a block
  page, which makes connecting impossible.
- The identity behind the friend code is `%APPDATA%\Rewatch\identity.key`. Deleting
  it gives a new code.

## Sending a game to a coach

A player can send one game to someone for review, and get their notes back in the app.
New in version 0.7.0; both sides need at least that version.

- In the player: More, Send to a coach. Pick someone (coaches sent to before, then
  teammates) or paste a new person's friend code, say what they should look at, and
  choose whether the Discord call and microphone go along (off unless ticked).
- The coach's Rewatch shows the request on the Games page with the game and the
  message. Accepting puts the player on the coach's students list (Settings, Coaching);
  from then on that player's games arrive without asking. "No thanks" turns that game
  down, and the player's app is told. Someone not accepted yet is announced once, however
  many games they offer, since anyone holding the coach's code can ask.
- What travels: a smaller copy of the video with game sound (`review.mp4`, made on the
  spot if there is none; the recording itself when a copy would not be smaller),
  `match.json`, Riot's record (summarized and raw, so a newer app at the other end can
  summarize it again) and the ranks, the cursor and key logs, the thumbnail and the AI
  review if there is one. With the voices: `discord.m4a`, `mic.m4a` and
  `voice.json`. The player's notes and drawings show in the coach's player under the
  player's name.
- It is fetched by the coach's app, over the same direct connection teammates use,
  while both PCs are on with Rewatch running; nothing is uploaded anywhere else. It
  carries on where it stopped if the connection drops, and waits while either side is
  in a game. The player's app offers it again every minute for up to 30 days. A game
  that keeps failing to arrive says why on the coach's Games page (no room on the
  drive, a game running, the other PC out of reach).
- The coach's copy lives in `Coaching\<their id>_<start of their code>` inside the
  recordings folder and is listed under "From students" on the Games page. It is not
  one of the coach's own games: Trends, the losing streak, the focus, the post-game
  job, highlights, the AI review job and teammates' requests never see it. It does
  count towards the size limit. Deleting it there keeps it from being fetched again.
- The coach's notes and drawings on it show up in the player's own recording, the way
  teammates' do (kept in `pov_<code>.extras.json` for when the coach is offline), and
  a reply to a note threads under it on both PCs. Both can press "Watch together" on
  the game to go through it in step.
- Who gets what (`sharing.rs`, and `serve_coaching` in `pov.rs`): a share is one game
  for one friend code, kept in `%APPDATA%\Rewatch\shares.json`. That person can ask
  for the files of that game named above and nothing else: not the player's other
  games, not the list of them, not the voices unless they were included. Nobody else
  can ask for anything. Being someone's coach does not make them a teammate, in either
  direction, and "Let teammates watch my recordings" has no say over a game that was
  sent on purpose. "Stop sharing" ends it; a copy already fetched stays with the coach.
- What the coach's app writes to disk is checked on its side too: only file names it
  knows, sizes capped, the game's id and file names in `match.json` replaced by its
  own, text cut to length, and nothing fetched without a gigabyte to spare.
- An app older than this answers the request with a refusal it already had; the sender
  then shows "Their Rewatch is too old to receive games".

Checked on 2026-11-16, everything on this PC with each side given its own identity,
settings and folders, over the real connection:

- Two stand-ins (`--send-game` and `--take-games`, under Tests): an offer from someone
  not accepted is shown and nothing is fetched; once accepted, a 108 MB copy arrived in
  about five seconds, was filed under `Coaching` with the player's notes, and the
  player's side went to "received"; the voice tracks came only with `--comms`; the
  coach's notes, a reply and a drawing came back; a game sent again was fetched once
  and kept the coach's notes; watch-together reports from the player reached the coach.
- Who is told what (`--pov-ask`): a third identity was refused the files, the notes and
  the list, and the coach was refused the Discord track, the player's `review.json`,
  another game and the list of games.
- A test copy of the app as the player, against a stand-in coach: it was offline
  (sharing off, nobody listed), went online when the game was sent, made the smaller
  copy on the spot (about 55 seconds for a 4-minute AV1 recording), and went through
  "preparing", "accepted" and "received".
- The same copy as the coach, against a stand-in student sending a ranked game: the
  request showed with the game and the message and was announced once while the
  student's app kept offering; after Accept the game arrived, was listed under "From
  students" and not in Trends, opened with the scoreboard data, ranks, story, AI review
  and the student's note, played from the `Coaching` folder, and could not be sent on.
  A note and a reply written there reached the student's app.
- Teammates' views still save as before (`--pov-serve` with `--pov-fetch`), since the
  file sending was moved into one place.
- The send dialog, the request, the arrival bar and the Settings lists were also
  looked at in a browser with sample data.

Not checked: two real PCs, a full-size game (a 35-minute recording's copy is about
1.3 GB, and making it took about a quarter of the game's length here), the size limit
reaching a received game, the stuck-transfer line with a real full drive, and an app
on 0.6.3 or older at the other end. A coach whose app is offline because sharing with
teammates is off and nobody is listed cannot be reached by a first request; they have
to switch that on, or add a teammate or student, first.

## How a recording is made

- **Video**: FFmpeg records League's own window (Windows' window capture, FFmpeg's
  `gfxcapture`), so other windows, alt-tabs and notifications stay out of it, and a
  covered or moved window is still recorded. The picture is sized on the graphics card
  as it is captured. This needs Windows 11 (Windows 10 can't hide the yellow frame it
  draws around a captured window) and an FFmpeg that has `gfxcapture` (8.0 or newer).
  Without them, with Settings, Video, *Record only League's window* off, or when the
  window can't be captured, FFmpeg grabs the whole display the game is on (Desktop
  Duplication), and the "Recording" notification says so. Either way the frames go
  to the graphics card's encoder directly. The encoder is picked automatically
  (NVIDIA, then AMD, then Intel, then the processor as a fallback that works anywhere).
  Each frame is stamped with wall-clock time, so the file itself records when video
  started. A minimized game sends no frames; the last one is held until it comes back.
  When the game's window closes, its recording ends as if the game had.
- **Champion select**: with *Ask the League client* and *Record champion select* on,
  the League client is asked for its phase (lobby, champion select, game...) every 2
  seconds while it is open. During champion select it is also asked, once a second,
  what champion select looks like (`/lol-champ-select/v1/session`, a GET like every
  other request): each seat's role, hover, locked champion and summoner spells, the
  bans, whose turn it is, and the phase with its timer. No names or accounts are kept.
  Only the answers that show a change are kept (`champselect.rs`), on the same clock as
  the client's sound, Discord and the microphone, which are recorded with them into
  `.draft` in the recordings folder. The client's window is recorded too (at 30 fps at
  most) only with *Also record the client's window*. If a game starts within 10
  minutes, it all moves into that game's folder; a dodge, leaving the lobby, or the
  Stop button drops it. It stays on this PC: copies sent to a coach or a teammate
  leave it out.
- **Sound**: three WASAPI captures written to separate files on the same clock:
  the game process, Discord's process tree, and the microphone.
- **Mouse**: cursor position and button state are polled (no input hook) into `mouse.csv`.
- **Keys**: the state of a fixed list of game keys (Q W E R D F, 1 to 7, B, A, S, Tab,
  Space, Ctrl, Shift) is polled the same way into `keys.csv`, only while League's window
  is in front and never while the in-game chat is open (Enter opens and sends it, Esc
  closes it). Manual recordings have no key log.
- **Events**: `https://127.0.0.1:2999/liveclientdata/allgamedata` is read once a second.
  Purchases are detected from changes in each player's item list.
- **After the game** (`riot.rs`): while no game is on, Riot's record of each game is read
  from the League client (or Riot's web API with a key in Settings) and saved next to
  the recording; see Version 0.5.0 below.
- When the game exits, the pieces are joined (video is copied, not re-encoded) into one
  folder per game: `game.mp4` (video + game sound), `discord.m4a`, `mic.m4a`,
  `mouse.csv`, `match.json`, `thumb.jpg`, and `review.json` for notes and drawings.
  Champion select, when recorded, is `draft-picks.json` (what the client reported, the
  champions' names, and a list of what happened), `draft-game.m4a` (the client's sound),
  `draft-discord.m4a` and `draft-mic.m4a`, listed under `draft` in `match.json`. With
  the client's window recorded, `draft.mp4` holds its video and the client's sound.

## Two hard rules

1. **Low cost.** Capture and encode stay on the graphics card, helper processes run at
   below-normal priority, nothing is drawn over the game, and joining happens after
   the game.
2. **Hands off the game.** The game process is never opened, injected into or hooked.
   No input hooks, no overlay, no automation.

## Tests

```
cd src-tauri
cargo test --lib                      # event and purchase detection, post-game data
target\debug\rewatch.exe --riot-probe   # what the League client and the key can see now
target\debug\rewatch.exe --postgame C:\recording\folder [--key-file key.txt]   # fetch one game's record
target\debug\rewatch.exe --test-record 10 --out C:\some\folder   # headless capture test
target\debug\rewatch.exe --test-record 10 --out C:\some\folder --window notepad.exe   # one program's window, as a game's
target\debug\rewatch.exe --test-draft 8 --out C:\some\folder --window notepad.exe     # champion select as the settings record it, then that program as its game
target\debug\rewatch.exe --list-mics
```

Sending a game to a coach, with two stand-ins on one PC. Each needs its own `APPDATA`
(the list of shares lives there) and its own identity file:

```
rewatch.exe --pov-code --identity coach.key                      # prints a friend code
rewatch.exe --take-games C:\coach\recordings --identity coach.key [--from <player's code>]
rewatch.exe --send-game C:\player\recordings\<id> --to <coach's code> --identity player.key [--comms] [--message "..."]
rewatch.exe --pov-ask <code> --identity any.key --json "{\"op\":\"shared\"}"   # what another app answers
```

Three environment variables exist only for testing the automatic flow without League:
`REWATCH_GAME_EXE` (process name to treat as the game), `REWATCH_LIVE_URL` (address of
a stand-in for the live-game feed) and `REWATCH_CLIENT_URL` (address of a stand-in for
the League client's API, asked without a password; it answers the phase, such as
`"ChampSelect"`, the game's queue, and what champion select looks like). Champion select
also needs the real League client open, since its sound (and, if asked for, its window)
is recorded.

## Layout

- `src-tauri/src/` Rust core: `session.rs` (one recording), `video.rs`, `audio.rs`,
  `liveclient.rs` (game feed and the numbers for the graph), `library.rs` (folders,
  clips, size limit), `pov.rs` (everything between teammates: views, notes, speech
  times, watching together), `copies.rs` (smaller copies for teammates), `sharing.rs` (games sent to a coach: who gets what, and how a received game is kept), `voice.rs`
  (when someone was talking), `update.rs`, `insight.rs` (hints about deaths), `coach.rs` (written review), `team.rs` (team review of a fight), `titles.rs`, `highlights.rs`, `riot.rs`
  (post-game data and ranks, from the League client or Riot's web API), `winutil.rs`, `settings.rs`, `lib.rs` (app
  wiring, watcher, commands).
- `src/` interface (React + TypeScript): `Games.tsx`, `Player.tsx`, `Views.tsx` (split
  view, zoom, cursor), `Timeline.tsx`, `Insights.tsx` (review tab, comms rows, graph),
  `PostGame.tsx` (the Players tab's post-game panel), `MapView.tsx` (minimap), `Rank.tsx`
  (LP and the rank chart), `Coaching.tsx` (the send dialog and the coach's requests), `SettingsPage.tsx`, `api.ts`.
- `updates-site/` the update address; `scripts/release.mjs` publishes a version. `mock.ts` and `public/mock/` are sample data for
  working on the interface in a plain browser; they are not part of release builds.

## Checked on 2026-11-12

- Automatic flow with a stand-in game and feed: detect, record, place events at the
  right video times, detect a purchase, save, show in the library.
- Sound/video timing: a flash-and-beep pattern landed within about one frame (9 to 42 ms).
- Real game-feed data from a Practice Tool game parsed correctly.
- Recorder load on an idle PC: 60 fps held at 1440p and 4K with FFmpeg using about a
  tenth of one processor core.
- Clip export, all-tracks export, rescue of an interrupted recording, and that FFmpeg
  ends when the app is killed.

Checked later the same day:

- A real Practice Tool game was recorded automatically, with sound on all three tracks.
- Teammate views by friend code, with a second copy of the app on this PC standing in
  for a teammate: pairing, refusal of someone not on the list, matching, playback,
  seeking and the 3-second offset of the stand-in recording.
- Automatic encoder choice (picked NVIDIA here) and the processor fallback.
- The installer's contents.

Not checked: the AMD and Intel encoder paths (no such setup on this PC; Intel failed
here because the screen is driven by the NVIDIA card), teammate views between two real
PCs, and running the installer itself.

Not yet checked: in-game FPS cost, a full-length game (long-run sound drift), the F8
bookmark key, sharing the player in Discord, HEVC/AV1 playback, HDR screens, and
League in exclusive fullscreen (borderless is the safe choice).

## Notes from 2026-11-13

- First full-length game recorded by the installed app: Ranked Flex, 28:57, about 59 fps
  at 1440p, 6.1 GB (H.264), result and all events captured, three sound tracks of equal
  length.
- Fixed: checking a friend code (or opening a game) before any teammate was saved made
  the app panic while going online, and the release build was set to end the whole
  program on any panic. Going online is now safe from any thread, the build unwinds
  instead of aborting, and panics are written to the log as `[crash]`.
- Interrupted recordings are now looked for whenever the recordings folder is first
  set or changed, not only at start-up.

- Pairing takes one pasted code: Check saves the teammate first, and the app on the
  other side shows "X wants to connect" with a one-click Add. The app now goes online
  whenever sharing with teammates is on, so that first contact can reach it.
- Split view (`S`): your recording plus up to four teammates' views on the same game
  moment. One-big or equal-size layout, a draggable divider, wheel zoom and drag pan
  inside each view, and a label per view that moves the game sound to it. Lanes are
  recorded from now on and shown on the labels.
- Teammates' cursor trails are shared along with their video.
- The side panel's width can be dragged.

- Teammates' views are saved for offline use: the app copies each teammate's video and
  cursor log of a shared game into your own recording's folder (`pov_<code>.mp4`,
  `.csv`, `.json`), now and then in the background and when you open the game. Saved
  views play without the teammate being online, count towards the size limit and are
  deleted with the game. Copying resumes after an interruption and never runs while
  either side is in a game. Setting: Teammates, "Keep teammates' views on this PC".

## Version 0.2.0 (2026-11-13)

- **Smaller copies for teammates.** After each game a 1080p H.264 copy
  (`review.mp4`, constant quality 28, sound copied untouched) is made next to the
  recording, and that is what teammates are sent and what they stream when watching
  live. Measured on real recordings: 59 MB instead of 219 MB, and about 5.7 Mbit/s
  against 27 for the 1440p original, so roughly a fifth to a quarter. Made only
  while no game is running, at idle priority, and abandoned the moment a game
  starts. H.264 rather than H.265 so it plays on every teammate's PC. Recordings
  older than a week, and teammates on version 0.1, get the original as before.
- **Shared notes and drawings.** Teammates who recorded the same game see each
  other's notes (Notes tab, blue flags on the timeline) and drawings. A drawing
  belongs to the recording it was drawn over and shows when that recording is on
  screen. Asked for again every 20 seconds while a game is open, and kept in the
  recording's folder (`pov_<code>.extras.json`) for when the teammate is offline.
  Switch: Teammates, "Share my notes and drawings".
- **Watch together.** Button in the player. Everyone who has the game open and the
  button on stays on the same game moment; anyone can play, pause or seek and the
  rest follow. Each app plays its own files, so everyone sees full quality. A bar
  offers to join when a teammate is reviewing a game you also recorded. It needs
  your own recording of that game.
- **Review tab.** Your deaths, team fights (three or more kills within 14 seconds of
  each other) and bookmarks, each playable as a walk-through that plays the lead-in
  and stops. Team fights also show as bands on the timeline.
- **Graph.** CS, CS per minute, level and your gold over the game, under the
  timeline, against your lane opponent or anyone else. Sampled every ten seconds
  from the live feed, so only games recorded from 0.2.0 on have it.
- **Comms rows.** Who was talking when, under the timeline: you (from your
  microphone track), each teammate who runs Rewatch (from their own microphone
  track; only the times are shared, never the sound), and Discord as a whole.
  People without Rewatch cannot be told apart: Discord's own "who is speaking" is
  only available to apps Discord has approved, or by reading Discord's memory,
  which this app does not do. Worked out on first open for older recordings.
- **Split-view clips.** With split view on, the clip button makes one video of the
  views that are showing, side by side on the same moment, with names.
- **Notifications.** A Windows notification when a recording starts, is saved, or
  could not start, and the tray icon's tooltip says what is being recorded.
- **Updates.** See above.

Checked: the unit tests (31); the smaller copy, the saved view arriving as that copy
(byte-identical), notes, drawings and speech times fetched online and again with the
teammate offline, and watch-together reports (follow, drift correction, leaving), all
between two copies of the app on this PC; speech detection on the real 29-minute game
(165 stretches on the microphone, 492 on Discord); a two-view clip; the interface
with sample data in a browser; the published installer downloaded and its signature
checked by the app's own updater.

Not checked: any of this between two real PCs; the installer replacing a running
app and restarting it (first possible when a version after 0.2.0 is published);
whether the Windows notification shows from the installed app; a real graph, since
no game has been recorded with 0.2.0 yet.

## Version 0.2.1 (2026-11-13)

- **Hints about deaths** (`insight.rs`, optional, off by default). For each of your
  deaths a 17-second 720p clip with game sound goes to Google's Decisions API
  (`gemini-decision-1`, `POST /v1beta/decisions`) with six closed questions: was it
  avoidable, main cause, kind of fight, were the enemies visible beforehand, was an
  ally close, positioning. The API returns probabilities, no text. They are kept in
  `insights.json` and shown in the Review tab as one line per death ("Likely
  avoidable (89%), overextended"), with a button to put the most avoidable first.
  A cause is only named when the model gives it 40% or more. Runs by itself after a
  game for the last three days' recordings, or from "Get hints" in the Review tab;
  never while a game is running. Needs the user's own Gemini API key (Settings,
  Hints), which is stored in `settings.json` on that PC. Discord and microphone
  sound are never sent. About 6,100 input tokens and 2 seconds per death.
- What the trial on a real game (Rakan, 4 deaths, plus a clip without a death)
  showed: checkable facts are reliable at "high" video detail (the player dies:
  88 to 93% on the deaths, 6% on the control; at "medium" it was unsure on two of
  four). The judgement answers are soft: "avoidable" ranged 59 to 80% and the top
  cause never passed 41%. The ranking mostly matched the player's own read, which
  is why it is shown as a ranking and a hint, not a verdict. Telling the model how
  many enemies took part in the kill made it call every death "outnumbered and
  avoidable", so that is left out of what it is told.
- **Written review** (`coach.rs`, same switch and key). One request per game to
  Gemini's Interactions API (`POST /v1beta/interactions`, `gemini-3.8-flash`, falling
  back to `gemini-3.5-flash-lite`): the scoreboard and timeline as text plus a clip
  of up to six deaths (720p, ten frames a second, no sound; the most avoidable
  first). The answer follows a fixed JSON shape: a headline, what went well, what to
  work on, one focus for next game, a sentence or two on each death, and a title for
  every player. Kept in `coach.json`, shown at the top of the Review tab and under
  each death. About half a minute and a cent or two per game. It describes what it
  believes it saw in the clips and can be wrong; the tab says so.
- **Titles** (`titles.rs`). Every player gets a title after a game. Without any key
  they come from the game's own numbers (most kills, most deaths, most assists,
  towers, big monsters, CS a minute, ward score, first blood, multikills, low kill
  participation), one title per player, the same on every PC for the same game.
  With the AI review on, its titles (written for that one game) replace them, and
  teammates get those too through the same channel as shared notes. Shown under
  each name in the Players tab, next to your score in the top bar, and in the
  "recording saved" notification. Ward scores are recorded from this version on.
- Fixed: a smaller copy for teammates is now only kept if it is clearly smaller
  than the recording (0.2.0 kept a 149 MB copy of a 26 MB recording). Such copies
  are removed at start and teammates get the original.

Not checked: the hints and the review running by themselves after a real game in
the installed app, how well they hold up on other champions and roles, whether what
the review says about each clip is accurate (only the player can judge that), and titles
reaching a teammate's PC.

## Version 0.2.2 (2026-11-13)

- **Automatic highlights** (`highlights.rs`). Found from the event list alone: your
  double kills and better, a teammate's triple and better, aces for your team, fights
  around Baron, Atakhan or a dragon (two or more kills near it), and team fights won
  by two or more with at least three kills. Overlapping moments become one; at most
  six a game, none longer than 45 seconds. They are listed at the top of the Review
  tab and play as a walk-through. With "Save highlights as clips" on (the default)
  each is also saved by itself a little after the game as a 1080p H.264 clip with
  game sound, Discord and the microphone mixed, in the recording's folder
  (`highlight_<time>_<what>.mp4`): counted towards the size limit, deleted with the
  game. Older games get a "Save clips" button.
- **Team review** (`team.rs`, part of the AI review). A button under each team fight
  in the Review tab sends the same seconds (eight before the first kill to four
  after the last, 40 at most) from your recording and from up to four teammates'
  views, with what the event list says about the fight, to Gemini, and asks what the
  team should have done: a summary, the turning point, two or three things to do next
  time, a line per player it could judge, and the call someone should have made.
  Pictures only, no Discord or microphone. Kept in `team.json` and passed to
  teammates with the notes, so everyone reads the same review.
- The developer's own copy updated itself from 0.2.0 to 0.2.1 at 12:13 on 2026-11-13: the
  first real run of the self-update, including the installer closing and restarting
  the app.

Not checked: a team review with real teammates' views (none were saved on this PC,
so it was tried with one screen), highlights being saved by themselves after a live
game, and a team review arriving on a teammate's PC.

## Version 0.2.3 (2026-11-13)

- **Fixed: AV1 and H.265 recordings were blocky.** Every recording made in those two
  formats came out at about 1 Mbit/s whatever the quality setting. Cause: the screen
  grabber's clock counts in microseconds, and after the wall-clock stamp the encoder
  no longer knew the frame rate, so NVIDIA's AV1 and H.265 encoders assumed a million
  frames a second and gave each frame almost no bits. H.264 was never affected. The
  capture chain now states the frame rate again right after the stamp (`fps=60`).
  Measured on the real capture path after the fix: AV1 16.4 Mbit/s (was 1.0), H.265
  9.5 Mbit/s (was 0.6). A game of 12:42 that day (Elise, AV1) and the 4-minute
  H.265 one from the night before were recorded with the fault and cannot be
  repaired.
- The earlier size comparison (AV1 at quality 30 about 45% smaller than H.264 at
  23) was made by re-encoding finished footage, where the fault does not occur; it
  still stands, but no full game has been recorded in AV1 with the fix yet.

## Version 0.2.4 (2026-11-13)

- **Key overlay** (`keys.rs`). Which game keys were held is logged with each League
  game and shown as keycaps at the bottom left of the video, lit while held (and for at
  least 0.15 s after a tap, so quick presses are seen at normal speed), with "Chat open"
  or "Game not in front" when nothing was recorded. The Keys chip switches it and shows
  key presses per minute around the current moment. Setting: Sound and mouse, "Record
  game keys" (on by default). The log stays on this PC: teammates do not get it, and
  the overlay is hidden on their views.

Checked: the unit tests (47, six new for the chat and focus rules), a full build check,
and the overlay with sample data in a browser (lit keys, chat and away states, keys per
minute). Not checked: a real game. Points to look at then: whether the chat rule stays
in step (pressing Enter for anything other than chat would hide keys until the next
Enter or Esc), and whether polling every 8 ms misses very short taps.

## Version 0.2.5 (2026-11-13)

- **New icon.** The app, taskbar, tray and installer use the new Rewatch mark: an R
  built from a ring, a stem and a leg, in the brand red on a dark square
  (`branding/logo/`, drawn by `build_logo.py`; `src-tauri/icons/` made from
  `rewatch-icon-small-1024.png` with `tauri icon`). No other changes from 0.2.4.

## Version 0.3.0 (2026-11-13)

- **Highlight reel** (`highlights.rs`). The Review tab's Reel button stitches a game's
  highlight clips into `highlights_reel.mp4` with short crossfades and a title on each.
- **Highlights-only mode** (Settings, off by default). After a game the reel is made;
  a day after the game started the full `game.mp4` is deleted unless the game was
  starred by then. A trimmed game plays its reel, whose sound already holds Discord and
  the microphone; the full game's markers, graph, comms rows and teammates' views are
  hidden for it, since they run on the full game's clock.
- **League settings backup** (`league_cfg.rs`). `PersistedSettings.json`, `input.ini`
  and `game.cfg` are copied to `%APPDATA%\Rewatch\league-backups\` when a game starts
  and they changed (last 20 kept), or by hand in Settings. Restoring first saves the
  current files as "Before restore", and is refused while a game runs.
- **Recording resolution** (Native, 1440p, 1080p, 720p). Scaled on the graphics card
  with NVIDIA and Intel when the card can, otherwise just before encoding.
- **Player**: A-B loop (`[`, `]`, `R`, also on walk-throughs), clips sized for
  Discord (10 MB) or Nitro (50 MB; a stretch too long for the size is refused with the
  longest that fits), per-game sound levels with optional ducking of game sound while
  someone talks, drawings on teammates' tiles in split view, game tags.
- **Keys**: a custom key list for the overlay (up to 32, mouse buttons too); Space
  camera share, attack-move count and summoner presses (D, F) on the timeline.
- **Numbers**: item gold, vision score and whether each player is dead are sampled with
  the other stats; new graph lines (item gold, team gold and kill difference, vision
  score, APM), CS at 10 and 15 minutes, comparison with another game by game clock, a
  strip of grey-screen time, unspent gold, vision, APM, Space and attack-move, and the
  state 8 s before each death and fight.
- **Trends** tab: results over many games by queue, role, champion and tag, champion
  table, recurring death causes, duos, recent games. The library search also finds
  tags, note text and player names.

Checked: the unit tests (52), a full build check, and a code review of the whole
change (fixed: the Intel downscale fallback used a pixel format QSV refuses, trimmed
games played the full-length Discord and mic over the reel, an old game hid the graph
when a new graph line was chosen, clips longer than the size allowed came out too
big). Not checked: a real game, the reel and downscaling on real hardware.

## Version 0.4.0 (2026-11-13)

The interface is reworked around reviewing a game and taking one lesson into the next.

- **Library**: hovering a game plays a preview, a list view sits next to the grid,
  several games can be selected to keep, tag or delete at once, and a storage meter
  shows the space used against the limit. A first-run checklist covers the setup, and
  the To review filter lists the games not yet marked reviewed.
- **Focus**: while reviewing, pick one thing to work on. The next game's "Recording"
  notice repeats it, and that game's review asks whether you did it (yes, partly, no).
- **Trends**, rebuilt: date range, queue, role, champion and tag in one row; headline
  numbers against the period before; game-by-game charts (time dead, CS at 10, CS per
  minute, vision per minute) with a rolling average and one shared hover; "Why you
  died", where a cause plays every such death in the games shown as one walk-through;
  how the focus went; champion, teammate and every-game tables.
- **Walk-throughs** can span games. Previous and next move between them, and a game
  trimmed to its highlights or deleted since is skipped, with a note saying so.
- **Reviewing with teammates**: share mode (`Shift+P`), a clean, large view for sharing
  the window in Discord; a laser pointer that is never saved; undo for drawings; replies
  to notes, which reach teammates' copies too.
- **Clips** can be copied to the clipboard as a file, ready to paste into Discord.
- **Settings** save themselves. A Status panel at the top checks FFmpeg, auto-record,
  the League folder, free disk space, the microphone and sharing, each with a button to
  fix it, and a list on the left jumps between sections. Lowering the storage limit
  asks first when it would delete games.
- **Everywhere**: Archivo for headings and Geist for text (bundled, replacing Inter),
  the app's own dropdowns, menus and confirm dialogs, loading placeholders, errors in
  plain words, and toasts that follow long jobs (clips, the reel, exports). Deleting
  games, notes and teammates can be undone for a few seconds.
- The Trends tab keeps each recording's row and reads it again only when its match,
  review or insights file changes.
- Clips, highlight clips, the reel and split-view clips share one list of encoders to
  try (`video::h264_ladder`), in a quality or a bitrate mode.

Checked: the unit tests (54), a full build, the interface with sample data in a browser
from 1100 to 1920 px wide, and a code review of the whole change (fixed: a walk-through
stopped at a game trimmed to its highlights or deleted, notes changed just before
leaving a game were not saved, deleted games could flash back after the Undo, popovers
could not be reached with Tab, a walk-through could end itself when the app refreshed,
Settings reopened during a save showed old values, a deleted note could not be brought
back, leaving Trends while a walk-through loaded pulled the player into it). Not
checked: a real game, pasting a copied clip into Discord, the focus in the "Recording"
notice.

## Version 0.4.1 (2026-11-13)

- **AI review**: the written review, the death hints and the team review each cut their
  clips into a file of their own (`insight::temp_clip`). The review the app writes after
  a game and one asked for with "Get the AI review" could run at once and shared one
  file; each ffmpeg run wrote over the clip the other was about to send, and Google
  refused the broken video ("Google answered 400: Request contains an invalid
  argument."). No other changes from 0.4.0.

Checked: the unit tests (55, one new: jobs running at once never share a clip file), a
full build, the clips of two reviews cut at the same time from a real recording (one
shared file: 9 of 12 clips did not decode; a file each: all 12 fine), and that an empty
or half-written clip gets exactly that 400 from both models. Not checked: two reviews
of one game running at once in the installed app.

## Version 0.4.2 (2026-11-14)

- **Fixed: a gray box at the top of the player.** With the graph under the timeline
  switched on, its three dropdowns (what the graph shows, "vs" and the other game) left
  the graph's header and sat at the top of the player as a small gray box with a "vs"
  and two arrows. The line that follows the mouse over the graph and the timeline had
  the class `ghost`, the same as the dropdowns' transparent style from 0.4.0, and the
  line's rule (`.lanes .ghost`) made each dropdown a 1 px wide box pinned to the top of
  the player. The line is now `hoverline`. No other changes from 0.4.1.

Checked: the interface with sample data in a browser, 2560 px wide with the graph on
(before the fix all three dropdowns sat at the top of the player as in the report; after
it they are in the graph's header with their labels), the lines that follow the mouse over
the graph and the timeline (unchanged), the type check, a full build, and the published
installer downloaded by 0.4.1's own updater with its signature checked. Not checked: the
installed 0.4.2 with a real game's graph.

## Version 0.5.0 (2026-11-15)

**Post-game data.** After each game Rewatch reads Riot's record of it: from the League
client by default, or from Riot's official web API (match-v5 and league-v4) with your
own key in Settings, Match data. It is read only while no game is on, and only read.

- **LP** won or lost on game cards, list rows and the last-game recap, and the rank in
  the recap. The rank is read as a game loads and again after it; the LP shows only
  when exactly one game was played between the two reads.
- **Players tab**: kill participation, damage share, damage and gold a minute; who did
  what (damage dealt and taken, gold, CS, vision, crowd control, healing and shields,
  objectives) with each player's share of their team; a map of your kills, deaths and
  assists, or every kill, or where everyone was at a chosen minute, where picking a kill
  plays it; the gold lead against your lane opponent and between the teams, minute by
  minute, with the leads at 10 and 15 minutes; your deaths, each playing its run-up.
  With a key, also what hit you (physical, magic, true; which abilities), what you
  dealt back, and your skill order, none of which the League client keeps. When the
  record is not in yet, the tab says why and "Get them now" asks straight away.
- **Trends**: a rank chart per ranked queue; "Where you die", every death (or kill) of
  the games shown on the map, filtered by the page's champion and role filters and by
  the time in the game, where each dot plays that death and "Watch all" plays them one
  after another, with who kills you most; charts for the gold lead at 15 minutes and
  the share of your team's damage; LP and damage share columns.
- Each game folder gets `riot_match.json` and `riot_timeline.json` (raw), `postgame.json`
  (what the app shows) and `riot.json` (the account, ranks before and after, and how
  the fetching went). Games recorded before this version are filled in by the same
  background job, newest first, a few at a time. A game the League client cannot find
  is tried again later, and given up after three days unless there is a key.
- A development key from developer.riotgames.com stops working after 24 hours. A
  refused key is not used again until it changes, and the League client carries on.
- The setting that used to say "Ask League which queue it is" is now "Ask the League
  client", since it also covers the post-game reads.

Checked: the unit tests (66, 13 of them new for match records in both formats, rank
changes across promotions and gaps, unknown ranked queues, retries, and game time to
video time), the type check, a full build, the new code reading 15 real games from the
League client (all saved, with every kill's place on the map and the minute-by-minute
numbers, and five Practice Tool games marked as having no record), and the published
installer downloaded by 0.4.2's own updater with its signature checked. Not checked: a
real Riot key, the LP after a ranked game, and the new screens with real games.

## Version 0.6.0 (2026-11-15)

**Where the game turned.** The Review tab finds the minutes where the team gold lead
swung by 1,500 or more (the three biggest), says what happened in each (the fight, the
kills, the objectives taken and lost) and plays it as a walk-through, over a small
chart of the lead. The same numbers tag each game as a stomp, comeback, throw or close
game; the tag shows on game cards, list rows and in the Review tab, and the library can
show only one kind.

- **Graph under the video**: three new lines from Riot's record, in step with the
  video: the gold lead and the XP lead over your lane opponent, and the team gold
  lead. They step once a minute, which is how often Riot records them. The old "Team
  gold diff" (from items bought, every 10 seconds) is now called "Team item gold
  diff". Games without the live numbers can show the graph too.
- **Everyone's rank on the scoreboard**, read once within six hours of the game: from
  the League client for players it knows, else from Riot with a key. The requests are
  spaced out, since the client refuses quick runs of them. New games only.
- **Matchups** in Trends: per lane opponent, your record and LP, your average gold lead
  at 10 and 15 minutes, your deaths in the first 14 minutes, a note of your own
  (`matchups.json` in the app's folder), and "Play every early death vs" that champion.
- **Sessions** in Trends: today's record and LP, LP per sitting (games less than an
  hour apart), and your win rate in games right after two losses in a row. Settings,
  Recording, "Suggest a break": after the chosen number of losses in a row in one
  sitting, the notice for the saved game asks "Stop for today?". Remakes don't count.
- **Picture of the game**: More, "Copy a picture of the game" draws the result, LP, KDA,
  damage share, kill participation, CS and a map of your deaths and kills, saves it as
  `share.png` in the game's folder and puts it on the clipboard to paste in Discord.
- Players the live feed showed under another name now get their champion from Riot's
  record (matched by name, then the one left on each team, then by K/D/A), and saved
  games are summarized again from their files once, without asking Riot.
- Deaths from before the recording started no longer play from 0:00 in the playlists
  of deaths.

**The numbers, laid out like a match history.** Victory and defeat in blue and red
stripes on game cards, list rows, both scoreboards and the Trends tables. KDA ratios
are coloured by how good they are (grey under 2, then white, teal, blue, and orange from
5 or a game without deaths), win rates blue from 50% and orange from 60%, and ranks show
as a crest in the tier's colour. Champions are square pictures with their level on the
corner.

- **Full scoreboard**: O, or Scoreboard at the top of the player, shows both teams over
  the video: each player's rank, summoner spells, runes, KDA and kill participation,
  damage to champions (a bar, and the share of the team's), gold, CS and vision a
  minute, items and trinket, multi-kills and first blood, and each team's kills, gold,
  towers, inhibitors, dragons, barons, grubs and bans. Esc or O closes it.
- **A score for each player**, 0 to 10, with an MVP (the best on the winning team) and
  an ACE (the best on the losing team). It weighs KDA 30%, kill participation 20%, damage
  a minute 18%, gold a minute 12%, vision a minute 8%, damage taken and blocked a minute
  7% and objective damage a minute 5%, each as a place among the ten players. It needs
  Riot's record of the game, and shows in the player's header and both scoreboards.
- **Players tab**: the rank after the game with its LP, your final build, and two
  compact team tables (level, name, rank, KDA and ratio, CS, MVP and ACE) with a button
  to the full scoreboard. "Your game" says where each number places you, such as "2nd
  of 10 in the game" or "Most in the team".
- **Library**: list rows show the result, queue, length and time, the level, KDA and
  ratio, CS, your items and both teams; narrower windows drop the teams, then the items.
  Game cards add the items, CS and the ratio.
- **Trends**: the rank card has the tier's crest, a bar for the LP to the next division
  and the season's wins as a ring. The champion and game tables colour win rates, ratios
  and results.
- The gold chart fills the team's lead blue above zero and red below, and the skill
  order gives each key its own colour.

Checked: the unit tests (69), the type check, a full build, the turn finder and the
picture on the 15 real games with Riot's record (the turns name the right fights; a
recording cut off after four minutes shows none), and the reads of other players' ranks
run start to finish on copies of two real games, one through the League client and one
with a Riot key: all 10 players each time, in about 11 seconds. Every new screen was
checked with the sample data in a browser, 1000 to 1700 px wide: the library in both
layouts, the player, the Players tab, the full scoreboard and its keys, the Review tab,
Trends, a matchup note and the playlist of early deaths. The page logged no errors and
no picture failed to load. The published installer was downloaded by 0.5.0's own
updater, which accepted its signature. Not checked: the new screens in the app with real
games, several new games read in one go, and the break notice after real losses.

## Version 0.6.1 (2026-11-15)

**Delete a game's video and keep its stats.** "Delete the video, keep the stats" in the
player's More menu, and "Delete videos" for the games picked in the library, delete a
game's video and sound and keep the rest of its folder: the live-game numbers, Riot's
record of the game, rank and LP, the review, notes, tags, hints and the thumbnail. The
game stays in the library, marked "No video", and in Trends. Opening it shows its
scoreboard, review, notes and players with nothing to play, and walk-throughs skip it.
An undo is offered for a few seconds, as for deleting a game.

- **The size limit** works the same way now: past the limit it deletes the videos of
  the oldest games instead of the games, and a screen recording (which has no stats)
  whole. Kept games are never touched.
- **Riot's rank emblems**: ranks show with Riot's own emblem for the tier instead of
  the drawn crest, on both scoreboards, the Players tab, the rank card in Trends, "Your
  last game" in the library and the picture of a game for Discord. The ten emblems come
  with the app (120 KB together), so they show offline and nothing is fetched for them.
  A player without a rank gets a plain outline.

Checked: the unit tests (71, two of them new: deleting a video keeps the stats; the size
limit deletes old videos and keeps their games, passes over kept games and the newest
one, and removes a screen recording whole), the type check, a full build, and with the
sample data in a browser: the "No video" marks in the grid and list, "Delete videos" for
a selection with its undo and after it runs, deleting from the player (undone, and with
the game left open while it goes through), the game without its video, the size limit's
texts in Settings and the storage popover, Trends, and every place the emblems show (all
ten tiers and the outline at each size the app uses, 12 to 56 px tall, on a normal and a
2x screen, and the picture of a game drawn with the emblem on it). The page logged no
errors and no picture failed to load. The published installer was downloaded by 0.6.0's
own updater, which accepted its signature. Not checked: the app itself with real games,
and a video that another program has open.

## Version 0.6.2 (2026-11-15)

**A setup guide.** A new PC starts with a guide over the whole window instead of the one
question about a recordings folder. The steps are listed on the left, each one slides in
the way you're going, and anything set in it can be changed later in Settings:

- **This PC**: League, FFmpeg, the free space and the connection to teammates, each
  ticked off as it's checked. A League folder or FFmpeg that wasn't found gets a button
  to choose it.
- **Recording**: the recordings folder with the free space on its drive, the size limit
  (with a warning when it's more than the drive has free), Start with Windows, and which
  queues to record.
- **Sound**: the Discord and microphone tracks, and a microphone picker with a live level
  that shows whether Rewatch hears you.
- **Teammates**: your name, filled in from League; your friend code in eight groups, the
  first one marked because that's what a teammate sees when you ask to connect; "Copy
  invite for Discord", a ready-made message with the code and the download link; and a
  field that takes a code or a whole pasted invite. Each teammate shows whether they've
  added you back, and turns to "Connected" by itself once they have. Requests to connect
  show up with an Add button.
- **Ready**: what's set up and what isn't, and three tips.

If Rewatch is closed halfway through, the guide opens again on the step it was on.
Settings has "Open the guide" under Status and "Pair step by step" under Teammates, and
the empty library's checklist opens the guide at the step that fixes each item. Settings
starts again from what the guide saved when the guide closes, so it can't save over it,
and the "Watch together" toast waits until the guide is closed.

Checked: the unit tests, the type check, a full build, the whole guide with the sample
data in a browser (every step, a PC without League or FFmpeg, every teammate state, a
request coming in, reopening on the step it was left at, and with reduced motion), and a
debug copy of the app on this PC with its own app id and data folder: the guide opened on
the first start, found FFmpeg and League, read the player's name from the League client
and the free space on C:. Not checked: the microphone level and connecting to a real
teammate in the app itself.

## Version 0.6.3 (2026-11-15)

**Updates without a restart.** With "Update by itself" on, a new version is downloaded in
the background while no game is running. A version that only changes the interface goes
in while the app runs: the window reloads to show it, on the screen it was on. If the
window is closed it reloads by itself a few seconds after closing, so the last edits are
saved first. If it's open, "Reload" in the bar does it. Recording and everything else carry
on. A version that changes the program itself still comes as an installer: it's downloaded
and checked beforehand, and installs without a window while the app sits in the tray,
then starts again hidden. With "Update by itself" off, nothing is downloaded until "Update
now" is pressed. Each release now also publishes its interface as one signed file
(`Rewatch_<version>_ui.json`) made for one exact build of the program. An installed copy
takes it only if its own program is that build, and only once the signature checks out.
It's kept in `%APPDATA%\Rewatch\interface\` for the next start and dropped once an
installer has replaced the program. The update site serves it from `/download/`, and a
release stops if the site doesn't. This version still arrives by installer for everyone.
Later ones that only change the interface don't need a restart.

Checked: the Rust tests (five new ones: the interface alone only for the same build of the
program, files only over https or from the update site itself, an interface surviving the
trip, one that doesn't fit refused, and a page keeping its own files while newer
interfaces come), the type check and a full build. A debug copy of the app was also tested:
its own app id and data folder, nothing recorded, against a stand-in for the update site on
this PC, with interface files signed with the release key. The packed interface held all 18
files of the build, byte for byte. Started hidden, as at Windows start-up, the check took
only the interface file (the installer was never asked for) and the window reloaded into it
in under half a second. After a restart it showed straight away and the check said it was
up to date. With the window open, the next version went in without a reload and "Reload"
showed in the bar. Once the window was closed, the page reloaded by itself 6 seconds later,
on the same Settings screen. "Reload now" reloads to the same screen and says "Updated to
version …". A page that said "not now" to reloading, as it does while an Undo runs, kept
getting its own files while two newer versions came in. The one in between was let go, and
a reload showed the newest. A kept interface changed on disk was refused at the next start
and removed, and the built-in one showed. The page logged no errors and no file failed to
load. Not checked: an installer update installing by itself (on this PC it would have
replaced the installed app), the six-hourly check on its own (the tests asked for it), the
page saying "not now" because of a real Undo or job (it was made to), and an interface-only
update through the real site: the first can only come with a version after this one.

Released: the update site was deployed first, and its landing page stayed the same, byte
for byte. Then 0.6.3 went out with its interface file, which the site serves. The installed
0.6.2 found 0.6.3, downloaded the installer and accepted its signature. The 0.6.3 build,
checked against the same announcement, says it's up to date.

## Version 0.7.0 (2026-11-16)

**Send a game to a coach.** In the player: More, Send to a coach. The coach gets that one
game in their own Rewatch (a smaller copy of the video with game sound, the timeline and
stats, the cursor and keys, the player's notes; the voice call and microphone only if
ticked), kept under "From students" apart from their own games, and what they write and
draw on it shows up in the player's recording. It travels straight between the two PCs,
like teammates' views; nothing is uploaded. How it works, who is told what, and what was
checked: "Sending a game to a coach" above. New files: `sharing.rs`, `Coaching.tsx`; new
settings: `coaches`, `students`; new section in Settings: Coaching.

This version changes the program, so it comes by installer and restarts the app.

Released: the installer and the interface file are on the site, which was left as it was.
The installed 0.6.3 found 0.7.0, downloaded the installer and accepted its signature, and
the 0.7.0 build, checked against the same announcement, says it's up to date.

## Next version (not released, 2026-11-16)

**Only League's window is recorded**, not the screen: other windows, alt-tabs and
notifications stay out. Needs Windows 11; elsewhere, or if the window can't be captured,
the whole screen is recorded as before and the notification says so. Setting: Video,
*Record only League's window* (on by default). `match.json` says which under `capture`.

**Champion select is rebuilt from what the League client reports**, and kept with the
game that follows. A *Champion select* button in the player shows both teams with their
roles and summoner spells, the bans, what your side is hovering, whose turn it is and
the timer, as they went, with the Discord call, the microphone and the client's sound
following the same sound controls. A list beside it says what happened (phases, bans,
hovers, picks, champions traded after locking in); a click on a line plays from just
before it, and marks on the timeline show the bans and picks. Space plays and pauses,
the arrow keys skip 5 seconds. Nothing on screen is recorded for it, so a minimized or
covered client makes no difference. The other team's hovers stay hidden, as in the
client (one sometimes shows in its last second). Settings: Which games, *Record
champion select* (on by default; needs *Ask the League client*), and *Also record the
client's window* (off by default) for a video of the client beside the picks, with a
*Picks* / *Client* switch between the two. It is never sent to a coach or a teammate.
New files: `champselect.rs`, `draft.rs`, `Draft.tsx`. How it works: "How a recording is
made" above.

**Less work for the processor.** League's window is sized to the chosen resolution on
the graphics card, as it is captured. The whole screen had to be copied back and
resized on the processor on this PC: the on-card resize has never worked here (`on-card
downscale (NVIDIA) unavailable` in the log since 2026-11-15). Measured over 10 seconds of
video: 9.6 seconds of processor time for the whole 2560x1440 screen made 1080p, 0.5
seconds for the 1280x720 League client window sized inside the capture. A 2560x1440 game
window hasn't been measured.

**Colours.** A recording whose colours are converted on the processor (a whole-screen
recording that is resized, or anything made with the processor encoder) now says which
colour formula it used. Before, the player read AV1 and H.265 recordings, and any HD
recording, with a different one: reds came out slightly orange and greens darker. The
NVIDIA encoder's files also said their picture was RGB at full range while the video
inside said BT.601; both now say BT.601. Recordings made before stay as they were.

**When League's window gives no picture.** If no picture comes from the window in the
first 5 seconds of a game, the recording switches to the whole screen; the first 7
seconds or so are then missing. A window that changes size mid-game is fitted into the
same picture, with black bars if its shape changed. When the game starts, a video of
the client's window, if one is recorded, gets 3 seconds to stop; if the window isn't
changing then (nothing to capture means FFmpeg doesn't hear the stop), FFmpeg is ended
and its last moments can be lost. The picks and the sound stop at once.

Bundles FFmpeg 9.0.2 (gyan.dev essentials, sha256
`60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`) instead of 7.1.1;
with an older FFmpeg the app still records, but only the whole screen.

Checked:

- The League client's window (1280x720) and test windows recorded on their own through
  the app, also while covered, with no frame drawn around them.
- A test copy of the app with a stand-in League client (`REWATCH_CLIENT_URL`) and a
  stand-in game, when champion select was recorded from the client's window: recorded
  3 seconds after the phase changed, then kept and joined into the game's folder
  (`draft.mp4` and its entry in `match.json`, nothing left in `.draft`); thrown away
  when the phase went back to `Lobby` or to `None`; after Stop, not started again in
  the same champion select, even after one unanswered request to the client, but
  started in the next one; the game's recording ended when its window closed, with no
  second recording while its process stayed; a game whose window came 6 seconds after
  its process still recorded from its window (the app waits up to 20 seconds for it);
  only GET requests went to the client.
- A window that gives no picture: the recording switched to the whole screen.
- Red, green, blue and grey from a test window come out right in Edge (the engine of
  the app's player): at 1080p for AV1 and H.264 recorded from a window with the NVIDIA
  encoder and with the processor encoder, and at 640x360 for a resized whole-screen
  recording in all three codecs. H.265 from a window is still slightly off in the
  player, as it was before.
- FFmpeg 9 with every existing FFmpeg job, the new interface with the sample data,
  `cargo test` (93) and the TypeScript build.
- A Practice Tool game with `npm run tauri dev`: League's borderless 2560x1440 window
  came out at 1920x1080, with no black pictures and nothing stuck beyond 1.6 seconds of
  loading screen; 87% of frames were new pictures. League's own log gave 236 fps on
  average while it was recorded (earlier 5v5 games, recorded the old way: 197 to 227).
  Champion select came from the client's window with the client's sound, Discord and
  the microphone, and went with the game. Its picture stops about 6 seconds before its
  sound: the client stopped drawing about 2 seconds before the game's process
  appeared, then FFmpeg was ended after its 3 seconds, which also started the game's
  recording 3 seconds later (still before the game clock started).
- Champion select as the client reported it in a ranked flex game and a Practice Tool
  game, kept as test data without names or accounts (`src-tauri/testdata`). Every pick,
  ban, role and summoner spell comes out as the client showed it; ten bans made at once,
  the other side's shown once revealed; the timer as the client counted it (it repeats
  its last count with when it was made, which is taken off); seats that swapped pick
  order; and the empty seat across in Practice Tool, which "locks in" nothing.
- A ranked flex game with `npm run tauri dev`: champion select kept for its game (198
  seconds, 28 changes) with the client's sound, Discord and the microphone. When the app
  restarted during a later champion select (the development build rebuilding itself),
  what was recorded before was thrown away; the last 58 seconds were recorded and went
  with the game.

Not yet checked: a 5v5 game's frame rate against one recorded the old way, exclusive
fullscreen (which may give black pictures rather than none), AMD and Intel encoders, the
on-card resize on a PC where it works, and Windows 10. For champion select: blind pick,
ARAM, Arena and custom games, and whether a player who has locked in can still swap pick
order (the list would then tell their pick again).

## Not built yet

Code signing (so Windows stops warning about the installer). A sample game for the
first launch. A percentage for FFmpeg jobs (their toasts show the time so far). Still
frames for the library's hover preview (it plays the video). A live microphone level in
Settings (Windows reports one only while some app has the microphone open).

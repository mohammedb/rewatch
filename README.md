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
every six hours (or on Settings, Updates, Check now), download the installer, check
its signature and run it. It installs by itself only while the window is closed and
no game is running or being recorded; with the window open it shows a bar with
"Update now" instead.

- The site is a small Cloudflare Worker (`updates-site/`, deployed as
  `rewatch-updates`) in front of the R2 bucket `rewatch-releases`, in the same
  Cloudflare account as the rest of ggwp.no. It serves `/` (landing page, not indexed), `/latest.json`,
  `/download/latest`, `/download/<installer>` and `/fonts/*`.
- The landing page is `updates-site/page.html`, bundled into the Worker as text;
  `{{cta}}` and `{{version}}` are filled from `latest.json` on each request. Inter is
  served by the Worker itself (`updates-site/fonts/`), so the page loads nothing from
  other sites. Headlines use Bahnschrift, which every Windows PC has; phones fall back
  to Inter. Preview it locally with the `rewatch-site` entry in `.claude/launch.json`
  (`wrangler dev` on port 8787; seed the local bucket with
  `npx wrangler r2 object put rewatch-releases/latest.json --file=... --local`).
- The Cloudflare account id is not in the repository: `release.mjs` reads it from
  `.secrets/cloudflare-account-id` (or the `CLOUDFLARE_ACCOUNT_ID` environment variable);
  set the same variable before `npx wrangler deploy` in `updates-site/`.
- The signing key is `.secrets/updater.key` (no password; never commit it, and keep a
  copy somewhere safe). Its public half is `src-tauri/updater.pub`, built into the
  app. Lose the key and installed apps can no longer be updated: everyone would have
  to install by hand once more.
- The updater is the app's own (`update.rs`), not Tauri's plugin, so it can be tried
  from the command line: `rewatch.exe --update-check --download` fetches the newest
  installer and checks its signature without running it.
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

## How a recording is made

- **Video**: FFmpeg grabs the display the game is on (Desktop Duplication) and feeds
  the graphics card's encoder directly. The encoder is picked automatically (NVIDIA,
  then AMD, then Intel, then the processor as a fallback that works anywhere). Each frame is stamped with wall-clock
  time, so the file itself records when video started.
- **Sound**: three WASAPI captures written to separate files on the same clock:
  the game process, Discord's process tree, and the microphone.
- **Mouse**: cursor position and button state are polled (no input hook) into `mouse.csv`.
- **Keys**: the state of a fixed list of game keys (Q W E R D F, 1 to 7, B, A, S, Tab,
  Space, Ctrl, Shift) is polled the same way into `keys.csv`, only while League's window
  is in front and never while the in-game chat is open (Enter opens and sends it, Esc
  closes it). Manual recordings have no key log.
- **Events**: `https://127.0.0.1:2999/liveclientdata/allgamedata` is read once a second.
  Purchases are detected from changes in each player's item list.
- When the game exits, the pieces are joined (video is copied, not re-encoded) into one
  folder per game: `game.mp4` (video + game sound), `discord.m4a`, `mic.m4a`,
  `mouse.csv`, `match.json`, `thumb.jpg`, and `review.json` for notes and drawings.

## Two hard rules

1. **Low cost.** Capture and encode stay on the graphics card, helper processes run at
   below-normal priority, nothing is drawn over the game, and joining happens after
   the game.
2. **Hands off the game.** The game process is never opened, injected into or hooked.
   No input hooks, no overlay, no automation.

## Tests

```
cd src-tauri
cargo test --lib                      # event and purchase detection
target\debug\rewatch.exe --test-record 10 --out C:\some\folder   # headless capture test
target\debug\rewatch.exe --list-mics
```

Two environment variables exist only for testing the automatic flow without League:
`REWATCH_GAME_EXE` (process name to treat as the game) and `REWATCH_LIVE_URL`
(address of a stand-in for the live-game feed).

## Layout

- `src-tauri/src/` Rust core: `session.rs` (one recording), `video.rs`, `audio.rs`,
  `liveclient.rs` (game feed and the numbers for the graph), `library.rs` (folders,
  clips, size limit), `pov.rs` (everything between teammates: views, notes, speech
  times, watching together), `copies.rs` (smaller copies for teammates), `voice.rs`
  (when someone was talking), `update.rs`, `insight.rs` (hints about deaths), `coach.rs` (written review), `team.rs` (team review of a fight), `titles.rs`, `highlights.rs`, `winutil.rs`, `settings.rs`, `lib.rs` (app
  wiring, watcher, commands).
- `src/` interface (React + TypeScript): `Games.tsx`, `Player.tsx`, `Views.tsx` (split
  view, zoom, cursor), `Timeline.tsx`, `Insights.tsx` (review tab, comms rows, graph),
  `SettingsPage.tsx`, `api.ts`.
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

## Not built yet

One reel of all highlights, League settings backup, on-card
downscaling (recordings are at the screen's own resolution), teammates' drawings in
the side views of split view (they show in the main view only), code signing (so
Windows stops warning about the installer).

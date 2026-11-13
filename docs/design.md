# Rewatch: personal League of Legends recorder and review app

Date: 2026-11-12. Working name "Rewatch" (my call, easy to change).

## Intent

The goal is to get better at League of Legends by reviewing your own games, alone
and together with friends. Today that would mean using RiftRec; this is a
free, independent tool with comparable features, plus one thing that matters for group
review: the Discord voice call and your own microphone recorded with the game,
so the comms are part of the review.

Group review happens over **Discord screen share** (a deliberate choice): you open a
recording in the app and share your screen. Friends watch; they do not need
the app.

This is a personal tool for one Windows PC. It is written from scratch.
Nothing from the RiftRec installer, code, name or artwork is used.

## Goals for the first version

1. **Automatic recording.** When a League game starts, recording starts; when
   it ends, recording stops and the game appears in the library. No clicks.
   Each queue type (ranked solo, flex, normal, ARAM, custom/practice...) can
   be switched on or off.
2. **Three separate sound tracks**: game sound, Discord (everything Discord
   plays, i.e. teammates' voices), and your microphone. Each can be muted or
   turned down on its own during review. This is essential: while screen
   sharing in a live Discord call you must be able to silence the recorded call.
3. **Hardware-encoded video** with settings for resolution, frame rate,
   quality and codec. Recording must not noticeably cost in-game FPS.
4. **Match library**: every recorded game with champion, win/loss, KDA, CS,
   queue, length and date.
5. **Event timeline** on the player: kills, deaths, assists, item purchases,
   dragons, herald, baron, towers, inhibitors, multikills and aces as markers.
   Click a marker to jump there (a few seconds before it). Filter by type;
   "my deaths" is one click. (Kills, item buys and objectives
   by name.)
5b. **Mouse recording.** The cursor is visible in the video, and its position
   and clicks are also logged separately so the review screen can show a
   cursor trail, left/right click markers and a clicks-per-minute graph that
   can be switched on and off.
6. **Review tools**: speed control, frame stepping, skip keys, timestamped
   notes, drawing on the video (pen, arrow, circle, colours, clear), and the
   three-track sound mixer. Must read well when screen shared.
7. **Bookmark hotkey** in game (F8 by default) to mark a moment for later.
8. **Clips**: cut a range, or the seconds around an event or bookmark, into a
   standalone MP4 with the sound tracks you choose.
9. **Storage control**: choose the recordings folder; a size cap that deletes
   the oldest recordings first; a "keep" flag that protects a game from that.

## Second stage (after the first version is in daily use)

- Key-press overlay (which keys were pressed when).
- Automatic highlight reel from kills, deaths and objectives, and a
  "highlights only" mode that keeps the reel instead of the full game.
- Editing and backing up League's settings files.

## Not being built

Accounts, cloud storage, upload/share links, a public clips feed, a phone
app, AI coaching, and shared online review rooms. These are RiftRec's hosted
service; Discord screen share was chosen instead.

## The two hard rules (extremely important)

**1. It must not cost noticeable performance.**
- Video goes from screen to the NVIDIA encoder on the graphics card without
  passing through main memory; the processor does almost none of the work.
- Recorder processes run at below-normal priority. Riot's data feed is read
  about once a second. Mouse position is sampled at a low fixed rate.
- Nothing is drawn over the game: no overlay, no in-game window.
- Heavy work (joining files, thumbnails, clips) happens only after the game.
- The capture test measures in-game FPS with recording off and on. Target:
  under 3% average FPS loss. If it is worse, settings are lowered or the
  approach is changed before anything else is built.

**2. It must stay clear of the anti-cheat.**
- It never touches the game process: no injection, no reading or writing
  game memory, no hooks placed in the game, no overlay inside it, no
  automation of any input. It only observes from outside.
- Picture: Windows' own screen duplication, the same kind of capture OBS's
  display capture uses.
- Sound: Windows' own per-application sound capture.
- Mouse: read from Windows (cursor position polling and Windows' raw input
  feed). No input hook is installed, so nothing sits in the path between the
  mouse and the game, and nothing can add input delay.
- Game data: Riot's Live Client Data API, which Riot documents for
  third-party tools. It is the only source for events, items, win/loss, KDA
  and CS. The League client's local API is used read-only and for one thing
  only: the queue name (ranked solo, flex, normal...), which the live feed
  does not give. That part is a setting. With it off, every game is recorded,
  the per-queue switches are disabled, and the library shows the game mode
  from the live feed instead of the queue name (my call).
- No administrator rights unless the capture test shows clicks cannot be
  read without them, in which case it becomes an opt-in setting.
- Honest limit: nobody outside Riot can promise what their anti-cheat will
  accept in future. These are the same outside-only methods that mainstream
  recorders use, which is the safest ground available.

## Anti-goals (failure even if it "works")

- Breaking either hard rule above.
- Losing a recording because the app or the game crashed mid-match.
- Sound drifting out of step with the video over a 40-minute game.
- A review screen where the recorded Discord call cannot be silenced.

## Constraints

Built and tested on Windows 11 with an NVIDIA graphics card and more than one
display, where the screens differ in size and refresh rate, so the recorder must
capture the display League is actually running on (found from the game window's
position), not a fixed one.
Checked on 2026-11-12: FFmpeg grabbed a display at 60 fps straight into the NVIDIA
H.264 encoder with no dropped frames in a 3-second test. That FFmpeg has no on-card
downscaler for this capture path.
Tools: Node 22, Rust, the Visual Studio build tools and FFmpeg 7.1.1.

## Approaches considered

**A. One desktop app with its own recorder (chosen).** A Tauri app: Rust core, web-technology interface. Video is
captured and encoded by a bundled FFmpeg (screen grab on the graphics card
straight into the NVIDIA encoder). The Rust core records the three sound
sources itself, using Windows' per-application sound capture for League and
Discord and the normal microphone input. When the game ends the pieces are
joined into the final files. Self-contained, small, all our own code. Cost:
the sound/video joining and timing is ours to get right, and it records the
whole monitor rather than only the game window.

**B. Drive OBS Studio in the background.** OBS already does screen capture,
per-application sound and multi-track files, and can be remote-controlled.
Least capture code and very proven. Cost: OBS must be running, the app has to
own an OBS profile, and it breaks if the user changes OBS for other uses. Kept as
the fallback if A's sound/video joining proves unreliable. Only OBS's display
or window capture may be used. OBS's "game capture" source is forbidden
because it works by hooking into the game, which breaks hard rule 2.

**If the FPS target is missed** (my call): B does not help, since it uses the
same kind of screen capture. The order is: lower the settings (frame rate,
resolution, encoder preset), then try capturing only the game window through
Windows' window-capture feature (approach C's capture half), and only then
consider accepting a higher cost.

**C. Fully native capture of only the game window with a hand-written
encoder pipeline.** The "purest" result, but weeks of low-level work for
little visible difference. Rejected for now.

Also rejected: Electron (same shape as A, heavier, and the native sound
capture is harder to do there); reusing RiftRec's binaries (not ours to use).

## How it works (approach A)

- **Detecting a game.** Watch for the League game process and Riot's local
  live-game data feed (the Live Client Data API on `127.0.0.1:2999`). Start
  recording as soon as the game process appears so nothing is missed; stop
  when it exits. The League client's local API (found through its lockfile)
  gives the queue name before the game, nothing else. Win/loss, KDA and CS
  are taken from the live feed's last reads and its game-end event.
- **Events.** Poll the live-game feed during the match and store each event
  with its game-clock time. Store the offset between game clock and recording
  clock so every event maps to a position in the video. The feed reports
  kills and objectives as events. It does not report purchases, but it lists
  every player's current items, so a purchase is detected when an item
  appears in that list between two reads (accurate to about a second).
- **Mouse.** Cursor position and button state are sampled with a timestamp
  and written to a small log file in the game's folder. The review screen
  draws the trail, click markers and clicks-per-minute graph from that log.
  Screen coordinates are stored together with the capture size so the
  overlay lines up at any playback size.
- **Sound.** Three independent captures, each written to its own file with a
  precise start time, so they can be lined up exactly when joined. "Discord"
  means the Discord app and all its child processes. The microphone is the
  Windows default input unless another is chosen in settings. The microphone
  track is the raw microphone for the whole game: it includes what you say
  while muted or not holding push-to-talk, and it is not what teammates heard
  after Discord's noise removal. That is accepted for the first version (my
  call) and the track is labelled "Microphone (raw)". Matching it to what
  teammates heard would need keyboard reading, which is second-stage.
- **Sharing in Discord.** Friends must be able to see the video and hear the
  recording through the share (my call). Whether you share the app window or
  the whole screen is your choice at the time, so both must work. Sound from
  the app's player and hardware-decoded video are known trouble spots for
  Discord's window share, so this is checked in the first capture test, not
  at the end. If window share cannot carry picture and sound, the documented
  way to share is the whole screen, and the player design is revisited.
- **Files.** One folder per game: the video (MP4, video plus game sound, so it
  plays anywhere), the Discord and microphone tracks as separate sound files
  for the in-app mixer, and small JSON files for match data, events, notes,
  drawings and bookmarks. The library is rebuilt by scanning these folders,
  so there is no database to corrupt. An export option writes one MP4 holding
  all three sound tracks for use in an editor such as DaVinci Resolve.
- **Player.** The video element plays picture and game sound; two sound
  elements play the Discord and microphone tracks, kept locked to the video
  position. Drawings are an overlay stored with their timestamp.
- **Defaults.** H.264, 60 fps, quality-based encoding. Resolution default is
  decided by the first capture test (see below).

## Left to the builder

- Exact FFmpeg capture/encode settings, and whether downscaling 4K to 1440p
  can be done on the graphics card with this FFmpeg version. If not, record
  at native resolution or bundle a newer FFmpeg.
- The crash-safe container used *while* recording, and how sound start times
  are measured and applied.
- Interface framework details (React + TypeScript + Vite assumed) and the
  visual design, which must be original.
- File and folder naming, settings storage, first-run flow (it should ask
  where recordings go).

## How we will know it works

- **First thing built is a capture test**: record the desktop for a short
  time with a test tone, Discord sound and the microphone; confirm three
  tracks, correct picture, sound in step with video at the start and end,
  and that mouse position and clicks are logged. The same test is then run
  inside a Practice Tool game to measure the FPS cost against the 3% target.
  The same test plays the result in a bare-bones player while it is shared in
  Discord (window share and whole-screen share) with a friend or a second
  account, to confirm picture and sound arrive.
  If the joining of sound and video fails, switch to approach B before
  building anything else. If the FPS target fails, follow the order under
  "If the FPS target is missed".
- Automated tests for event-to-video-time mapping, the storage cap, and the
  library scan, using saved samples of Riot's data feeds.
- A fake live-game feed so the whole record-and-review flow can be exercised
  without playing.
- Final check: one Practice Tool game, then one real game, reviewed
  over Discord screen share with a friend.

## One thing to do outside the app

The Discord track records other people's voices. Tell the people you play
with that calls are being recorded.

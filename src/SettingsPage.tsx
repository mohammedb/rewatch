import { AudioLines, CircleDot, Copy, Download, Sparkles, ListVideo, Plus, ShieldCheck, Users, Video, X, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, pickFolder } from "./api";
import type { Environment, Friend, MicInfo, QueueToggles, Settings, ShareInfo, UpdateInfo } from "./types";

const QUEUES: [keyof QueueToggles, string][] = [
  ["rankedSolo", "Ranked Solo/Duo"],
  ["rankedFlex", "Ranked Flex"],
  ["normal", "Normal"],
  ["aram", "ARAM"],
  ["custom", "Custom and Practice Tool"],
  ["other", "Other modes"],
];

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="set">
      <h2><Icon size={19} aria-hidden />{title}</h2>
      <div className="rows">{children}</div>
    </section>
  );
}

function Opt({ title, hint, children, wide }: { title: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`opt ${wide ? "wide" : ""}`}>
      <div>{title}{hint && <small>{hint}</small>}</div>
      <div className="ctl">{children}</div>
    </div>
  );
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

/** One teammate: a name for them and the friend code their app shows. */
function FriendRow({ friend, onChange, onRemove, onCommit }: { friend: Friend; onChange: (f: Friend) => void; onRemove: () => void; onCommit: () => Promise<void> }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      // Save first: a teammate only counts once saved, and checking an unsaved one
      // would connect to them while their requests to you were still refused.
      await onCommit();
      const name = await api.friendPing(friend.code);
      setResult({ ok: true, text: `Connected${name ? ` to ${name}` : ""}. You can watch their view of games you both recorded.` });
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="friend">
      <input className="field-input" type="text" placeholder="Name" aria-label="Teammate's name" value={friend.name} onChange={(e) => onChange({ ...friend, name: e.target.value })} />
      <input className="field-input" type="text" placeholder="Paste their friend code" aria-label="Teammate's friend code" value={friend.code} onChange={(e) => onChange({ ...friend, code: e.target.value.trim() })} />
      <button className="btn" disabled={testing || !friend.code.trim()} onClick={test}>{testing ? "Checking" : "Check"}</button>
      <button className="btn sq quiet danger" aria-label={`Remove ${friend.name || "teammate"}`} onClick={onRemove}><X size={16} /></button>
      {result && <span className={`result ${result.ok ? "ally" : "enemy"}`} role="status">{result.text}</span>}
    </div>
  );
}

export function SettingsPage({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [s, setS] = useState(settings);
  const [env, setEnv] = useState<Environment | null>(null);
  const [mics, setMics] = useState<MicInfo[]>([]);
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    api.environment().then(setEnv);
    api.listMicrophones().then(setMics);
    api.updateInfo().then(setUpdate).catch(() => {});
  }, []);
  // What to hand a teammate changes whenever sharing settings are saved, and people
  // asking to connect can turn up at any time while this page is open.
  useEffect(() => {
    setS(settings);
    const load = () => api.shareInfo().then(setShare).catch(() => setShare(null));
    load();
    const iv = setInterval(load, 3000);
    return () => clearInterval(iv);
  }, [settings]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setS((cur) => ({ ...cur, [key]: value }));
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  // Rough size of an hour of 1440p60 H.264 at this quality, to make the slider meaningful.
  const perHour = Math.round(18 * Math.pow(2, (23 - s.quality) / 6) * (s.fps / 60) * (s.codec === "h264" ? 1 : 0.65));

  return (
    <div className="page">
      <div className="sets-wrap">
      <div className="set-head"><h1>Settings</h1><p>Changes apply when you save them.</p></div>
      <div className="sets">
        <Section icon={CircleDot} title="Recording">
          <Opt title="Record games automatically" hint="Starts when a League game starts and stops when it ends. Nothing to press.">
            <Switch label="Record games automatically" checked={s.autoRecord} onChange={(v) => set("autoRecord", v)} />
          </Opt>
          <Opt title="Start with Windows" hint="Opens hidden in the tray when you sign in, so the app is already running when you queue up.">
            <Switch label="Start with Windows" checked={s.startWithWindows} onChange={(v) => set("startWithWindows", v)} />
          </Opt>
          <Opt title="Recordings folder" wide>
            <input className="field-input" type="text" value={s.recordingsDir} onChange={(e) => set("recordingsDir", e.target.value)} aria-label="Recordings folder" />
            <button className="btn" onClick={async () => { const d = await pickFolder(s.recordingsDir); if (d) set("recordingsDir", d); }}>Browse</button>
          </Opt>
          <Opt title="Size limit" hint="When the folder grows past this, the oldest games are deleted first. Kept games never are. 0 turns the limit off.">
            <input className="field-input num" type="number" min={0} style={{ width: 90 }} value={s.quotaGb} aria-label="Size limit in GB" onChange={(e) => set("quotaGb", Math.max(0, Number(e.target.value) || 0))} />
            <span className="muted">GB</span>
          </Opt>
          <Opt title="Tell me when recording starts" hint="A Windows notification when a recording starts, is saved, or could not start. Windows hides these during a game if its Do not disturb is set to.">
            <Switch label="Tell me when recording starts" checked={s.notify} onChange={(v) => set("notify", v)} />
          </Opt>
          <Opt title="Save highlights as clips" hint="Multikills, aces, fights over Baron and dragons, and team fights won clearly are saved by themselves as short 1080p clips with game sound, Discord and your microphone, next to the recording. At most six a game, made after the game ends. They count towards the size limit and go when the game is deleted.">
            <Switch label="Save highlights as clips" checked={s.autoHighlights} onChange={(v) => set("autoHighlights", v)} />
          </Opt>
          <Opt title="Bookmark key" hint="Press it in game to mark a moment for later, for example F8 or Ctrl+Shift+B. The key still reaches the game, so pick one League does not use. Leave empty to turn it off.">
            <input className="field-input" type="text" style={{ width: 90 }} value={s.bookmarkHotkey} aria-label="Bookmark key" onChange={(e) => set("bookmarkHotkey", e.target.value)} />
          </Opt>
        </Section>

        <Section icon={ListVideo} title="Which games">
          <Opt title="Ask the League client which queue it is" hint="One read-only request when a game starts. Without it the app cannot tell ranked from normal, so it records every game.">
            <Switch label="Ask the League client which queue it is" checked={s.useClientApi} onChange={(v) => set("useClientApi", v)} />
          </Opt>
          <Opt title="Queues to record" wide>
            <div className="checks">
              {QUEUES.map(([key, label]) => (
                <button key={key} className="chip" disabled={!s.useClientApi} aria-pressed={s.useClientApi ? s.queues[key] : true} onClick={() => set("queues", { ...s.queues, [key]: !s.queues[key] })}>
                  {label}
                </button>
              ))}
            </div>
          </Opt>
        </Section>

        <Section icon={Video} title="Video">
          <Opt title="Frame rate" hint="Recorded at your screen's own resolution.">
            <div className="seg" role="group" aria-label="Frame rate">
              {[30, 60, 120].map((f) => <button key={f} aria-pressed={s.fps === f} onClick={() => set("fps", f)}>{f} fps</button>)}
            </div>
          </Opt>
          <Opt title="Format" hint="H.264 plays everywhere. The other two make smaller files but may not play on every device.">
            <div className="seg" role="group" aria-label="Format">
              {([["h264", "H.264"], ["hevc", "H.265"], ["av1", "AV1"]] as const).map(([v, label]) => (
                <button key={v} aria-pressed={s.codec === v} onClick={() => set("codec", v)}>{label}</button>
              ))}
            </div>
          </Opt>
          <Opt title="Encoder" hint="Automatic picks your graphics card's encoder, which costs the game almost nothing. Processor works on any PC but takes real processor time.">
            <select className="field-input" value={s.encoder} aria-label="Encoder" onChange={(e) => set("encoder", e.target.value as Settings["encoder"])}>
              <option value="auto">Automatic</option>
              <option value="nvenc">NVIDIA</option>
              <option value="amf">AMD</option>
              <option value="qsv">Intel</option>
              <option value="cpu">Processor (slow)</option>
            </select>
          </Opt>
          <Opt title="Quality" hint={`A lower number is sharper and bigger. About ${perHour} GB an hour at 1440p.`}>
            <input type="range" min={18} max={32} value={s.quality} aria-label="Quality" onChange={(e) => set("quality", Number(e.target.value))} />
            <span className="num" style={{ fontSize: 19, width: 24, textAlign: "right" }}>{s.quality}</span>
          </Opt>
        </Section>

        <Section icon={AudioLines} title="Sound and mouse">
          <Opt title="Record Discord" hint="Everything Discord plays, as its own track you can mute while reviewing.">
            <Switch label="Record Discord" checked={s.recordDiscord} onChange={(v) => set("recordDiscord", v)} />
          </Opt>
          <Opt title="Record your microphone" hint="The raw microphone for the whole game, including while you are muted in Discord.">
            <select className="field-input" value={s.micDevice} disabled={!s.recordMic} onChange={(e) => set("micDevice", e.target.value)} aria-label="Microphone" style={{ maxWidth: 240 }}>
              <option value="">Windows default</option>
              {mics.map((m) => <option key={m.id} value={m.id}>{m.name}{m.isDefault ? " (default)" : ""}</option>)}
            </select>
            <Switch label="Record your microphone" checked={s.recordMic} onChange={(v) => set("recordMic", v)} />
          </Opt>
          <Opt title="Record the mouse" hint="Cursor path and clicks, for the trail and the clicks-per-minute graph.">
            <Switch label="Record the mouse" checked={s.mouseTracking} onChange={(v) => set("mouseTracking", v)} />
          </Opt>
          <Opt title="Record game keys" hint="Which of Q W E R D F, 1 to 7, B, A, S, Tab, Space, Ctrl and Shift were held, for the key overlay. Only while League is in front, and nothing while the chat is open. Stays on this PC.">
            <Switch label="Record game keys" checked={s.keyTracking} onChange={(v) => set("keyTracking", v)} />
          </Opt>
        </Section>

        <Section icon={Users} title="Teammates">
          <div className="pairing first">
            <div className="line">
              <span>Your friend code</span>
              <code>{share?.code ? `${share.code.slice(0, 10)}…${share.code.slice(-6)}` : "…"}</code>
              <button className="btn mark" disabled={!share?.code} onClick={() => { copy(share!.code); setCopied(true); }}>
                <Copy size={14} aria-hidden />{copied ? "Copied" : "Copy code"}
              </button>
            </div>
            <p className="muted">
              Send your code to a teammate (paste it in Discord). One of you pastes the other's code below and presses Check; the other then sees a request here and adds it with one click. After that, each other's view shows up in the player for every game you both recorded.
            </p>
            {share?.error && <p className="enemy">{share.error}</p>}
          </div>
          {(share?.requests ?? []).map((r) => (
            <div className="pairing" key={r.code}>
              <div className="line">
                <span><b>{r.name || "Someone"}</b> wants to connect <span className="muted">(code {r.code.slice(0, 8)}…{r.code.slice(-4)})</span></span>
                <button className="btn mark" onClick={() => onSave({ ...s, friends: [...s.friends.filter((f) => f.code !== r.code), { name: r.name || "Teammate", code: r.code }] })}>
                  <Plus size={14} aria-hidden />Add as teammate
                </button>
              </div>
              <p className="muted">Only add people you know. Check that the start of the code matches what they see in their app.</p>
            </div>
          ))}
          <Opt title="Teammates" hint="Only the people listed here can watch your recordings. They get the video with game sound and your cursor trail, never your Discord or microphone tracks." wide>
            <button className="btn" onClick={() => set("friends", [...s.friends, { name: "", code: "" }])}><Plus size={15} aria-hidden />Add a teammate</button>
          </Opt>
          {s.friends.map((f, i) => (
            <FriendRow
              key={i}
              friend={f}
              onChange={(next) => set("friends", s.friends.map((x, j) => (j === i ? next : x)))}
              onRemove={() => set("friends", s.friends.filter((_, j) => j !== i))}
              onCommit={() => onSave(s)}
            />
          ))}
          <Opt title="Let my teammates watch my recordings" hint="Switch this off to keep watching theirs without sharing yours.">
            <Switch label="Let my teammates watch my recordings" checked={s.shareWithFriends} onChange={(v) => set("shareWithFriends", v)} />
          </Opt>
          <Opt title="Make smaller copies for teammates" hint="After each game a 1080p copy is made next to your recording, about a fifth of the size, and that is what teammates get. Made only while no game is running. Your own recording stays as it is.">
            <Switch label="Make smaller copies for teammates" checked={s.reviewCopies} onChange={(v) => set("reviewCopies", v)} />
          </Opt>
          <Opt title="Keep teammates' views on this PC" hint="Copies each teammate's view of games you both recorded into your own recording's folder, so it plays when they are offline. Counts towards your size limit and is deleted with the game. Copying pauses whenever either of you is in a game.">
            <Switch label="Keep teammates' views on this PC" checked={s.keepTeammateViews} onChange={(v) => set("keepTeammateViews", v)} />
          </Opt>
          <Opt title="Share my notes and drawings" hint="Teammates who recorded the same game see what you wrote and drew on it. They also see when you were talking (the times only, never the sound), which is what tells people apart on the comms rows.">
            <Switch label="Share my notes and drawings" checked={s.shareNotes} onChange={(v) => set("shareNotes", v)} />
          </Opt>
          <Opt title="Your name" hint="Shown to a teammate when they check the connection.">
            <input className="field-input" type="text" style={{ width: 180 }} value={s.shareName} aria-label="Your name" onChange={(e) => set("shareName", e.target.value)} />
          </Opt>
        </Section>

        <Section icon={Sparkles} title="AI review">
          <div className="promise">
            <p><b>Optional, and off until you switch it on.</b> After a game, the scoreboard and a 17-second clip of each of your deaths (720p, game sound only) are sent to Google's Gemini. Back comes a written review (what went well, what to work on, what happened in each death), a hint on how avoidable each death was, and a funny title for every player. From the Review tab you can also ask for a team review of a fight, which sends the same seconds from your screen and from each teammate's view. Your microphone and Discord are never sent. It runs after the game, never during one, and costs a cent or two per game on a paid key. On Google's free tier, Google may use what is sent to improve its products.</p>
            <p>Every player gets a title from the game's own numbers even with this off. Teammates see the AI's titles too if one of you has it on.</p>
          </div>
          <Opt title="Review my games with AI" hint="Done by itself after each game, and on request from the Review tab for older ones.">
            <Switch label="Review my games with AI" checked={s.aiReview} disabled={!s.geminiKey.trim()} onChange={(v) => set("aiReview", v)} />
          </Opt>
          <Opt title="Gemini API key" hint="Your own key from aistudio.google.com. It is kept in this PC's settings file and sent only to Google." wide>
            <input className="field-input" type="password" autoComplete="off" value={s.geminiKey} placeholder="Paste your key" aria-label="Gemini API key" onChange={(e) => setS((cur) => ({ ...cur, geminiKey: e.target.value.trim(), aiReview: e.target.value.trim() ? cur.aiReview : false }))} />
          </Opt>
        </Section>

        <Section icon={Download} title="Updates">
          <Opt title={`Version ${update?.current ?? "…"}`} hint={update?.installing ? "Updating now. The app restarts by itself." : update?.available ? `Version ${update.available.version} is ready. ${update.available.notes}` : update?.error ? `Could not check: ${update.error}` : update?.checked ? "This is the newest version." : "Not checked yet."}>
            {update?.available && !update.installing && (
              <button className="btn mark" onClick={() => api.updateInstall().catch(() => {}).then(() => api.updateInfo().then(setUpdate))}>Update now</button>
            )}
            <button className="btn" disabled={checking} onClick={() => { setChecking(true); api.updateCheck().then(setUpdate).catch(() => {}).finally(() => setChecking(false)); }}>{checking ? "Checking" : "Check now"}</button>
          </Opt>
          <Opt title="Update by itself" hint="New versions install on their own while the window is closed and no game is running or being recorded. With this off, the app only tells you when one is ready.">
            <Switch label="Update by itself" checked={s.autoUpdate} onChange={(v) => set("autoUpdate", v)} />
          </Opt>
        </Section>

        <Section icon={ShieldCheck} title="How it stays out of the game's way">
          <div className="promise">
            <p><b>Performance.</b> The picture goes from the screen straight to the graphics card's encoder. Recorder processes run at below-normal priority, and nothing is drawn over the game.</p>
            <p><b>Anti-cheat.</b> The game is never opened, injected into or hooked. The app reads the screen, the sound Windows already mixes per app, the cursor position, and the live-game data feed Riot provides for tools.</p>
          </div>
          <Opt title="FFmpeg" hint={env ? env.ffmpegVersion ?? "Not found. Recording needs it." : "Looking…"} wide>
            <input className="field-input" type="text" value={s.ffmpegPath} placeholder={env?.ffmpeg ? `Found automatically: ${env.ffmpeg}` : "Path to ffmpeg.exe"} aria-label="FFmpeg path" onChange={(e) => set("ffmpegPath", e.target.value)} />
          </Opt>
          <Opt title="League folder" wide>
            <input className="field-input" type="text" value={s.leagueDir} placeholder={env?.leagueDir ? `Found automatically: ${env.leagueDir}` : "Not found. Enter the folder League is installed in."} aria-label="League folder" onChange={(e) => set("leagueDir", e.target.value)} />
          </Opt>
        </Section>
      </div>

      {dirty && (
        <div className="savebar" role="status">
          <span>You have changes that are not saved yet.</span>
          <button className="btn quiet" onClick={() => setS(settings)}>Discard</button>
          <button className="btn mark" onClick={() => onSave(s)}>Save changes</button>
        </div>
      )}
      </div>
    </div>
  );
}

"""Build the landing page's footage, pictures and demo data from one real recording.

    python build_media.py <recording folder> [video|stills|data|all]

Writes media/ (uploaded to the bucket under media/, served at /media/) and demo.json
(bundled into the page). Needs ffmpeg with libsvtav1, libx264 and libwebp.
Every video is written without sound. The moments, deaths and pictures below are
picked for the 2026-11-13_00-42-08 game; another game needs new times.
"""
import json, os, subprocess, sys, bisect, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
G = sys.argv[1].rstrip("/\\")
LIB = os.path.dirname(G)
OUT = os.path.join(HERE, "media")
TMP = os.path.join(tempfile.gettempdir(), "rewatch-site-reel")
os.makedirs(OUT, exist_ok=True)
os.makedirs(TMP, exist_ok=True)

def L(n):
    return json.load(open(f"{G}/{n}", encoding="utf8"))

match = L("match.json")
clock = match["clock"]  # [video_t, game_t]
vt = [c[0] for c in clock]
gt = [c[1] for c in clock]

def game_time(t):
    i = bisect.bisect_right(vt, t) - 1
    i = max(0, min(i, len(vt) - 2))
    k = (t - vt[i]) / (vt[i + 1] - vt[i])
    return gt[i] + k * (gt[i + 1] - gt[i])

# Real moments from the game (video seconds).
SEGMENTS = [
    {"from": 69.5, "to": 80.5, "label": "First blood"},
    {"from": 733.0, "to": 746.0, "label": "Fire drake"},
    {"from": 794.5, "to": 804.0, "label": "Your notes"},
    {"from": 1150.5, "to": 1166.5, "label": "Ace"},
    {"from": 1682.0, "to": 1696.0, "label": "Final ace"},
]

def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2000:])
        sys.exit(1)

step = sys.argv[2] if len(sys.argv) > 2 else "all"

if step in ("all", "video"):
    parts = []
    for i, s in enumerate(SEGMENTS):
        p = f"{TMP}/seg{i}.mp4"
        run(["ffmpeg", "-v", "error", "-y", "-ss", str(s["from"]), "-i", f"{G}/game.mp4", "-t", str(s["to"] - s["from"]),
             "-an", "-vf", "scale=1920:1080:flags=lanczos,fps=30", "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", p])
        parts.append(p)
    with open(f"{TMP}/list.txt", "w") as f:
        for p in parts:
            f.write(f"file '{p}'\n")
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", f"{TMP}/list.txt", "-c", "copy", f"{TMP}/reel.mp4"])
    # AV1 for browsers that can, H.264 for the rest. No sound, ever.
    def encode(src, out, extra=()):
        run(["ffmpeg", "-v", "error", "-y", *extra, "-i", src, "-an", "-vf", "scale=1600:900:flags=lanczos",
             "-c:v", "libsvtav1", "-crf", "46", "-preset", "4", "-g", "60", "-pix_fmt", "yuv420p10le", "-movflags", "+faststart", f"{OUT}/{out}-av1.mp4"])
        run(["ffmpeg", "-v", "error", "-y", *extra, "-i", src, "-an", "-vf", "scale=1280:720:flags=lanczos",
             "-c:v", "libx264", "-crf", "29", "-preset", "slower", "-tune", "film", "-g", "60", "-pix_fmt", "yuv420p", "-movflags", "+faststart", f"{OUT}/{out}-h264.mp4"])
    encode(f"{TMP}/reel.mp4", "reel")
    # the hero loop: the 16 seconds around the Cloud Drake ace (reel offset 33.5s)
    hero_at = sum(s["to"] - s["from"] for s in SEGMENTS[:3])
    encode(f"{TMP}/reel.mp4", "hero", ["-ss", str(hero_at), "-t", "16"])
    run(["ffmpeg", "-v", "error", "-y", "-ss", str(hero_at), "-i", f"{TMP}/reel.mp4", "-frames:v", "1",
         "-vf", "scale=1920:1080", "-c:v", "libwebp", "-quality", "80", f"{OUT}/poster-hero.webp"])
    # the link preview picture other sites show
    run(["ffmpeg", "-v", "error", "-y", "-ss", str(hero_at), "-i", f"{TMP}/reel.mp4", "-frames:v", "1",
         "-vf", "scale=1200:675:flags=lanczos,crop=1200:630", "-pix_fmt", "yuvj420p", "-q:v", "3", f"{OUT}/og.jpg"])

def still(t, name, w=1600, src=None):
    run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", src or f"{G}/game.mp4", "-frames:v", "1",
         "-vf", f"scale={w}:-2:flags=lanczos", "-c:v", "libwebp", "-quality", "82", f"{OUT}/{name}.webp"])

if step in ("all", "stills"):
    # the demo player's poster: the first frame of the reel
    still(SEGMENTS[0]["from"], "poster-demo", 1600)
    coach = L("coach.json")
    for i, d in enumerate(coach["deaths"]):
        still(d["t"] - 1.2, f"death-{i + 1}", 1280)
    still(1155.6, "team", 1600)          # the air drake + ace fight, all five together
    still(1689.5, "final-ace", 1600)
    # the library tile: the thumbnails of the three real matches (practice-tool recordings left out)
    for d in ("2026-11-13_00-42-08", "2026-11-13_12-42-47", "2026-11-13_00-19-48"):
        thumb = f"{LIB}/{d}/thumb.jpg"
        if os.path.exists(thumb):
            run(["ffmpeg", "-v", "error", "-y", "-i", thumb, "-vf", "scale=640:-2", "-c:v", "libwebp", "-quality", "80", f"{OUT}/lib-{d}.webp"])

if step in ("all", "data"):
    # cursor, decimated to ~30 per second, coordinates 0..1000
    W, H, off = match["mouse"]["w"], match["mouse"]["h"], match["mouse"]["offset"]
    cur = [[] for _ in SEGMENTS]
    clicks = [[] for _ in SEGMENTS]
    prev = 0
    last_kept = [-1.0] * len(SEGMENTS)
    with open(f"{G}/mouse.csv") as f:
        next(f)
        for line in f:
            p = line.split(",")
            if len(p) < 4:
                continue
            t = int(p[0]) / 1000 - off
            b = int(p[3])
            for i, s in enumerate(SEGMENTS):
                if s["from"] <= t <= s["to"]:
                    rt = round(t - s["from"], 3)
                    x, y = round(int(p[1]) / W * 1000), round(int(p[2]) / H * 1000)
                    if rt - last_kept[i] >= 0.033:
                        cur[i].append([rt, x, y]); last_kept[i] = rt
                    if b & 2 and not prev & 2:
                        clicks[i].append([rt, x, y, 1])
                    if b & 1 and not prev & 1:
                        clicks[i].append([rt, x, y, 0])
            prev = b
    keep = {"ChampionKill", "DragonKill", "BaronKill", "HordeKill", "TurretKilled", "InhibKilled", "Ace", "Multikill", "FirstBlood"}
    events = []
    for e in match["events"]:
        if e["kind"] not in keep:
            continue
        if e["kind"] == "ChampionKill" and not e.get("mine"):
            kind = "kill" if e.get("good") else "enemy"
        elif e["kind"] == "ChampionKill":
            kind = {"kill": "kill", "assist": "assist", "death": "death"}.get(e.get("role"), "kill")
        else:
            kind = {"DragonKill": "dragon", "BaronKill": "baron", "HordeKill": "grubs", "TurretKilled": "tower", "InhibKilled": "tower",
                    "Ace": "ace", "Multikill": "multi", "FirstBlood": "first"}[e["kind"]]
        if kind == "multi" and e.get("detail", "2") == "2":
            continue
        events.append({"t": round(e["t"], 2), "g": round(game_time(e["t"]), 1), "k": kind, "good": bool(e.get("good")),
                       "who": e.get("killerChamp"), "vic": e.get("victimChamp"), "d": e.get("detail")})
    review = L("review.json")
    drawings = [{"t": d["t"], "shapes": [{"tool": s["tool"], "color": s["color"], "pts": [[round(a, 4), round(b, 4)] for a, b in s["pts"]]} for s in d["shapes"]]}
                for d in review["drawings"]]
    voice = L("voice.json")
    g = match["game"]
    out = {
        "duration": match["duration"],
        "gameLength": round(game_time(match["duration"]), 1),
        "clock": [[round(a, 3), round(b, 3)] for a, b in clock],
        "segments": [{**s, "g": round(game_time(s["from"]), 1)} for s in SEGMENTS],
        "cursor": cur,
        "clicks": clicks,
        "events": events,
        "drawings": drawings,
        "voice": {k: [[round(a, 1), round(b, 1)] for a, b in v] for k, v in voice.items()},
        "coach": L("coach.json"),
        "insights": L("insights.json"),
    }
    json.dump(out, open(os.path.join(HERE, "demo.json"), "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
    print("cursor points", [len(c) for c in cur], "clicks", [len(c) for c in clicks], "events", len(events))

print("done", step)

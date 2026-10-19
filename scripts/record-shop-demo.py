#!/usr/bin/env python3
"""Record the shopping-agent demo as an asciicast, then render GIF and MP4.

Runs the real commands and replays their output with readable pacing, so the
video always matches what `npm run demo:shop` prints. Needs agg
(https://github.com/asciinema/agg) and ffmpeg on PATH.

    python3 scripts/record-shop-demo.py      # writes docs/assets/shopping-demo.{cast,gif,mp4}
"""
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "assets")
COLS, ROWS = 112, 30
PROMPT = "\x1b[1;32m$\x1b[0m "

events = []
t = 0.0


def emit(text, delay=0.0):
    global t
    t += delay
    events.append([round(t, 3), "o", text])


def type_command(cmd):
    emit(PROMPT, 0.4)
    for ch in cmd:
        emit(ch, 0.035)
    emit("\r\n", 0.4)


def run(cmd, line_delay=0.05, pause_after=None):
    env = dict(os.environ, FORCE_COLOR="1")
    out = subprocess.run(cmd, shell=True, cwd=ROOT, env=env, capture_output=True, text=True, check=True).stdout
    for line in out.rstrip("\n").split("\n"):
        delay = line_delay
        if pause_after:
            delay = pause_after(line, line_delay)
        emit(line + "\r\n", delay)


def demo_pacing(line, base):
    # Linger on each decision so a viewer can read it.
    if "BLOCK" in line:
        return 1.6
    if "ALLOW" in line:
        return 0.9
    if line.strip().startswith(("1 ", "2 ", "3 ", "4 ", "5 ", "6 ", "7 ")):
        return 0.6
    return 0.35


emit("\x1b[2m# An agent with a wallet, behind the AgentProof MCP gateway. First, the household's policy:\x1b[0m\r\n", 0.2)
type_command("sed -n '/contracts:/,/window_ms/p' examples/shopping-agent/agentproof.yaml")
run("sed -n '/contracts:/,/window_ms/p' examples/shopping-agent/agentproof.yaml", line_delay=0.06)
emit("", 3.5)
emit("\x1b[2J\x1b[H", 0.1)
emit("\x1b[2m# Now the agent shops. It is a plain MCP client; the gateway decides every call.\x1b[0m\r\n", 0.2)
type_command("npm run -s demo:shop")
run("npm run -s demo:shop", pause_after=demo_pacing)
emit("", 5.0)

os.makedirs(OUT, exist_ok=True)
cast = os.path.join(OUT, "shopping-demo.cast")
with open(cast, "w") as f:
    f.write(json.dumps({"version": 2, "width": COLS, "height": ROWS, "env": {"TERM": "xterm-256color"}}) + "\n")
    for e in events:
        f.write(json.dumps(e) + "\n")

for tool in ("agg", "ffmpeg"):
    if not shutil.which(tool):
        sys.exit(f"wrote {cast}; install {tool} to render the GIF and MP4")

gif = os.path.join(OUT, "shopping-demo.gif")
mp4 = os.path.join(OUT, "shopping-demo.mp4")
subprocess.run(["agg", "--theme", "monokai", "--font-size", "16", "--idle-time-limit", "6", cast, gif], check=True)
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-i", gif, "-movflags", "faststart", "-pix_fmt", "yuv420p",
     "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-crf", "20", mp4],
    check=True,
)
print(f"wrote {cast}, {gif}, {mp4}")

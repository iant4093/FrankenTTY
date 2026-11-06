"""Synthesize the demo narration with Kokoro-82M (local, no account, no key).

Run from the repo root:
  uv run --python 3.12 --with kokoro==0.9.4 --with soundfile --with 'numpy<3' \
    python video/narration/narrate.py [--voice NAME] [--speed X] [--gap SEC]

Outputs (video/build/narration/):
  <id>.wav        one file per line, 48 kHz mono 16-bit
  <act>.wav       lines of that act joined with --gap seconds of silence
  durations.json  { "<act>": seconds, "<id>": seconds }
  voice.json      the voice probe results and the choice
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
LINES = ROOT / "video" / "narration" / "lines.json"
OUT = ROOT / "video" / "build" / "narration"

KOKORO_RATE = 24000
OUT_RATE = 48000

# Candidates in the order of Kokoro-82M's VOICES.md quality grades for English
# (af_heart A, am_michael C+, am_fenrir C+, bf_emma B-). The first candidate whose
# speech rate on act1 is in a sane range wins, so the model card's ranking decides.
CANDIDATES = ["af_heart", "am_michael", "am_fenrir", "bf_emma"]
MIN_WPM, MAX_WPM = 120.0, 185.0


def lang_code(voice: str) -> str:
    # Kokoro voice names start with a language letter: a = American, b = British.
    return voice[0]


def words(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", text))


def load_lines() -> dict[str, list[dict[str, str]]]:
    data = json.loads(LINES.read_text(encoding="utf-8"))
    return data["acts"]


class Synth:
    def __init__(self) -> None:
        from kokoro import KPipeline

        self._klass = KPipeline
        self._pipes: dict[str, object] = {}

    def pipe(self, code: str):
        if code not in self._pipes:
            self._pipes[code] = self._klass(lang_code=code, repo_id="hexgrad/Kokoro-82M")
        return self._pipes[code]

    def say(self, text: str, voice: str, speed: float) -> np.ndarray:
        pipe = self.pipe(lang_code(voice))
        parts = [np.asarray(audio, dtype=np.float32) for _, _, audio in pipe(text, voice=voice, speed=speed)]
        if not parts:
            raise RuntimeError(f"Kokoro returned no audio for: {text!r}")
        return np.concatenate(parts)


def resample_to_48k(samples: np.ndarray, dest: Path) -> None:
    """Write 24 kHz float samples as 48 kHz mono 16-bit WAV using ffmpeg."""
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.wav"
        sf.write(src, samples, KOKORO_RATE, subtype="PCM_16")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ar", str(OUT_RATE), "-ac", "1",
             "-c:a", "pcm_s16le", str(dest)],
            check=True,
        )


def choose_voice(synth: Synth, acts: dict, speed: float) -> tuple[str, list[dict]]:
    probe_text = " ".join(line["text"] for line in acts["act1"])
    n_words = words(probe_text)
    results = []
    for voice in CANDIDATES:
        samples = synth.say(probe_text, voice, speed)
        seconds = len(samples) / KOKORO_RATE
        wpm = n_words / seconds * 60.0
        results.append({"voice": voice, "seconds": round(seconds, 3), "wpm": round(wpm, 1)})
        print(f"voice probe: {voice:<11} {seconds:6.2f} s  {wpm:6.1f} wpm")
    for result in results:
        if MIN_WPM <= result["wpm"] <= MAX_WPM:
            return result["voice"], results
    return CANDIDATES[0], results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voice", help="skip the voice probe and use this Kokoro voice")
    parser.add_argument("--speed", type=float, default=1.0, help="Kokoro speed factor (default 1.0)")
    parser.add_argument("--gap", type=float, default=0.35, help="silence between lines inside an act, seconds")
    args = parser.parse_args()

    acts = load_lines()
    ids = [line["id"] for lines in acts.values() for line in lines]
    if len(ids) != len(set(ids)):
        print("FAIL: duplicate ids in lines.json", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    synth = Synth()

    if args.voice:
        voice, probe = args.voice, []
    else:
        voice, probe = choose_voice(synth, acts, args.speed)
    print(f"voice: {voice}")
    (OUT / "voice.json").write_text(
        json.dumps({"voice": voice, "speed": args.speed, "probe": probe}, indent=2) + "\n", encoding="utf-8"
    )

    durations: dict[str, float] = {}
    gap = np.zeros(int(round(args.gap * OUT_RATE)), dtype=np.int16)
    for act, lines in acts.items():
        pieces: list[np.ndarray] = []
        for index, line in enumerate(lines):
            dest = OUT / f"{line['id']}.wav"
            resample_to_48k(synth.say(line["text"], voice, args.speed), dest)
            data, rate = sf.read(dest, dtype="int16")
            assert rate == OUT_RATE and data.ndim == 1
            durations[line["id"]] = round(len(data) / OUT_RATE, 3)
            if index:
                pieces.append(gap)
            pieces.append(data)
        joined = np.concatenate(pieces)
        sf.write(OUT / f"{act}.wav", joined, OUT_RATE, subtype="PCM_16")
        durations[act] = round(len(joined) / OUT_RATE, 3)
        print(f"{act}: {durations[act]:.2f} s ({len(lines)} lines)")

    ordered = {act: durations[act] for act in acts}
    ordered.update({i: durations[i] for i in ids})
    (OUT / "durations.json").write_text(json.dumps(ordered, indent=2) + "\n", encoding="utf-8")
    total = sum(durations[act] for act in acts)
    print(f"total narration: {total:.2f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

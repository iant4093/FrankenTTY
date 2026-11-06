# Demo video

Rebuild the whole video with one command from the repo root:

```sh
video/build.sh
```

The result is `video/output/FrankenTTY_Demo.mp4` (H.264, AAC 192k, 1920x1080, 30 fps).
Logs for each step are in `video/build/logs/`. Skip any step with `--skip-<step>`; see
`video/build.sh --help`.

Needs `node` 24+, `ffmpeg`/`ffprobe`, [`uv`](https://docs.astral.sh/uv/) (narration) and `npm`
(Remotion). The first narration run downloads Kokoro-82M and its Python packages (a few
hundred MB, cached by uv and Hugging Face afterwards).

## Steps

| Step | What it does | Uses |
|---|---|---|
| `sessions` | Records real FrankenTTY runs in a PTY into `video/sessions/*.json` | `tools/session-recorder/record.ts` (task 6.A), real `src/main.ts` |
| `narration` | Speaks `video/narration/lines.json` (the narration blocks of `video/script.md`) and writes one WAV per line and per act, plus `durations.json` | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) running locally, via `uv run --python 3.12`; ffmpeg resamples to 48 kHz mono |
| `music` | Synthesizes an ambient pad (Am, Fmaj7, C, Em, 10 s per chord, slow tremolo) as long as the narration plus 6 s, peak below -20 dBFS | `ffmpeg -f lavfi aevalsrc` only; no samples |
| `copy` | Puts sessions, act narration WAVs, `durations.json` and `bed.wav` in `video/remotion/public/` | `cp` |
| `render` | Renders composition `FrankenTTYDemo` to `video/build/render.mp4`. Remotion places narration and music itself with `<Audio>`, and act lengths follow `durations.json` | Remotion (task 6.B) |
| `mix` | Two-pass `loudnorm` (`I=-14`, `TP=-1.5`, `LRA=11`) on the render's audio; copies the video stream when it is already H.264 yuv420p | ffmpeg |
| `checks` | Duration 120-175 s, 1920x1080, 30 fps, audio present, integrated loudness -15 to -13 LUFS; prints the numbers | ffprobe, ffmpeg `ebur128` |

A step whose input does not exist yet (`record.ts`, `video/remotion/`) is skipped with a
warning, so the narration and music steps work on their own.

## Run a step by hand

```sh
# Narration (add --voice bf_emma to skip the voice probe)
uv run --python 3.12 --with kokoro==0.9.4 --with soundfile --with 'numpy<3' \
  python video/narration/narrate.py

# Music, default length from durations.json, or a fixed length
video/music/music.sh
video/music/music.sh --duration 3 --output /tmp/bed.wav
```

## Narration voice

`narrate.py` renders the act 1 text with `af_heart`, `am_michael`, `am_fenrir` and `bf_emma`,
prints each speech rate, and takes the first voice in that order whose rate is 120-185 words
per minute. The order follows the quality grades in Kokoro-82M's `VOICES.md`, so `af_heart`
wins unless it is too slow or fast. The probe results and the choice are saved in
`video/build/narration/voice.json`.

## Editing the words

`lines.json` is the narration text, split into sentence groups with ids such as `act2-03`.
Its text must match the narration blocks in `video/script.md` (a test checks this), so edit
the script first and then the JSON.

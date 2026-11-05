---
name: ffmpeg-pipe
description: FFmpeg recipes for streaming raw RGB24 frames and audio into a Node process - argv, fast seeking, backpressure, and killing the process tree on every OS.
---

# FFmpeg raw pipes

## Video decode

```text
ffmpeg -hide_banner -loglevel error -nostdin [-ss SEC] -i INPUT \
  -an -sn -dn -vf fps=30,scale=W:H:flags=area,format=rgb24 \
  -f rawvideo -pix_fmt rgb24 pipe:1
```

- Put `-ss` before `-i` for fast seek. It works on lavfi sources too.
- `W` and `H` must be even. Each frame is exactly `W * H * 3` bytes.
- Decode once at the largest grid any render mode needs (Braille: `2c × 4r`)
  and downsample in code, so switching modes never restarts FFmpeg.
- Spawn with an argv array, never a shell. Pass the input after `-i` so a
  path starting with `-` is not read as an option.

## Framing and backpressure

- Pipe chunks do not align with frames. One 64 KB chunk can hold many small
  frames. Feed the assembler only the bytes it has room for, and keep the
  rest pending; pause the pipe when the queue is full. Pushing whole chunks
  into a full queue silently drops frames.
- Tag each decoder with a generation ID and drop bytes from older
  generations after a seek or resize.

## Audio

Decode with `ffmpeg -ss POS -i INPUT -vn -f wav -` and pipe into
`ffplay -nodisp -autoexit -i -`. Seeking with `ffplay -ss` directly costs
about 2 s more (FrankenTTY Wave 0), and the pipe makes `ffplay` exit when the
parent dies.

## Killing

- On Windows, `ffmpeg.exe` on `PATH` may be a Chocolatey or Scoop shim. Killing
  the shim leaves the real FFmpeg running and holding the pipe. Use
  `taskkill /pid N /T /F`.
- Destroy the child's stdout when killing, so end-of-stream fires even if a
  descendant still holds the pipe.

## Procedural test media

Use lavfi sources (`testsrc2`, `mandelbrot`, `life`, `cellauto`,
`gradients`) and `aevalsrc` audio. They need no files and carry no copyright.

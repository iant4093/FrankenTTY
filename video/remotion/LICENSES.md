# Licenses (video/remotion)

This folder is a separate npm project. It is not a dependency of the root package and nothing in `src/` imports it.

| Component | Version | License | Use |
|---|---|---|---|
| JetBrains Mono (`@fontsource/jetbrains-mono`) | 5.3.0 | SIL Open Font License 1.1 (checked: `node_modules/@fontsource/jetbrains-mono/LICENSE`, "Copyright 2020 The JetBrains Mono Project Authors") | Terminal text and all on-screen text. The Latin 400 and 700 `.woff2` files are copied to `public/fonts/` by `npm run prebuild`. |
| Remotion (`remotion`, `@remotion/cli`) | 4.0.541 | Remotion License: free for individuals and small teams, company license above that (https://www.remotion.dev/license) | Renders the video. Dev tooling only, not shipped with FrankenTTY. |
| `@xterm/xterm` | 6.0.0 | MIT | Parses the recorded terminal sessions. |
| React, React DOM | 19.3.1 | MIT | Remotion components. |

The OFL permits bundling and embedding the font in a rendered video. The font files themselves are not committed
(`public/fonts/` is generated and git-ignored); the license text stays in `node_modules/@fontsource/jetbrains-mono/LICENSE`.

All other assets are generated: terminal sessions are recordings of FrankenTTY running procedural `lavfi` demos,
narration comes from Kokoro (task 6.C), and the music is a procedural `ffmpeg` synth (task 6.C). No third-party media.

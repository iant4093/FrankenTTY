import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Heading, Source, typed, useFade, useProgress, useSpring } from '../components/ui.tsx';
import { planSegments, segmentsOf } from '../lib/acts.ts';
import type { DemoData, TreeNode } from '../lib/data.ts';
import { AMBER, AMBER_DIM, AMBER_HOT, BG, FONT_FAMILY, GREEN, PANEL, PANEL_BORDER, RED, TEXT, TEXT_DIM } from '../lib/theme.ts';

const Card: React.FC<{ style?: React.CSSProperties; children: React.ReactNode }> = ({ style, children }) => (
  <div style={{ background: PANEL, border: `1px solid ${PANEL_BORDER}`, borderRadius: 14, padding: '26px 32px', boxShadow: '0 20px 60px rgba(0,0,0,0.45)', ...style }}>{children}</div>
);

const Step: React.FC<{ n: number; title: string; sub?: string }> = ({ n, title, sub }) => (
  <div style={{ position: 'absolute', left: 90, top: 40 }}>
    <div style={{ fontFamily: FONT_FAMILY, fontSize: 20, color: AMBER, marginBottom: 6 }}>{`Built with Kiro · ${String(n)}/5`}</div>
    <Heading sub={sub}>{title}</Heading>
  </div>
);

// ---------------------------------------------------------------------------
// 1. The .kiro/ tree
// ---------------------------------------------------------------------------

interface TreeLine {
  text: string;
  dir: boolean;
}

export function flattenTree(nodes: TreeNode[], prefix = ''): TreeLine[] {
  const out: TreeLine[] = [];
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    const isDir = n.children !== undefined;
    out.push({ text: `${prefix}${last ? '└── ' : '├── '}${n.name}${isDir ? '/' : ''}`, dir: isDir });
    if (n.children !== undefined) out.push(...flattenTree(n.children, prefix + (last ? '    ' : '│   ')));
  });
  return out;
}

const TreeStage: React.FC<{ data: DemoData; total: number }> = ({ data, total }) => {
  const frame = useCurrentFrame();
  const fade = useFade(total, 10, 10);
  const lines = flattenTree(data.kiroTree);
  const perLine = Math.max(1, Math.floor((total * 0.55) / Math.max(1, lines.length)));
  const shown = Math.floor(frame / perLine);
  const note = useSpring(Math.round(total * 0.5));
  const top = data.kiroTree.map((n) => n.name);
  const notes: { dir: string; text: string }[] = [
    { dir: 'agents', text: data.kiro.agents.map((a) => `${a.name} (${a.model})`).join(' · ') },
    { dir: 'steering', text: 'rules every agent reads: product, tech, structure, roles' },
    { dir: 'hooks', text: data.kiro.hooks.join(' · ') },
    { dir: 'specs', text: 'EARS requirements, design, tasks' },
  ].filter((x) => top.includes(x.dir));
  return (
    <AbsoluteFill style={{ opacity: fade, fontFamily: FONT_FAMILY }}>
      <Step n={1} title="The .kiro/ folder" sub="agents, steering, hooks and specs, all tracked in Git" />
      <Card style={{ position: 'absolute', left: 90, top: 230, width: 760, height: 780, overflow: 'hidden' }}>
        <div style={{ fontSize: 26, color: AMBER, fontWeight: 700, marginBottom: 8 }}>.kiro/</div>
        <div style={{ fontSize: 24, lineHeight: '32px', whiteSpace: 'pre' }}>
          {lines.slice(0, shown).map((l, i) => (
            <div key={i} style={{ color: l.dir ? AMBER_HOT : TEXT }}>
              {l.text}
            </div>
          ))}
        </div>
      </Card>
      <div style={{ position: 'absolute', left: 930, top: 260, width: 900, opacity: note, transform: `translateX(${String((1 - note) * 40)}px)` }}>
        {notes.map((n) => (
          <div key={n.dir} style={{ marginBottom: 34 }}>
            <div style={{ fontSize: 32, color: GREEN, fontWeight: 700 }}>{`${n.dir}/`}</div>
            <div style={{ fontSize: 26, color: TEXT, lineHeight: 1.4 }}>{n.text}</div>
          </div>
        ))}
      </div>
      <Source style={{ position: 'absolute', left: 90, bottom: 24 }}>.kiro/ in this repository, read when the video was built</Source>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// 2. Architect and three builders
// ---------------------------------------------------------------------------

const Box: React.FC<{ x: number; y: number; w: number; h: number; color: string; p: number; children: React.ReactNode }> = ({ x, y, w, h, color, p, children }) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: w,
      height: h,
      boxSizing: 'border-box',
      background: PANEL,
      border: `2px solid ${color}`,
      borderRadius: 16,
      padding: '18px 26px',
      opacity: p,
      transform: `scale(${String(0.85 + 0.15 * p)})`,
      boxShadow: `0 0 30px ${color}33`,
    }}
  >
    {children}
  </div>
);

const WorktreeStage: React.FC<{ data: DemoData; total: number }> = ({ data, total }) => {
  const fade = useFade(total, 10, 10);
  const architect = useSpring(6);
  const d = Math.round(total * 0.18);
  const draw = useProgress(d, Math.round(total * 0.2));
  const back = useProgress(Math.round(total * 0.62), Math.round(total * 0.18));
  const agents = data.kiro.agents;
  const opus = agents.find((a) => a.name === 'architect-opus');
  const sonnet = agents.find((a) => a.name === 'builder-sonnet');
  const ys = [250, 470, 690];
  return (
    <AbsoluteFill style={{ opacity: fade, fontFamily: FONT_FAMILY }}>
      <Step n={2} title="One architect, three builders" sub="parallel tasks, each in its own git worktree" />
      <Box x={110} y={430} w={470} h={190} color={AMBER} p={architect}>
        <div style={{ fontSize: 32, fontWeight: 700, color: AMBER }}>architect-opus</div>
        <div style={{ fontSize: 20, color: TEXT_DIM, marginTop: 4 }}>{opus?.model}</div>
        <div style={{ fontSize: 22, color: TEXT, marginTop: 14 }}>specs · briefs · review</div>
      </Box>
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        {ys.map((y, i) => {
          const sx = 580;
          const sy = 525;
          const ex = 1010;
          const ey = y + 80;
          const path = `M ${String(sx)} ${String(sy)} C ${String(sx + 220)} ${String(sy)}, ${String(ex - 220)} ${String(ey)}, ${String(ex)} ${String(ey)}`;
          const len = 600;
          const p = interpolate(draw, [i * 0.15, i * 0.15 + 0.7], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          const q = interpolate(back, [i * 0.15, i * 0.15 + 0.7], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          const backPath = `M ${String(ex + 4)} ${String(ey + 24)} C ${String(ex - 220)} ${String(ey + 24)}, ${String(sx + 220)} ${String(sy + 50)}, ${String(sx)} ${String(sy + 50)}`;
          return (
            <g key={y}>
              <path d={path} fill="none" stroke={AMBER} strokeWidth={4} strokeDasharray={len} strokeDashoffset={len * (1 - p)} />
              <path d={backPath} fill="none" stroke={GREEN} strokeWidth={3} strokeDasharray={`${String(10)} ${String(8)}`} opacity={q} />
            </g>
          );
        })}
      </svg>
      {data.briefs.map((b, i) => (
        <BuilderBox key={b.id} id={b.id} title={b.title} model={sonnet?.model ?? ''} y={ys[i] ?? 0} delay={d + i * 6} />
      ))}
      <div style={{ position: 'absolute', left: 110, top: 700, width: 470, fontSize: 22, color: TEXT_DIM, opacity: back }}>
        <span style={{ color: GREEN }}>- - ▶</span> review, rerun tests, merge
      </div>
      <Source style={{ position: 'absolute', left: 90, bottom: 24 }}>{`docs/briefs/${data.briefs.map((b) => b.id).join(', ')}.md`}</Source>
    </AbsoluteFill>
  );
};

const BuilderBox: React.FC<{ id: string; title: string; model: string; y: number; delay: number }> = ({ id, title, model, y, delay }) => {
  const p = useSpring(delay, { damping: 14 });
  return (
    <Box x={1010} y={y} w={800} h={160} color={GREEN} p={p}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontSize: 30, fontWeight: 700, color: GREEN }}>builder-sonnet</div>
        <div style={{ fontSize: 22, color: AMBER_HOT }}>{`task ${id}`}</div>
      </div>
      <div style={{ fontSize: 20, color: TEXT_DIM, marginTop: 2 }}>{`${model} · own git worktree`}</div>
      <div style={{ fontSize: 28, color: TEXT, marginTop: 14 }}>{title}</div>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// 3. Hook block and property-test counterexample
// ---------------------------------------------------------------------------

const HookStage: React.FC<{ data: DemoData; total: number }> = ({ data, total }) => {
  const frame = useCurrentFrame();
  const fade = useFade(total, 10, 10);
  const card2 = useSpring(Math.round(total * 0.42));
  const { hook, pbt } = data;
  const line = hook.line;
  const typedLine = typed(line, (frame - 14) / 0.7);
  const blockAt = line.indexOf('BLOCK');
  const pre = typedLine.slice(0, Math.max(0, blockAt));
  const rest = typedLine.slice(Math.max(0, blockAt));
  const flash = interpolate(frame, [14 + blockAt * 0.7, 14 + (blockAt + 5) * 0.7 + 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const rows: [string, string][] = [
    ['source image', pbt.source],
    ['terminal', pbt.terminal],
    ['cell aspect', pbt.cellAspect],
    ['max cells', pbt.maxCells],
    ['result', pbt.result],
  ];
  return (
    <AbsoluteFill style={{ opacity: fade, fontFamily: FONT_FAMILY }}>
      <Step n={3} title="Hooks and property tests" sub="the turn does not end until the suite is green" />
      <Card style={{ position: 'absolute', left: 90, top: 250, width: 1740 }}>
        <div style={{ fontSize: 20, color: TEXT_DIM, marginBottom: 12 }}>
          {hook.real ? (
            <>
              <span style={{ color: AMBER }}>$ </span>tail -n 1 build/hooks/hooks.log
            </>
          ) : (
            <>{'gate-turn hook output (scripts/hooks/gate-turn.sh)'}</>
          )}
        </div>
        <div style={{ fontSize: 34, whiteSpace: 'pre', minHeight: 46 }}>
          <span style={{ color: TEXT }}>{pre}</span>
          <span style={{ color: RED, fontWeight: 700, textShadow: `0 0 ${String(24 * flash)}px ${RED}` }}>{rest.slice(0, 5)}</span>
          <span style={{ color: TEXT }}>{rest.slice(5)}</span>
        </div>
        <div style={{ fontSize: 22, color: TEXT_DIM, marginTop: 12 }}>Stop hook: typecheck, lint and tests must pass before the agent can finish.</div>
        <Source style={{ marginTop: 10 }}>{hook.source}</Source>
      </Card>
      <Card style={{ position: 'absolute', left: 90, top: 560, width: 1740, opacity: card2, transform: `translateY(${String((1 - card2) * 50)}px)` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
          <div style={{ fontSize: 30, fontWeight: 700, color: AMBER }}>{`${pbt.property} counterexample`}</div>
          <div style={{ fontSize: 20, color: TEXT_DIM }}>{`fast-check shrank it${pbt.runs === null ? '' : `, ${pbt.runs} runs`}`}</div>
        </div>
        <div style={{ display: 'flex', gap: 44, marginTop: 18 }}>
          <div style={{ fontSize: 26, lineHeight: 1.55 }}>
            {rows.map(([k, v]) => (
              <div key={k}>
                <span style={{ color: TEXT_DIM, display: 'inline-block', width: 220 }}>{k}</span>
                <span style={{ color: k === 'result' ? GREEN : TEXT }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 26, lineHeight: 1.5, flex: 1 }}>
            <div style={{ color: TEXT_DIM }}>bound in the spec</div>
            <div style={{ color: RED, textDecoration: 'line-through' }}>{pbt.boundWas}</div>
            <div style={{ color: TEXT_DIM, marginTop: 10 }}>actual error</div>
            <div style={{ color: AMBER_HOT }}>{pbt.error}</div>
            <div style={{ color: TEXT_DIM, marginTop: 10 }}>corrected bound</div>
            <div style={{ color: GREEN }}>{pbt.boundNow}</div>
          </div>
        </div>
        <Source style={{ marginTop: 14 }}>{`${pbt.file}, Wave 1 (the spec was wrong, the code was right)`}</Source>
      </Card>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// 4. MCP snapshot
// ---------------------------------------------------------------------------

const McpStage: React.FC<{ data: DemoData; total: number }> = ({ data, total }) => {
  const frame = useCurrentFrame();
  const fade = useFade(total, 10, 10);
  const { mcp } = data;
  const call = `${mcp.tool} ${JSON.stringify(mcp.arguments)}`;
  const callTyped = typed(call, (frame - 8) / 0.55);
  const rows = mcp.grid.split('\n');
  const rowsShown = Math.floor(interpolate(frame, [Math.round(total * 0.3), Math.round(total * 0.62)], [0, rows.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const sw = useSpring(Math.round(total * 0.62));
  return (
    <AbsoluteFill style={{ opacity: fade, fontFamily: FONT_FAMILY }}>
      <Step n={4} title="A tool that looks at the terminal" sub="MCP server: render a frame through a real terminal emulator, return the glyph grid" />
      <Card style={{ position: 'absolute', left: 90, top: 250, width: 1740 }}>
        <div style={{ fontSize: 22, color: TEXT_DIM }}>tools/call</div>
        <div style={{ fontSize: 26, color: AMBER_HOT, minHeight: 36, wordBreak: 'break-all' }}>{callTyped}</div>
      </Card>
      <Card style={{ position: 'absolute', left: 90, top: 400, width: 1000, height: 560 }}>
        <div style={{ fontSize: 22, color: TEXT_DIM, marginBottom: 14 }}>{`grid ${String(mcp.cols)}×${String(rows.length)} glyphs`}</div>
        <div style={{ fontSize: 25, lineHeight: '34px', color: GREEN, whiteSpace: 'pre' }}>
          {rows.slice(0, rowsShown).map((r, i) => (
            <div key={i}>{r.replaceAll(' ', '·')}</div>
          ))}
        </div>
      </Card>
      <Card style={{ position: 'absolute', left: 1130, top: 400, width: 700, height: 560, opacity: sw, transform: `translateX(${String((1 - sw) * 40)}px)` }}>
        <div style={{ fontSize: 22, color: TEXT_DIM, marginBottom: 18 }}>most common cell backgrounds</div>
        {mcp.topBackgrounds.slice(0, 4).map((b) => (
          <div key={b.color} style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 18 }}>
            <div style={{ width: 64, height: 64, borderRadius: 10, background: b.color, border: `1px solid ${PANEL_BORDER}` }} />
            <div style={{ fontSize: 30, color: TEXT }}>{b.color}</div>
            <div style={{ fontSize: 26, color: TEXT_DIM }}>{`${String(b.count)} cells`}</div>
          </div>
        ))}
        <div style={{ fontSize: 22, color: TEXT_DIM, marginTop: 26, lineHeight: 1.5 }}>
          {Object.entries(mcp.stats)
            .slice(0, 3)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join('  ·  ')}
        </div>
      </Card>
      <Source style={{ position: 'absolute', left: 90, bottom: 24 }}>
        {mcp.live ? 'tools/frankentty-mcp, called over stdio when the video was built' : 'tools/frankentty-mcp, recorded output (fixtures/mcp-snapshot.json)'}
      </Source>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// 5. CI matrix and install
// ---------------------------------------------------------------------------

const Tile: React.FC<{ name: string; delay: number }> = ({ name, delay }) => {
  const p = useSpring(delay, { damping: 11, stiffness: 160 });
  return (
    <div
      style={{
        width: 330,
        height: 74,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 18px',
        background: PANEL,
        border: `1px solid ${GREEN}66`,
        borderRadius: 12,
        opacity: Math.min(1, p),
        transform: `scale(${String(0.6 + 0.4 * p)})`,
      }}
    >
      <div style={{ width: 34, height: 34, borderRadius: 17, background: GREEN, color: '#031a03', fontSize: 24, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>✓</div>
      <div style={{ fontSize: 19, color: TEXT, lineHeight: 1.2 }}>{name}</div>
    </div>
  );
};

const CiStage: React.FC<{ data: DemoData; total: number }> = ({ data, total }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fade = useFade(total, 10, 10);
  const tiles = data.ci.jobs.flatMap((j) => j.tiles);
  const per = Math.max(1, Math.round((total * 0.4) / tiles.length));
  const released = useSpring(Math.round(total * 0.5), { damping: 10 });
  const cmd = data.install.command;
  const cmdStart = Math.round(total * 0.62);
  const cmdTyped = typed(cmd, (frame - cmdStart) / 0.45);
  const blink = Math.floor(frame / (fps / 2)) % 2 === 0;
  return (
    <AbsoluteFill style={{ opacity: fade, fontFamily: FONT_FAMILY }}>
      <Step n={5} title="CI on three operating systems" sub="every job green before a release is published" />
      <div style={{ position: 'absolute', left: 90, top: 240, width: 1740, display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {tiles.map((t, i) => (
          <Tile key={`${t}-${String(i)}`} name={t} delay={6 + i * per} />
        ))}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 90,
          top: 640,
          fontSize: 52,
          fontWeight: 700,
          color: GREEN,
          opacity: released,
          transform: `scale(${String(0.8 + 0.2 * released)})`,
          transformOrigin: 'left center',
        }}
      >
        {`${data.release} released`}
      </div>
      <Card style={{ position: 'absolute', left: 90, top: 760, width: 1740 }}>
        <div style={{ fontSize: 20, color: TEXT_DIM, marginBottom: 10 }}>install</div>
        <div style={{ fontSize: 30, color: AMBER_HOT, minHeight: 40, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <span style={{ color: AMBER }}>$ </span>
          {cmdTyped}
          <span style={{ display: 'inline-block', width: 16, height: 30, verticalAlign: 'middle', background: blink ? AMBER : 'transparent' }} />
        </div>
      </Card>
      <Source style={{ position: 'absolute', left: 90, bottom: 24 }}>{`${data.ci.file} · ${data.install.file}`}</Source>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------

export const Act4: React.FC<{ data: DemoData; frames: number }> = ({ data, frames }) => {
  const plan = planSegments(frames, segmentsOf(data.manifest.sessions).act4);
  const stages = [TreeStage, WorktreeStage, HookStage, McpStage, CiStage];
  return (
    <AbsoluteFill style={{ background: BG, color: TEXT }}>
      <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(ellipse at 80% 0%, ${AMBER_DIM}18, transparent 55%)` }} />
      {plan.map((seg, i) => {
        const Stage = stages[i];
        if (Stage === undefined) throw new Error(`no act4 stage ${String(i)}`);
        return (
          <Sequence key={seg.key} from={seg.from} durationInFrames={seg.frames}>
            <Stage data={data} total={seg.frames} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

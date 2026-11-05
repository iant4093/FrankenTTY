// Procedural demo sources for `--demo` (REQ-INGEST-03, REQ-COMP-03).
// Every video and audio stream is an FFmpeg lavfi filter string. No samples, no files.
// Pure data and pure functions: this module never spawns a process.

import { DEMOS } from '../cli/args.ts';
import type { MediaInfo } from './media-info.ts';

export const DEMO_NAMES = DEMOS;
export type DemoName = (typeof DEMO_NAMES)[number];

export interface DemoSource {
  name: DemoName;
  description: string;
  width: number;
  height: number;
  fps: 30;
  durationSec: 60;
  /** lavfi video source (with any post-processing), usable after `-f lavfi -i`. */
  videoFilter: string;
  /** lavfi audio source, 48 kHz stereo, peak at or below -12 dBFS. */
  audioFilter: string;
}

const WIDTH = 640;
const HEIGHT = 360;

// Audio: `aevalsrc` takes one expression per channel, separated by `|`. Expressions are
// single-quoted so the commas inside function calls survive filtergraph parsing.
// Each expression sums to a peak amplitude of at most 0.2 (-14 dBFS).
function stereo(left: string, right: string): string {
  return `aevalsrc=exprs='${left}|${right}':channel_layout=stereo:sample_rate=48000:duration=60`;
}

// One pentatonic note per 0.25 s. Phase restarts with each note, so there is no click at note changes.
function arpeggio(amp: number, octave: number): string {
  const semis = 'if(lt(ld(0),1),0,if(lt(ld(0),2),3,if(lt(ld(0),3),5,if(lt(ld(0),4),7,10))))';
  return (
    `st(0,mod(floor(t*4),5));${amp}*min(1,mod(t,0.25)*200)*exp(-6*mod(t,0.25))` +
    `*sin(2*PI*mod(t,0.25)*${220 * octave}*pow(2,${semis}/12))`
  );
}

const SOURCES: readonly DemoSource[] = [
  {
    name: 'mandelbrot',
    description: 'Slow zoom into the Mandelbrot set, with a slow detuned minor chord.',
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    durationSec: 60,
    // end_pts is in frames at rate=30: 1800 frames = 60 s, so the zoom ends with the clip.
    videoFilter:
      'mandelbrot=size=640x360:rate=30:maxiter=300:start_x=-0.743643887037151:start_y=0.131825904205330' +
      ':start_scale=3:end_scale=0.00005:end_pts=1800,trim=duration=60',
    audioFilter: stereo(
      '(0.06*sin(2*PI*220*t)+0.06*sin(2*PI*261.63*t)+0.06*sin(2*PI*329.63*t))*(0.7+0.3*sin(2*PI*0.1*t))',
      '(0.06*sin(2*PI*220.5*t)+0.06*sin(2*PI*262.13*t)+0.06*sin(2*PI*330.13*t))*(0.7+0.3*sin(2*PI*0.1*t+1))',
    ),
  },
  {
    name: 'life',
    description: "Conway's Life on a 128x72 grid, scaled 5x with nearest neighbor, with clicks on a 120 bpm beat.",
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    durationSec: 60,
    videoFilter:
      'life=size=128x72:rate=30:mold=12:life_color=#33ff99:death_color=#ff3366:random_seed=7' +
      ':random_fill_ratio=0.3:stitch=1,scale=640:360:flags=neighbor,trim=duration=60',
    audioFilter: stereo(
      '0.2*exp(-40*mod(t,0.5))*sin(2*PI*1000*t)+0.1*exp(-60*mod(t+0.25,0.5))*sin(2*PI*600*t)',
      '0.2*exp(-40*mod(t,0.5))*sin(2*PI*1000*t)+0.1*exp(-60*mod(t+0.25,0.5))*sin(2*PI*600*t)',
    ),
  },
  {
    name: 'cellauto',
    description: 'Rule 110 on a 160x90 grid, scaled 4x, with a rotating hue and a pentatonic arpeggio.',
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    durationSec: 60,
    videoFilter:
      'cellauto=size=160x90:rate=30:rule=110:random_fill_ratio=0.5:random_seed=7:full=1:start_full=1' +
      ':scroll=1:stitch=1,lutrgb=r=val*0.25:g=val*0.9:b=val,hue=h=t*12' +
      ',scale=640:360:flags=neighbor,trim=duration=60',
    // Five-note pentatonic over A3 (0, 3, 5, 7, 10 semitones), one note per 0.25 s with a short attack.
    // Right channel plays the same notes one octave up, quieter.
    audioFilter: stereo(arpeggio(0.2, 1), arpeggio(0.1, 2)),
  },
  {
    name: 'gradients',
    description: 'Six-color spiral gradient that drifts, with a slow frequency-modulated drone.',
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    durationSec: 60,
    videoFilter:
      'gradients=size=640x360:rate=30:duration=60:speed=0.03:seed=3:nb_colors=6:type=spiral' +
      ':c0=0xff0066:c1=0xffcc00:c2=0x00ff99:c3=0x0066ff:c4=0x9900ff:c5=0xff0066',
    audioFilter: stereo(
      '0.1*sin(2*PI*110*t+3*sin(2*PI*0.2*t))+0.08*sin(2*PI*165*t+2*sin(2*PI*0.13*t))',
      '0.1*sin(2*PI*110.4*t+3*sin(2*PI*0.2*t+1))+0.08*sin(2*PI*165.4*t+2*sin(2*PI*0.13*t+1))',
    ),
  },
  {
    name: 'testsrc2',
    description: 'FFmpeg test pattern with a 1 kHz beep at the start of every second (left) and 440 Hz (right), for A/V sync checks.',
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    durationSec: 60,
    videoFilter: 'testsrc2=size=640x360:rate=30:duration=60',
    audioFilter: stereo(
      '0.2*sin(2*PI*1000*t)*lt(mod(t,1),0.1)',
      '0.2*sin(2*PI*440*t)*lt(mod(t,1),0.1)',
    ),
  },
];

export function getDemo(name: string): DemoSource {
  const found = SOURCES.find((s) => s.name === name);
  if (found === undefined) {
    throw new RangeError(`Unknown demo "${name}". Allowed: ${DEMO_NAMES.join(', ')}`);
  }
  return found;
}

export function demoVideoInputArgs(src: DemoSource): string[] {
  return ['-f', 'lavfi', '-i', src.videoFilter];
}

export function demoAudioInputArgs(src: DemoSource): string[] {
  return ['-f', 'lavfi', '-i', src.audioFilter];
}

export function demoMetadata(src: DemoSource): MediaInfo {
  return {
    width: src.width,
    height: src.height,
    fps: src.fps,
    durationSec: src.durationSec,
    hasAudio: true,
    source: 'demo',
  };
}

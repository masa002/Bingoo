import type { Glow, Rarity, Tier } from '../fx/theme'
import { engine, type FilterSpec } from './engine'
import type { EventSfx, GaraponVoice } from './types'

// イベント・景品・ガラポン・UI の効果音。音声ファイルは使わず、すべてその場で合成する。
// 単純な音は engine.tone / noise で鳴らし、鐘・金管・合唱・紙や土の質感・ガラポンのように
// 包絡やフィルタを細かく動かしたい音は engine.ctx のノードを直接組む（出口は効果音バスと残響）。
// 音量は、重ねたときのピークが 0.5 を超えない程度に抑える。スマホで鳴る音（あおり・景品・選択・ガラポン）は控えめにする。
// index.ts でスプレッドして合成するので、this を使わない関数だけで書く

// ---- 小さな部品 ----

// 鳴らせる状態なら AudioContext を返す（未初期化や、音を切っているときは null で、何もしない）
function audio(): AudioContext | null {
  return engine.ready && engine.enabled ? engine.ctx : null
}

// MIDI の音番号を周波数に（60 = C4、69 = A4 = 440Hz、72 = C5、84 = C6、96 = C7）
const hz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12)
const rnd = (a: number, b: number): number => a + Math.random() * (b - a)
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
// ±c セントの範囲で音程をわずかにずらす倍率（同じ音が続いても機械的に聞こえないように）
const cents = (c: number): number => Math.pow(2, rnd(-c, c) / 1200)

// 長調の五音音階。きらめきの駆け上がりに使う（どの音が重なっても濁らない）
const PENTA = [0, 2, 4, 7, 9]
const penta = (root: number, i: number): number => root + 12 * Math.floor(i / 5) + PENTA[((i % 5) + 5) % 5]

// 自前で組んだ音の出口。定位を付けて効果音バスへつなぎ、残響へも送る
function outlet(ctx: AudioContext, pan = 0, reverb = 0): GainNode {
  const input = ctx.createGain()
  let tail: AudioNode = input
  if (pan) {
    const p = ctx.createStereoPanner()
    p.pan.value = clamp(pan, -1, 1)
    tail = input.connect(p)
  }
  tail.connect(engine.bus('sfx'))
  if (reverb > 0) {
    const send = ctx.createGain()
    send.gain.value = reverb
    tail.connect(send).connect(engine.reverb)
  }
  return input
}

// ---- 鐘・ベル ----

// 倍音の組（周波数の比・音量・減衰の長さの比）。高い倍音ほど早く消える
type BellKind = 'glass' | 'tube' | 'hand' | 'church' | 'tray'
type Partials = readonly (readonly [number, number, number])[]
const BELLS: Readonly<Record<BellKind, Partials>> = {
  // グロッケン・オルゴール風（きらきら）
  glass: [
    [1, 1, 1],
    [2.756, 0.3, 0.45],
    [5.404, 0.12, 0.25],
    [8.933, 0.05, 0.14],
  ],
  // チューブラーベル風（穏やかなチャイム）
  tube: [
    [1, 1, 1],
    [2.01, 0.45, 0.7],
    [3.02, 0.3, 0.5],
    [4.17, 0.18, 0.38],
    [5.43, 0.1, 0.28],
  ],
  // 手持ちの真鍮の鐘（カラン。倍音が整数倍からずれていて、金属らしく濁る）
  hand: [
    [1, 1, 1],
    [1.51, 0.35, 0.5],
    [2.32, 0.6, 0.55],
    [2.94, 0.45, 0.42],
    [4.18, 0.3, 0.3],
    [5.6, 0.18, 0.2],
    [7.1, 0.1, 0.14],
  ],
  // 教会の大きな鐘（うなり・短三度・五度・オクターブ。UR や大当たりの「ゴーン」）
  church: [
    [0.5, 0.55, 1.4],
    [1, 1, 1],
    [1.2, 0.4, 0.75],
    [1.5, 0.3, 0.6],
    [2, 0.5, 0.55],
    [2.51, 0.22, 0.4],
    [3.01, 0.14, 0.3],
  ],
  // 金属の受け皿（カン）
  tray: [
    [1, 1, 1],
    [1.59, 0.55, 0.6],
    [2.34, 0.4, 0.45],
    [3.21, 0.28, 0.3],
    [4.47, 0.15, 0.2],
  ],
}

interface BellOptions {
  at?: number // 何秒後に打つか
  dur?: number // いちばん長く残る倍音が消えるまでの秒数（の目安）
  gain?: number // 基音の音量。倍音を足すと、ピークはこの 1.5〜2 倍くらいになる
  pan?: number
  reverb?: number
  kind?: BellKind
  click?: number // 打った瞬間の「カッ」の強さ（0〜1）
}

// 鐘・ベルを 1 回打つ。倍音ごとに正弦波を重ね、打つたびに倍音をわずかにずらす（毎回同じ響きにしない）
function bell(freq: number, o: BellOptions = {}): void {
  const ctx = audio()
  if (!ctx) return
  const t0 = ctx.currentTime + (o.at ?? 0)
  const dur = o.dur ?? 1.2
  const gain = o.gain ?? 0.06
  const out = outlet(ctx, o.pan ?? 0, o.reverb ?? 0.3)
  out.gain.value = gain
  for (const [ratio, amp, decay] of BELLS[o.kind ?? 'glass']) {
    const f = freq * ratio * cents(5)
    if (f > 15000) continue
    const osc = ctx.createOscillator()
    osc.frequency.value = f
    const env = ctx.createGain()
    const end = t0 + Math.max(0.05, dur * decay)
    env.gain.setValueAtTime(0.0001, t0)
    env.gain.exponentialRampToValueAtTime(amp, t0 + 0.002)
    env.gain.exponentialRampToValueAtTime(0.0001, end)
    osc.connect(env).connect(out)
    osc.start(t0)
    osc.stop(end + 0.02)
  }
  if (o.click) {
    engine.noise({ at: o.at, dur: 0.018, gain: gain * o.click, attack: 0.001, filter: { type: 'highpass', freq: 3500 }, pan: o.pan })
  }
}

// ---- 金管・合唱 ----

interface BrassOptions {
  at?: number
  dur?: number
  gain?: number // 和音全体の大きさ
  pan?: number
  reverb?: number
  bright?: number // 明るさ（1 が標準。上げるとフィルタが開く）
}

// 金管っぽい和音。少しずらしたノコギリ波を 2 本ずつ重ね、吹いた瞬間に開いて落ち着くローパスに通す。
// 音程はわずかに下からしゃくり上げる（ラッパらしさ）
function brass(freqs: readonly number[], o: BrassOptions = {}): void {
  const ctx = audio()
  if (!ctx) return
  const t0 = ctx.currentTime + (o.at ?? 0)
  const dur = o.dur ?? 0.4
  const bright = o.bright ?? 1
  const peak = (o.gain ?? 0.1) / Math.sqrt(freqs.length * 2)
  const out = outlet(ctx, o.pan ?? 0, o.reverb ?? 0.25)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.Q.value = 1.4
  lp.frequency.setValueAtTime(500, t0)
  lp.frequency.exponentialRampToValueAtTime(4200 * bright, t0 + 0.04)
  lp.frequency.exponentialRampToValueAtTime(1800 * bright, t0 + 0.04 + Math.min(0.3, dur))
  const amp = ctx.createGain()
  amp.gain.setValueAtTime(0.0001, t0)
  amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.02)
  amp.gain.setTargetAtTime(peak * 0.72, t0 + 0.05, 0.1)
  amp.gain.setTargetAtTime(0.0001, t0 + dur, 0.08)
  lp.connect(amp).connect(out)
  for (const f of freqs) {
    for (const c of [-7, 7]) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = f
      osc.detune.setValueAtTime(c - 35, t0)
      osc.detune.linearRampToValueAtTime(c + rnd(-3, 3), t0 + 0.05)
      osc.connect(lp)
      osc.start(t0)
      osc.stop(t0 + dur + 0.6)
    }
  }
}

interface ChoirOptions {
  at?: number
  dur?: number
  gain?: number // ピークのおおよその大きさ
  attack?: number
  reverb?: number
}

// 合唱のような「あー」。1 音につき 3 声のずらしたノコギリ波を、母音「あ」の響き（フォルマント）に通し、ゆっくり震わせる
function choir(freqs: readonly number[], o: ChoirOptions = {}): void {
  const ctx = audio()
  if (!ctx) return
  const t0 = ctx.currentTime + (o.at ?? 0)
  const dur = o.dur ?? 2
  const attack = Math.min(o.attack ?? 0.3, dur * 0.5)
  const peak = o.gain ?? 0.08
  const reverb = o.reverb ?? 0.5
  const out = outlet(ctx, 0, reverb)
  // ローパスで角を取り、「あ」の共鳴する帯域（750・1150・2700Hz あたり）を持ち上げる
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 3200
  lp.Q.value = 0.5
  let tail: AudioNode = lp
  for (const [f, db, q] of [
    [750, 9, 2.5],
    [1150, 7, 3],
    [2700, 5, 4],
  ] as const) {
    const pk = ctx.createBiquadFilter()
    pk.type = 'peaking'
    pk.frequency.value = f
    pk.gain.value = db
    pk.Q.value = q
    tail = tail.connect(pk)
  }
  const amp = ctx.createGain()
  amp.gain.setValueAtTime(0.0001, t0)
  amp.gain.exponentialRampToValueAtTime(peak, t0 + attack)
  amp.gain.setValueAtTime(peak, t0 + Math.max(attack, dur * 0.55))
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  tail.connect(amp).connect(out)
  // 声の震え。速さの違う 2 つの揺れを交互に割り当てて、全員がそろって揺れないようにする
  const vib = [5.1, 5.9].map((rate) => {
    const lfo = ctx.createOscillator()
    lfo.frequency.value = rate
    const depth = ctx.createGain()
    depth.gain.value = 10
    lfo.connect(depth)
    lfo.start(t0)
    lfo.stop(t0 + dur + 0.05)
    return depth
  })
  const each = 1 / Math.sqrt(freqs.length * 3) / 3 // 共鳴の持ち上げ（最大 +9dB）の分を見込んで下げておく
  let k = 0
  for (const f of freqs) {
    for (const c of [-13, 0, 12]) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = f
      osc.detune.value = c + rnd(-4, 4)
      vib[k++ % 2].connect(osc.detune)
      const g = ctx.createGain()
      g.gain.value = each
      osc.connect(g).connect(lp)
      osc.start(t0)
      osc.stop(t0 + dur + 0.05)
    }
  }
  // 息の成分（ほんの少し）
  engine.noise({ at: o.at, dur, gain: peak * 0.12, attack, filter: { type: 'bandpass', freq: 1200, q: 1 }, reverb })
}

// ---- きらめき ----

interface SparkleOptions {
  at?: number
  root?: number // いちばん低い音（MIDI）
  count?: number
  gap?: number // 粒の間隔（秒）
  gain?: number
  dur?: number
  dir?: 1 | -1 // 1 = 駆け上がる、-1 = 降りてくる
  spread?: number // 左右への広がり（0〜1）
}

// シャララ: 五音音階のベルを速く連ね、左から右へ散らす
function sparkle(o: SparkleOptions = {}): void {
  const count = o.count ?? 8
  const gap = o.gap ?? 0.045
  const spread = o.spread ?? 0.7
  for (let i = 0; i < count; i++) {
    const step = o.dir === -1 ? count - 1 - i : i
    const pan = count > 1 ? spread * ((i / (count - 1)) * 2 - 1) : 0
    bell(hz(penta(o.root ?? 84, step)), {
      at: (o.at ?? 0) + (i + rnd(-0.2, 0.2)) * gap, // 揺らすのは 1 間隔の 2 割まで（順番が入れ替わらないように）
      dur: o.dur ?? 0.9,
      gain: (o.gain ?? 0.04) * rnd(0.75, 1),
      pan,
      reverb: 0.45,
    })
  }
}

// 金貨がこぼれるようなきらめき（高いベルを、ばらばらの間隔と高さで）
function coins(at: number, count: number, gain: number): void {
  let t = at
  for (let i = 0; i < count; i++) {
    t += rnd(0.025, 0.07)
    bell(rnd(2600, 4800), { at: t, dur: rnd(0.3, 0.6), gain: gain * rnd(0.5, 1), pan: rnd(-0.6, 0.6), reverb: 0.35 })
  }
}

// ---- 質感の素（紙・土・木の玉）----

// 粒の集まり（パリパリ・ザクザク）。density は 1 秒あたりの粒の数、shape は時間に沿った粒の多さと強さ（0〜1）
function grainBuffer(ctx: AudioContext, dur: number, density: number, shape: (x: number) => number = () => 1): AudioBuffer {
  const sr = ctx.sampleRate
  const len = Math.max(1, Math.floor(sr * dur))
  const buf = ctx.createBuffer(1, len, sr)
  const d = buf.getChannelData(0)
  const n = Math.round(density * dur)
  for (let k = 0; k < n; k++) {
    const pos = Math.floor(Math.random() * len)
    const s = shape(pos / len)
    if (Math.random() > s) continue // 粒の多さを shape で間引く
    const amp = (0.3 + Math.random() * 0.7) * s
    const glen = Math.floor(sr * rnd(0.0004, 0.003)) // 粒の長さ 0.4〜3ms
    for (let i = 0; i < glen && pos + i < len; i++) d[pos + i] += amp * (Math.random() * 2 - 1) * Math.exp(-i / (glen * 0.3))
  }
  return buf
}

// 紙が裂ける音の素。雑音の強さが数 ms ごとに不規則に揺れ（ビリビリ）、ときどき繊維が切れる鋭い粒（パリッ）が混ざる。
// 後半ほど速く裂ける
function tearBuffer(ctx: AudioContext, dur: number): AudioBuffer {
  const sr = ctx.sampleRate
  const len = Math.max(1, Math.floor(sr * dur))
  const buf = ctx.createBuffer(1, len, sr)
  const d = buf.getChannelData(0)
  let level = 0
  let target = 0
  let next = 0
  for (let i = 0; i < len; i++) {
    const x = i / len
    if (i >= next) {
      target = Math.random() < 0.25 ? rnd(0.05, 0.2) : rnd(0.45, 1)
      next = i + Math.floor(sr * rnd(0.003, 0.011) * (1 - 0.5 * x))
    }
    level += (target - level) * 0.02
    const fade = Math.min(1, x / 0.06) * Math.min(1, (1 - x) / 0.12)
    let v = (Math.random() * 2 - 1) * level * fade
    if (Math.random() < 0.0012) v += (Math.random() < 0.5 ? -1 : 1) * rnd(0.8, 1.6) * fade
    d[i] = v
  }
  return buf
}

interface BufferOptions {
  at?: number
  gain?: number
  pan?: number
  reverb?: number
  rate?: number
  filter?: FilterSpec
}

// 作った素材を、フィルタ・定位・残響を付けて 1 回鳴らす
function playBuffer(ctx: AudioContext, buf: AudioBuffer, o: BufferOptions = {}): void {
  const t0 = ctx.currentTime + (o.at ?? 0)
  const rate = o.rate ?? 1
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = rate
  const out = outlet(ctx, o.pan ?? 0, o.reverb ?? 0)
  out.gain.value = o.gain ?? 0.1
  let node: AudioNode = src
  if (o.filter) {
    const f = ctx.createBiquadFilter()
    f.type = o.filter.type
    f.Q.value = o.filter.q ?? 0.8
    f.frequency.setValueAtTime(o.filter.freq, t0)
    if (o.filter.to) f.frequency.exponentialRampToValueAtTime(o.filter.to, t0 + buf.duration / rate)
    node = node.connect(f)
  }
  node.connect(out)
  src.start(t0)
}

// 木の玉が木の壁や玉どうしに当たる「カッ」。12 通りを最初に作って使い回す（ガラポンは 1 秒に 100 粒近く鳴らすので、
// 粒ごとにフィルタを作らずに済むよう、共振フィルタまで済ませた音にしておく）
let clackCache: { ctx: AudioContext; list: AudioBuffer[] } | null = null

function clackBank(ctx: AudioContext): AudioBuffer[] {
  if (clackCache && clackCache.ctx === ctx) return clackCache.list
  const sr = ctx.sampleRate
  const list: AudioBuffer[] = []
  for (let v = 0; v < 12; v++) {
    const len = Math.floor(sr * 0.05)
    const buf = ctx.createBuffer(1, len, sr)
    const d = buf.getChannelData(0)
    // 当たった瞬間の雑音を、2 次の共振フィルタ（帯域通過）に通して「カッ」にする
    const w = (2 * Math.PI * rnd(1500, 4200)) / sr
    const alpha = Math.sin(w) / (2 * rnd(3, 8))
    const a0 = 1 + alpha
    const b0 = alpha / a0
    const a1 = (-2 * Math.cos(w)) / a0
    const a2 = (1 - alpha) / a0
    // 玉の胴鳴り（低めの、すぐ消える正弦波）
    const body = rnd(550, 1100)
    const bodyDecay = rnd(0.004, 0.012)
    const exciteDecay = rnd(0.0015, 0.004)
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    let peak = 0
    for (let i = 0; i < len; i++) {
      const t = i / sr
      const x = (Math.random() * 2 - 1) * Math.exp(-t / exciteDecay)
      const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y
      const s = y * 3 + Math.sin(2 * Math.PI * body * t) * Math.exp(-t / bodyDecay) * 0.4
      d[i] = s
      peak = Math.max(peak, Math.abs(s))
    }
    for (let i = 0; i < len; i++) d[i] *= 0.9 / (peak || 1)
    list.push(buf)
  }
  clackCache = { ctx, list }
  return list
}

// 「カッ」を 1 粒、決まった時刻（AudioContext の時刻）に鳴らす。dest は粒をまとめる出口
function clackAt(ctx: AudioContext, dest: AudioNode, t: number, gain: number, rate: number): void {
  const list = clackBank(ctx)
  const src = ctx.createBufferSource()
  src.buffer = list[Math.floor(Math.random() * list.length)]
  src.playbackRate.value = rate
  const g = ctx.createGain()
  g.gain.value = gain
  src.connect(g).connect(dest)
  src.start(Math.max(t, ctx.currentTime))
}

// ---- カード・リーチ・ビンゴ ----

// 穴が開く: 打った瞬間に音程が落ちる「ぽん」と、紙を抜く「パチ」、小さな「きらっ」。何度も鳴るので、毎回わずかに高さを変える
function stamp(): void {
  if (!audio()) return
  const k = cents(35)
  engine.tone(1050 * k, { dur: 0.08, slide: 360 * k, gain: 0.15, attack: 0.002 })
  engine.tone(2100 * k, { dur: 0.04, slide: 900 * k, gain: 0.03, attack: 0.001 })
  engine.noise({ dur: 0.022, gain: 0.06, attack: 0.001, filter: { type: 'bandpass', freq: 3200, q: 1.4 } })
  bell(hz(96) * k, { at: 0.015, dur: 0.4, gain: 0.03, reverb: 0.2 })
}

// リーチ: 駆け上がる「ピロリ」と、震えながら伸びる最後の音。2 本以上なら前振り・金管・高いベルを足して大きく
function reach(lines: number): void {
  if (!audio()) return
  const big = lines >= 2
  const t = big ? 0.28 : 0
  if (big) {
    engine.noise({ dur: 0.3, gain: 0.12, attack: 0.26, release: 0.04, filter: { type: 'bandpass', freq: 450, to: 5200, q: 1.1 } })
    engine.tone(120, { at: t, dur: 0.35, slide: 48, gain: 0.18, attack: 0.002 })
  }
  const notes = big ? [76, 81, 85, 88, 93] : [76, 81, 88]
  notes.forEach((m, i) => {
    const last = i === notes.length - 1
    const at = t + i * 0.065
    const dur = last ? (big ? 0.9 : 0.55) : 0.1
    const vibrato = last ? { rate: 7, depth: 22 } : undefined
    const pan = -0.25 + i * 0.12
    engine.tone(hz(m), { at, dur, type: 'square', gain: 0.045, filter: { type: 'lowpass', freq: 3400 }, vibrato, reverb: 0.2, pan })
    engine.tone(hz(m) * 2, { at, dur: dur * 0.7, type: 'triangle', gain: 0.02, vibrato, reverb: 0.2, pan })
  })
  if (big) {
    brass([hz(57), hz(61), hz(64), hz(69)], { at: t + 0.3, dur: 0.75, gain: 0.12 })
    bell(hz(93), { at: t + 0.3, dur: 1.4, gain: 0.05, reverb: 0.4 })
  }
}

// 自分のビンゴ: ドン！ → タタタ・ターン！（金管）→ きらめきとシンバルの余韻
function bingo(): void {
  if (!audio()) return
  engine.tone(110, { dur: 0.6, slide: 42, gain: 0.2, attack: 0.002 })
  engine.noise({ dur: 2.2, gain: 0.045, attack: 0.004, release: 2.1, filter: { type: 'highpass', freq: 5500 }, reverb: 0.35 })
  ;[0.02, 0.13, 0.24].forEach((at) => brass([hz(67), hz(55)], { at, dur: 0.08, gain: 0.08, bright: 1.1 }))
  brass([hz(60), hz(64), hz(67), hz(72), hz(76)], { at: 0.36, dur: 1.4, gain: 0.13, bright: 1.15 })
  engine.tone(hz(48), { at: 0.36, dur: 1.4, type: 'triangle', gain: 0.08, attack: 0.01, release: 0.6 })
  sparkle({ at: 0.4, root: 84, count: 10, gap: 0.04, gain: 0.035 })
  bell(hz(96), { at: 0.8, dur: 1.6, gain: 0.04, reverb: 0.5 })
}

// ---- 手元のあおり ----
// 段階: 0 青（静か）、1 緑、2 赤、3 金、4 虹（自分のビンゴ確定）。
// 途中で何度か呼ばれる aoriPulse は、回を重ねるたびに全音ずつ上がって高まる（aoriStart で数え直す）

let pulses = 0

function aoriStart(tier: Tier): void {
  if (!audio()) return
  pulses = 0
  switch (tier) {
    case 0:
      // 青: ほとんど気づかない「ふっ」
      engine.noise({ dur: 0.25, gain: 0.06, attack: 0.08, filter: { type: 'lowpass', freq: 1400, to: 500 } })
      break
    case 1:
      // 緑: ピロリン（軽い予告）
      engine.noise({ dur: 0.3, gain: 0.05, attack: 0.12, filter: { type: 'bandpass', freq: 1800, to: 6000, q: 1.5 } })
      ;[84, 88, 91].forEach((m, i) => bell(hz(m), { at: 0.05 + i * 0.06, dur: 0.7, gain: 0.05, pan: -0.3 + i * 0.3, reverb: 0.3 }))
      break
    case 2:
      // 赤: 吸い込んでから「ジャン！」。減七の和音で、不穏に期待を高める
      engine.noise({ dur: 0.24, gain: 0.1, attack: 0.22, release: 0.02, filter: { type: 'bandpass', freq: 500, to: 3500, q: 1 } })
      engine.tone(95, { at: 0.22, dur: 0.32, slide: 45, gain: 0.16, attack: 0.002 })
      brass([hz(57), hz(60), hz(63), hz(66)], { at: 0.22, dur: 0.5, gain: 0.1 })
      break
    case 3:
      // 金: キュイーン（震えながら駆け上がる）→ 金の和音と鐘、きらめき
      engine.tone(620, { dur: 0.42, slide: 2600, type: 'square', gain: 0.03, filter: { type: 'lowpass', freq: 4000 }, vibrato: { rate: 18, depth: 35 } })
      engine.tone(1240, { dur: 0.42, slide: 5200, gain: 0.02, vibrato: { rate: 18, depth: 35 } })
      engine.tone(100, { at: 0.42, dur: 0.4, slide: 42, gain: 0.16, attack: 0.002 })
      brass([hz(60), hz(64), hz(67), hz(72)], { at: 0.42, dur: 0.7, gain: 0.11, bright: 1.15 })
      bell(hz(84), { at: 0.42, dur: 1.2, gain: 0.04, kind: 'hand', reverb: 0.35 })
      sparkle({ at: 0.46, root: 91, count: 5, gain: 0.025 })
      break
    case 4: {
      // 虹（確定）: キュ・キュ・キュイーン → 合唱の和音と、両側に広がるきらめき
      ;[0, 0.11, 0.22].forEach((at, i) => {
        const last = i === 2
        const f = 880 * (1 + i * 0.12)
        const dur = last ? 0.5 : 0.08
        const vibrato = last ? { rate: 20, depth: 30 } : undefined
        engine.tone(f, { at, dur, slide: f * (last ? 4 : 2), type: 'square', gain: 0.03, filter: { type: 'lowpass', freq: 4500 }, vibrato })
        engine.tone(f * 2, { at, dur, slide: f * (last ? 8 : 4), gain: 0.015, vibrato })
      })
      const t = 0.72
      engine.tone(110, { at: t, dur: 0.6, slide: 38, gain: 0.16, attack: 0.002 })
      choir([hz(60), hz(64), hz(67), hz(71), hz(74)], { at: t, dur: 2.0, gain: 0.08, attack: 0.15 })
      brass([hz(72), hz(76), hz(79)], { at: t, dur: 0.6, gain: 0.08, bright: 1.2 })
      sparkle({ at: t + 0.03, root: 84, count: 12, gap: 0.035, gain: 0.03 })
      sparkle({ at: t + 0.5, root: 96, count: 8, gap: 0.05, gain: 0.02, dir: -1 })
      engine.noise({ at: t, dur: 1.8, gain: 0.025, attack: 0.3, release: 1.2, filter: { type: 'highpass', freq: 7500 }, reverb: 0.5 })
      break
    }
  }
}

function aoriPulse(tier: Tier): void {
  if (!audio()) return
  const n = Math.min(pulses++, 7)
  const up = Math.pow(2, (n * 2) / 12)
  if (tier >= 2) engine.tone(95, { dur: 0.16, slide: 45, gain: 0.07 + tier * 0.02, attack: 0.004 }) // 鼓動
  switch (tier) {
    case 0:
      engine.tone(1500 * up, { dur: 0.03, gain: 0.015, attack: 0.002 })
      break
    case 1:
      engine.tone(hz(76) * up, { dur: 0.16, type: 'triangle', gain: 0.045, reverb: 0.2 })
      engine.tone(hz(83) * up, { at: 0.07, dur: 0.14, type: 'triangle', gain: 0.03, reverb: 0.2 })
      break
    case 2: {
      // 半音でぶつかる 2 音（緊張）
      const filter: FilterSpec = { type: 'lowpass', freq: 1800 }
      engine.tone(hz(64) * up, { dur: 0.24, type: 'square', gain: 0.03, filter, attack: 0.004, pan: -0.2 })
      engine.tone(hz(65) * up, { dur: 0.24, type: 'square', gain: 0.022, filter, attack: 0.004, pan: 0.2 })
      engine.noise({ dur: 0.12, gain: 0.04, attack: 0.002, filter: { type: 'bandpass', freq: 2500 * up, q: 3 } })
      break
    }
    case 3:
      bell(hz(84) * up, { dur: 0.7, gain: 0.035, kind: 'hand', reverb: 0.3 })
      bell(hz(91) * up, { at: 0.06, dur: 0.6, gain: 0.03, reverb: 0.3 })
      engine.noise({ dur: 0.35, gain: 0.015, attack: 0.05, filter: { type: 'highpass', freq: 7000 }, reverb: 0.3 })
      break
    case 4: {
      // 虹は確定なので、緊張ではなく明るい和音で高める
      const base = 72 + n * 2
      ;[0, 4, 7, 12].forEach((iv, i) =>
        engine.tone(hz(base + iv), { at: i * 0.012, dur: 0.35, type: 'triangle', gain: 0.03, reverb: 0.35, pan: -0.3 + i * 0.2 }),
      )
      sparkle({ at: 0.05, root: base + 12, count: 3, gap: 0.04, gain: 0.025 })
      break
    }
  }
}

function aoriSuccess(tier: Tier): void {
  if (!audio()) return
  switch (tier) {
    case 0:
      bell(hz(84), { dur: 0.5, gain: 0.04, kind: 'tube' })
      break
    case 1:
      // ピンポン↑ ときらめき
      bell(hz(84), { dur: 0.8, gain: 0.06, kind: 'tube' })
      bell(hz(91), { at: 0.1, dur: 1.0, gain: 0.06, kind: 'tube' })
      sparkle({ at: 0.15, root: 96, count: 4, gain: 0.025 })
      break
    case 2:
      engine.tone(100, { dur: 0.4, slide: 45, gain: 0.16, attack: 0.002 })
      brass([hz(60), hz(64), hz(67), hz(72)], { dur: 0.55, gain: 0.12, bright: 1.1 })
      sparkle({ at: 0.08, root: 84, count: 6, gain: 0.03 })
      break
    case 3:
      // 金: タ・ターン！ と、こぼれる金貨
      engine.tone(90, { dur: 0.5, slide: 40, gain: 0.18, attack: 0.002 })
      engine.noise({ dur: 1.4, gain: 0.035, attack: 0.004, release: 1.3, filter: { type: 'highpass', freq: 5500 }, reverb: 0.35 })
      brass([hz(67), hz(55)], { dur: 0.09, gain: 0.08 })
      brass([hz(60), hz(64), hz(67), hz(72)], { at: 0.12, dur: 0.9, gain: 0.13, bright: 1.2 })
      coins(0.15, 14, 0.03)
      break
    case 4:
      // 虹（ビンゴ確定の成就）: 合唱・金管・鐘・きらめきを重ねて、いちばん華やかに
      engine.tone(110, { dur: 0.8, slide: 36, gain: 0.18, attack: 0.002 })
      engine.noise({ dur: 2.4, gain: 0.04, attack: 0.004, release: 2.3, filter: { type: 'highpass', freq: 5000 }, reverb: 0.45 })
      brass([hz(60), hz(64), hz(67), hz(72), hz(76)], { dur: 1.2, gain: 0.12, bright: 1.25 })
      choir([hz(60), hz(67), hz(72), hz(76), hz(79)], { at: 0.05, dur: 2.6, gain: 0.07, attack: 0.25 })
      bell(hz(72), { at: 0.05, dur: 2.6, gain: 0.05, kind: 'church', reverb: 0.5 })
      sparkle({ at: 0.1, root: 84, count: 14, gap: 0.032, gain: 0.03 })
      sparkle({ at: 0.75, root: 96, count: 10, gap: 0.045, gain: 0.02, dir: -1 })
      break
  }
}

// 確変失敗: 「ひゅるるる…ぽすっ」。口笛のような音が、震えを大きくしながら落ちていき、柔らかいところに落ちる。
// がっかりはするが、少しおどけていて、何度聞いても嫌にならない軽さにする（毎回少し違う高さから落ちる）
function aoriFail(): void {
  const ctx = audio()
  if (!ctx) return
  const t0 = ctx.currentTime
  const k = cents(80)
  const fall = 0.72 // 落ちきるまでの秒数
  const out = outlet(ctx, 0, 0.18)
  const whistle = ctx.createOscillator()
  whistle.frequency.setValueAtTime(1500 * k, t0)
  whistle.frequency.exponentialRampToValueAtTime(1250 * k, t0 + 0.14) // 一瞬ためてから
  whistle.frequency.exponentialRampToValueAtTime(240 * k, t0 + fall)
  // 「るるる」: 落ちるほど速く大きく震える
  const lfo = ctx.createOscillator()
  lfo.frequency.setValueAtTime(6, t0)
  lfo.frequency.linearRampToValueAtTime(11, t0 + fall)
  const depth = ctx.createGain()
  depth.gain.setValueAtTime(8, t0)
  depth.gain.linearRampToValueAtTime(110, t0 + fall)
  lfo.connect(depth).connect(whistle.detune)
  const amp = ctx.createGain()
  amp.gain.setValueAtTime(0.0001, t0)
  amp.gain.exponentialRampToValueAtTime(0.085, t0 + 0.04)
  amp.gain.setValueAtTime(0.085, t0 + fall * 0.55)
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + fall + 0.04)
  whistle.connect(amp).connect(out)
  whistle.start(t0)
  whistle.stop(t0 + fall + 0.1)
  lfo.start(t0)
  lfo.stop(t0 + fall + 0.1)
  engine.noise({ dur: fall, gain: 0.03, attack: 0.05, filter: { type: 'bandpass', freq: 3000 * k, to: 500 * k, q: 3 } }) // 息
  // ぽすっ
  engine.tone(180 * k, { at: fall, dur: 0.15, slide: 70, gain: 0.12, attack: 0.003 })
  engine.noise({ at: fall, dur: 0.1, gain: 0.12, attack: 0.002, filter: { type: 'lowpass', freq: 900, to: 260 } })
  // ぷしゅ…（気の抜けた小さな余韻）
  engine.noise({ at: fall + 0.08, dur: 0.32, gain: 0.03, attack: 0.04, filter: { type: 'bandpass', freq: 1700, to: 600, q: 1.8 } })
}

// ---- 虹玉（全員確定のワイルド）----

// シャララーン: 五音音階のベルが左から右へ駆け上がり、ゆらめく和音が広がる
function wildBall(): void {
  if (!audio()) return
  engine.noise({ dur: 2.4, gain: 0.03, attack: 0.5, release: 1.6, filter: { type: 'highpass', freq: 6500 }, reverb: 0.5 })
  sparkle({ root: 72, count: 15, gap: 0.042, gain: 0.045, spread: 0.85, dur: 1.4 })
  ;[72, 76, 79, 86, 91].forEach((m, i) => {
    for (const d of [-7, 7]) {
      engine.tone(hz(m), {
        at: 0.55 + i * 0.03,
        dur: 2.0,
        gain: 0.018,
        attack: 0.12,
        release: 1.4,
        detune: d,
        vibrato: { rate: 4.5 + i * 0.3, depth: 6 },
        pan: d > 0 ? 0.35 : -0.35,
        reverb: 0.5,
      })
    }
  })
  bell(hz(96), { at: 0.62, dur: 1.8, gain: 0.05, reverb: 0.5 })
  bell(hz(103), { at: 0.7, dur: 1.6, gain: 0.03, reverb: 0.5 })
}

// シャラン: 開く「ぽん」と、短い駆け上がり、残るきらめき（スマホ側なので短く控えめ）
function wildOpen(): void {
  if (!audio()) return
  engine.tone(900, { dur: 0.08, slide: 420, gain: 0.1, attack: 0.002 })
  sparkle({ at: 0.03, root: 79, count: 7, gap: 0.03, gain: 0.04, spread: 0.5, dur: 1.0 })
  bell(hz(91), { at: 0.24, dur: 1.4, gain: 0.045, kind: 'tube', reverb: 0.45 })
  bell(hz(96), { at: 0.26, dur: 1.2, gain: 0.03, reverb: 0.45 })
  engine.noise({ at: 0.2, dur: 1.0, gain: 0.018, attack: 0.1, release: 0.8, filter: { type: 'highpass', freq: 7000 }, reverb: 0.4 })
}

// ---- モグラ（BAD イベント）----

// ぴょこっ: 土がもこっと盛り上がり、音程が跳ね上がって「こっ」、最後に小さく「きゅっ」と鳴く
function moleAppear(): void {
  const ctx = audio()
  if (!ctx) return
  engine.noise({ dur: 0.16, gain: 0.2, attack: 0.03, filter: { type: 'lowpass', freq: 800, to: 300 } })
  playBuffer(ctx, grainBuffer(ctx, 0.15, 500), { gain: 0.08, filter: { type: 'bandpass', freq: 2000, q: 0.8 } })
  engine.tone(240, { at: 0.12, dur: 0.12, slide: 1150, type: 'triangle', gain: 0.13, attack: 0.004 })
  engine.tone(480, { at: 0.12, dur: 0.12, slide: 2300, gain: 0.04, attack: 0.004 })
  engine.tone(1300, { at: 0.24, dur: 0.05, gain: 0.08, attack: 0.001 })
  engine.noise({ at: 0.24, dur: 0.025, gain: 0.05, attack: 0.001, filter: { type: 'bandpass', freq: 2600, q: 3 } })
  engine.tone(1500, { at: 0.36, dur: 0.09, slide: 2100, gain: 0.035, attack: 0.01, vibrato: { rate: 30, depth: 60 } })
}

// ザク・ザク: スコップが土と砂利に刺さる（粒のかたまり＋土の重い雑音＋手応え）。最後に土がぱらぱら落ちる
function moleDig(): void {
  const ctx = audio()
  if (!ctx) return
  ;[0, 0.21].forEach((at, i) => {
    const g = i === 0 ? 1 : 0.8
    const pan = rnd(-0.25, 0.25)
    const grains = grainBuffer(ctx, 0.17, 1600, (x) => Math.pow(1 - x, 1.5))
    playBuffer(ctx, grains, { at, gain: 0.2 * g, pan, filter: { type: 'bandpass', freq: rnd(1700, 2500), q: 0.9 } })
    engine.noise({ at, dur: 0.13, gain: 0.16 * g, attack: 0.003, filter: { type: 'bandpass', freq: 1000, to: 380, q: 1.1 }, pan })
    engine.tone(120, { at, dur: 0.09, slide: 60, gain: 0.09 * g, attack: 0.002 })
  })
  playBuffer(ctx, grainBuffer(ctx, 0.35, 260, (x) => 1 - x), { at: 0.36, gain: 0.08, filter: { type: 'bandpass', freq: 2600, q: 0.8 } })
}

// ドスッ: 重い土のかたまりが穴に落ちる。続けて「あらら…」と下がる 2 音（こもった音で、しつこくしない）
function moleFill(): void {
  const ctx = audio()
  if (!ctx) return
  engine.tone(150, { dur: 0.3, slide: 40, gain: 0.2, attack: 0.002 })
  engine.tone(75, { dur: 0.4, slide: 36, gain: 0.1, attack: 0.002 })
  engine.noise({ dur: 0.25, gain: 0.22, attack: 0.002, filter: { type: 'lowpass', freq: 1500, to: 220 } })
  playBuffer(ctx, grainBuffer(ctx, 0.3, 700, (x) => Math.pow(1 - x, 2)), { at: 0.01, gain: 0.1, filter: { type: 'bandpass', freq: 1600, q: 0.8 } })
  engine.tone(hz(64), { at: 0.32, dur: 0.16, type: 'square', gain: 0.025, filter: { type: 'lowpass', freq: 1300 }, attack: 0.004 })
  engine.tone(hz(59), {
    at: 0.5,
    dur: 0.38,
    type: 'square',
    gain: 0.025,
    filter: { type: 'lowpass', freq: 1200, to: 500 },
    attack: 0.004,
    vibrato: { rate: 5, depth: 15 },
  })
}

// セーフ: ふわっと明るい 2 音（ほっとする）
function moleSafe(): void {
  if (!audio()) return
  engine.noise({ dur: 0.3, gain: 0.05, attack: 0.12, filter: { type: 'bandpass', freq: 1500, to: 4000, q: 1.5 } })
  bell(hz(79), { at: 0.02, dur: 0.6, gain: 0.06, kind: 'tube', pan: -0.15 })
  bell(hz(84), { at: 0.12, dur: 0.9, gain: 0.065, kind: 'tube', pan: 0.15 })
  engine.tone(hz(76), { at: 0.12, dur: 0.6, type: 'triangle', gain: 0.03, attack: 0.03, reverb: 0.3 })
}

// ---- 景品パック（オリパの開封）----

// パックが出てくる。光の格（白 < 金 < 虹）で音の格を変える。光はガセもあるので、白でも少しは期待が持てる明るさに
function packAppear(glow: Glow): void {
  if (!audio()) return
  if (glow === 'white') {
    // 白: ふわっと現れる
    engine.noise({ dur: 0.7, gain: 0.06, attack: 0.35, release: 0.35, filter: { type: 'bandpass', freq: 500, to: 3000, q: 0.9 } })
    ;[72, 79, 88].forEach((m, i) =>
      engine.tone(hz(m), { at: 0.2 + i * 0.05, dur: 1.0, gain: 0.025, attack: 0.15, release: 0.6, detune: rnd(-6, 6), reverb: 0.45 }),
    )
    sparkle({ at: 0.3, root: 96, count: 3, gap: 0.08, gain: 0.02 })
  } else if (glow === 'gold') {
    // 金: 低いうねりからせり上がり、金の和音と鐘、こぼれる金貨
    engine.noise({ dur: 0.9, gain: 0.1, attack: 0.6, release: 0.3, filter: { type: 'bandpass', freq: 300, to: 4000, q: 0.9 } })
    engine.tone(82, { dur: 1.3, slide: 98, gain: 0.1, attack: 0.5, release: 0.6 })
    brass([hz(60), hz(64), hz(67), hz(74)], { at: 0.6, dur: 0.9, gain: 0.1, bright: 1.1 })
    bell(hz(84), { at: 0.6, dur: 1.6, gain: 0.045, kind: 'hand', reverb: 0.4 })
    coins(0.62, 12, 0.025)
  } else {
    // 虹: 光が強まるのに合わせて風と音が膨らみ、ドン！で合唱・鐘・きらめきが一気に開く
    engine.noise({ dur: 1.0, gain: 0.12, attack: 0.85, release: 0.15, filter: { type: 'bandpass', freq: 250, to: 6000, q: 0.8 } })
    engine.tone(110, { dur: 1.0, slide: 440, type: 'sawtooth', gain: 0.025, attack: 0.8, release: 0.2, filter: { type: 'lowpass', freq: 400, to: 3000 } })
    const t = 0.9
    engine.tone(120, { at: t, dur: 0.8, slide: 36, gain: 0.18, attack: 0.003 })
    choir([hz(60), hz(64), hz(67), hz(71), hz(74)], { at: t - 0.05, dur: 2.2, gain: 0.08, attack: 0.12 })
    bell(hz(72), { at: t, dur: 2.6, gain: 0.05, kind: 'church', reverb: 0.5 })
    sparkle({ at: t, root: 84, count: 14, gap: 0.035, gain: 0.03 })
    engine.noise({ at: t, dur: 1.8, gain: 0.03, attack: 0.2, release: 1.4, filter: { type: 'highpass', freq: 7000 }, reverb: 0.5 })
  }
}

// ビリッ…パリパリ…ピッ: 裂け目のざらつき（中高域）と、繊維が切れる鋭さ（高域）、紙の胴のこすれを重ねる
function packTear(): void {
  const ctx = audio()
  if (!ctx) return
  const dur = rnd(0.38, 0.48)
  const tear = tearBuffer(ctx, dur)
  const pan = rnd(-0.2, 0.2)
  playBuffer(ctx, tear, { gain: 0.3, pan, filter: { type: 'bandpass', freq: 2200, to: 3400, q: 0.7 } })
  playBuffer(ctx, tear, { gain: 0.14, pan: -pan, filter: { type: 'highpass', freq: 5000 } })
  playBuffer(ctx, grainBuffer(ctx, dur, 900, (x) => 0.4 + 0.6 * x), { gain: 0.18, filter: { type: 'bandpass', freq: 1200, q: 1.2 } })
  engine.noise({ at: dur - 0.02, dur: 0.04, gain: 0.1, attack: 0.001, filter: { type: 'highpass', freq: 3500 }, pan })
}

// めくる風切り（ふわっ）と、紙の縁が鳴る「ぱちっ」
function cardFlip(): void {
  if (!audio()) return
  const pan = rnd(-0.3, 0.3)
  engine.noise({ dur: 0.16, gain: 0.14, attack: 0.07, release: 0.09, filter: { type: 'bandpass', freq: 900, to: 3800, q: 1.4 }, pan })
  engine.noise({ at: 0.14, dur: 0.1, gain: 0.08, attack: 0.002, filter: { type: 'bandpass', freq: 3800, to: 1800, q: 1.2 }, pan: -pan })
  engine.noise({ at: 0.15, dur: 0.02, gain: 0.07, attack: 0.001, filter: { type: 'highpass', freq: 2500 } })
}

// レア度の発表。C は控えめなチャイム、R はきらり、SR は金のファンファーレ、UR は合唱と鐘で圧倒的に。
// null（ダブルチャンス券）は明るいが控えめに
function rarity(r: Rarity | null): void {
  if (!audio()) return
  switch (r) {
    case null:
      engine.noise({ dur: 0.03, gain: 0.07, attack: 0.001, filter: { type: 'bandpass', freq: 3000, q: 1.5 } })
      bell(hz(81), { dur: 0.6, gain: 0.05, kind: 'tube' })
      bell(hz(88), { at: 0.11, dur: 0.9, gain: 0.055, kind: 'tube' })
      sparkle({ at: 0.2, root: 93, count: 3, gap: 0.05, gain: 0.018 })
      break
    case 'C':
      // やわらかい 3 音で、がっかりさせない
      bell(hz(76), { dur: 1.0, gain: 0.055, kind: 'tube', pan: -0.15 })
      bell(hz(79), { at: 0.12, dur: 1.1, gain: 0.055, kind: 'tube' })
      bell(hz(84), { at: 0.24, dur: 1.5, gain: 0.06, kind: 'tube', pan: 0.15 })
      break
    case 'R':
      // 青い光が走るような、速い駆け上がりと澄んだ高音
      engine.noise({ dur: 0.35, gain: 0.06, attack: 0.25, release: 0.1, filter: { type: 'bandpass', freq: 2000, to: 9000, q: 1.5 } })
      sparkle({ at: 0.15, root: 84, count: 6, gap: 0.035, gain: 0.04, spread: 0.6 })
      bell(hz(100), { at: 0.36, dur: 1.4, gain: 0.05, reverb: 0.5 })
      engine.tone(hz(88), { at: 0.36, dur: 1.2, gain: 0.025, attack: 0.02, release: 0.9, vibrato: { rate: 5.5, depth: 8 }, reverb: 0.4 })
      break
    case 'SR':
      // タタタ・ターン！ と、鐘とこぼれる金貨
      engine.tone(95, { dur: 0.5, slide: 40, gain: 0.18, attack: 0.002 })
      engine.noise({ dur: 1.8, gain: 0.04, attack: 0.004, release: 1.7, filter: { type: 'highpass', freq: 5500 }, reverb: 0.4 })
      ;[0, 0.1, 0.2].forEach((at) => brass([hz(67), hz(72)], { at, dur: 0.07, gain: 0.08, bright: 1.1 }))
      brass([hz(60), hz(64), hz(67), hz(72), hz(76)], { at: 0.32, dur: 1.3, gain: 0.13, bright: 1.25 })
      engine.tone(hz(48), { at: 0.32, dur: 1.3, type: 'triangle', gain: 0.07, attack: 0.01, release: 0.7 })
      bell(hz(84), { at: 0.32, dur: 2, gain: 0.04, kind: 'hand', reverb: 0.4 })
      coins(0.36, 16, 0.03)
      break
    case 'UR':
      ultraRare()
      break
  }
}

// UR: 腹に響く一撃 → 合唱が湧き上がり、大きな鐘が 3 度鳴り、きらめきが何度も降り注ぐ。最後に金管で高らかに
function ultraRare(): void {
  engine.tone(120, { dur: 0.8, slide: 34, gain: 0.15, attack: 0.002 }) // 小さなスピーカーでも聞こえる一撃
  engine.tone(52, { dur: 1.0, slide: 30, gain: 0.08, attack: 0.002 }) // 会場の PA で腹に響く低音
  engine.noise({ dur: 3.2, gain: 0.04, attack: 0.004, release: 3.1, filter: { type: 'highpass', freq: 4500 }, reverb: 0.5 })
  brass([hz(48), hz(55), hz(60), hz(64), hz(67)], { dur: 0.7, gain: 0.11, bright: 1.2 })
  choir([hz(60), hz(64), hz(67), hz(72), hz(76), hz(79)], { at: 0.05, dur: 3.6, gain: 0.09, attack: 0.5 })
  choir([hz(48), hz(55)], { at: 0.05, dur: 3.6, gain: 0.05, attack: 0.6 })
  bell(hz(72), { at: 0.05, dur: 3.4, gain: 0.055, kind: 'church', reverb: 0.55, pan: -0.2 })
  bell(hz(67), { at: 0.95, dur: 3.0, gain: 0.05, kind: 'church', reverb: 0.55, pan: 0.2 })
  bell(hz(72), { at: 1.85, dur: 3.2, gain: 0.055, kind: 'church', reverb: 0.55 })
  sparkle({ at: 0.15, root: 84, count: 15, gap: 0.03, gain: 0.03 })
  sparkle({ at: 1.0, root: 96, count: 12, gap: 0.05, gain: 0.022, dir: -1 })
  sparkle({ at: 1.9, root: 91, count: 10, gap: 0.04, gain: 0.02 })
  brass([hz(72), hz(76), hz(79), hz(84)], { at: 1.85, dur: 1.4, gain: 0.09, bright: 1.3 })
}

// ランクアップ: 駆け上がる音階 → 1 段上（ニ長調）の和音で「ジャーン」と転調したように
function rankUp(): void {
  if (!audio()) return
  ;[72, 74, 76, 77, 79, 81, 83, 84].forEach((m, i) =>
    engine.tone(hz(m), { at: i * 0.045, dur: 0.09, type: 'square', gain: 0.035, filter: { type: 'lowpass', freq: 2600 }, pan: -0.5 + i * 0.13 }),
  )
  engine.noise({ dur: 0.38, gain: 0.08, attack: 0.3, release: 0.08, filter: { type: 'bandpass', freq: 500, to: 6000, q: 1 } })
  const t = 0.4
  engine.tone(110, { at: t, dur: 0.45, slide: 50, gain: 0.16, attack: 0.002 })
  brass([hz(62), hz(66), hz(69), hz(74)], { at: t, dur: 0.8, gain: 0.14, bright: 1.2 })
  sparkle({ at: t + 0.05, root: 86, count: 6, gap: 0.04, gain: 0.03 })
  bell(hz(98), { at: t + 0.2, dur: 1.2, gain: 0.04, reverb: 0.45 })
}

// ---- 選択・上位チャレンジ ----

// 残り秒数。4 秒以上は時計のように「カチ・コチ」と小さく、残り 3・2・1 は音程を上げながら強く（胸に響く拍も足す）
function countdown(secondsLeft: number): void {
  if (!audio()) return
  const n = Math.ceil(secondsLeft)
  if (n <= 0) {
    bell(hz(81), { dur: 1.0, gain: 0.05, kind: 'tube' }) // 時間切れ: やわらかく「ポーン」
    return
  }
  if (n > 3) {
    const tick = n % 2 === 0
    engine.tone(tick ? 2000 : 1700, { dur: 0.025, gain: 0.045, attack: 0.001 })
    engine.noise({ dur: 0.012, gain: 0.06, attack: 0.001, filter: { type: 'bandpass', freq: tick ? 4200 : 3600, q: 2 } })
    return
  }
  const m = [88, 85, 81][n - 1] // 残り 3 = A5、2 = C#6、1 = E6
  engine.tone(2600, { dur: 0.02, gain: 0.06, attack: 0.001 })
  engine.tone(hz(m), { dur: 0.16, type: 'square', gain: 0.045, filter: { type: 'lowpass', freq: 3800 }, attack: 0.002 })
  engine.tone(hz(m + 12), { dur: 0.1, type: 'triangle', gain: 0.025 })
  engine.tone(95, { dur: 0.14, slide: 48, gain: 0.08 + (3 - n) * 0.03, attack: 0.003 })
}

function choose(kind: 'receive' | 'challenge'): void {
  if (!audio()) return
  if (kind === 'receive') {
    // 受け取る: 落ち着いた決定音（木琴のようにやわらかい和音を、下から軽くずらす）
    ;[60, 67, 72, 76].forEach((m, i) => {
      engine.tone(hz(m), { at: i * 0.03, dur: 0.9, gain: 0.05, attack: 0.003, reverb: 0.25 })
      engine.tone(hz(m) * 4, { at: i * 0.03, dur: 0.07, gain: 0.01, attack: 0.001 }) // 叩いた瞬間の硬さ
    })
    bell(hz(84), { at: 0.12, dur: 1.1, gain: 0.035, kind: 'tube', reverb: 0.35 })
    return
  }
  // 上位チャレンジ: 「いざ！」吸い込む風 → 太鼓の一撃と、勇ましい五度の金管、刀のような「シャキーン」
  engine.noise({ dur: 0.2, gain: 0.1, attack: 0.18, release: 0.02, filter: { type: 'bandpass', freq: 400, to: 3200, q: 1 } })
  const t = 0.19
  engine.tone(92, { at: t, dur: 0.5, slide: 46, gain: 0.2, attack: 0.002 })
  engine.noise({ at: t, dur: 0.2, gain: 0.15, attack: 0.002, filter: { type: 'lowpass', freq: 2000, to: 300 } })
  brass([hz(50), hz(57), hz(62), hz(69)], { at: t, dur: 0.6, gain: 0.12, bright: 1.25 })
  engine.noise({ at: t + 0.02, dur: 0.6, gain: 0.03, attack: 0.002, filter: { type: 'highpass', freq: 6500 }, reverb: 0.35 })
  engine.tone(3100, { at: t + 0.02, dur: 0.7, slide: 3350, gain: 0.018, attack: 0.002, vibrato: { rate: 14, depth: 12 }, reverb: 0.35 })
  bell(2200, { at: t + 0.02, dur: 0.8, gain: 0.02, kind: 'hand', reverb: 0.35 })
}

// 3×3 のカードを配る: 「しゅっ・ぱちっ」を 9 回、3 列に振り分けて
function challengeDeal(): void {
  if (!audio()) return
  for (let i = 0; i < 9; i++) {
    const at = i * 0.06 + rnd(0, 0.01)
    const pan = ((i % 3) - 1) * 0.4
    engine.noise({ at, dur: 0.05, gain: 0.1, attack: 0.002, filter: { type: 'bandpass', freq: rnd(2500, 3500), to: 1500, q: 1.5 }, pan })
    engine.noise({ at: at + 0.04, dur: 0.015, gain: 0.06, attack: 0.001, filter: { type: 'highpass', freq: 3000 }, pan })
  }
  bell(hz(84), { at: 0.6, dur: 0.6, gain: 0.035 })
}

// 上位チャレンジ成功: 大逆転のファンファーレ（ジャッ・ジャーン！と上へ抜ける）
function challengeSuccess(): void {
  if (!audio()) return
  engine.tone(100, { dur: 0.5, slide: 42, gain: 0.18, attack: 0.002 })
  engine.noise({ dur: 2.0, gain: 0.04, attack: 0.004, release: 1.9, filter: { type: 'highpass', freq: 5500 }, reverb: 0.4 })
  ;[67, 72, 76].forEach((m, i) => brass([hz(m), hz(m - 12)], { at: i * 0.09, dur: 0.08, gain: 0.08, bright: 1.1 }))
  brass([hz(65), hz(69), hz(72)], { at: 0.3, dur: 0.22, gain: 0.11, bright: 1.15 })
  engine.tone(105, { at: 0.55, dur: 0.5, slide: 40, gain: 0.14, attack: 0.002 })
  brass([hz(72), hz(76), hz(79), hz(84)], { at: 0.55, dur: 1.2, gain: 0.13, bright: 1.3 })
  sparkle({ at: 0.58, root: 84, count: 12, gap: 0.035, gain: 0.03 })
  bell(hz(96), { at: 0.6, dur: 1.8, gain: 0.04, reverb: 0.5 })
}

// 上位チャレンジ失敗: 力が抜けるように下がる音と、こもった短調の和音（責めない、やわらかい終わり）
function challengeFail(): void {
  if (!audio()) return
  engine.tone(hz(76), { dur: 0.7, slide: hz(64), type: 'triangle', gain: 0.06, attack: 0.01, vibrato: { rate: 5, depth: 20 } })
  ;[57, 60, 64].forEach((m, i) =>
    engine.tone(hz(m), {
      at: 0.5 + i * 0.02,
      dur: 1.2,
      type: 'sawtooth',
      gain: 0.025,
      attack: 0.04,
      filter: { type: 'lowpass', freq: 900, to: 400 },
      reverb: 0.35,
    }),
  )
  engine.tone(hz(45), { at: 0.5, dur: 1.2, gain: 0.08, attack: 0.02 })
}

// ラストワン争奪の結果。取れたら鐘と金管で祝い、取れなかったらやわらかく下がる 2 音
function lastOne(win: boolean): void {
  if (!audio()) return
  if (win) {
    engine.tone(90, { dur: 0.5, slide: 40, gain: 0.18, attack: 0.002 })
    brass([hz(62), hz(66), hz(69), hz(74)], { dur: 1.0, gain: 0.12, bright: 1.2 })
    bell(hz(74), { dur: 2.2, gain: 0.05, kind: 'church', reverb: 0.5 })
    bell(hz(69), { at: 0.45, dur: 2.0, gain: 0.04, kind: 'church', reverb: 0.5 })
    sparkle({ at: 0.05, root: 86, count: 10, gap: 0.04, gain: 0.03 })
    return
  }
  bell(hz(76), { dur: 0.9, gain: 0.05, kind: 'tube' })
  bell(hz(71), { at: 0.24, dur: 1.4, gain: 0.05, kind: 'tube' })
  engine.tone(hz(64), { at: 0.24, dur: 1.0, type: 'triangle', gain: 0.025, attack: 0.03, reverb: 0.3 })
}

// ---- ダブルチャンス（ガラポン）----

// エントリー: 券に「パチッ」と印を付けて、明るい「ピコン♪」
function entry(): void {
  if (!audio()) return
  engine.noise({ dur: 0.02, gain: 0.08, attack: 0.001, filter: { type: 'bandpass', freq: 2800, q: 2 } })
  bell(hz(84), { at: 0.02, dur: 0.5, gain: 0.045, pan: -0.15 })
  bell(hz(91), { at: 0.1, dur: 0.8, gain: 0.05, pan: 0.15 })
  engine.tone(hz(79), { at: 0.1, dur: 0.4, type: 'triangle', gain: 0.025, attack: 0.01 })
}

const silentVoice: GaraponVoice = { setSpeed() {}, stop() {} }

const LOOKAHEAD = 0.1 // 何秒先まで粒を予約しておくか
const MAX_LIFE = 120 // 止め忘れの保険（秒）

// ガラポン（八角形の木の抽選器）の中で玉が転がる音。
// 八角形なので、1 回転で 8 回、玉の群れが角を越えて崩れ落ちる。そのたびに「ガラララ」とひとかたまり鳴らす
// （頭の 1 粒を強く、続く粒をばらばらに弱く）。速いほどかたまりが詰まって途切れない「ガラガラ」になり、
// 粒の音程も少し上がる。速いときは連続した転がりの雑音と、木の胴の低い鳴りも足す。
// 連打で速さが細かく変わるので、指定された速さ（target）を実際の速さ（speed）が滑らかに追いかける。
// 粒は AudioContext の時刻で少し先まで予約する（演出の Timeline ではなく音の時計に合わせるため、ここだけ setInterval を使う）
function garaponStart(): GaraponVoice {
  const ctx = audio()
  if (!ctx) return silentVoice
  const out = outlet(ctx, 0, 0.12)
  // 粒を左右に少し散らすための 5 本の通り道（粒ごとに定位のノードを作らずに済む）
  const lanes = [-0.4, -0.2, 0, 0.2, 0.4].map((p) => {
    const panner = ctx.createStereoPanner()
    panner.pan.value = p
    panner.connect(out)
    return panner
  })
  // 連続した転がり（帯域雑音）と木の胴の鳴り（低域）。どちらも角を越える周期で揺らす
  const noise = ctx.createBufferSource()
  noise.buffer = engine.noiseBuffer()
  noise.loop = true
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.Q.value = 0.9
  band.frequency.value = 1200
  const roll = ctx.createGain()
  roll.gain.value = 0
  const low = ctx.createBiquadFilter()
  low.type = 'lowpass'
  low.frequency.value = 260
  const rumble = ctx.createGain()
  rumble.gain.value = 0
  noise.connect(band).connect(roll).connect(out)
  noise.connect(low).connect(rumble).connect(out)
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 4
  const rollDepth = ctx.createGain()
  rollDepth.gain.value = 0
  const rumbleDepth = ctx.createGain()
  rumbleDepth.gain.value = 0
  lfo.connect(rollDepth).connect(roll.gain)
  lfo.connect(rumbleDepth).connect(rumble.gain)
  const born = ctx.currentTime
  noise.start(born)
  lfo.start(born)

  let target = 0 // 指定された速さ（毎秒の回転数）
  let speed = 0 // 実際の速さ
  let top = 0 // これまでの最大の速さ（止まるときの余韻の量に使う）
  let last = born
  let lastEdge = born
  let nextEdge = born
  let stopping = false
  let done = false

  // 角を越えた玉の群れ: 1 秒あたりの粒が 100 個くらいに収まるよう、速いほど 1 群れの粒を減らす。
  // 画面の抽選器は 3 回転/秒が上限なので、3 で「全速」に聞こえるようにし、その先（〜6）はゆるやかに伸ばす
  const cascade = (t: number, rps: number): void => {
    const edgeRate = 8 * rps
    const count = clamp(Math.round(100 / edgeRate), 1, 6)
    const span = Math.min(0.12, 0.85 / edgeRate)
    const pitch = 0.88 + 0.1 * Math.min(rps, 3) + 0.03 * clamp(rps - 3, 0, 3)
    const level = 0.05 + 0.05 * Math.min(1, rps / 2)
    for (let i = 0; i < count; i++) {
      const at = i === 0 ? t : t + span * Math.pow(Math.random(), 0.8)
      const g = i === 0 ? level : level * rnd(0.25, 0.75)
      clackAt(ctx, lanes[Math.floor(Math.random() * lanes.length)], at, g, pitch * rnd(0.88, 1.14))
    }
  }

  // 止まったあと、残った玉が「コロ…コト」と落ち着く
  const settle = (t: number): void => {
    const n = top > 2 ? 4 : 2
    let at = t
    for (let i = 0; i < n; i++) {
      at += rnd(0.07, 0.16) * (1 + i * 0.5)
      clackAt(ctx, lanes[Math.floor(Math.random() * lanes.length)], at, 0.05 * Math.pow(0.6, i), 0.85 * rnd(0.92, 1.05))
    }
  }

  const finish = (): void => {
    if (done) return
    done = true
    window.clearInterval(timer)
    const now = ctx.currentTime
    for (const p of [roll.gain, rumble.gain, rollDepth.gain, rumbleDepth.gain]) {
      p.cancelScheduledValues(now)
      p.setTargetAtTime(0, now, 0.06)
    }
    noise.onended = () => out.disconnect()
    noise.stop(now + 1.6)
    lfo.stop(now + 1.6)
  }

  const stop = (): void => {
    if (stopping || done) return
    stopping = true
    target = 0
  }

  const tick = (): void => {
    if (done) return
    if (!engine.ready) return finish()
    const now = ctx.currentTime
    const dt = Math.min(0.2, Math.max(0, now - last))
    last = now
    // 連打の 1 打には素早く、手を離したときはややゆっくり、止めるときは中くらいで追いつく
    const tau = target > speed ? 0.08 : stopping ? 0.22 : 0.3
    speed += (target - speed) * (1 - Math.exp(-dt / tau))
    top = Math.max(top, speed)
    const flow = clamp((speed - 0.6) / 2.4, 0, 1.3) // 連続した転がりの量（3 回転/秒で 1）
    const body = clamp(speed / 2.5, 0, 1) // 胴の鳴りの量
    // 帯域を絞った雑音は実効値がかなり小さくなるので、粒（ピーク 0.05〜0.1）と釣り合うよう大きめに入れる
    roll.gain.setTargetAtTime(0.1 * flow, now, 0.06)
    rollDepth.gain.setTargetAtTime(0.07 * flow, now, 0.06)
    band.frequency.setTargetAtTime(1000 + 400 * Math.min(speed, 3) + 100 * clamp(speed - 3, 0, 3), now, 0.08)
    rumble.gain.setTargetAtTime(0.3 * body, now, 0.08)
    rumbleDepth.gain.setTargetAtTime(0.2 * body, now, 0.08)
    lfo.frequency.setTargetAtTime(Math.max(0.5, 8 * speed), now, 0.08)
    // 角を越える時刻を少し先まで予約する。速くなったら、次の角を前倒しする
    if (speed < 0.05) {
      lastEdge = now
      nextEdge = now + 0.03
    } else {
      nextEdge = Math.max(now, Math.min(nextEdge, lastEdge + 1.2 / (8 * speed)))
      while (nextEdge < now + LOOKAHEAD) {
        cascade(nextEdge, speed)
        lastEdge = nextEdge
        nextEdge += rnd(0.8, 1.2) / (8 * speed)
      }
    }
    if (stopping && speed < 0.06) {
      if (top > 0.3) settle(now)
      finish()
    } else if (now - born > MAX_LIFE) stop()
  }
  const timer = window.setInterval(tick, 25)

  return {
    setSpeed(rps: number) {
      if (!stopping && !done) target = clamp(rps, 0, 8)
    },
    stop,
  }
}

// コロコロ…カン: 口から出た玉が斜面を転がり（だんだん速く、少し高く）、受け皿の金属に当たって、小さく跳ねて止まる
function garaponDrop(): void {
  const ctx = audio()
  if (!ctx) return
  const out = outlet(ctx, 0.1, 0.15)
  const t0 = ctx.currentTime
  let t = t0 + 0.02
  for (let i = 0; i < 7; i++) {
    t += 0.085 - i * 0.008
    clackAt(ctx, out, t, 0.045 + i * 0.006, (1.05 + i * 0.03) * rnd(0.95, 1.05))
  }
  let hit = t - t0 + 0.1
  bell(1650, { at: hit, dur: 0.9, gain: 0.05, kind: 'tray', click: 0.8, pan: 0.15, reverb: 0.25 })
  ;[0.15, 0.1, 0.065, 0.04].forEach((gap, i) => {
    hit += gap
    bell(1650, { at: hit, dur: 0.35, gain: 0.03 * Math.pow(0.55, i + 1), kind: 'tray', pan: 0.15 })
    clackAt(ctx, out, t0 + hit, 0.03 * Math.pow(0.6, i), 1.2)
  })
}

// 当たりの鐘（手持ちの真鍮の鐘を振る「カランカランカラン」）。振るたびに舌が両側に当たって「カ・ラン」と 2 打ずつ鳴る。
// red < gold < rainbow の順に長く振り、金は鐘を 2 つ重ねて最後に金管、虹はさらに合唱・大きな鐘・きらめきを足す
function garaponWin(color: 'red' | 'gold' | 'rainbow'): void {
  if (!audio()) return
  const shakes = color === 'red' ? 7 : color === 'gold' ? 12 : 18
  const period = 0.16
  const f = 1180
  const bells = color === 'red' ? [f] : [f, f * 1.26]
  for (let i = 0; i < shakes; i++) {
    const swell = Math.min(1, (i + 1) / 3, (shakes - i) / 3 + 0.25) // 振り始めと振り終わりは弱く
    bells.forEach((bf, j) => {
      const at = i * period + j * 0.023 + rnd(-0.008, 0.008)
      const g = (0.05 / Math.sqrt(bells.length)) * swell
      const pan = j === 0 ? -0.1 : 0.3
      bell(bf * cents(8), { at, dur: 0.8, gain: g * 0.7, kind: 'hand', pan: pan - 0.1, reverb: 0.25 })
      bell(bf * cents(8), { at: at + 0.06, dur: 1.0, gain: g, kind: 'hand', pan: pan + 0.1, click: 0.7, reverb: 0.25 })
    })
  }
  if (color === 'red') return
  const end = shakes * period
  engine.tone(90, { at: end, dur: 0.5, slide: 40, gain: 0.15, attack: 0.002 })
  brass([hz(60), hz(64), hz(67), hz(72)], { at: end, dur: 1.1, gain: 0.12, bright: 1.2 })
  coins(end + 0.02, 12, 0.025)
  if (color === 'gold') return
  choir([hz(60), hz(64), hz(67), hz(72), hz(76)], { at: end - 0.4, dur: 2.6, gain: 0.07, attack: 0.4 })
  bell(hz(72), { at: end, dur: 3.0, gain: 0.05, kind: 'church', reverb: 0.55 })
  sparkle({ at: end + 0.05, root: 84, count: 14, gap: 0.035, gain: 0.03 })
  sparkle({ at: end + 0.7, root: 96, count: 10, gap: 0.05, gain: 0.02, dir: -1 })
}

// はずれ: やわらかい「ぽん」。熱を冷ます場面なので、小さく温かく（後ろに 5 度下の小さな「ぽ」を添える）
function garaponMiss(): void {
  if (!audio()) return
  engine.tone(560, { dur: 0.22, slide: 380, gain: 0.08, attack: 0.004, reverb: 0.2 })
  engine.tone(1120, { dur: 0.08, slide: 760, gain: 0.012, attack: 0.002 })
  engine.tone(375, { at: 0.14, dur: 0.3, slide: 300, type: 'triangle', gain: 0.035, attack: 0.006, reverb: 0.25 })
}

// 締めくくり（おつかれさまでした）: 学校のチャイムの旋律（ミドレソ・ソレミド）を、やわらかい鐘でゆっくり。
// 下に穏やかな和音（ヘ長調）をふわっと敷く
function outro(): void {
  if (!audio()) return
  const melody = [69, 65, 67, 60, 60, 67, 69, 65]
  const beat = 0.52
  melody.forEach((m, i) => {
    const at = i * beat + (i >= 4 ? beat : 0) // フレーズの間に一拍あける
    const last = i === melody.length - 1
    bell(hz(m), { at, dur: last ? 4.0 : 2.6, gain: 0.07, kind: 'tube', reverb: 0.5, pan: i % 2 ? 0.15 : -0.15 })
  })
  ;[53, 60, 65, 69, 67].forEach((m, i) =>
    engine.tone(hz(m), {
      at: 0.3 + i * 0.1,
      dur: 7.0,
      gain: 0.016,
      attack: 1.2,
      release: 2.8,
      detune: rnd(-5, 5),
      vibrato: { rate: 0.6 + i * 0.17, depth: 5 },
      reverb: 0.6,
    }),
  )
}

export const eventSfx: EventSfx = {
  stamp,
  reach,
  bingo,
  aoriStart,
  aoriPulse,
  aoriSuccess,
  aoriFail,
  wildBall,
  wildOpen,
  moleAppear,
  moleDig,
  moleFill,
  moleSafe,
  packAppear,
  packTear,
  cardFlip,
  rarity,
  rankUp,
  countdown,
  choose,
  challengeDeal,
  challengeSuccess,
  challengeFail,
  lastOne,
  entry,
  garaponStart,
  garaponDrop,
  garaponWin,
  garaponMiss,
  outro,
}

import type { Tier } from '../fx/theme'
import { engine } from './engine'
import type { SpinSfx } from './types'

// 手元のスロット（抽選のたびに、自分のスマホで回して STOP で止める）の効果音。音声ファイルは使わず、すべて合成する。
//
//   spinStart（回り出す）→ spinTap（連打の 1 打。1 秒に十数回）→ spinLevel（ゲージの段階が上がる。予告の格で強さが変わる）
//   → stopReady（STOP が押せる）→ stopPress（STOP を押す）→ reelLand（番号に止まる）
//
//   - 作り方は sfx-draw.ts と同じ（役割の違う層を重ね、時刻は engine.now を基準に予約する）。部品は sfx-draw.ts から書き写した
//   - 音程のある音は、すべてハ長調の五音音階に乗せる（連打の「ポ」・段階の駆け上がり・着地の鐘が、いつ重なっても濁らない）
//   - 段階の音は level 1〜4 で ド・レ・ミ・ソ と上がり、STOP が押せる音で上のドへ跳ね、着地の鐘のドで落ち着く
//   - 予告の格は大画面と同じ覚え方にそろえる（青は小さく、緑「ピロリン」、赤から低いドンと金管、金は鐘、虹は左右いっぱいに）。
//     虹の確定の瞬間は演出側が aoriStart(4) を重ねるので、ここでは高まりの音にとどめる（確定音の「キュイン」は使わない）
//   - スマホの音なので控えめにし、残響も少なめにする（連打は大画面のコマ送り tick と同じくらい、段階の音は手元のあおり
//     aoriStart より小さく、着地は大画面の impact より小さく）。重ねたピークは 0.45 まで。9kHz より上は鳴らさない
//   - 連打は、速いほど 1 打を小さくして、続けても大きくならないようにする
//   - stopPress のブレーキ（減速していくコマ送り）は、reelLand（着地）が来たら 15ms で絞って止める

// ---- 道具 -------------------------------------------------------------------

const ac = (): AudioContext => engine.ctx!
const live = (): boolean => engine.ready && engine.enabled
// 鳴らし始める時刻。ノードを組む間に時計が進んでも頭が欠けないよう、少しだけ先に予約する
const soon = (): number => engine.now + 0.008

const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12)

// ハ長調の五音音階（ド レ ミ ソ ラ）。i 番目の音の周波数（0 = C5、5 = C6、10 = C7。負でもよい）
const PENTA = [0, 2, 4, 7, 9] as const
const scale = (i: number): number => midi(72 + 12 * Math.floor(i / 5) + PENTA[((i % 5) + 5) % 5])

// いちばん近い五音音階の音にそろえる（きらめきの粒に使う）
function onScale(f: number): number {
  const m = 69 + 12 * Math.log2(f / 440)
  const base = Math.floor(m / 12) * 12
  let best = m
  let dist = Infinity
  for (const o of [base - 12, base, base + 12]) {
    for (const s of PENTA) {
      if (Math.abs(o + s - m) < dist) {
        dist = Math.abs(o + s - m)
        best = o + s
      }
    }
  }
  return midi(best)
}

interface Place {
  pan?: number
  reverb?: number // 残響へ送る量（0〜1）
  to?: AudioNode // 効果音バスではなく、自前の出口（ブレーキの音をまとめる出口など）に流すとき。残響は出口の側で付ける
}

// 出口: 入口 → 定位 → 効果音バス（＋残響）。音源は input につなぐ
function out(o: Place = {}): { input: GainNode; panner: StereoPannerNode } {
  const c = ac()
  const input = c.createGain()
  const panner = c.createStereoPanner()
  panner.pan.value = clamp(o.pan ?? 0, -1, 1)
  input.connect(panner)
  if (o.to) {
    panner.connect(o.to)
    return { input, panner }
  }
  panner.connect(engine.bus('sfx'))
  if (o.reverb) {
    const send = c.createGain()
    send.gain.value = o.reverb
    panner.connect(send).connect(engine.reverb)
  }
  return { input, panner }
}

const dest = (o: Place = {}): GainNode => out(o).input

function amp(to: AudioNode, value = 0): GainNode {
  const g = ac().createGain()
  g.gain.value = value
  g.connect(to)
  return g
}

function filter(type: BiquadFilterType, freq: number, q: number, to: AudioNode): BiquadFilterNode {
  const f = ac().createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  f.connect(to)
  return f
}

function pan(value: number, to: AudioNode): StereoPannerNode {
  const p = ac().createStereoPanner()
  p.pan.value = clamp(value, -1, 1)
  p.connect(to)
  return p
}

function osc(type: OscillatorType, freq: number, t: number, end: number, to: AudioNode, detune = 0): OscillatorNode {
  const o = ac().createOscillator()
  o.type = type
  o.frequency.setValueAtTime(freq, t)
  if (detune) o.detune.setValueAtTime(detune, t)
  o.connect(to)
  o.start(t)
  o.stop(end)
  return o
}

// 白色雑音。共有のバッファを毎回ちがう位置から読むので、重ねても同じ波形にならない
function noise(t: number, end: number, to: AudioNode): AudioBufferSourceNode {
  const src = ac().createBufferSource()
  src.buffer = engine.noiseBuffer()
  src.loop = true
  src.connect(to)
  src.start(t, Math.random() * 1.9)
  src.stop(end)
  return src
}

// 打楽器型の包絡: 0 → peak（attack 秒）→ 時定数 tau で指数的に減る。聞こえなくなる時刻を返す
function perc(p: AudioParam, t: number, peak: number, attack: number, tau: number): number {
  p.setValueAtTime(0, t)
  p.linearRampToValueAtTime(peak, t + attack)
  p.setTargetAtTime(0, t + attack, tau)
  return t + attack + tau * 7
}

// 持続型の包絡: 0 → peak（attack 秒）→ until まで保つ → release 秒で消える。聞こえなくなる時刻を返す
function sustain(p: AudioParam, t: number, peak: number, attack: number, until: number, release: number): number {
  const top = Math.max(t + attack, until)
  p.setValueAtTime(0, t)
  p.linearRampToValueAtTime(peak, t + attack)
  p.setValueAtTime(peak, top)
  p.setTargetAtTime(0, top, release / 4)
  return top + release * 1.6
}

// 好きな形で値を動かす（細かい折れ線で近似する。setValueCurveAtTime と違い、前後の予約とぶつからない）
function shape(p: AudioParam, t: number, dur: number, fn: (x: number) => number, steps = 24): void {
  p.setValueAtTime(fn(0), t)
  for (let i = 1; i <= steps; i++) p.linearRampToValueAtTime(fn(i / steps), t + (dur * i) / steps)
}

// 山なりのふくらみ（x: 0〜1 → 0 → 1 → 0）。peak は山の位置
function swell(x: number, peak: number): number {
  if (x <= 0 || x >= 1) return 0
  return x < peak ? Math.sin((Math.PI / 2) * (x / peak)) ** 2 : Math.cos((Math.PI / 2) * ((x - peak) / (1 - peak))) ** 2
}

// ビブラート（深さはセント）。t から fadeIn 秒かけて深くなる。返り値を OscillatorNode.detune につなぐ
function vibrato(t: number, end: number, rate: number, depth: number, fadeIn = 0.25): GainNode {
  const c = ac()
  const lfo = c.createOscillator()
  lfo.frequency.setValueAtTime(rate, t)
  const g = c.createGain()
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(depth, t + Math.max(0.001, fadeIn))
  lfo.connect(g)
  lfo.start(t)
  lfo.stop(end)
  return g
}

function makeCurve(k: number) {
  const curve = new Float32Array(1025)
  const norm = Math.tanh(k)
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(k * ((i / (curve.length - 1)) * 2 - 1)) / norm
  return curve
}
const curves = new Map<number, ReturnType<typeof makeCurve>>()

// やわらかく歪ませる。強いところほど倍音が出るので、小さなスピーカーでも低音の芯が聞こえる
function drive(k: number, to: AudioNode): WaveShaperNode {
  let curve = curves.get(k)
  if (!curve) {
    curve = makeCurve(k)
    curves.set(k, curve)
  }
  const ws = ac().createWaveShaper()
  ws.curve = curve
  ws.oversample = '2x'
  ws.connect(to)
  return ws
}

// ---- 楽器（よく使う層） -----------------------------------------------------

// 丸い「ポン」。鳴った直後に音程が drop 倍へ動く（1 より大きいと、跳ね上がる「ピッ」になる）
function pop(t: number, f: number, o: Place & { gain: number; tau: number; drop?: number; type?: OscillatorType }): void {
  const g = amp(dest(o))
  const end = perc(g.gain, t, o.gain, 0.0015, o.tau)
  const s = osc(o.type ?? 'sine', f, t, end, g)
  s.frequency.setTargetAtTime(f * (o.drop ?? 0.75), t, 0.012)
}

// 低音の芯。上から落ちる正弦波を、包絡のあとで軽く歪ませる
function thump(
  t: number,
  f0: number,
  f1: number,
  o: Place & { gain: number; tau: number; glide?: number; drive?: number; lp?: number },
): void {
  const post = amp(dest(o), o.gain)
  const env = amp(drive(o.drive ?? 1.5, filter('lowpass', o.lp ?? 700, 0.7, post)))
  const end = perc(env.gain, t, 1, 0.003, o.tau)
  const s = osc('sine', f0, t, end, env)
  s.frequency.exponentialRampToValueAtTime(f1, t + (o.glide ?? o.tau * 1.4))
}

// 雑音の一撃。フィルタの種類と帯域で「カチッ」「コッ」「ドスッ」「シャッ」を作り分ける。sweep は帯域の行き先
function burst(
  t: number,
  o: Place & { type: BiquadFilterType; f: number; q?: number; sweep?: number; gain: number; attack?: number; tau: number },
): void {
  const g = amp(dest(o))
  const end = perc(g.gain, t, o.gain, o.attack ?? 0.0008, o.tau)
  const f = filter(o.type, o.f, o.q ?? 0.7, g)
  if (o.sweep) {
    f.frequency.setValueAtTime(o.f, t)
    f.frequency.setTargetAtTime(o.sweep, t, o.tau * 1.5)
  }
  noise(t, end, f)
}

// 鐘。非整数比の倍音を重ね、高い倍音ほど早く消える。芯にわずかにずらした相方を重ねて、ゆっくりうならせる
const BELL: readonly (readonly [ratio: number, level: number, decay: number])[] = [
  [1, 1, 1],
  [2.0, 0.45, 0.62],
  [2.76, 0.34, 0.45],
  [4.07, 0.2, 0.32],
  [5.4, 0.13, 0.24],
  [6.8, 0.07, 0.18],
]

function bell(t: number, f: number, o: Place & { gain: number; tau?: number }): void {
  const d = dest(o)
  const tau = o.tau ?? 0.8
  for (const [ratio, level, decay] of BELL) {
    if (f * ratio > 9000) break
    const g = amp(d)
    osc('sine', f * ratio, t, perc(g.gain, t, o.gain * level, 0.0012, tau * decay), g, rand(-3, 3))
  }
  const g = amp(d)
  osc('sine', f * 1.0021, t, perc(g.gain, t, o.gain * 0.45, 0.002, tau * 1.1), g)
  // 打った瞬間の硬い音
  burst(t, { type: 'bandpass', f: Math.min(f * 3.2, 7500), q: 1.6, gain: o.gain * 0.9, tau: 0.0035, pan: o.pan, to: o.to })
}

// はじく音（ハープ・アルペジオ）。明るい倍音がすぐに丸くなる
function pluck(t: number, f: number, o: Place & { gain: number; tau?: number; bright?: number }): void {
  const tau = o.tau ?? 0.25
  const g = amp(dest(o))
  const end = perc(g.gain, t, o.gain, 0.0015, tau)
  const top = Math.min(f * (o.bright ?? 6), 9000)
  const lp = filter('lowpass', top, 0.8, g)
  lp.frequency.setValueAtTime(top, t)
  lp.frequency.setTargetAtTime(Math.max(f * 1.5, 400), t + 0.004, tau * 0.3)
  osc('triangle', f, t, end, amp(lp, 0.55))
  osc('sawtooth', f, t, end, amp(lp, 0.22), rand(-6, 6))
  osc('sine', f, t, end, amp(lp, 0.35))
}

// 金管。のこぎり波を少しずつずらして重ね、ローパスを素早く開いて少し戻す（「パァッ」と吹く感じ）。
// 音程はわずかに下から入る（しゃくり）
function brass(t: number, f: number, dur: number, o: Place & { gain: number; voices?: number; spread?: number; bright?: number }): void {
  const n = o.voices ?? 3
  const spread = o.spread ?? 9
  const bright = o.bright ?? 1
  const rel = 0.11
  const end = t + dur + rel * 2
  const g = amp(dest(o))
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(o.gain, t + 0.022)
  g.gain.setTargetAtTime(o.gain * 0.8, t + 0.022, 0.09)
  g.gain.setTargetAtTime(0, t + dur, rel / 3)
  const lp = filter('lowpass', Math.min(f * 1.3, 9000), 1.1, g)
  lp.frequency.setValueAtTime(Math.min(f * 1.3, 9000), t)
  lp.frequency.linearRampToValueAtTime(Math.min(f * 7 * bright, 9000), t + 0.045)
  lp.frequency.setTargetAtTime(Math.min(f * 3.5 * bright, 7000), t + 0.045, 0.1)
  lp.frequency.setTargetAtTime(Math.max(f, 200), t + dur, rel / 2)
  for (let i = 0; i < n; i++) {
    const det = n === 1 ? 0 : ((i / (n - 1)) * 2 - 1) * spread
    const s = osc('sawtooth', f, t, end, amp(lp, 1 / n))
    s.detune.setValueAtTime(det - 28, t)
    s.detune.linearRampToValueAtTime(det, t + 0.045)
  }
  // 息の音
  burst(t, { type: 'bandpass', f: Math.min(f * 2.5, 6000), q: 1.4, gain: o.gain * 0.5, attack: 0.006, tau: 0.025, pan: o.pan, to: o.to })
}

// 和音のパッド。のこぎり波を左右にずらして重ね、ローパスでやわらげる。lpTo へ向けて音色を開く
function pad(
  t: number,
  freqs: readonly number[],
  o: Place & { gain: number; attack: number; hold: number; release: number; lp: number; lpTo?: number; spread?: number; vib?: number },
): void {
  const g = amp(dest(o))
  const end = sustain(g.gain, t, 1, o.attack, t + o.hold, o.release)
  const lp = filter('lowpass', o.lp, 0.6, g)
  if (o.lpTo) {
    lp.frequency.setValueAtTime(o.lp, t)
    lp.frequency.exponentialRampToValueAtTime(o.lpTo, t + o.attack + o.hold * 0.5)
  }
  const spread = o.spread ?? 10
  for (const f of freqs) {
    for (const side of [-1, 1]) {
      const s = osc('sawtooth', f, t, end, amp(pan(side * 0.6, lp), o.gain), side * spread + rand(-2, 2))
      if (o.vib) vibrato(t, end, rand(4.5, 5.8), o.vib, o.attack + 0.2).connect(s.detune)
    }
  }
}

// きらめきの粒（短く高い鐘）
function glint(t: number, f: number, o: Place & { gain: number }): void {
  const d = dest(o)
  const g = amp(d)
  osc('sine', f, t, perc(g.gain, t, o.gain, 0.001, rand(0.05, 0.12)), g)
  if (f * 2.76 < 9000) {
    const g2 = amp(d)
    osc('sine', f * 2.76, t, perc(g2.gain, t, o.gain * 0.25, 0.001, 0.025), g2)
  }
}

// きらきら: 粒を時間と左右にばらまく。rise なら時間とともに音程が上がっていく
function sparkle(t: number, dur: number, count: number, o: { lo: number; hi: number; gain: number; rise?: boolean; reverb?: number }): void {
  for (let i = 0; i < count; i++) {
    const x = o.rise ? i / Math.max(1, count - 1) : Math.random()
    const at = t + clamp(x * dur + rand(-0.04, 0.04), 0, dur)
    const y = o.rise ? clamp(x + rand(-0.12, 0.12), 0, 1) : Math.random()
    const f = onScale(o.lo * Math.pow(o.hi / o.lo, y))
    glint(at, f, { gain: o.gain * rand(0.55, 1), pan: rand(-0.8, 0.8), reverb: o.reverb ?? 0.45 })
  }
}

// 風切り。帯域を動かした雑音が、ふくらんでしぼむ。pan1 を渡すと左右に動く
function whoosh(
  t: number,
  dur: number,
  o: Place & { f0: number; f1: number; q?: number; gain: number; peak?: number; pan1?: number },
): void {
  const ob = out(o)
  if (o.pan1 !== undefined) {
    ob.panner.pan.setValueAtTime(clamp(o.pan ?? 0, -1, 1), t)
    ob.panner.pan.linearRampToValueAtTime(clamp(o.pan1, -1, 1), t + dur)
  }
  const g = amp(ob.input)
  const peak = o.peak ?? 0.6
  shape(g.gain, t, dur, (x) => o.gain * swell(x, peak), 20)
  const bp = filter('bandpass', o.f0, o.q ?? 1, g)
  bp.frequency.setValueAtTime(o.f0, t)
  bp.frequency.exponentialRampToValueAtTime(o.f1, t + dur)
  noise(t, t + dur + 0.02, bp)
}

// 金属の短い響き（非整数比の正弦波の束）。高い成分ほど早く消える
function metal(t: number, freqs: readonly number[], o: Place & { gain: number; tau: number }): void {
  const d = dest(o)
  freqs.forEach((f, i) => {
    if (f > 9000) return
    const g = amp(d)
    osc('sine', f, t, perc(g.gain, t, o.gain / (1 + i * 0.35), 0.001, o.tau / (1 + i * 0.45)), g, rand(-8, 8))
  })
}

// シンバル。高い雑音の長い減衰（左右で別の雑音）。8.5kHz より上は削って、耳に痛くしない
function crash(t: number, o: { gain: number; tau: number; reverb?: number }): void {
  for (const p of [-0.5, 0.5]) {
    const g = amp(dest({ pan: p, reverb: o.reverb ?? 0.3 }))
    const end = perc(g.gain, t, o.gain, 0.003, o.tau)
    noise(t, end, filter('highpass', 3000, 0.7, filter('lowpass', 8500, 0.5, g)))
  }
  metal(t, [3270, 4410, 5690, 7130], { gain: o.gain * 0.18, tau: o.tau * 0.5, reverb: 0.3 })
}

// リールのコマ送り 1 コマ（ごく短い「カチ」と小さな「ポ」）。k で高さ、level で強さを変える
function notch(t: number, k: number, level: number, o: Place = {}): void {
  burst(t, { ...o, type: 'bandpass', f: 2050 * k, q: 2, gain: 0.19 * level, tau: 0.0032 })
  pop(t, 1280 * k, { ...o, gain: 0.02 * level, tau: 0.007, drop: 0.85 })
}

// ---- 回り出す ---------------------------------------------------------------

let taps = 0 // この回の連打の数（2 つの高さを交互にする）
let lastTap = -1 // 前の 1 打の時刻（ctx の時刻）

// レバーを倒す「カチャッ」→ モーターが立ち上がる「ウィーン」とリールの風切り。コマ送りが「カタ、カタ、カタカタカタ…」と
// 速くなりながら風切りに溶けていき、回りきったところで小さく「キラッ」と光る（段階の音とまぎれないよう、旋律は鳴らさない）
function spinStart(): void {
  if (!engine.ready) return
  endBrake(0.02) // 前の回の減速の音が残っていれば止める
  taps = 0
  lastTap = -1
  if (!engine.enabled) return
  const t = soon()
  burst(t, { type: 'bandpass', f: 2000, q: 1.4, gain: 0.2, tau: 0.004 })
  burst(t + 0.016, { type: 'bandpass', f: 1150, q: 1, gain: 0.14, tau: 0.012 })
  pop(t, 640, { gain: 0.06, tau: 0.03, drop: 0.7, type: 'triangle' })
  thump(t, 150, 70, { gain: 0.09, tau: 0.045, drive: 1.4 })
  metal(t + 0.004, [1630, 2870, 4110], { gain: 0.016, tau: 0.08, reverb: 0.1 })
  // モーター: 低いのこぎり波が 1.5 オクターブ上がり、こもった音が開いていく
  const t1 = t + 0.02
  const d = 0.55
  const g = amp(dest({ reverb: 0.08 }))
  shape(g.gain, t1, d, (x) => 0.05 * swell(x, 0.55), 16)
  const lp = filter('lowpass', 450, 2.5, g)
  lp.frequency.setValueAtTime(450, t1)
  lp.frequency.exponentialRampToValueAtTime(2200, t1 + d)
  osc('sawtooth', 70, t1, t1 + d + 0.03, lp).frequency.exponentialRampToValueAtTime(220, t1 + d)
  whoosh(t + 0.04, 0.52, { f0: 450, f1: 2800, q: 1.1, gain: 0.07, peak: 0.7, reverb: 0.08 })
  // コマ送り: 間隔を 0.8 倍ずつ詰めていく
  let at = t + 0.07
  for (let i = 0; i < 9; i++) {
    const x = i / 8
    notch(at, (i % 2 ? 0.92 : 1) * (1 + 0.12 * x), 0.9 * (1 - 0.5 * x), { pan: rand(-0.1, 0.1) })
    at += 0.11 * Math.pow(0.8, i)
  }
  glint(t + 0.48, midi(96), { gain: 0.016, pan: -0.15, reverb: 0.3 })
  glint(t + 0.53, midi(103), { gain: 0.011, pan: 0.15, reverb: 0.3 })
}

// ---- 連打 -------------------------------------------------------------------

// 連打の 1 打: 指先の「トッ」と、音程のある小さな「ポ」、指に返るごく低い「トン」。
// ゲージが溜まるほど「ポ」が五音音階を上がり（ミ → 1 オクターブ上のミ）、倍音と高い「シャッ」が増え、
// 音程が下がる「ポ」から跳ね上がる「ピッ」へ変わっていく。
// 「トッ」の高さを 2 つ交互にし（左右の指のように）、音量・定位・音程を毎回少しずつ揺らして、機械的な連打に聞こえないようにする
function spinTap(power: number): void {
  if (!live()) return
  const t = soon()
  const p = clamp(Number.isFinite(power) ? power : 0, 0, 1)
  // 速い連打ほど 1 打を小さく（間隔 0.12 秒以上で 1、12 回/秒で 0.9、16 回/秒で 0.82 くらい）
  const gap = lastTap < 0 ? 1 : t - lastTap
  lastTap = t
  const k = clamp(0.62 + gap * 3.2, 0.75, 1) * rand(0.88, 1.06)
  const alt = ++taps % 2 ? 1 : 0.92
  const pn = rand(-0.14, 0.14)
  const f = scale(2 + Math.round(p * 5)) * Math.pow(2, rand(-8, 8) / 1200)
  burst(t, { type: 'bandpass', f: (1350 + 650 * p) * alt * rand(0.95, 1.05), q: 1.3, gain: (0.13 + 0.05 * p) * k, tau: 0.0028, pan: pn })
  pop(t, f, { gain: (0.046 + 0.016 * p) * k * (alt === 1 ? 1 : 0.9), tau: 0.016 + 0.006 * p, drop: 0.84 + 0.22 * p, pan: pn })
  pop(t, f * 2, { gain: (0.004 + 0.012 * p) * k, tau: 0.01, drop: 0.9 + 0.15 * p, pan: pn })
  pop(t, 190 + 70 * p, { gain: 0.037 * k, tau: 0.013, drop: 0.62 })
  if (p > 0.4) burst(t, { type: 'bandpass', f: 5800, q: 1, gain: 0.06 * ((p - 0.4) / 0.6) * k, tau: 0.004, pan: -pn })
}

// ---- ゲージの段階 -----------------------------------------------------------

// level ごとの和音（金管・パッド）。段階の音 ド → レ → ミ → ソ に合わせ、五音音階の音だけで組む
// （ド・レ・ラ・ソ の和音を順にたどり、着地の鐘のドへ戻る）
const CHORD: readonly (readonly number[])[] = [
  [60, 67, 72, 76], // 1: ド ソ ド ミ
  [62, 69, 74, 81], // 2: レ ラ レ ラ
  [57, 64, 72, 76], // 3: ラ ミ ド ミ
  [55, 62, 67, 74], // 4: ソ レ ソ レ（着地のドへ向かう）
]

// ゲージの段階が上がった。level 1〜4 で ド・レ・ミ・ソ と上がり、予告の格で中身を変える:
// 青「ポロン」（2 音だけ）、緑「ピロリン」、赤「吸い込んでジャン！」、金「シャララ → 鐘と金管」、虹は左右いっぱいに広げて光が上へ抜ける
function spinLevel(level: number, tier: Tier): void {
  if (!live()) return
  const t = soon()
  const lv = clamp(Math.round(level) || 1, 1, 4)
  const x = clamp(Math.round(tier) || 0, 0, 4)
  const top = 4 + lv // 五音音階で何番目の音か（5 ド・6 レ・7 ミ・8 ソ）
  const chord = CHORD[lv - 1].map(midi)
  const k = 0.88 + lv * 0.04 // 段が上がるほど少しずつ大きく
  if (x === 0) {
    pluck(t, scale(top - 2), { gain: 0.045 * k, tau: 0.1, bright: 3, pan: -0.12, reverb: 0.12 })
    pluck(t + 0.065, scale(top), { gain: 0.056 * k, tau: 0.26, bright: 3.5, pan: 0.12, reverb: 0.18 })
    glint(t + 0.065, scale(top + 5), { gain: 0.01 * k, reverb: 0.25 })
    return
  }
  if (x === 1) {
    whoosh(t, 0.2, { f0: 900, f1: 4500, q: 1.2, gain: 0.035 * k, peak: 0.8 })
    for (let i = 0; i < 3; i++) {
      pluck(t + i * 0.05, scale(top - 2 + i), { gain: 0.06 * k, tau: i === 2 ? 0.42 : 0.12, pan: -0.25 + i * 0.25, reverb: 0.2 })
    }
    bell(t + 0.1, scale(top), { gain: 0.022 * k, tau: 0.6, reverb: 0.3 })
    sparkle(t + 0.12, 0.3, 3, { lo: 2600, hi: 5000, gain: 0.015 })
    return
  }
  if (x === 2) {
    // 赤: 速い駆け上がりで吸い込み、低いドン＋短い金管の和音（激アツの手触り）
    const hit = t + 0.13
    whoosh(t, 0.15, { f0: 500, f1: 4200, q: 1.1, gain: 0.05 * k, peak: 0.9 })
    for (let i = 0; i < 4; i++) pluck(t + i * 0.032, scale(top - 4 + i), { gain: 0.048 * k, tau: 0.1, pan: -0.3 + i * 0.2, reverb: 0.15, bright: 7 })
    thump(hit, 150, 55, { gain: 0.15 * k, tau: 0.07, drive: 1.8 })
    burst(hit, { type: 'bandpass', f: 4500, q: 0.6, gain: 0.07 * k, tau: 0.01 })
    for (const f of chord.slice(0, 3)) brass(hit, f, 0.17, { gain: 0.04 * k, voices: 2, bright: 1.15, reverb: 0.18 })
    pluck(hit, scale(top), { gain: 0.05 * k, tau: 0.35, reverb: 0.25, bright: 7 })
    return
  }
  // 金・虹: きらめく駆け上がり → 低いドン＋鐘の和音＋金管＋シンバル＋きらきら。
  // 虹は駆け上がりを長く左右いっぱいにし、鐘を 1 つ足して、パッドで包み、光が上へ抜けていく
  const rainbow = x === 4
  const n = rainbow ? 9 : 6
  const gap = rainbow ? 0.022 : 0.026
  const wide = rainbow ? 0.8 : 0.5
  for (let i = 0; i < n; i++) {
    pluck(t + i * gap, scale(top - n + i), { gain: 0.042 * k, tau: 0.22, pan: -wide + (2 * wide * i) / (n - 1), reverb: 0.3 })
  }
  const hit = t + n * gap
  thump(hit, 130, 45, { gain: 0.15 * k, tau: 0.1, drive: 1.6 })
  const bells = rainbow ? [top, top + 2, top + 3, top + 5] : [top, top + 2, top + 5]
  bells.forEach((i, j) =>
    bell(hit + j * 0.015, scale(i), { gain: 0.022 * k, tau: 0.9, pan: -0.3 + (0.6 * j) / (bells.length - 1), reverb: 0.35 }),
  )
  for (const f of chord.slice(0, 3)) brass(hit, f, 0.22, { gain: 0.032 * k, voices: rainbow ? 3 : 2, bright: 1.15, reverb: 0.25 })
  crash(hit, { gain: 0.02, tau: 0.35, reverb: 0.3 })
  if (!rainbow) {
    sparkle(hit + 0.03, 0.5, 7 + lv, { lo: 2200, hi: 5000, gain: 0.02 })
    return
  }
  pad(hit, chord, { gain: 0.01, attack: 0.05, hold: 0.3, release: 0.8, lp: 1800, lpTo: 4500, spread: 12, vib: 7, reverb: 0.4 })
  whoosh(hit, 0.6, { f0: 1500, f1: 6500, q: 1.6, gain: 0.035, peak: 0.6, reverb: 0.3 })
  sparkle(hit + 0.02, 0.7, 12 + lv * 2, { lo: 2000, hi: 5600, gain: 0.022, rise: true, reverb: 0.5 })
}

// ---- STOP と着地 --------------------------------------------------------------

// STOP が押せる: 光が走る「シュッ」と、構える「カチャッ」、高い「ピコーン」（ソ → 上のド）。
// 連打の「ポ」より上に置いて、連打の最中でも聞き分けられるようにする。鳴っているのは 0.4 秒ほど
function stopReady(): void {
  if (!live()) return
  const t = soon()
  whoosh(t, 0.1, { f0: 1500, f1: 6500, q: 1.4, gain: 0.045, peak: 0.85 })
  const hit = t + 0.07
  burst(hit, { type: 'bandpass', f: 2300, q: 2, gain: 0.14, tau: 0.004 })
  metal(hit, [1870, 2930, 4410], { gain: 0.016, tau: 0.07, reverb: 0.12 })
  pluck(hit, midi(91), { gain: 0.05, tau: 0.07, bright: 4, pan: -0.12, reverb: 0.15 })
  pluck(hit + 0.075, midi(96), { gain: 0.055, tau: 0.28, bright: 4, pan: 0.12, reverb: 0.22 })
  pluck(hit + 0.075, midi(84), { gain: 0.028, tau: 0.22, bright: 3, reverb: 0.2 })
  bell(hit + 0.075, midi(96), { gain: 0.022, tau: 0.45, pan: 0.12, reverb: 0.28 })
}

let brake: GainNode | null = null // 減速の音の出口。着地（と次の回り出し）で絞る

// 減速の音を fade 秒で絞る（まだ鳴っていないコマ送りも、絞った出口の先では聞こえない）
function endBrake(fade: number): void {
  const g = brake
  brake = null
  if (!g || !engine.ctx) return
  const now = engine.now
  g.gain.cancelScheduledValues(now)
  g.gain.setValueAtTime(g.gain.value, now)
  g.gain.linearRampToValueAtTime(0, now + fade)
}

// STOP: 大きなボタンを押し込む「カチッ・コッ」と、指に返る低い「ドッ」、機構の小さな「キン」。
// 続けてブレーキが「キュウゥン」とかかり、風切りがしぼみ、コマ送りが「カラララ…カタ…カタ」と遅くなっていく
// （コマ送りは 0.9 秒ほど続けて、だんだん小さくする。その前に着地が来たら、そこで止める）
function stopPress(): void {
  if (!live()) return
  const t = soon()
  burst(t, { type: 'bandpass', f: 2500, q: 1.1, gain: 0.24, tau: 0.0035 })
  pop(t, 700, { gain: 0.13, tau: 0.04, drop: 0.7, type: 'triangle' })
  thump(t, 175, 58, { gain: 0.2, tau: 0.065, drive: 1.8, lp: 700 })
  burst(t + 0.014, { type: 'lowpass', f: 1300, gain: 0.16, tau: 0.012 })
  metal(t + 0.005, [1210, 2570, 3830, 5090], { gain: 0.026, tau: 0.09, reverb: 0.12 })
  endBrake(0.01)
  const to = dest({ reverb: 0.06 })
  brake = to
  // モーターが落ちる「キュウゥン」
  const g = amp(dest({ to }))
  const end = perc(g.gain, t + 0.01, 0.05, 0.008, 0.11)
  const lp = filter('lowpass', 2400, 2.2, g)
  lp.frequency.setValueAtTime(2400, t + 0.01)
  lp.frequency.exponentialRampToValueAtTime(400, t + 0.32)
  osc('sawtooth', 640, t + 0.01, end, lp).frequency.exponentialRampToValueAtTime(170, t + 0.32)
  whoosh(t + 0.01, 0.34, { f0: 2400, f1: 700, q: 1.2, gain: 0.06, peak: 0.12, to })
  // コマ送りが遅くなっていく（間隔を 1.19 倍ずつ広げ、高さも少しずつ下げる）
  let at = t + 0.03
  for (let i = 0; i < 11; i++) {
    const x = i / 10
    notch(at, (i % 2 ? 0.92 : 1) * (1 - 0.15 * x), 1.05 * (1 - 0.65 * x), { pan: rand(-0.1, 0.1), to })
    at += 0.032 * Math.pow(1.19, i)
  }
}

// 着地: リールが噛み合って止まる「ガチッ」と、少し戻って落ち着く「カタン」。段階が高いほど低音が重く、鐘ときらめきが増える。
// 鐘はドの和音（段階の音 ド・レ・ミ・ソ のあと、ここで落ち着く）。大画面の impact より、どの段階も小さく短い
function reelLand(tier: Tier): void {
  if (!engine.ready) return
  endBrake(0.015) // 減速のコマ送りは着地で終わる
  if (!engine.enabled) return
  const t = soon()
  const x = clamp(Math.round(tier) || 0, 0, 4)
  burst(t, { type: 'bandpass', f: 1900, q: 1, gain: 0.2, tau: 0.005 })
  burst(t, { type: 'lowpass', f: 900, gain: 0.1, tau: 0.018 })
  metal(t + 0.003, [1150, 2480, 3710], { gain: 0.018, tau: 0.07, reverb: 0.1 })
  burst(t + 0.055, { type: 'bandpass', f: 2200, q: 1.5, gain: 0.07, tau: 0.003 }) // 少し戻って落ち着く
  pop(t + 0.055, 1050, { gain: 0.018, tau: 0.008, drop: 0.85 })
  if (x <= 1) {
    thump(t, 160, 70, { gain: 0.075 + x * 0.03, tau: 0.05 + x * 0.02, drive: 1.5 })
    pop(t, midi(84), { gain: 0.085 + x * 0.015, tau: 0.07 + x * 0.03, drop: 0.68, reverb: 0.12 })
    if (x === 0) {
      glint(t + 0.02, midi(96), { gain: 0.01, reverb: 0.25 })
      return
    }
    pluck(t + 0.03, midi(84), { gain: 0.038, tau: 0.25, pan: -0.2, reverb: 0.25 })
    pluck(t + 0.08, midi(91), { gain: 0.036, tau: 0.35, pan: 0.2, reverb: 0.3 })
    sparkle(t + 0.08, 0.35, 3, { lo: 2500, hi: 4500, gain: 0.015 })
    return
  }
  // 赤から上: 低音のドロップと雑音の割れで重くし、鐘を足す
  const k = x - 2 // 0 赤 / 1 金 / 2 虹
  thump(t, 120 - k * 8, 38, { gain: 0.17 + k * 0.01, tau: 0.14 + k * 0.05, glide: 0.25 + k * 0.1, drive: 1.6, lp: 600 })
  burst(t, { type: 'lowpass', f: 1000, sweep: 160, gain: 0.12 + k * 0.025, tau: 0.08 + k * 0.04 })
  pop(t, 660, { gain: 0.06, tau: 0.08, drop: 0.66 })
  if (x === 2) {
    bell(t + 0.005, midi(84), { gain: 0.034, tau: 0.7, reverb: 0.3 })
    bell(t + 0.02, midi(91), { gain: 0.024, tau: 0.6, pan: 0.2, reverb: 0.3 })
    sparkle(t + 0.05, 0.4, 5, { lo: 2200, hi: 4800, gain: 0.018 })
    return
  }
  // 金・虹: 軽いシンバルと鐘の和音（ド ミ ソ ド）。虹は虹のグリッサンドとパッドを重ねる
  crash(t, { gain: 0.026 + k * 0.006, tau: 0.45 + k * 0.2, reverb: 0.3 })
  ;[84, 88, 91, 96].forEach((n, i) =>
    bell(t + i * 0.016, midi(n), { gain: 0.021, tau: 1.0 + k * 0.3, pan: -0.36 + i * 0.24, reverb: 0.4 }),
  )
  if (x === 4) {
    const run = [72, 76, 79, 84, 86, 88, 91, 96]
    run.forEach((n, i) =>
      pluck(t + 0.08 + i * 0.024, midi(n), { gain: 0.028, tau: 0.3, pan: -0.8 + (1.6 * i) / (run.length - 1), reverb: 0.4 }),
    )
    pad(t + 0.1, [60, 64, 67, 74].map(midi), { gain: 0.009, attack: 0.2, hold: 0.8, release: 1.1, lp: 2400, vib: 7, reverb: 0.45 })
  }
  sparkle(t + 0.06, 0.7 + k * 0.4, 9 + k * 5, { lo: 2000, hi: 5200, gain: 0.02, reverb: 0.45 })
}

export const spinSfx: SpinSfx = {
  spinStart,
  spinTap,
  spinLevel,
  stopReady,
  stopPress,
  reelLand,
}

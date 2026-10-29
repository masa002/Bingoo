import { engine } from './engine'
import type { DrawSfx } from './types'

// 抽選まわりの効果音。音声ファイルは使わず、すべて Web Audio で合成する。
//
//   - 1 つの音を、役割の違う層で重ねて作る（低音の芯・雑音のアタック・音程のある本体・倍音の飾り・残響）
//   - 時刻はすべて engine.now（ctx.currentTime）を基準に予約する
//   - 段階（青 緑 赤 金 虹）が上がるほど、低く重い層と、高く華やかな層を足していく
//   - 高い音で「キュイン」と上がる音色は確定音（kakutei）だけに使う。この音が鳴ったら確定、と覚えてもらう
//   - 重ねたときのピークが 0.5 を超えないように層の音量を決める（リミッターに頼らない）。9kHz より上は鳴らさない
//   - 伸ばす音（ライザー・鼓動・間の空気・PUSH 待ちの響き）は、止めるときに 15ms で絞ってから止める（プツッと鳴らさない）。
//     溜めの音は impact()（着地）でもすべて止まる
//
// BGM の下げ・戻し（engine.duckBgm）もここで行う:
//   ma() で 0、kakutei() と rainbowChord() で 0.15、fanfare() の間は 0.35、finalBall() の間は 0.3 に下げる。
//   impact() で戻す。fanfare()・rainbowChord()・finalBall() は鳴り終わったら自分で戻す。silence() は戻さない

// ---- 道具 -------------------------------------------------------------------

const ac = (): AudioContext => engine.ctx!
const live = (): boolean => engine.ready && engine.enabled
// 鳴らし始める時刻。ノードを組む間に時計が進んでも頭が欠けないよう、少しだけ先に予約する
const soon = (): number => engine.now + 0.008

const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12)
const notes = (...ns: number[]): number[] => ns.map(midi)

interface Place {
  pan?: number
  reverb?: number // 残響へ送る量（0〜1）
  to?: AudioNode // 効果音バスではなく、自前の経路（確定音の音質調整など）に流すとき。残響は経路の側で付ける
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

// AudioParam を揺らす深さ（LFO → 深さ → param）
function mod(param: AudioParam, depth: number): GainNode {
  const g = ac().createGain()
  g.gain.value = depth
  g.connect(param)
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

// 白色雑音。共有のバッファを毎回ちがう位置から読むので、重ねても同じ波形にならない（左右に置くと広がる）
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
function vibrato(t: number, end: number, rate: number, depth: number, fadeIn = 0.25, rateTo?: number): GainNode {
  const c = ac()
  const lfo = c.createOscillator()
  lfo.frequency.setValueAtTime(rate, t)
  if (rateTo) lfo.frequency.linearRampToValueAtTime(rateTo, end)
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

// ハ長調のペンタトニック。どの音を重ねても濁らないので、きらめきの粒はこの音階に乗せる
const PENTA = [0, 2, 4, 7, 9] as const

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

// ---- 楽器（よく使う層） -----------------------------------------------------

// 丸い「ポン」。鳴った直後に音程が少し下がる
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

// 雑音の一撃。フィルタの種類と帯域で「カチッ」「パキッ」「ドスッ」「シャッ」を作り分ける。sweep は帯域の行き先
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
// 音程はわずかに下から入り（しゃくり）、長い音にはあとからビブラートがかかる
function brass(
  t: number,
  f: number,
  dur: number,
  o: Place & { gain: number; voices?: number; spread?: number; bright?: number; vib?: number },
): void {
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
  const vib = o.vib && dur > 0.32 ? vibrato(t + 0.18, end, 5.4, o.vib, 0.3) : null
  for (let i = 0; i < n; i++) {
    const det = n === 1 ? 0 : ((i / (n - 1)) * 2 - 1) * spread
    const s = osc('sawtooth', f, t, end, amp(lp, 1 / n))
    s.detune.setValueAtTime(det - 28, t)
    s.detune.linearRampToValueAtTime(det, t + 0.045)
    vib?.connect(s.detune)
  }
  // 息の音
  burst(t, { type: 'bandpass', f: Math.min(f * 2.5, 6000), q: 1.4, gain: o.gain * 0.5, attack: 0.006, tau: 0.025, pan: o.pan, to: o.to })
}

type Part = readonly (readonly [at: number, note: number, dur: number])[]

// 楽譜どおりに金管を鳴らす（at・dur は秒、note は MIDI の番号）
function score(t: number, part: Part, o: Place & { gain: number; voices?: number; spread?: number; bright?: number; vib?: number }): void {
  for (const [at, n, dur] of part) brass(t + at, midi(n), dur, o)
}

// 和音のパッド。のこぎり波を左右にずらして重ね、ローパスでやわらげる。lpTo へ向けて音色を開く（閉じる）
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

// 合唱のような「アー」。のこぎり波の和音を、母音「ア」の共鳴（フォルマント）に通す
const FORMANT_A: readonly (readonly [freq: number, q: number, level: number])[] = [
  [800, 3, 1],
  [1150, 4, 0.6],
  [2900, 5, 0.25],
]

function choir(t: number, freqs: readonly number[], o: { gain: number; attack: number; hold: number; release: number; reverb?: number }): void {
  const g = amp(dest({ reverb: o.reverb }))
  const end = sustain(g.gain, t, o.gain, o.attack, t + o.hold, o.release)
  const mix = ac().createGain()
  for (const [f, q, level] of FORMANT_A) mix.connect(filter('bandpass', f, q, amp(g, level)))
  mix.connect(filter('lowpass', 900, 0.7, amp(g, 0.2)))
  freqs.forEach((f, i) => {
    for (const side of [-1, 1]) {
      const s = osc('sawtooth', f, t, end, amp(pan(side * 0.5, mix), 0.5), side * 7)
      vibrato(t, end, 4.6 + i * 0.3 + side * 0.12, 14, o.attack + 0.3).connect(s.detune)
    }
  })
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
function sparkle(t: number, dur: number, count: number, o: { lo: number; hi: number; gain: number; rise?: boolean; reverb?: number; to?: AudioNode }): void {
  for (let i = 0; i < count; i++) {
    const x = o.rise ? i / Math.max(1, count - 1) : Math.random()
    const at = t + clamp(x * dur + rand(-0.04, 0.04), 0, dur)
    const y = o.rise ? clamp(x + rand(-0.12, 0.12), 0, 1) : Math.random()
    const f = onScale(o.lo * Math.pow(o.hi / o.lo, y))
    glint(at, f, { gain: o.gain * rand(0.55, 1), pan: rand(-0.8, 0.8), reverb: o.reverb ?? 0.5, to: o.to })
  }
}

// 風切り。帯域を動かした雑音が、ふくらんでしぼむ。pan1 を渡すと左右に動く
function whoosh(
  t: number,
  dur: number,
  o: { f0: number; f1: number; q?: number; gain: number; peak?: number; pan0?: number; pan1?: number; reverb?: number },
): void {
  const ob = out({ pan: o.pan0, reverb: o.reverb })
  if (o.pan1 !== undefined) {
    ob.panner.pan.setValueAtTime(clamp(o.pan0 ?? 0, -1, 1), t)
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

// ティンパニ（音程のある低い太鼓）
function timpani(t: number, f: number, gain: number, tau = 0.3): void {
  thump(t, f * 1.35, f, { gain, tau, glide: 0.06, drive: 1.2, lp: 900, reverb: 0.25 })
  burst(t, { type: 'lowpass', f: 700, gain: gain * 0.9, tau: 0.03 })
}

// 和太鼓（ドン）
function taiko(t: number, k: number): void {
  thump(t, 125, 58, { gain: 0.28 * k, tau: 0.15, glide: 0.1, drive: 1.6, lp: 600, reverb: 0.2 })
  burst(t, { type: 'bandpass', f: 230, q: 0.9, gain: 0.55 * k, tau: 0.05, reverb: 0.2 })
  burst(t, { type: 'highpass', f: 1800, gain: 0.05 * k, tau: 0.004 })
}

// 刃物のような「シャキーン」
function shing(t: number, gain: number, tau: number): void {
  whoosh(t - 0.02, 0.1, { f0: 3000, f1: 7000, q: 2, gain: gain * 1.2, peak: 0.85 })
  burst(t, { type: 'bandpass', f: 5200, q: 5, gain: gain * 2.2, attack: 0.002, tau, reverb: 0.35 })
  metal(t, [2310, 3570, 4980, 6290], { gain, tau: tau * 1.2, reverb: 0.4 })
}

// 歪んだ低いのこぎり波（赤の荒々しさ）
function grit(t: number, f: number, dur: number, gain: number): void {
  const lp = filter('lowpass', 1400, 0.9, amp(dest({ reverb: 0.15 }), gain))
  lp.frequency.setValueAtTime(1400, t)
  lp.frequency.setTargetAtTime(400, t + 0.03, dur * 0.4)
  const env = amp(drive(3, lp))
  const end = sustain(env.gain, t, 1, 0.006, t + dur * 0.4, dur * 0.6)
  osc('sawtooth', f, t, end, env)
  osc('sawtooth', f * 1.006, t, end, env)
}

// カードが 1 枚、目の前を横切る「シュッ」（近づくと高く、離れると低く）
function fwip(t: number, p: number): void {
  const d = 0.11
  const g = amp(dest({ pan: p, reverb: 0.1 }))
  shape(g.gain, t, d, (x) => 0.24 * swell(x, 0.45), 10)
  const bp = filter('bandpass', 3200, 3, g)
  bp.frequency.setValueAtTime(3200, t)
  bp.frequency.exponentialRampToValueAtTime(900, t + d)
  noise(t, t + d + 0.01, bp)
}

// ガラスの小さな鳴り（ピキッ）
function ping(t: number, f: number, p: number, gain: number): void {
  const g = amp(dest({ pan: p, reverb: 0.35 }))
  const end = perc(g.gain, t, gain, 0.0008, rand(0.015, 0.045))
  const s = osc('sine', f, t, end, g)
  s.frequency.exponentialRampToValueAtTime(f * 0.96, end)
}

// 氷がきしむ低い音（ギ…ギギ…）。低いのこぎり波の音程を不規則に飛ばし、帯域を絞る
function creak(t: number, dur: number): void {
  const g = amp(dest({ reverb: 0.1 }))
  shape(g.gain, t, dur, (x) => 0.06 * swell(x, 0.7), 16)
  const s = osc('sawtooth', 60, t, t + dur + 0.02, filter('bandpass', 420, 2.2, g))
  for (let at = t + 0.03; at < t + dur; at += rand(0.025, 0.07)) s.frequency.setValueAtTime(rand(38, 90), at)
}

// ためる音（ギュイッ）。低いのこぎり波が 2 オクターブ駆け上がり、共鳴するローパスが追いかける
function charge(t: number): void {
  const d = 0.32
  const g = amp(dest({ reverb: 0.2 }))
  shape(g.gain, t, d + 0.06, (x) => 0.07 * swell(x, 0.8), 16)
  const lp = filter('lowpass', 300, 5, g)
  lp.frequency.setValueAtTime(300, t)
  lp.frequency.exponentialRampToValueAtTime(3400, t + d)
  for (const [mul, level] of [[1, 0.7], [2, 0.3]] as const) {
    const s = osc('sawtooth', 110 * mul, t, t + d + 0.08, amp(lp, level))
    s.frequency.exponentialRampToValueAtTime(440 * mul, t + d)
  }
}

// ---- 伸ばす音（ライザー・鼓動・間の空気）の管理 ---------------------------

// air は間の空気と PUSH 待ちの響き。engine.hold には登録しない（ma() と同時の silence() で消えないように）
type HeldKind = 'riser' | 'beat' | 'air'

interface Held {
  kind: HeldKind
  gate: GainNode // ふだんは 1。止めるときにここを絞る
  srcs: AudioScheduledSourceNode[]
  start: number
  end: number // 自然に消える時刻
}

const held = new Set<Held>()

function holdVoice(kind: HeldKind, t: number, end: number, o: Place = {}): Held {
  for (const h of held) if (h.end < engine.now) held.delete(h)
  const gate = dest(o)
  gate.gain.value = 1
  const h: Held = { kind, gate, srcs: [], start: t, end }
  held.add(h)
  return h
}

// 伸ばす音の音源を登録する。global なら engine.hold にも登録し、engine.stopHeld() でも止まるようにする
function keep<T extends AudioScheduledSourceNode>(h: Held, src: T, global = true): T {
  h.srcs.push(src)
  return global ? engine.hold(src) : src
}

// 伸ばしている音を、fade 秒で絞ってから止める。which を省くとすべて
function cut(fade: number, which?: (h: Held) => boolean): void {
  if (!engine.ctx) return
  const now = engine.now
  for (const h of held) {
    if (which && !which(h)) continue
    const g = h.gate.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(0, now + fade)
    for (const s of h.srcs) {
      try {
        s.stop(now + fade + 0.01) // まだ始まっていない音（先読みした鼓動）は、そもそも鳴らない
      } catch {
        // すでに止まっている
      }
    }
    held.delete(h)
  }
}

const kinds =
  (...k: HeldKind[]) =>
  (h: Held): boolean =>
    k.includes(h.kind)

// 鼓動の先読みのタイマー（音の時刻は Web Audio の時計で決まる。タイマーは少し先までを予約するだけ）
let beatTimer = 0

function stopBeats(): void {
  if (beatTimer) window.clearInterval(beatTimer)
  beatTimer = 0
}

// 鼓動 1 回分（ドクン）。1 打目は強く低く、2 打目は少し弱い。テンポが速いほど 2 打目が詰まる
function lubDub(t: number, period: number, k: number): void {
  const gap = clamp(period * 0.32, 0.07, 0.22)
  const tau = Math.min(0.085, period * 0.3)
  beatHit(t, 58, 0.34 * k, tau)
  beatHit(t + gap, 50, 0.24 * k, tau * 0.85)
}

function beatHit(t: number, f: number, gain: number, tau: number): void {
  const h = holdVoice('beat', t, t + tau * 7 + 0.15)
  // 芯: 少し上から落ちる正弦波を軽く歪ませ、サブベースに聞こえる倍音を足す
  const env = amp(drive(1.8, filter('lowpass', 340, 0.8, amp(h.gate, gain))))
  const end = perc(env.gain, t, 1, 0.004, tau)
  const s = keep(h, osc('sine', f * 1.7, t, end, env))
  s.frequency.exponentialRampToValueAtTime(f, t + 0.03)
  s.frequency.exponentialRampToValueAtTime(f * 0.72, t + tau * 3)
  // 胸を打つ鈍い音
  const n = amp(h.gate)
  perc(n.gain, t, gain * 0.45, 0.002, 0.018)
  keep(h, noise(t, t + 0.14, filter('lowpass', 200, 0.7, n)))
}

// ---- BGM の下げ・戻し ---------------------------------------------------------
// 後から呼んだ指示が勝つ。予約した「戻す」は、その間に別の指示があれば取り消す。
// （duckBgm は今の時刻からしか動かせないので、戻す時刻だけはタイマーで待つ）

let duckSeq = 0
let duckTimer = 0

function duck(level: number, ms: number): void {
  duckSeq++
  window.clearTimeout(duckTimer)
  engine.duckBgm(level, ms)
}

function unduck(ms: number, after = 0): void {
  const seq = ++duckSeq
  window.clearTimeout(duckTimer)
  if (after <= 0) {
    engine.duckBgm(1, ms)
    return
  }
  duckTimer = window.setTimeout(() => {
    if (seq === duckSeq) engine.duckBgm(1, ms)
  }, after * 1000)
}

// ---- 確定音の部品 -----------------------------------------------------------

// 「キュイン」1 回分（85ms）。矩形波とのこぎり波を混ぜ、速く上がって細かく揺れ、最後は口を閉じるようにこもる
function chirp(t: number, p: number, to: AudioNode): void {
  const d = 0.085
  const g = amp(pan(p, to))
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(0.26, t + 0.004)
  g.gain.setValueAtTime(0.26, t + d - 0.022)
  g.gain.linearRampToValueAtTime(0, t + d)
  const lp = filter('lowpass', 7500, 1.4, g)
  lp.frequency.setValueAtTime(7500, t + d - 0.03)
  lp.frequency.exponentialRampToValueAtTime(2400, t + d)
  const vib = vibrato(t, t + d + 0.02, 24, 35, 0.01)
  // はじめ速く、上のほうでゆっくり（キュ→イン）
  const rise = (x: number): number => 1200 * Math.pow(2600 / 1200, 1 - Math.pow(1 - x, 2.6))
  for (const [type, level, det] of [['square', 0.42, 0], ['sawtooth', 0.36, 8], ['sawtooth', 0.28, -10]] as const) {
    const s = osc(type, 1200, t, t + d + 0.02, amp(lp, level), det)
    shape(s.frequency, t, 0.068, rise, 14)
    s.frequency.linearRampToValueAtTime(2520, t + d)
    vib.connect(s.detune)
  }
}

// 「ちゅいーん」（1.18 秒）。700Hz から 3kHz へ、はじめ速く、だんだんゆっくり上がる。途中から歌うようなビブラート
function whine(t: number, to: AudioNode): void {
  const rise = 1.0
  const len = 1.18
  const f0 = 700
  const f1 = 3000
  const curve = (x: number): number => f0 * Math.pow(f1 / f0, 1 - Math.pow(1 - x, 2))
  // 「ち」の子音
  burst(t, { type: 'bandpass', f: 5200, q: 0.9, gain: 0.22, tau: 0.012, to })
  const g = amp(to)
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(0.7, t + 0.012)
  g.gain.linearRampToValueAtTime(1, t + 0.3)
  g.gain.setValueAtTime(1, t + 0.8)
  g.gain.linearRampToValueAtTime(0, t + len)
  // 「ん」: 終わりに向けてこもる
  const lp = filter('lowpass', 8000, 0.7, g)
  lp.frequency.setValueAtTime(8000, t + 0.82)
  lp.frequency.exponentialRampToValueAtTime(2000, t + len)
  const vib = vibrato(t + 0.2, t + len + 0.05, 6.5, 38, 0.5, 8.5)
  // [波形, 倍率, 音量, ずらし（セント）, 定位]。左右にずらした相方で広げ、1 オクターブ下で芯、上できらめきを足す
  const layers = [
    ['square', 1, 0.08, 0, 0],
    ['sawtooth', 1, 0.075, 0, 0],
    ['sawtooth', 1, 0.058, 9, -0.55],
    ['sawtooth', 1, 0.058, -9, 0.55],
    ['sine', 0.5, 0.1, 0, 0],
    ['triangle', 2, 0.025, 0, 0],
  ] as const
  for (const [type, mul, level, det, p] of layers) {
    const s = osc(type, f0 * mul, t, t + len + 0.03, amp(pan(p, lp), level), det)
    shape(s.frequency, t, rise, (x) => curve(x) * mul, 28)
    s.frequency.linearRampToValueAtTime(f1 * 1.05 * mul, t + len)
    vib.connect(s.detune)
  }
}

// 帰還のない多重エコー（高い成分だけを、左右交互に返す）。taps は [遅れ（秒）, 音量, 定位]
function echoes(from: AudioNode, taps: readonly (readonly [delay: number, level: number, pan: number])[]): void {
  const c = ac()
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 1600
  from.connect(hp)
  for (const [delay, level, p] of taps) {
    const d = c.createDelay(1)
    d.delayTime.value = delay
    hp.connect(d)
    d.connect(amp(dest({ pan: p, reverb: 0.5 }), level))
  }
}

// ---- 抽選の効果音 -------------------------------------------------------------

let tickCount = 0
let pseudoRun = 0 // 疑似連の何回目か（続けて呼ばれると 0, 1, 2）
let pseudoAt = -10

function pseudoIndex(): number {
  if (engine.now - pseudoAt > 2.5) pseudoRun = 0
  return pseudoRun
}

const STEP_SEMI = [0, 2, 4, 7, 9, 12, 14] as const // ステップアップの音階（ソから上へ）

export const drawSfx: DrawSfx = {
  // ボタン: 指先に返る、小さく丸い「ポッ」
  uiTap() {
    if (!live()) return
    const t = soon()
    pop(t, 1250, { gain: 0.06, tau: 0.028, drop: 0.78 })
    pop(t, 520, { gain: 0.05, tau: 0.022, drop: 0.7, type: 'triangle' })
    burst(t, { type: 'bandpass', f: 3600, q: 1.2, gain: 0.1, tau: 0.003 })
  },

  // コマ送り: ごく短い「カチ」。耳に刺さりやすい 3kHz 前後を避けて少し低めに置き、
  // 2 つの高さを交互にし、少しずつ揺らして、機械的な連打に聞こえないようにする
  tick() {
    if (!live()) return
    const t = soon()
    tickCount++
    const k = (tickCount % 2 ? 1 : 0.9) * rand(0.97, 1.03)
    const p = rand(-0.12, 0.12)
    burst(t, { type: 'bandpass', f: 2300 * k, q: 2, gain: 0.36, tau: 0.0035, pan: p })
    pop(t, 1400 * k, { gain: 0.03, tau: 0.007, drop: 0.85, pan: p })
  },

  // 保留の色が上がった: 緑「ピロリン」、赤「ピロリロッ＋ドン」、金「シャララーン」、虹は和音を広げて左右いっぱいに
  holdChange(tier) {
    if (!live()) return
    const t = soon()
    if (tier <= 0) {
      pluck(t, midi(84), { gain: 0.08, tau: 0.3, reverb: 0.2 })
      return
    }
    if (tier === 1) {
      const run = [79, 83, 86, 91] // ソ シ レ ソ
      run.forEach((n, i) =>
        pluck(t + i * 0.055, midi(n), { gain: 0.075, tau: i === run.length - 1 ? 0.5 : 0.16, pan: -0.3 + i * 0.2, reverb: 0.25 }),
      )
      whoosh(t, 0.26, { f0: 900, f1: 5000, q: 1.2, gain: 0.05, peak: 0.8 })
      bell(t + 0.165, midi(91), { gain: 0.03, tau: 0.6, reverb: 0.3 })
      return
    }
    if (tier === 2) {
      const run = [81, 85, 88, 93, 97] // ラ ド# ミ ラ ド#（明るく鋭い）
      run.forEach((n, i) =>
        pluck(t + i * 0.042, midi(n), { gain: 0.072, tau: i === run.length - 1 ? 0.55 : 0.14, pan: -0.4 + i * 0.2, reverb: 0.28, bright: 7 }),
      )
      const hit = t + run.length * 0.042
      whoosh(t, 0.22, { f0: 700, f1: 6000, q: 1.2, gain: 0.06, peak: 0.85 })
      thump(hit, 140, 50, { gain: 0.2, tau: 0.1, drive: 1.8 })
      burst(hit, { type: 'highpass', f: 2500, gain: 0.08, tau: 0.012 })
      bell(hit, midi(93), { gain: 0.04, tau: 0.8, reverb: 0.4 })
      return
    }
    // 金・虹: ハープのグリッサンド → 鐘の和音
    const rainbow = tier >= 4
    const run = rainbow ? [72, 76, 79, 83, 86, 88, 91, 95, 98, 100] : [72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96]
    const gap = rainbow ? 0.026 : 0.03
    run.forEach((n, i) =>
      pluck(t + i * gap, midi(n), { gain: 0.048, tau: 0.3, pan: -0.75 + (1.5 * i) / (run.length - 1), reverb: 0.4 }),
    )
    const hit = t + run.length * gap
    thump(hit, 110, 40, { gain: 0.2, tau: 0.18, drive: 1.5 })
    const chord = rainbow ? [84, 88, 91, 95, 98] : [84, 88, 91, 96]
    chord.forEach((n, i) =>
      bell(hit + i * 0.014, midi(n), { gain: 0.032, tau: 1.2, pan: -0.4 + (0.8 * i) / (chord.length - 1), reverb: 0.5 }),
    )
    sparkle(hit, 1.1, rainbow ? 18 : 12, { lo: 2000, hi: 5000, gain: 0.026, reverb: 0.55 })
  },

  // ステップアップ: 「ジャン！」。段ごとに音階を上がり、段階の色で音色を変える（青はやわらかく、赤から厚く、金は鐘付き）
  step(index, tier) {
    if (!live()) return
    const t = soon()
    const i = clamp(Math.round(index), 0, STEP_SEMI.length - 1)
    const f = midi(67 + STEP_SEMI[i])
    const k = 0.85 + i * 0.05
    thump(t, 160 + i * 12, 60, { gain: 0.17 * k, tau: 0.06 + tier * 0.015, drive: 1.6 })
    burst(t, { type: 'highpass', f: 2400, gain: 0.09 * k, tau: 0.01 })
    if (tier <= 0) {
      pluck(t, f, { gain: 0.11 * k, tau: 0.2, reverb: 0.15, bright: 4 })
      pluck(t, f * 2, { gain: 0.04 * k, tau: 0.12, bright: 3 })
      return
    }
    // 緑から上: 根音と 5 度の金管のスタブ
    const dur = 0.15 + tier * 0.03
    const bright = 0.8 + tier * 0.12
    brass(t, f, dur, { gain: 0.09 * k, voices: tier >= 2 ? 3 : 2, bright, reverb: 0.2 })
    brass(t, f * 1.5, dur, { gain: 0.065 * k, voices: 2, bright, reverb: 0.2 })
    pluck(t, f * 2, { gain: 0.05 * k, tau: 0.15, reverb: 0.25 })
    if (tier >= 2) brass(t, f / 2, dur + 0.05, { gain: 0.065 * k, voices: 3, bright: 0.9 }) // 下のオクターブで厚く
    if (tier >= 3) {
      bell(t + 0.01, f * 2, { gain: 0.04, tau: 0.7, reverb: 0.4 })
      sparkle(t + 0.04, 0.45, 6, { lo: 2200, hi: 4600, gain: 0.024 })
    }
  },

  // 群予告: カードの群れが左から右へ。全体の風＋1 枚ずつの「シュッ」＋紙の「バサバサ」
  flutter() {
    if (!live()) return
    const t = soon()
    const dur = 0.95
    const across = (at: number): number => -0.9 + 1.8 * clamp((at - t) / dur, 0, 1) // 群れの位置（左 → 右）
    whoosh(t, dur, { f0: 450, f1: 1800, q: 0.8, gain: 0.17, peak: 0.5, pan0: -0.85, pan1: 0.85, reverb: 0.15 })
    for (let i = 0; i < 9; i++) {
      const at = t + 0.04 + i * 0.085 + rand(-0.02, 0.02)
      fwip(at, clamp(across(at) + rand(-0.25, 0.25), -1, 1))
    }
    for (let i = 0; i < 22; i++) {
      const at = t + 0.05 + Math.random() * 0.8
      const p = clamp(across(at) + rand(-0.3, 0.3), -1, 1)
      const f = rand(900, 2200)
      burst(at, { type: 'bandpass', f, q: 1.6, gain: rand(0.25, 0.45), tau: rand(0.007, 0.014), pan: p })
      burst(at + 0.013, { type: 'bandpass', f: f * 0.8, q: 1.4, gain: rand(0.15, 0.25), tau: 0.01, pan: p })
    }
  },

  // 疑似連の止まりかけ: モーターが落ちる「ヒュウン」→「ガコッ」→ 半音でぶつかる低い響き（このまま止まるのか…？）
  pseudoStop() {
    if (!live()) return
    const t = soon()
    const k = 1 + pseudoIndex() * 0.12 // 2 回目・3 回目は少しずつ重く
    const g = amp(dest({ reverb: 0.1 }))
    perc(g.gain, t, 0.05 * k, 0.01, 0.09)
    const lp = filter('lowpass', 1800, 2, g)
    lp.frequency.setValueAtTime(1800, t)
    lp.frequency.exponentialRampToValueAtTime(320, t + 0.3)
    const s = osc('sawtooth', 420, t, t + 0.7, lp)
    s.frequency.exponentialRampToValueAtTime(130, t + 0.3)
    thump(t + 0.015, 170, 70, { gain: 0.2 * k, tau: 0.05, drive: 2 })
    burst(t + 0.015, { type: 'lowpass', f: 1400, gain: 0.26 * k, tau: 0.025 })
    metal(t + 0.015, [720, 1880, 3110], { gain: 0.035 * k, tau: 0.09, reverb: 0.15 })
    const h = amp(dest({ reverb: 0.25 }))
    const end = sustain(h.gain, t + 0.05, 0.05 * k, 0.12, t + 0.3, 0.35)
    const lp2 = filter('lowpass', 520, 0.7, h)
    osc('sawtooth', 98, t + 0.05, end, amp(lp2, 0.5))
    osc('sawtooth', 103.8, t + 0.05, end, amp(lp2, 0.5))
  },

  // 疑似連の「NEXT」: 回り直す風切り＋5 度上がる明るいチャイム。続くほど全音ずつ高くなる
  nextChime() {
    if (!live()) return
    const t = soon()
    const n = Math.min(2, pseudoIndex())
    pseudoRun = n + 1
    pseudoAt = engine.now
    const f = midi(88) * Math.pow(2, (n * 2) / 12)
    whoosh(t, 0.17, { f0: 400, f1: 4200, q: 1.4, gain: 0.1, peak: 0.85 })
    burst(t + 0.075, { type: 'highpass', f: 3000, gain: 0.06, tau: 0.008 })
    pluck(t + 0.08, f, { gain: 0.075, tau: 0.14, pan: -0.15, reverb: 0.25 })
    bell(t + 0.08, f, { gain: 0.05, tau: 0.45, pan: -0.15, reverb: 0.3 })
    pluck(t + 0.17, f * 1.5, { gain: 0.09, tau: 0.25, pan: 0.15, reverb: 0.3 })
    bell(t + 0.17, f * 1.5, { gain: 0.062, tau: 0.8, pan: 0.15, reverb: 0.35 })
    sparkle(t + 0.2, 0.45, 5 + n * 2, { lo: 2500, hi: 5000, gain: 0.02 })
  },

  // カットイン: 横から飛び込む風切り → ぶつかる一撃 → 格の違う和音。緑「シャキーン」、赤「ドォン」、金「ジャーン」
  cutin(tier) {
    if (!live()) return
    const t = soon()
    const g = clamp(tier, 1, 3)
    const hit = t + 0.13
    whoosh(t, 0.15, { f0: 350, f1: 6000, q: 0.9, gain: 0.08 + g * 0.02, peak: 0.92, pan0: 0.7, pan1: 0 })
    thump(hit, 120 - g * 10, 36, { gain: 0.15 + g * 0.045, tau: 0.08 + g * 0.08, drive: 1.4 + g * 0.3 })
    burst(hit, { type: 'highpass', f: 1600, gain: 0.08 + g * 0.02, tau: 0.015 + g * 0.01, pan: -0.35 })
    burst(hit, { type: 'highpass', f: 2000, gain: 0.08 + g * 0.02, tau: 0.015 + g * 0.01, pan: 0.35 })
    if (g === 1) {
      shing(hit, 0.05, 0.3)
      for (const n of [67, 71, 74, 79]) brass(hit, midi(n), 0.2, { gain: 0.032, voices: 2, bright: 1.1, reverb: 0.25 }) // ソ シ レ
      return
    }
    if (g === 2) {
      for (const n of [45, 52, 57]) brass(hit, midi(n), 0.42, { gain: 0.055, voices: 3, spread: 14, bright: 1.4, reverb: 0.3 }) // ラ ミ ラ
      grit(hit, midi(33), 0.45, 0.07)
      crash(hit, { gain: 0.045, tau: 0.45 })
      shing(hit, 0.025, 0.25)
      return
    }
    for (const n of [48, 55, 60, 64, 67, 72]) {
      brass(hit, midi(n), 0.65, { gain: n < 50 ? 0.055 : 0.03, voices: 3, bright: 1.1, reverb: 0.35, vib: 8 }) // ド ソ ド ミ ソ ド
    }
    crash(hit, { gain: 0.045, tau: 0.8, reverb: 0.4 })
    ;[84, 88, 91].forEach((n, i) => bell(hit + i * 0.02, midi(n), { gain: 0.032, tau: 1.0, pan: -0.3 + i * 0.3, reverb: 0.45 }))
    sparkle(hit + 0.05, 0.9, 12, { lo: 2000, hi: 5000, gain: 0.026 })
  },

  // テロップ: 控えめな「スッ」と、やわらかい 2 音
  telop() {
    if (!live()) return
    const t = soon()
    whoosh(t, 0.22, { f0: 2400, f1: 6000, q: 0.8, gain: 0.03, peak: 0.4, pan0: -0.5, pan1: 0.3 })
    pluck(t + 0.05, midi(76), { gain: 0.035, tau: 0.22, pan: -0.1, reverb: 0.25, bright: 3 })
    pluck(t + 0.13, midi(83), { gain: 0.035, tau: 0.32, pan: 0.1, reverb: 0.3, bright: 3 })
    glint(t + 0.13, midi(95), { gain: 0.012, reverb: 0.4 })
  },

  // ライザー: のこぎり波 3 本と雑音が、加速するように上がり続ける。トレモロもだんだん速く深く。
  // silence() で 15ms で絞ってピタッと止まる。止められなければ、少しずつ上がり続けてから消える
  riser(sec) {
    if (!engine.ready) return
    cut(0.03, kinds('riser')) // 前のライザーとは重ねない
    if (!engine.enabled) return
    const s = clamp(sec || 1, 0.3, 30)
    const t = soon()
    const t1 = t + s
    const tail = 1.5
    const end = t1 + tail + 0.6
    const f0 = 110
    const f1 = f0 * Math.pow(2, clamp(2.2 + s * 0.35, 2.5, 3.6))
    const h = holdVoice('riser', t, end, { reverb: 0.15 })
    const vol = amp(h.gate)
    shape(vol.gain, t, s, (x) => Math.pow(x, 1.8), 24)
    vol.gain.setValueAtTime(1, t1 + tail)
    vol.gain.linearRampToValueAtTime(0, t1 + tail + 0.5)
    // トレモロ（ウワンウワン…）。深くなるほど中心を下げて、最大が 1 を超えないようにする
    const trem = amp(vol, 1)
    trem.gain.setValueAtTime(1, t)
    trem.gain.linearRampToValueAtTime(0.78, t1)
    const depth = mod(trem.gain, 0)
    depth.gain.setValueAtTime(0, t)
    depth.gain.linearRampToValueAtTime(0.22, t1)
    const lfo = keep(h, osc('sine', 3, t, end, depth))
    lfo.frequency.exponentialRampToValueAtTime(16, t1)
    // のこぎり波 3 本（中央と左右）。共鳴するローパスが一緒に開いていく
    for (const [p, det, level] of [[0, 0, 0.1], [-0.55, -14, 0.08], [0.55, 14, 0.08]] as const) {
      const lp = filter('lowpass', 300, 3.5, amp(pan(p, trem), level))
      lp.frequency.setValueAtTime(300, t)
      lp.frequency.exponentialRampToValueAtTime(6500, t1)
      lp.frequency.exponentialRampToValueAtTime(7500, t1 + tail)
      const o = keep(h, osc('sawtooth', f0, t, end, lp, det))
      o.frequency.exponentialRampToValueAtTime(f1, t1)
      o.frequency.exponentialRampToValueAtTime(f1 * 1.25, t1 + tail)
    }
    // 1 オクターブ下の正弦波で芯を足す
    const sub = keep(h, osc('sine', f0 / 2, t, end, amp(trem, 0.14)))
    sub.frequency.exponentialRampToValueAtTime(f1 / 2, t1)
    sub.frequency.exponentialRampToValueAtTime((f1 / 2) * 1.25, t1 + tail)
    // 雑音のスイープ（左右で別の雑音）
    for (const p of [-0.7, 0.7]) {
      const bp = filter('bandpass', 700, 1.1, filter('highpass', 400, 0.7, amp(pan(p, trem), 0.18)))
      bp.frequency.setValueAtTime(700, t)
      bp.frequency.exponentialRampToValueAtTime(7000, t1)
      keep(h, noise(t, end, bp))
    }
  },

  // 鼓動: 低い 2 拍（ドクン・ドクン）。後半ほど少し強く。ms たったら自然に止まり、silence() でも止まる
  heartbeat(bpm, ms) {
    if (!engine.ready) return
    stopBeats()
    cut(0.03, kinds('beat'))
    if (!engine.enabled || !(ms > 0)) return
    const period = 60 / clamp(bpm || 90, 30, 300)
    const t0 = soon()
    const end = t0 + ms / 1000
    let next = t0
    // 1.1 秒先まで予約する（タブが裏に回ってタイマーが 1 秒に間引かれても途切れない）。
    // 予約済みの鼓動も伸ばす音として登録してあるので、silence() で鳴る前に取り消せる
    const pump = (): void => {
      if (!engine.ready || !engine.enabled) return stopBeats()
      const horizon = engine.now + 1.1
      while (next < end && next < horizon) {
        lubDub(next, period, 0.82 + 0.18 * ((next - t0) / (end - t0)))
        next += period
      }
      if (next >= end) stopBeats()
    }
    pump()
    if (next < end) beatTimer = window.setInterval(pump, 250)
  },

  // 間（ま）: BGM と溜めの音をすっと消し、低くこもった空気だけを残す（着地か silence() まで）
  ma() {
    if (!engine.ready) return
    duck(0, 80)
    stopBeats()
    cut(0.04, kinds('riser', 'beat', 'air'))
    if (!engine.enabled) return
    const t = soon()
    const len = 20 // PUSH 待ちが長引いても途切れないよう長めに保つ
    // 空気は engine.hold に登録しない（ma() の直後に silence() が呼ばれても消えないように）
    const h = holdVoice('air', t, t + len)
    const g = amp(h.gate)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(1, t + 0.4)
    g.gain.setValueAtTime(1, t + len - 2.5)
    g.gain.linearRampToValueAtTime(0, t + len)
    for (const p of [-0.5, 0.5]) {
      const lp = filter('lowpass', 420, 0.6, filter('highpass', 70, 0.7, amp(pan(p, g), 0.1)))
      // ゆっくり息をするように、こもり具合を揺らす
      keep(h, osc('sine', rand(0.12, 0.2), t, t + len, mod(lp.frequency, 110)), false)
      keep(h, noise(t, t + len, lp), false)
    }
  },

  // 金の粒が立ち上る: 上っていく光の帯＋ペンタトニックで上る金の粒＋遠くからふくらむ温かい和音
  goldRise() {
    if (!live()) return
    const t = soon()
    const dur = 1.6
    for (const p of [-0.6, 0.6]) whoosh(t, dur, { f0: 1200, f1: 6000, q: 2.2, gain: 0.11, peak: 0.6, pan0: p, reverb: 0.4 })
    sparkle(t + 0.05, dur * 0.9, 22, { lo: 1000, hi: 4200, gain: 0.04, rise: true, reverb: 0.5 })
    pad(t, notes(48, 55, 60, 64, 67), { gain: 0.02, attack: 0.9, hold: 1.0, release: 0.8, lp: 450, lpTo: 2200, reverb: 0.35 })
    const g = amp(dest())
    osc('sine', midi(36), t, sustain(g.gain, t, 0.085, 0.8, t + 1.0, 0.7), g)
  },

  // PUSH 待ち: 「ガシャン」と構え、「ギュイッ」と溜め、明るい 2 音で促す。下で重い響きが長く残る
  pushReady() {
    if (!live()) return
    const t = soon()
    thump(t, 150, 60, { gain: 0.2, tau: 0.07, drive: 2 })
    burst(t, { type: 'bandpass', f: 1900, q: 0.8, gain: 0.28, tau: 0.028 })
    metal(t + 0.004, [1150, 2730, 4020, 5310], { gain: 0.045, tau: 0.18, reverb: 0.3 })
    charge(t + 0.03)
    pluck(t + 0.4, midi(81), { gain: 0.055, tau: 0.12, reverb: 0.2 })
    pluck(t + 0.48, midi(88), { gain: 0.065, tau: 0.35, reverb: 0.3 })
    bell(t + 0.48, midi(88), { gain: 0.03, tau: 0.6, reverb: 0.4 })
    // 待つ間の重い響き（ゴォーン…）。間の空気と同じ扱いにして、着地や silence() で一緒に止める
    const h = holdVoice('air', t, t + 4.1, { reverb: 0.2 })
    const g = amp(h.gate)
    shape(g.gain, t, 4, (x) => 0.1 * swell(x, 0.12), 24)
    const lp = filter('lowpass', 220, 0.8, g)
    keep(h, osc('sawtooth', 55, t, t + 4.05, amp(lp, 0.5)), false)
    keep(h, osc('sawtooth', 55.4, t, t + 4.05, amp(lp, 0.5)), false)
  },

  // 番号の着地。青は軽い「ポン」。赤から低音のドロップ・雑音のクラック・鐘、金はシンバルと和音、虹は虹のグリッサンドまで
  impact(tier) {
    if (!engine.ready) return
    stopBeats()
    cut(0.02) // 溜めの音（ライザー・鼓動・間の空気）は着地で終わる
    unduck(1200)
    if (!engine.enabled) return
    const t = soon()
    const x = clamp(tier, 0, 4)
    if (x === 0) {
      pop(t, 784, { gain: 0.15, tau: 0.09, drop: 0.68, reverb: 0.15 })
      pop(t, 1568, { gain: 0.025, tau: 0.04, drop: 0.7 })
      pop(t, 200, { gain: 0.1, tau: 0.06, drop: 0.6 })
      burst(t, { type: 'bandpass', f: 2600, q: 0.8, gain: 0.1, tau: 0.005 })
      glint(t + 0.03, midi(96), { gain: 0.016, reverb: 0.3 })
      return
    }
    if (x === 1) {
      pop(t, 880, { gain: 0.15, tau: 0.12, drop: 0.66, reverb: 0.2 })
      thump(t, 170, 70, { gain: 0.16, tau: 0.09, drive: 1.4 })
      burst(t, { type: 'bandpass', f: 2600, q: 0.8, gain: 0.13, tau: 0.006 })
      pluck(t + 0.03, midi(88), { gain: 0.05, tau: 0.3, pan: -0.2, reverb: 0.3 })
      pluck(t + 0.07, midi(95), { gain: 0.045, tau: 0.4, pan: 0.2, reverb: 0.35 })
      sparkle(t + 0.08, 0.4, 4, { lo: 2500, hi: 4500, gain: 0.02 })
      return
    }
    const k = x - 2 // 0 赤 / 1 金 / 2 虹
    thump(t, 110 - k * 10, 34, { gain: 0.3 + k * 0.005, tau: 0.22 + k * 0.12, glide: 0.35 + k * 0.2, drive: 1.8, lp: 600 })
    thump(t, 220, 110, { gain: 0.08, tau: 0.08, drive: 1.2, lp: 1500 })
    for (const p of [-0.4, 0.4]) burst(t, { type: 'highpass', f: 1700, gain: 0.1 + k * 0.01, tau: 0.03 + k * 0.015, pan: p })
    burst(t, { type: 'lowpass', f: 1000, sweep: 140, gain: 0.2 + k * 0.04, tau: 0.14 + k * 0.08 })
    pop(t, 660, { gain: 0.08, tau: 0.1, drop: 0.66 })
    if (x === 2) {
      bell(t + 0.005, midi(81), { gain: 0.05, tau: 0.9, reverb: 0.35 })
      bell(t + 0.02, midi(88), { gain: 0.035, tau: 0.8, pan: 0.2, reverb: 0.4 })
      sparkle(t + 0.06, 0.5, 6, { lo: 2200, hi: 4800, gain: 0.022 })
      return
    }
    crash(t, { gain: 0.045 + k * 0.01, tau: 0.6 + k * 0.3, reverb: 0.35 })
    ;[84, 88, 91, 96].forEach((n, i) =>
      bell(t + i * 0.016, midi(n), { gain: 0.03, tau: 1.3 + k * 0.4, pan: -0.36 + i * 0.24, reverb: 0.45 }),
    )
    pad(t, notes(60, 64, 67, 72), { gain: 0.017, attack: 0.008, hold: 0.12, release: 0.9, lp: 3600, lpTo: 900, reverb: 0.35 })
    if (x === 4) {
      const run = [72, 76, 79, 83, 86, 88, 91, 95, 98]
      run.forEach((n, i) =>
        pluck(t + 0.09 + i * 0.024, midi(n), { gain: 0.036, tau: 0.35, pan: -0.8 + (1.6 * i) / (run.length - 1), reverb: 0.45 }),
      )
      pad(t + 0.1, notes(60, 64, 67, 71, 74), { gain: 0.012, attack: 0.25, hold: 1.2, release: 1.5, lp: 2500, vib: 7, reverb: 0.5 })
    }
    sparkle(t + 0.08, 1.2 + k * 0.6, 14 + k * 8, { lo: 2000, hi: 5200, gain: 0.026, reverb: 0.55 })
  },

  // ファンファーレ: 金管（ずらしたのこぎり波＋ローパスの包絡）。small「タタ・ターン」、medium「タタタ・ターン・タ・ターン」、
  // big は最後に ♭VI・♭VII・I（ジャン・ジャン・ジャーーン）で締める
  fanfare(size) {
    if (!engine.ready) return
    const len = size === 'big' ? 3.4 : size === 'medium' ? 1.8 : 0.95
    duck(0.35, 150) // 金管が BGM と濁らないよう、鳴っている間だけ下げる
    unduck(1500, len + 0.2)
    if (!engine.enabled) return
    const t = soon()
    if (size === 'medium') {
      const lead: Part = [[0, 67, 0.07], [0.09, 67, 0.07], [0.18, 67, 0.07], [0.27, 72, 0.27], [0.56, 76, 0.13], [0.71, 79, 0.95]]
      const inner: Part = [
        [0.27, 64, 0.27], [0.27, 60, 0.27],
        [0.56, 72, 0.13], [0.56, 67, 0.13],
        [0.71, 76, 0.95], [0.71, 72, 0.95], [0.71, 67, 0.95],
      ]
      score(t, lead, { gain: 0.27, voices: 3, bright: 1.2, vib: 10, reverb: 0.3 })
      score(t, inner, { gain: 0.095, voices: 2, bright: 0.8, vib: 6, reverb: 0.3 })
      score(t, [[0.27, 48, 0.27], [0.56, 43, 0.13], [0.71, 48, 0.95]], { gain: 0.16, voices: 3, bright: 0.7 })
      timpani(t + 0.27, midi(48), 0.08)
      timpani(t + 0.71, midi(48), 0.12)
      crash(t + 0.71, { gain: 0.035, tau: 0.7 })
      ;[84, 88, 91].forEach((n, i) => bell(t + 0.72 + i * 0.02, midi(n), { gain: 0.026, tau: 1.0, pan: -0.3 + i * 0.3, reverb: 0.45 }))
      sparkle(t + 0.78, 1.0, 12, { lo: 2000, hi: 5000, gain: 0.024 })
      return
    }
    if (size === 'big') {
      const lead: Part = [
        [0, 67, 0.07], [0.085, 67, 0.07], [0.17, 67, 0.07], [0.255, 72, 0.34],
        [0.63, 76, 0.11], [0.76, 74, 0.11], [0.89, 76, 0.11], [1.02, 79, 0.3],
        [1.37, 84, 0.19], [1.59, 86, 0.19], [1.81, 88, 1.45],
      ]
      const inner: Part = [
        [0.255, 64, 0.34], [0.255, 60, 0.34],
        [0.63, 72, 0.11], [0.76, 71, 0.11], [0.89, 72, 0.11], [1.02, 74, 0.3], [1.02, 71, 0.3],
        [1.37, 75, 0.19], [1.37, 72, 0.19], [1.37, 68, 0.19], // ♭VI（ラ♭）
        [1.59, 77, 0.19], [1.59, 74, 0.19], [1.59, 70, 0.19], // ♭VII（シ♭）
        [1.81, 79, 1.45], [1.81, 76, 1.45], [1.81, 72, 1.45], // I（ド）
      ]
      const bass: Part = [[0.255, 48, 0.34], [0.63, 48, 0.36], [1.02, 43, 0.3], [1.37, 44, 0.19], [1.59, 46, 0.19], [1.81, 48, 1.45]]
      score(t, lead, { gain: 0.27, voices: 3, spread: 11, bright: 1.2, vib: 12, reverb: 0.32 })
      score(t, inner, { gain: 0.088, voices: 2, bright: 0.8, vib: 7, reverb: 0.32 })
      score(t, bass, { gain: 0.16, voices: 3, bright: 0.7 })
      const sub = amp(dest())
      osc('sine', midi(36), t + 1.81, sustain(sub.gain, t + 1.81, 0.07, 0.03, t + 3.0, 0.5), sub)
      timpani(t + 0.255, midi(48), 0.08)
      timpani(t + 1.02, midi(43), 0.08)
      for (let i = 0; i < 7; i++) timpani(t + 1.37 + i * 0.062, midi(43), 0.035 + i * 0.01, 0.12) // ロールでせり上げる
      timpani(t + 1.81, midi(48), 0.12)
      crash(t + 1.81, { gain: 0.05, tau: 1.2, reverb: 0.4 })
      ;[84, 88, 91, 96].forEach((n, i) =>
        bell(t + 1.82 + i * 0.02, midi(n), { gain: 0.024, tau: 1.4, pan: -0.36 + i * 0.24, reverb: 0.5 }),
      )
      sparkle(t + 1.9, 1.5, 24, { lo: 2000, hi: 5200, gain: 0.026, reverb: 0.55 })
      return
    }
    score(t, [[0, 67, 0.07], [0.09, 67, 0.07], [0.18, 72, 0.6]], { gain: 0.27, voices: 2, bright: 1.2, vib: 10, reverb: 0.3 })
    score(t, [[0.18, 64, 0.6], [0.18, 60, 0.6]], { gain: 0.1, voices: 2, bright: 0.8, reverb: 0.3 })
    score(t, [[0.18, 48, 0.6]], { gain: 0.16, voices: 2, bright: 0.7 })
    timpani(t + 0.18, midi(48), 0.1)
    bell(t + 0.2, midi(84), { gain: 0.03, tau: 0.8, pan: -0.2, reverb: 0.4 })
    bell(t + 0.23, midi(91), { gain: 0.025, tau: 0.8, pan: 0.2, reverb: 0.4 })
    sparkle(t + 0.25, 0.7, 8, { lo: 2000, hi: 4800, gain: 0.022 })
  },

  // 確定音（虹のときだけ）: 「キュイン・キュイン」（左・右）→「ちゅいーん」→ きらきらの残響。
  // 専用の経路で 8kHz あたりから緩く削り、6.5kHz より上も少し下げる（明るく強いが、耳に痛くない）
  kakutei() {
    if (!engine.ready) return
    duck(0.15, 120)
    stopBeats()
    cut(0.05)
    if (!engine.enabled) return
    const c = ac()
    const t = soon()
    const chain = c.createGain()
    const shelf = c.createBiquadFilter()
    shelf.type = 'highshelf'
    shelf.frequency.value = 6500
    shelf.gain.value = -4
    const lp = c.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 8000
    lp.Q.value = 0.5
    chain.connect(shelf).connect(lp).connect(dest({ reverb: 0.45 }))
    echoes(lp, [[0.11, 0.26, -0.7], [0.23, 0.19, 0.7], [0.35, 0.13, -0.6], [0.47, 0.09, 0.6], [0.6, 0.05, 0]])
    chirp(t, -0.3, chain)
    chirp(t + 0.12, 0.3, chain)
    whine(t + 0.26, chain)
    sparkle(t + 0.5, 1.4, 16, { lo: 2100, hi: 5200, gain: 0.028, to: chain })
  },

  // 虹のヒビ: 細かいヒビがだんだん密になり（ピキ…ピキピキッ）、氷がきしみ、隙間から光が漏れ、最後に大きく割れる
  crack() {
    if (!live()) return
    const t = soon()
    const dur = 1.3
    const n = 30
    for (let i = 0; i < n; i++) {
      const x = Math.pow((i + Math.random() * 0.9) / n, 0.65)
      const at = t + x * dur
      const p = rand(-0.75, 0.75)
      burst(at, {
        type: 'bandpass',
        f: rand(1800, 5800),
        q: rand(4, 9),
        gain: rand(0.25, 0.5) * (0.55 + 0.45 * x),
        attack: 0.0005,
        tau: rand(0.0025, 0.006),
        pan: p,
        reverb: 0.15,
      })
      if (Math.random() < 0.35) ping(at, rand(2800, 5600), p, 0.016 + 0.018 * x)
    }
    creak(t, dur)
    whoosh(t, dur + 0.25, { f0: 1800, f1: 5200, q: 3, gain: 0.05, peak: 0.85, reverb: 0.4 })
    const tb = t + dur
    burst(tb, { type: 'bandpass', f: 3200, q: 0.55, gain: 0.2, tau: 0.03, pan: -0.3 })
    burst(tb + 0.004, { type: 'bandpass', f: 3800, q: 0.55, gain: 0.2, tau: 0.03, pan: 0.3 })
    metal(tb, [2350, 3810, 5230, 6870], { gain: 0.045, tau: 0.35, reverb: 0.45 })
    thump(tb, 140, 60, { gain: 0.15, tau: 0.08 })
  },

  // 虹の和音（全員確定のピーク）: 虹のグリッサンドが左から右へ駆け上がり、
  // 大きな和音（低音・パッド・合唱の「アー」・鐘・シンバル）が着地して、きらきらが長く降り注ぐ
  rainbowChord() {
    if (!engine.ready) return
    duck(0.15, 200)
    unduck(2500, 3.4)
    stopBeats()
    cut(0.05)
    if (!engine.enabled) return
    const t = soon()
    const run = [60, 64, 67, 71, 74, 76, 79, 83, 86, 88, 91] // ド ミ ソ シ レ…（Cmaj9）
    run.forEach((n, i) =>
      pluck(t + i * 0.028, midi(n), { gain: 0.04, tau: 0.4, pan: -0.8 + (1.6 * i) / (run.length - 1), reverb: 0.45, bright: 4 }),
    )
    const hit = t + run.length * 0.028
    thump(hit, 90, 42, { gain: 0.16, tau: 0.35, glide: 0.5, drive: 1.3 })
    crash(hit, { gain: 0.045, tau: 1.1, reverb: 0.45 })
    const bass = amp(dest({ reverb: 0.2 }))
    const bend = sustain(bass.gain, hit, 1, 0.06, hit + 2.2, 1.2)
    osc('sine', midi(36), hit, bend, amp(bass, 0.12))
    osc('triangle', midi(48), hit, bend, amp(bass, 0.06))
    pad(hit, notes(55, 60, 64, 67, 71, 74), { gain: 0.022, attack: 0.12, hold: 2.2, release: 1.4, lp: 1500, lpTo: 4200, spread: 12, vib: 8, reverb: 0.45 })
    choir(hit + 0.05, notes(60, 64, 67, 72), { gain: 0.26, attack: 0.3, hold: 2.1, release: 1.5, reverb: 0.6 })
    ;[84, 88, 91, 96].forEach((n, i) => bell(hit + i * 0.03, midi(n), { gain: 0.034, tau: 1.6, pan: -0.4 + i * 0.27, reverb: 0.5 }))
    sparkle(hit + 0.1, 3.0, 28, { lo: 1800, hi: 5200, gain: 0.032, reverb: 0.6 })
  },

  // 「この1球で景品が尽きる」: ドン、ドン → ジャーン（sus4）→ 属七で解決させずに引っぱり、ティンパニのロールで張りつめる
  finalBall() {
    if (!engine.ready) return
    duck(0.3, 150)
    unduck(1200, 2.7)
    if (!engine.enabled) return
    const t = soon()
    taiko(t, 1)
    taiko(t + 0.3, 1.12)
    const ts = t + 0.62
    thump(ts, 100, 42, { gain: 0.2, tau: 0.22, drive: 1.6 })
    crash(ts, { gain: 0.04, tau: 0.6 })
    for (const n of [43, 55, 60, 62]) brass(ts, midi(n), 0.38, { gain: n < 50 ? 0.06 : 0.042, voices: 3, bright: 1.2, reverb: 0.3 }) // ソ ソ ド レ
    const t7 = ts + 0.45
    for (const n of [43, 55, 59, 62, 65]) {
      brass(t7, midi(n), 1.25, { gain: n < 50 ? 0.055 : 0.035, voices: 3, bright: 0.9, vib: 9, reverb: 0.35 }) // ソ ソ シ レ ファ
    }
    for (let i = 0; i < 16; i++) timpani(t7 + i * 0.075, midi(43), 0.025 + 0.006 * i, 0.12)
    whoosh(t7, 1.35, { f0: 500, f1: 3600, q: 1.2, gain: 0.06, peak: 0.95, reverb: 0.3 })
  },

  // 伸ばしている音（ライザー・鼓動）を止める。間の空気は、始めた直後（ma() と同時に呼ばれたとき）だけ残す
  silence() {
    if (!engine.ready) return
    stopBeats()
    cut(0.015, (h) => h.kind !== 'air' || engine.now - h.start > 0.25)
    engine.stopHeld()
  },
}

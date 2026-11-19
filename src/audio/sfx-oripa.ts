import { engine } from './engine'
import type { OripaSfx } from './types'

// オリパ（オンラインのトレカくじ）のお約束の合図の効果音。スマホの手元の演出で鳴らす。音声ファイルは使わず、すべて合成する。
//
//   puchun（「プチュン」。電源を抜いたように音が切れて、画面が暗転する）→ 約 0.5 秒の暗転 → revive（復活）→ aoriSuccess（成功）
//
//   - 作り方は sfx-spin.ts・sfx-quest.ts と同じ（役割の違う層を重ね、時刻は engine.now を基準に予約する）。部品はその 2 つから書き写した
//   - 音程のある音は、すべてハ長調の五音音階（ド レ ミ ソ ラ）に乗せる
//   - puchun は残響へ送らない（切れたあとが本当の無音になる）。revive はソの和音（ソ ド レ）で止めて、解決しないまま終わる。
//     続く aoriSuccess のドの和音が、その答えになる
//   - 音量（重ねたピーク。リミッターの手前をオフラインで描き出して測った値）: puchun 0.23、revive 0.30（弾ける瞬間）。
//     手元のあおり aoriStart（同じ測り方で、緑 0.10、赤 0.29、金 0.33、虹 0.28）の赤〜金と同じくらいで、金を超えない
//   - 9kHz より上は鳴らさない（音程のある成分は 9kHz より上に置かない。雑音のすそ野は、出口の 8kHz のローパスで削る）
//   - BGM には触らない（下げる・戻すは、演出の側の bgm.duck に任せる）
//   - 長さの目安（演出の時刻合わせ用）:
//       puchun 0.33 秒（0 秒で「プ」、0.05 秒で「チュ」、0.30 秒で音が切れる。そのあとは無音）
//       revive 1.0 秒（0 秒で底を蹴り、0.40 秒で弾ける。和音は 0.82 秒から消えていく。aoriSuccess は 1.0 秒後に呼ぶとつながる）

// ---- 道具 -------------------------------------------------------------------

const ac = (): AudioContext => engine.ctx!
const live = (): boolean => engine.ready && engine.enabled
// 鳴らし始める時刻。ノードを組む間に時計が進んでも頭が欠けないよう、少しだけ先に予約する
const soon = (): number => engine.now + 0.008

const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12)

// ハ長調の五音音階（ド レ ミ ソ ラ）
const PENTA = [0, 2, 4, 7, 9] as const

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
}

// 1 回の音の出口（効果音バス行きと、残響行き）。どちらも 8kHz から上を急な傾きのローパスで削る
// （雑音の層のすそ野が 9kHz より上に残らないようにする。音が鳴り終われば、ノードごと片づく）
let dry: AudioNode
let wet: AudioNode

function top(to: AudioNode): AudioNode {
  return filter('lowpass', 8000, 0.541, filter('lowpass', 8000, 1.307, to))
}

// 音を組み始める前に呼ぶ
function open(): void {
  dry = top(engine.bus('sfx'))
  wet = top(engine.reverb)
}

// 層の出口: 入口 → 定位 → 1 回の音の出口（＋残響）。音源は input につなぐ
function dest(o: Place = {}): GainNode {
  const c = ac()
  const input = c.createGain()
  const panner = c.createStereoPanner()
  panner.pan.value = clamp(o.pan ?? 0, -1, 1)
  input.connect(panner).connect(dry)
  if (o.reverb) {
    const send = c.createGain()
    send.gain.value = o.reverb
    panner.connect(send).connect(wet)
  }
  return input
}

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
  burst(t, { type: 'bandpass', f: Math.min(f * 3.2, 7500), q: 1.6, gain: o.gain * 0.9, tau: 0.0035, pan: o.pan })
}

// はじく音（ハープ・木琴）。明るい倍音がすぐに丸くなる
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
  burst(t, { type: 'bandpass', f: Math.min(f * 2.5, 6000), q: 1.4, gain: o.gain * 0.5, attack: 0.006, tau: 0.025, pan: o.pan })
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

// 風切り。帯域を動かした雑音が、ふくらんでしぼむ
function whoosh(t: number, dur: number, o: Place & { f0: number; f1: number; q?: number; gain: number; peak?: number }): void {
  const g = amp(dest(o))
  const peak = o.peak ?? 0.6
  shape(g.gain, t, dur, (x) => o.gain * swell(x, peak), 20)
  const bp = filter('bandpass', o.f0, o.q ?? 1, g)
  bp.frequency.setValueAtTime(o.f0, t)
  bp.frequency.exponentialRampToValueAtTime(o.f1, t + dur)
  noise(t, t + dur + 0.02, bp)
}

// シンバル。高い雑音の減衰（左右で別の雑音）。8.5kHz より上は削って、耳に痛くしない
function crash(t: number, o: { gain: number; tau: number; reverb?: number }): void {
  for (const p of [-0.5, 0.5]) {
    const g = amp(dest({ pan: p, reverb: o.reverb ?? 0.3 }))
    const end = perc(g.gain, t, o.gain, 0.003, o.tau)
    noise(t, end, filter('highpass', 3000, 0.7, filter('lowpass', 8500, 0.5, g)))
  }
}

// ---- 「プチュン」と復活 ---------------------------------------------------------

// 0.33 秒。「プ」: 小さな破裂と、すぐ落ちる丸い音。「チュ」（0.05 秒）: 歯のすき間の「チッ」。
// 「ュン」: ブラウン管の電源を抜いたように、高い音（ソ）が 0.25 秒で 5 オクターブ近く落ちながらこもっていき、
// 消えきる前の 0.30 秒で「プツッ」と切れる。残響へは送らないので、そのあとは本当の無音になる
function puchun(): void {
  if (!live()) return
  open()
  const t = soon()
  burst(t, { type: 'lowpass', f: 1500, gain: 0.13, tau: 0.006 })
  pop(t, midi(76), { gain: 0.16, tau: 0.02, drop: 0.6 })

  const s = t + 0.05
  const cut = t + 0.3
  const len = cut - s
  burst(s, { type: 'bandpass', f: 4400, q: 1.5, sweep: 2200, gain: 0.15, tau: 0.012 })
  const f0 = midi(103) // ソ（3136Hz）
  const f1 = midi(45) // ラ（110Hz）
  const fall = (x: number): number => f0 * Math.pow(f1 / f0, Math.pow(x, 0.75))
  const g = amp(dest())
  g.gain.setValueAtTime(0, s)
  g.gain.linearRampToValueAtTime(0.16, s + 0.006)
  g.gain.linearRampToValueAtTime(0.105, cut)
  g.gain.linearRampToValueAtTime(0, cut + 0.012)
  const lp = filter('lowpass', 5500, 1.2, g)
  lp.frequency.setValueAtTime(5500, s)
  lp.frequency.exponentialRampToValueAtTime(600, cut)
  for (const [type, level] of [
    ['sine', 0.75],
    ['sawtooth', 0.4],
  ] as const) {
    shape(osc(type, f0, s, cut + 0.03, amp(lp, level)).frequency, s, len, fall, 24)
  }
  // 画面がしぼむ「シュッ」
  const bp = filter('bandpass', 3200, 0.8, amp(g, 0.5))
  bp.frequency.setValueAtTime(3200, s)
  bp.frequency.exponentialRampToValueAtTime(500, cut)
  noise(s, cut + 0.03, bp)
  burst(cut, { type: 'lowpass', f: 600, gain: 0.06, tau: 0.004 })
}

// 1.0 秒。底を蹴る低い「ドゥ」から、のこぎり波（ソ。3 オクターブ）と風切り、五音音階のはじく音（ド → 2 オクターブ半上のソ）が
// 一気に駆け上がり、0.40 秒で「パァン！」と弾ける（破裂・太鼓・シンバル・金管・鐘）。
// 金管はソの和音（ソ レ ソ ド レ ソ）で、解決しないまま 0.82 秒から消えていく。上っていくきらきらが残り、
// 続く aoriSuccess のドの和音へつながる（revive の 1.0 秒後に呼ぶと、ちょうど受け止める）
const RUN = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86, 88, 91] as const // ド レ ミ ソ ラ …（最後は上のソ）

function revive(): void {
  if (!live()) return
  open()
  const t = soon()
  const hit = t + 0.4
  thump(t, 120, 48, { gain: 0.11, tau: 0.08, drive: 2.2, lp: 900 })
  burst(t, { type: 'lowpass', f: 700, gain: 0.08, tau: 0.02 })
  // 駆け上がる
  const g = amp(dest({ reverb: 0.15 }))
  shape(g.gain, t, 0.4, (x) => 0.075 * (0.15 + 0.85 * x * x), 16)
  g.gain.setTargetAtTime(0, hit, 0.015)
  const lp = filter('lowpass', 350, 2, g)
  lp.frequency.setValueAtTime(350, t)
  lp.frequency.exponentialRampToValueAtTime(5200, hit)
  for (const det of [-9, 9]) {
    osc('sawtooth', midi(43), t, hit + 0.12, amp(lp, 0.5), det).frequency.exponentialRampToValueAtTime(midi(79), hit)
  }
  whoosh(t + 0.02, 0.4, { f0: 350, f1: 5200, q: 1.2, gain: 0.06, peak: 0.92, reverb: 0.15 })
  RUN.forEach((n, i) => {
    const x = i / (RUN.length - 1)
    pluck(t + 0.03 + x * 0.35, midi(n), { gain: 0.035 + 0.04 * x, tau: 0.07, pan: -0.5 + x, reverb: 0.2 })
  })
  // 弾ける
  burst(hit, { type: 'bandpass', f: 2200, q: 0.7, gain: 0.2, tau: 0.008 })
  thump(hit, 160, 62, { gain: 0.12, tau: 0.09, drive: 1.8, lp: 800, reverb: 0.15 })
  crash(hit + 0.004, { gain: 0.032, tau: 0.4 })
  for (const n of [55, 62, 67, 72, 74, 79]) brass(hit, midi(n), 0.42, { gain: 0.044, voices: 3, bright: 1.25, reverb: 0.3 }) // ソ レ ソ ド レ ソ
  bell(hit, midi(91), { gain: 0.03, tau: 0.6, pan: -0.2, reverb: 0.4 })
  bell(hit + 0.02, midi(98), { gain: 0.024, tau: 0.6, pan: 0.2, reverb: 0.4 })
  sparkle(hit + 0.05, 0.45, 9, { lo: 2000, hi: 5200, gain: 0.02, rise: true })
}

export const oripaSfx: OripaSfx = {
  puchun,
  revive,
}

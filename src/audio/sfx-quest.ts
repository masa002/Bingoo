import { engine } from './engine'
import type { QuestSfx } from './types'

// 緊急クエスト「モグラ撃退」の効果音。音声ファイルは使わず、すべて合成する。
//
//   大画面: questAlarm（警報。約 2 秒）→ questGo（叩き始め）→ questTick（残り 3・2・1）→ questEnd（終わり）→ questTally（結果）
//   スマホ: bossAppear（狙われた人だけ）→ molePop（顔を出す）・whack（叩いた）・whackMiss（空振り）
//           → questDefend（守りきった）／ questFail（やられた。このあと card.moleFill で moleFill の「ドスッ」が鳴る）
//
//   - 作り方は sfx-draw.ts・sfx-spin.ts と同じ（役割の違う層を重ね、時刻は engine.now を基準に予約する）。部品はその 2 つから書き写した
//   - 音程のある音は、すべてハ長調の五音音階（ド レ ミ ソ ラ）に乗せる。BGM（ヘ長調・ハ長調・ニ短調・ト長調・ホ短調）のどれとも
//     ぶつからない。緊張させたい音（警報・ボス・失敗）は、同じ音の組のまま、ラを主音にして短調の響きにする。
//     警報（ラの短調）から叩き始め（ドの長調）へ、晴れるように切り替える
//   - 耳に痛くしない: 警報は甲高いサイレンにせず、中低音の「ウォン」を 3 回だけ鳴らす（全体で約 2 秒）。高い音を伸ばさない。
//     9kHz より上は鳴らさない
//   - 音量（重ねたピーク）: 大画面の音は impact と同じくらいまで（0.45 まで）。スマホの音は手元のあおり aoriStart より小さく
//     （ボス・成功は 0.25 まで、失敗は aoriFail と同じくらい）。モグラ・叩く音は 1 秒に数回鳴るので、1 打のピークは 0.15 まで
//   - 叩く音は、速く叩くほど 1 打を小さくする（1 秒に 3 回までは 1 倍、6 回で約 0.7 倍、10 回で約 0.5 倍）。続けても全体が大きくならない
//   - BGM には触らない（下げる・戻すは、演出の側の bgm.duck に任せる）
//   - 長さの目安（演出の時刻合わせ用）: questAlarm 2.0 秒、questGo 0.9 秒、questEnd 1.5 秒（0.3 秒で最後の「カーン」）、
//     bossAppear 1.4 秒（0.42 秒で飛び出す）、questDefend 1.0 秒、questFail 1.3 秒、
//     questTally 3.2 秒（1.5 秒まで数え上げ、1.5 秒で「ジャッ」、1.66 秒で「ジャーン！」）

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
}

// 出口: 入口 → 定位 → 効果音バス（＋残響）。音源は input につなぐ
function dest(o: Place = {}): GainNode {
  const c = ac()
  const input = c.createGain()
  const panner = c.createStereoPanner()
  panner.pan.value = clamp(o.pan ?? 0, -1, 1)
  input.connect(panner).connect(engine.bus('sfx'))
  if (o.reverb) {
    const send = c.createGain()
    send.gain.value = o.reverb
    panner.connect(send).connect(engine.reverb)
  }
  return input
}

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

// 和太鼓（ドン）。k で強さを変える
function taiko(t: number, k: number): void {
  thump(t, 125, 58, { gain: 0.28 * k, tau: 0.15, glide: 0.1, drive: 1.6, lp: 600, reverb: 0.2 })
  burst(t, { type: 'bandpass', f: 230, q: 0.9, gain: 0.55 * k, tau: 0.05, reverb: 0.2 })
  burst(t, { type: 'highpass', f: 1800, gain: 0.05 * k, tau: 0.004 })
}

// 警報の「ウォン」1 回分。音程が 1 オクターブ下から top へ跳ね上がり、共鳴するローパスが一緒に開いて閉じる（「ウ」→「ォン」）。
// のこぎり波 2 本と矩形波を混ぜた中低音で、ローパスは 2.3kHz までしか開かない（甲高いサイレンにしない）
function whoop(t: number, top: number, dur: number, gain: number): void {
  const end = t + dur + 0.2
  const g = amp(dest({ reverb: 0.22 }))
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(gain, t + 0.035)
  g.gain.setValueAtTime(gain, t + dur - 0.05)
  g.gain.setTargetAtTime(0, t + dur - 0.05, 0.03)
  const lp = filter('lowpass', 450, 2.5, g)
  lp.frequency.setValueAtTime(450, t)
  lp.frequency.exponentialRampToValueAtTime(2300, t + dur * 0.45)
  lp.frequency.exponentialRampToValueAtTime(700, t + dur)
  for (const [type, level, det] of [
    ['sawtooth', 0.4, -8],
    ['sawtooth', 0.4, 8],
    ['square', 0.22, 0],
  ] as const) {
    const s = osc(type, top / 2, t, end, amp(lp, level), det)
    s.frequency.exponentialRampToValueAtTime(top, t + dur * 0.4)
  }
}

// ---- 叩く速さ -----------------------------------------------------------------

// 鳴った回数を溜める（0.5 秒で 1/e に減る）。続けて鳴るほど溜まる
interface Rate {
  n: number
  at: number // 最後に鳴った時刻（ctx の時刻）
}
const taps: Rate = { n: 0, at: -1 } // 叩いた・空振り
const pops: Rate = { n: 0, at: -1 } // モグラが顔を出した

// 速さに応じた 1 打の音量の倍率。1 秒に 3 回までは 1、6 回で約 0.7、10 回で約 0.5
// （速くしても、1 秒あたりの音の量がほぼ頭打ちになる）
function thin(r: Rate, t: number): number {
  r.n = r.at < 0 || t < r.at || t - r.at > 3 ? 0 : r.n * Math.exp(-(t - r.at) / 0.5)
  r.at = t
  r.n += 1
  return clamp(Math.pow(2 / r.n, 0.65), 0.5, 1)
}

// ---- 大画面: 警報・合図・残り秒数 ---------------------------------------------------

// 緊急クエスト発生（約 2 秒）: 太鼓の「ドドン！」とラの短調の金管「ジャン！」で始まり、中低音の警報「ウォン」が 3 回
// （ラ・ラ・ド。最後だけ高くして、あおる）。下で地鳴り「ゴゴゴ…」がふくらみ、最後の「ウォン」と一緒に引く
function questAlarm(): void {
  if (!live()) return
  const t = soon()
  taiko(t, 0.8)
  const hit = t + 0.12
  taiko(hit, 0.8)
  burst(hit, { type: 'bandpass', f: 1800, q: 0.7, gain: 0.18, tau: 0.02 })
  for (const n of [45, 57, 64, 69, 72, 76]) brass(hit, midi(n), 0.26, { gain: n < 50 ? 0.05 : 0.07, voices: 3, bright: 1.3, reverb: 0.25 }) // ラ ラ ミ ラ ド ミ
  crash(hit, { gain: 0.028, tau: 0.45 })
  // 警報「ウォン」×3。下で小さな太鼓が拍を刻む
  ;[
    [0.42, 69],
    [0.92, 69],
    [1.42, 72],
  ].forEach(([at, n], i) => {
    whoop(t + at, midi(n), i === 2 ? 0.42 : 0.36, 0.11)
    taiko(t + at, 0.42 + i * 0.08)
  })
  // 地鳴り: こもった雑音と低いラ（のこぎり波）が、震えながら大きくなる
  const t1 = t + 0.15
  const len = 1.85
  const g = amp(dest({ reverb: 0.1 }))
  shape(g.gain, t1, len, (x) => 0.13 * swell(x, 0.78), 24)
  const trem = amp(g, 0.75)
  osc('sine', 8, t1, t1 + len, mod(trem.gain, 0.25))
  const lp = filter('lowpass', 200, 0.9, trem)
  lp.frequency.setValueAtTime(200, t1)
  lp.frequency.exponentialRampToValueAtTime(650, t1 + len * 0.8)
  noise(t1, t1 + len + 0.02, lp)
  osc('sawtooth', midi(33), t1, t1 + len + 0.02, amp(lp, 0.25))
}

// 叩き始めの合図「パァン！ジャーン！」: 号砲の「パン」と太鼓、ドの長調の金管の和音、五音音階の駆け上がりと鐘で明るく抜ける
// （警報のラの短調から、晴れるように切り替える）
function questGo(): void {
  if (!live()) return
  const t = soon()
  burst(t, { type: 'bandpass', f: 2000, q: 0.6, gain: 0.34, tau: 0.01 })
  burst(t, { type: 'lowpass', f: 1200, sweep: 300, gain: 0.14, tau: 0.04 })
  taiko(t, 1)
  crash(t + 0.004, { gain: 0.036, tau: 0.6, reverb: 0.35 })
  for (const n of [48, 55, 60, 64, 67, 72]) brass(t, midi(n), 0.42, { gain: n < 50 ? 0.06 : 0.034, voices: 3, bright: 1.25, reverb: 0.3 }) // ド ソ ド ミ ソ ド
  const run = [72, 74, 76, 79, 81, 84] // ド レ ミ ソ ラ ド
  run.forEach((n, i) =>
    pluck(t + 0.08 + i * 0.03, midi(n), { gain: 0.05, tau: i === run.length - 1 ? 0.4 : 0.12, pan: -0.5 + i * 0.2, reverb: 0.3 }),
  )
  bell(t + 0.23, midi(84), { gain: 0.034, tau: 0.8, pan: -0.15, reverb: 0.4 })
  bell(t + 0.25, midi(91), { gain: 0.027, tau: 0.8, pan: 0.15, reverb: 0.4 })
  sparkle(t + 0.25, 0.5, 7, { lo: 2200, hi: 5000, gain: 0.02 })
}

// 残り 3・2・1 秒: 木の「カッ」と、五音音階を上がる「ポーン」（ミ → ソ → ラ）、胸に響く「ドン」（残りが少ないほど強く）。
// 4 秒以上は小さな「カチ」だけ。0 以下は鳴らさない（終わりは questEnd が受け持つ）
function questTick(secondsLeft: number): void {
  if (!live()) return
  const n = Math.ceil(secondsLeft)
  if (!(n > 0)) return
  const t = soon()
  if (n > 3) {
    burst(t, { type: 'bandpass', f: n % 2 ? 1900 : 1600, q: 2.5, gain: 0.14, tau: 0.004 })
    pop(t, n % 2 ? 1250 : 1050, { gain: 0.03, tau: 0.008, drop: 0.9 })
    return
  }
  const u = 3 - n // 0（残り 3）〜 2（残り 1）
  const f = midi([76, 79, 81][u])
  burst(t, { type: 'bandpass', f: 1500, q: 2.2, gain: 0.2, tau: 0.006 })
  pop(t, 1100, { gain: 0.05, tau: 0.012, drop: 0.92, type: 'triangle' })
  pluck(t, f, { gain: 0.1 + u * 0.015, tau: 0.22, bright: 4, reverb: 0.2 })
  bell(t, f * 2, { gain: 0.016 + u * 0.005, tau: 0.3, reverb: 0.25 })
  thump(t, 130, 55, { gain: 0.12 + u * 0.04, tau: 0.07 + u * 0.01, drive: 1.6 })
}

// 終わりの合図「カン・カン・カーン」: 試合終了のゴング（真鍮の鐘を 3 回。最後だけ長く響かせる）。
// 最後の 1 打に太鼓の「ドン」と、モグラが穴へ引っ込んでいく「シュルル」を重ねる
const GONG: readonly (readonly [ratio: number, level: number, decay: number])[] = [
  [1, 1, 1],
  [1.51, 0.35, 0.5],
  [2.32, 0.55, 0.55],
  [2.94, 0.4, 0.42],
  [4.18, 0.25, 0.3],
  [5.6, 0.14, 0.2],
]

function gong(t: number, f: number, gain: number, tau: number): void {
  const d = dest({ reverb: 0.3 })
  for (const [ratio, level, decay] of GONG) {
    const g = amp(d)
    osc('sine', f * ratio, t, perc(g.gain, t, gain * level, 0.001, tau * decay), g, rand(-4, 4))
  }
  burst(t, { type: 'bandpass', f: 3200, q: 1.5, gain: gain * 1.4, tau: 0.003 })
}

function questEnd(): void {
  if (!live()) return
  const t = soon()
  const f = midi(81) // ラ
  gong(t, f, 0.085, 0.16)
  gong(t + 0.15, f, 0.085, 0.16)
  gong(t + 0.3, f, 0.1, 0.75)
  taiko(t + 0.3, 0.7)
  whoosh(t + 0.4, 0.55, { f0: 2400, f1: 450, q: 1.4, gain: 0.05, peak: 0.25 })
}

// 結果の数え上げ（3.2 秒）「ドゥルルル…ジャッ・ジャーン！」: スネアのロールが大きくなりながら、数字が回る「チチチ…」が
// 五音音階を駆け上がる（1.5 秒）。1.5 秒で「ジャッ」（ソの和音）、1.66 秒で「ジャーン！」（ドの和音・シンバル・鐘・きらきら）。
// 撃退王の冠の「キラリーン」で締める
function questTally(): void {
  if (!live()) return
  const t = soon()
  const roll = 1.5
  for (let x = 0; x < roll - 0.01; x += 1 / 28) {
    const k = 0.25 + 0.75 * Math.pow(x / roll, 1.6)
    const at = t + x + rand(-0.003, 0.003)
    burst(at, { type: 'bandpass', f: rand(1700, 2300), q: 0.8, gain: 0.11 * k, tau: 0.016, pan: rand(-0.2, 0.2) })
    pop(at, rand(190, 220), { gain: 0.03 * k, tau: 0.018, drop: 0.8 })
  }
  for (let i = 0; i < 24; i++) {
    const x = i / 23
    glint(t + x * (roll - 0.06), scale(Math.round(x * 10)), { gain: 0.018 + 0.014 * x, pan: rand(-0.3, 0.3), reverb: 0.15 })
  }
  whoosh(t + 0.2, roll - 0.2, { f0: 400, f1: 3200, q: 1.1, gain: 0.035, peak: 0.95 })
  // ジャッ（ソ）→ ジャーン！（ド）
  const h1 = t + roll
  const h2 = h1 + 0.16
  taiko(h1, 0.55)
  for (const n of [43, 55, 62, 67]) brass(h1, midi(n), 0.08, { gain: n < 50 ? 0.045 : 0.026, voices: 2, bright: 1.1, reverb: 0.2 }) // ソ ソ レ ソ
  taiko(h2, 1)
  crash(h2, { gain: 0.045, tau: 0.9, reverb: 0.4 })
  for (const n of [48, 55, 60, 64, 67, 72]) {
    brass(h2, midi(n), 0.85, { gain: n < 50 ? 0.06 : 0.034, voices: 3, bright: 1.2, reverb: 0.35, vib: 8 }) // ド ソ ド ミ ソ ド
  }
  ;[84, 88, 91, 96].forEach((n, i) => bell(h2 + i * 0.02, midi(n), { gain: 0.03, tau: 1.2, pan: -0.36 + i * 0.24, reverb: 0.45 }))
  sparkle(h2 + 0.05, 1.1, 12, { lo: 2000, hi: 5200, gain: 0.022, reverb: 0.5 })
  ;[91, 96, 100].forEach((n, i) => bell(h2 + 0.55 + i * 0.08, midi(n), { gain: 0.016, tau: 0.9, pan: -0.25 + i * 0.25, reverb: 0.5 }))
}

// ---- スマホ: モグラ・叩く音 -------------------------------------------------------

// 小さなモグラが顔を出す「ぴょこっ」: 土が「サッ」とはじけ、音程が下から跳ね上がる。高さは五音音階から毎回選ぶ
// （続けて鳴ると、ころころした旋律に聞こえる）。叩く音より低く丸くして、聞き分けられるようにする
const POP_NOTES = [67, 69, 72, 74, 76] as const // ソ ラ ド レ ミ
let lastPop = -1

function molePop(): void {
  if (!live()) return
  const t = soon()
  const k = thin(pops, t) * rand(0.9, 1.05)
  let i = Math.floor(Math.random() * POP_NOTES.length)
  if (i === lastPop) i = (i + 1 + Math.floor(Math.random() * (POP_NOTES.length - 1))) % POP_NOTES.length
  lastPop = i
  const f = midi(POP_NOTES[i])
  const pn = rand(-0.35, 0.35)
  burst(t, { type: 'bandpass', f: rand(1400, 2000), q: 1.1, gain: 0.06 * k, tau: 0.005, pan: pn })
  pop(t + 0.01, f / 1.5, { gain: 0.07 * k, tau: 0.035, drop: 1.5, type: 'triangle', pan: pn })
  pop(t + 0.01, (2 * f) / 1.5, { gain: 0.012 * k, tau: 0.02, drop: 1.5, pan: pn })
}

// 叩いた「ポコッ」: ハンマーが当たる乾いた「パコッ」、頭の空洞が鳴る「コッ」、跳ね上がる「ピコッ」、指に返る小さな「トン」。
// 続けて当てるほど「ピコッ」が五音音階を上がり（ド → 1 オクターブ上のミ。その先は レ・ミ を行き来）、
// 倍音と高い「シャッ」「キラッ」が増えて明るくなる。速く叩くほど 1 打を小さくする
function whack(combo: number): void {
  if (!live()) return
  const t = soon()
  const c = Math.max(1, Math.floor(Number.isFinite(combo) ? combo : 1))
  const k = thin(taps, t) * rand(0.8, 0.88)
  const x = clamp((c - 1) / 8, 0, 1) // 明るさ（9 連続で最大）
  const step = c <= 8 ? c - 1 : 6 + ((c - 9) % 2)
  const f = scale(step) * Math.pow(2, rand(-6, 6) / 1200)
  const pn = rand(-0.12, 0.12)
  const body = k * (1 - 0.15 * x) // 明るくなるぶん、芯を少し下げて、1 打の大きさをそろえる
  burst(t, { type: 'bandpass', f: rand(1700, 2100) * (1 + 0.2 * x), q: 1.3, gain: 0.2 * body, tau: 0.0035, pan: pn })
  pop(t, rand(430, 470), { gain: 0.095 * body, tau: 0.026, drop: 0.72, type: 'triangle', pan: pn })
  pop(t + 0.005, f / 1.12, { gain: 0.075 * k, tau: 0.045 + 0.015 * x, drop: 1.12, pan: pn })
  pop(t + 0.005, (2 * f) / 1.12, { gain: (0.008 + 0.026 * x) * k, tau: 0.028 + 0.012 * x, drop: 1.12, pan: pn })
  pop(t, 190, { gain: 0.04 * body, tau: 0.014, drop: 0.6 })
  if (x > 0.4) burst(t, { type: 'bandpass', f: 5600, q: 1, gain: 0.065 * ((x - 0.4) / 0.6) * k, tau: 0.004, pan: -pn })
  if (c >= 4) glint(t + 0.03, scale(step + 5), { gain: (0.011 + 0.016 * x) * k, pan: -pn, reverb: 0.15 })
}

// 空振り「スカッ」: ハンマーが空を切る短い風と、ごく小さな「ポフ」。音程は付けず、叩いた音よりずっと小さく
function whackMiss(): void {
  if (!live()) return
  const t = soon()
  const k = thin(taps, t)
  whoosh(t, 0.08, { f0: 2200, f1: 800, q: 1.1, gain: 0.09 * k, peak: 0.35, pan: rand(-0.15, 0.15) })
  burst(t + 0.05, { type: 'lowpass', f: 700, gain: 0.05 * k, tau: 0.01 })
}

// ---- スマホ: ボスと結果 ---------------------------------------------------------

// ボスモグラが、狙ったマスに現れる（1.4 秒）: 地面の下から「ゴゴゴ…」とせり上がり、0.42 秒で「ドバッ！」と飛び出して、
// ラの短調の金管（ラ・ミ・ド）が「ブォン」と鳴る。続けて照準が合う「ピピッ」、最後に低い唸り「グルル…」が残る（狙われている）。
// スマホのスピーカーでも聞こえるよう、低音は歪ませて倍音を足し、地鳴りにも中域のざらつきを混ぜる
function bossAppear(): void {
  if (!live()) return
  const t = soon()
  const hit = t + 0.42
  // 地鳴り（震えながら大きくなり、飛び出すと引く）と、土のこすれる粒
  const g = amp(dest({ reverb: 0.1 }))
  shape(g.gain, t, 0.42, (x) => 0.2 * x * x, 12)
  g.gain.setTargetAtTime(0, hit + 0.02, 0.07)
  const trem = amp(g, 0.7)
  osc('sine', 11, t, hit + 0.5, mod(trem.gain, 0.3))
  const lp = filter('lowpass', 400, 1.2, trem)
  lp.frequency.setValueAtTime(400, t)
  lp.frequency.exponentialRampToValueAtTime(1300, hit)
  noise(t, hit + 0.5, lp)
  for (let i = 0; i < 10; i++) {
    const x = Math.pow(Math.random(), 0.6)
    burst(t + x * 0.4, { type: 'bandpass', f: rand(1100, 2400), q: 1.5, gain: rand(0.02, 0.045) * (0.4 + x), tau: rand(0.004, 0.01), pan: rand(-0.4, 0.4) })
  }
  // 飛び出す「ドバッ！」と、はね上がる土
  thump(hit, 140, 42, { gain: 0.1, tau: 0.12, drive: 2.4, lp: 900 })
  burst(hit, { type: 'lowpass', f: 1400, sweep: 250, gain: 0.1, tau: 0.05 })
  burst(hit, { type: 'bandpass', f: 650, q: 0.9, gain: 0.18, tau: 0.06 })
  for (let i = 0; i < 6; i++) {
    burst(hit + 0.02 + i * rand(0.02, 0.045), { type: 'bandpass', f: rand(1200, 2600), q: 1.2, gain: rand(0.02, 0.04), tau: rand(0.004, 0.008), pan: rand(-0.5, 0.5) })
  }
  for (const n of [45, 57, 64, 72]) brass(hit, midi(n), 0.34, { gain: n < 50 ? 0.032 : 0.034, voices: 3, bright: 1.1, reverb: 0.2 }) // ラ ラ ミ ド
  // 照準が合う「ピピッ」（ラ）
  for (const at of [hit + 0.22, hit + 0.33]) {
    const b = amp(dest({ pan: 0.1, reverb: 0.12 }))
    const e = sustain(b.gain, at, 0.06, 0.004, at + 0.04, 0.025)
    osc('triangle', midi(81), at, e, b)
    osc('sine', midi(93), at, e, amp(b, 0.25))
  }
  // 低い唸り「グルル…」: ラ（110Hz）ののこぎり波を、揺れるローパスに通す
  const gr = amp(dest({ reverb: 0.15 }))
  const ge = sustain(gr.gain, hit + 0.3, 0.09, 0.15, hit + 0.7, 0.35)
  const glp = filter('lowpass', 700, 4, gr)
  osc('sine', 7.5, hit + 0.3, ge, mod(glp.frequency, 330))
  osc('sawtooth', midi(45), hit + 0.3, ge, glp)
  osc('sawtooth', midi(45), hit + 0.3, ge, glp, 10)
}

// 守りきった「カキーン！パ・パーン」: 盾がはじき返す金属の「カキーン」（ドの鐘）に、短い金管（ソ → ドの和音）と、
// 駆け上がるきらきら（1 秒ほど）。和音はスマホのスピーカーでも鳴るよう、高めに置く
function questDefend(): void {
  if (!live()) return
  const t = soon()
  burst(t, { type: 'bandpass', f: 2600, q: 1.4, gain: 0.15, tau: 0.004 })
  metal(t, [1320, 2090, 2950, 3960, 5270], { gain: 0.036, tau: 0.25, reverb: 0.25 })
  bell(t, midi(84), { gain: 0.045, tau: 0.5, reverb: 0.3 })
  thump(t, 220, 90, { gain: 0.1, tau: 0.05, drive: 1.5 })
  const h1 = t + 0.1
  for (const n of [67, 72]) brass(h1, midi(n), 0.06, { gain: 0.038, voices: 2, bright: 1.1, reverb: 0.2 }) // ソ ド
  const h2 = t + 0.2
  for (const n of [64, 67, 72, 76]) brass(h2, midi(n), 0.38, { gain: 0.034, voices: 2, bright: 1.15, reverb: 0.25 }) // ミ ソ ド ミ
  pluck(h2, midi(84), { gain: 0.05, tau: 0.4, reverb: 0.3 })
  sparkle(h2 + 0.02, 0.5, 7, { lo: 2200, hi: 5000, gain: 0.022, rise: true })
}

// 頑張ったけどダメだった「ストン…ポロロロン」: 五音音階をラまで駆け下りるはじく音と、こもりながら少し下がっていく
// ラの短調の和音（ラ ド ミ ソ）。悔しいが重すぎない（失敗の aoriFail と同じくらい）。
// このあと card.moleFill で moleFill（ドスッ）が鳴るので、土の音は入れない
function questFail(): void {
  if (!live()) return
  const t = soon()
  burst(t, { type: 'lowpass', f: 900, gain: 0.11, tau: 0.02 })
  pop(t, 330, { gain: 0.09, tau: 0.05, drop: 0.6, type: 'triangle' })
  const run = [81, 79, 76, 74, 72, 69] // ラ ソ ミ レ ド ラ
  run.forEach((n, i) =>
    pluck(t + 0.05 + i * 0.05, midi(n), { gain: 0.1 * (1 - i * 0.06), tau: i === run.length - 1 ? 0.5 : 0.1, pan: 0.3 - i * 0.12, reverb: 0.25, bright: 3.5 }),
  )
  // しょんぼりした和音: ずらしたのこぎり波を、閉じていくローパスに通し、音程を少しずつ下げる
  const s = t + 0.3
  const g = amp(dest({ reverb: 0.3 }))
  const end = sustain(g.gain, s, 1, 0.08, s + 0.45, 0.6)
  const lp = filter('lowpass', 1600, 0.7, g)
  lp.frequency.setValueAtTime(1600, s)
  lp.frequency.exponentialRampToValueAtTime(450, s + 0.9)
  for (const n of [57, 60, 64, 67]) {
    for (const side of [-1, 1]) {
      const o = osc('sawtooth', midi(n), s, end, amp(pan(side * 0.5, lp), 0.028), side * 8)
      o.detune.linearRampToValueAtTime(side * 8 - 35, s + 0.95)
    }
  }
}

export const questSfx: QuestSfx = {
  questAlarm,
  questGo,
  questTick,
  questEnd,
  molePop,
  whack,
  whackMiss,
  bossAppear,
  questDefend,
  questFail,
  questTally,
}

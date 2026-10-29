import { engine } from './engine'
import type { Bgm, BgmScene } from './types'

// BGM。場面ごとの曲を Web Audio でその場で合成し、ループで流す（音声ファイルは使わない）。
//
//   楽器 → 楽器ごとのバス ─┬→ ローパス → フェード ─→ ピーク止め → ダック ─→ engine.bus('bgm')
//    (kick/drum/bass/     └→ 残響の送り → フェード ─→ ローカット → ダック ─→ engine.reverb
//     keys/lead)          （デッキは場面ごと）      （ここから下は全デッキで共有）
//
// - 曲は「16 分音符ごとの楽譜」として、最初に鳴らすときに一度だけ組み立てる。
//   16 小節（前半 A ＋ 後半 B）を、アレンジを変えて 2 周（32 小節）で一巡する
// - 先読みのスケジューラ: 25ms ごとに、ctx.currentTime の 0.1 秒先までの音符を予約する
// - 場面ごとに「デッキ」（バスとフェーダーの組）を作る。切り替えは、古いデッキを下げながら
//   新しいデッキを 1 小節のイントロから上げる（クロスフェード）
// - 音量の制御（フェード・duck）は自分のノードで持つ。engine.duckBgm（効果音側の「間」）とは掛け算になる

const TICK_MS = 25 // スケジューラの間隔
const AHEAD = 0.1 // 何秒先まで予約するか
const AHEAD_HIDDEN = 1.5 // タブが裏にあるとタイマーが 1 秒ごとに間引かれるので、そのぶん先まで予約する
const WAIT_MS = 200 // unlock の前は、ctx ができるのをこの間隔で待つ
const XFADE = 1.5 // 場面の切り替え（秒）
const DUCK = 0.25 // duck(true) のときの音量
const MAX_VOICES = 64 // 1 つのデッキで同時に鳴らす音源の上限。超えたらハイハットなどの細かい音を省く
const CYCLE = 32 // 楽譜の長さ（小節）。16 小節 × 2 周

type BusName = 'kick' | 'drum' | 'bass' | 'keys' | 'lead'
const BUSES: readonly BusName[] = ['kick', 'drum', 'bass', 'keys', 'lead']

type Voice = (d: Deck, t: number, e: Ev) => void

// 楽譜の 1 音
interface Ev {
  v: Voice
  n: number // 音の高さ（MIDI 番号。音程のない打楽器は 0）
  ns?: number[] // 和音のときの構成音
  len: number // 長さ（16 分音符いくつ分か）
  g: number // 強さ 0〜1
  off: number // 16 分音符の中でのずれ（0.5 で 32 分音符の裏）
  low: boolean // 混み合ったら省いてよい音
}

interface Kit {
  k?: Voice // キック
  s?: Voice // スネア
  c?: Voice // クラップ
  h?: Voice // ハイハット（h の列に o / O と書くとオープン）
  o?: Voice // オープンのハイハット
  p?: Voice // シェイカー
  r?: Voice // リム・ウッドブロック
  t?: Voice // タム（H / M / L で高さ）
  x?: Voice // シンバル
  w?: Voice // スウェル（書いた位置から小節の終わりへ吸い込む）
}
type Lane = Exclude<keyof Kit, 'o'>

// 楽譜を書く道具。パターンは 16 文字（16 分音符 × 16）で、空白は読み飛ばす
interface Writer {
  // ドラム。. 休み、x 普通、X 強く、g ゴースト、1〜9 強さ、r / R 32 分の連打、o / O オープンハイハット
  drums(bar: number, p: Partial<Record<Lane, string>>): void
  // ベース。R 根音、O 1 オクターブ上、5 は 5 度、r / o は弱く。- で伸ばす（lo は根音を置く音域の下端）
  bass(bar: number, pat: string, v: Voice, lo: number, g?: number): void
  // 和音。x で弾き、- で伸ばす（X 強く、g 弱く）。open なら上から 2 番目を 1 オクターブ下げて広げる
  keys(bar: number, pat: string, v: Voice, lo: number, g?: number, open?: boolean): void
  // アルペジオ。数字は和音の何番目の音か（和音の数を超えると 1 オクターブ上）
  arp(bar: number, pat: string, v: Voice, lo: number, g?: number): void
  // メロディ。1 小節 1 行で「音名:長さ」を並べる（r は休み）。harm なら和音の音で下にハモる
  mel(bar: number, bars: readonly string[], v: Voice, g?: number, o?: { oct?: number; harm?: boolean }): void
  hit(bar: number, step: number, v: Voice, g: number, n?: number): void
  split(bar: number): boolean // その小節にコードが 2 つ以上あるか
}

interface SongDef {
  title: string // 曲名（ギャラリーに出す）
  feel: string // 曲の作り
  key: string
  bpm: number
  swing: number // 裏の 16 分音符を遅らせる割合（0〜0.3）
  vol: number
  lp: number // 全体のローパス。効果音とぶつからないよう、高域を出しすぎない
  drive: number // ベースを軽く歪ませて倍音を足す（ノート PC のスピーカーでも低音が聞こえるように）。0 でなし
  pump: number // キックのたびに和音を沈める深さ（ダンス曲のうねり）。0 でなし
  mix: Record<BusName, number>
  send: Partial<Record<BusName, number>> // 残響へ送る量
  echo?: { beats: number; fb: number; wet: number } // メロディのやまびこ（間隔の拍数、戻り、量）
  chords: readonly string[] // 16 小節ぶんのコード。空白で区切ると 1 小節を等分する
  pre: string // イントロ（最初の 1 小節）のコード
  kit: Kit
  intro(w: Writer): void
  compose(w: Writer): void // CYCLE 小節ぶんを書く
}

interface Song extends SongDef {
  main: Ev[][] // 16 分音符ごとの音符（CYCLE × 16）
  head: Ev[][] // イントロ（16）
}

type NoiseKind = 'white' | 'hat' | 'snare' | 'clap' | 'shaker'

interface Shared {
  ctx: BaseAudioContext
  input: AudioNode // デッキの出口がつながる先（ピーク止め）
  duck: GainNode
  duckW: GainNode
  wet: AudioNode // 残響の送りの入口
  noise: Record<NoiseKind, AudioBuffer>
}

// 1 つの場面を鳴らす組。切り替えの間だけ、2〜3 個が同時に動く
interface Deck {
  scene: BgmScene
  song: Song
  ctx: BaseAudioContext
  noise: Record<NoiseKind, AudioBuffer>
  step: number // 16 分音符の長さ（秒）
  t0: number // 本編の 1 小節目の頭の時刻（イントロはその 1 小節前から）
  pos: number // 次に予約する 16 分音符（イントロ中は負）
  bus: Record<BusName, GainNode>
  fade: GainNode
  fadeW: GainNode
  parts: AudioNode[] // デッキが持ち続けるノード（片付けで全部外す。やまびこの輪が残らないように）
  fd: { t0: number; t1: number; v0: number; v1: number } // いまのフェード（途中で向きを変えるときに使う）
  dieAt: number // この時刻を過ぎたら片付ける（鳴らし続けるあいだは Infinity）
  live: Array<{ n: AudioScheduledSourceNode; end: number }>
  open: GainNode | null // 鳴っているオープンハイハット（次のハイハットで止める）
}

// ── 音の高さとコード ─────────────────────────────

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const accidental = (s: string): number => (s[1] === '#' ? 1 : s[1] === 'b' ? -1 : 0)
const pitchClass = (s: string): number => (PC[s[0]] + accidental(s) + 12) % 12
const midi = (s: string): number => (Number(s[s.length - 1]) + 1) * 12 + PC[s[0]] + accidental(s) // 'C4' = 60
const mtof = (n: number): number => 440 * Math.pow(2, (n - 69) / 12)
const mod12 = (x: number): number => ((x % 12) + 12) % 12
const place = (pc: number, lo: number): number => lo + mod12(pc - lo) // lo から 1 オクターブの中に置く

interface Chord {
  root: number
  bass: number
  iv: readonly number[]
  pcs: number[]
}

const QUALITY: Record<string, readonly number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  mmaj7: [0, 3, 7, 11],
  m7b5: [0, 3, 6, 10],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  sus4: [0, 5, 7],
  '7sus4': [0, 5, 7, 10],
  add9: [0, 4, 7, 14],
}

function chord(sym: string): Chord {
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(sym)
  const iv = m ? QUALITY[m[2]] : undefined
  if (!m || !iv) throw new Error(`BGM: 読めないコード ${sym}`)
  const root = pitchClass(m[1])
  return { root, bass: m[3] ? pitchClass(m[3]) : root, iv, pcs: iv.map((i) => (root + i) % 12) }
}

// 構成音を lo から 1 オクターブの中に並べる（密集）。open なら上から 2 番目を 1 オクターブ下げて広げる（ドロップ 2）
function voicing(c: Chord, lo: number, open = false): number[] {
  const pcs = c.pcs.length > 4 ? c.pcs.filter((p) => p !== (c.root + 7) % 12) : c.pcs
  const ns = pcs.map((p) => place(p, lo)).sort((a, b) => a - b)
  if (open && ns.length >= 4) ns[ns.length - 2] -= 12
  return ns.sort((a, b) => a - b)
}

// メロディの下にハモる音: 短 3 度以上下にある、いちばん近い和音の音
function below(n: number, c: Chord): number {
  for (let k = 3; k <= 9; k++) if (c.pcs.includes(mod12(n - k))) return n - k
  return n - 5
}

function hits(pat: string): Array<{ s: number; ch: string; len: number }> {
  const p = pat.replace(/ /g, '')
  const out: Array<{ s: number; ch: string; len: number }> = []
  for (let s = 0; s < p.length; s++) {
    if (p[s] === '.' || p[s] === '-') continue
    let len = 1
    while (p[s + len] === '-') len++
    out.push({ s, ch: p[s], len })
  }
  return out
}

const TOM: Record<string, number> = { H: 55, M: 50, L: 45 }

function velocity(c: string): number {
  if (c >= '1' && c <= '9') return Number(c) / 10
  if (c === 'g') return 0.35
  if (c === 'X' || c === 'O') return 1
  if (c === 'h' || c === 'm' || c === 'l') return 0.55
  return 0.8
}

function writer(score: Ev[][], rows: Chord[][], kit: Kit): Writer {
  const at = (bar: number, step: number): Chord => {
    const row = rows[bar % rows.length]
    return row[Math.min(row.length - 1, Math.floor(step / (16 / row.length)))]
  }
  const add = (bar: number, step: number, e: Ev): void => {
    score[bar * 16 + step]?.push(e)
  }
  return {
    drums(bar, p) {
      for (const lane of Object.keys(p) as Lane[]) {
        const pat = (p[lane] ?? '').replace(/ /g, '')
        for (let s = 0; s < pat.length; s++) {
          const c = pat[s]
          if (c === '.') continue
          const v = lane === 'h' && (c === 'o' || c === 'O') ? kit.o : kit[lane]
          if (!v) continue
          const n = lane === 't' ? (TOM[c.toUpperCase()] ?? 50) : 0
          const len = lane === 'w' ? 16 - s : 1
          const low = lane === 'h' || lane === 'p'
          if (c === 'r' || c === 'R') {
            const g = c === 'R' ? 0.75 : 0.5
            add(bar, s, { v, n, len, g, off: 0, low })
            add(bar, s, { v, n, len, g: g * 0.8, off: 0.5, low })
          } else add(bar, s, { v, n, len, g: velocity(c), off: 0, low })
        }
      }
    },
    bass(bar, pat, v, lo, g = 0.8) {
      for (const h of hits(pat)) {
        const c = at(bar, h.s)
        const r = place(c.bass, lo)
        const fifth = c.iv.includes(7) ? 7 : c.iv.includes(6) ? 6 : 8
        const n = h.ch === 'O' || h.ch === 'o' ? r + 12 : h.ch === '5' ? r + mod12(c.root + fifth - r) : r
        add(bar, h.s, { v, n, len: h.len, g: h.ch === 'r' || h.ch === 'o' ? g * 0.6 : g, off: 0, low: false })
      }
    },
    keys(bar, pat, v, lo, g = 0.8, open = false) {
      for (const h of hits(pat)) {
        const k = h.ch === 'X' ? 1.15 : h.ch === 'g' ? 0.55 : 1
        add(bar, h.s, { v, n: 0, ns: voicing(at(bar, h.s), lo, open), len: h.len, g: g * k, off: 0, low: false })
      }
    },
    arp(bar, pat, v, lo, g = 0.7) {
      for (const h of hits(pat)) {
        const tones = voicing(at(bar, h.s), lo)
        const i = Number(h.ch)
        const n = tones[i % tones.length] + 12 * Math.floor(i / tones.length)
        add(bar, h.s, { v, n, len: h.len, g, off: 0, low: true })
      }
    },
    mel(bar, bars, v, g = 0.8, o = {}) {
      bars.forEach((line, i) => {
        let s = 0
        for (const tok of line.trim().split(/\s+/)) {
          const m = /^(r|[A-G][#b]?\d):(\d+)$/.exec(tok)
          if (!m) throw new Error(`BGM: 読めない音符 ${tok}`)
          const len = Number(m[2])
          if (m[1] !== 'r') {
            let n = midi(m[1]) + 12 * (o.oct ?? 0)
            if (o.harm) n = below(n, at(bar + i, s))
            add(bar + i, s, { v, n, len, g, off: 0, low: false })
          }
          s += len
        }
      })
    },
    hit(bar, step, v, g, n = 0) {
      add(bar, step, { v, n, len: 1, g, off: 0, low: false })
    },
    split: (bar) => rows[bar % rows.length].length > 1,
  }
}

// ── 音の部品 ─────────────────────────────────────

function osc(d: Deck, type: OscillatorType, hz: number, t: number, end: number): OscillatorNode {
  const o = d.ctx.createOscillator()
  o.type = type
  o.frequency.value = hz
  o.start(t)
  o.stop(end)
  d.live.push({ n: o, end })
  return o
}

function noise(d: Deck, kind: NoiseKind, t: number, end: number): AudioBufferSourceNode {
  const src = d.ctx.createBufferSource()
  src.buffer = d.noise[kind]
  src.loop = true
  src.start(t, Math.random() * 1.2) // 毎回ちがう場所から読み、同じ音の繰り返しに聞こえないようにする
  src.stop(end)
  d.live.push({ n: src, end })
  return src
}

function vca(d: Deck, out: AudioNode): GainNode {
  const g = d.ctx.createGain()
  g.gain.value = 0
  g.connect(out)
  return g
}

// 打楽器の包絡: すぐ立ち上がり、指数で減衰する（decay は 1% まで下がる秒数）
function strike(p: AudioParam, t: number, peak: number, decay: number, attack = 0.001): void {
  p.setValueAtTime(0, t)
  p.linearRampToValueAtTime(peak, t + attack)
  p.setTargetAtTime(0, t + attack, decay / 4.6)
}

// ADSR（dc と r は 1% まで下がる秒数）。鳴り終わる時刻を返す
function adsr(p: AudioParam, t: number, gate: number, peak: number, a: number, dc: number, s: number, r: number): number {
  p.setValueAtTime(0, t)
  p.linearRampToValueAtTime(peak, t + a)
  if (s < 1) p.setTargetAtTime(peak * s, t + a, Math.max(0.003, dc / 4.6))
  const off = Math.max(t + gate, t + a)
  p.setTargetAtTime(0, off, Math.max(0.003, r / 4.6))
  return s > 0 ? off + r : Math.min(t + a + dc, off + r)
}

// サイドチェイン風のうねり: キックのたびに和音のバスを一瞬沈める
function pumpKeys(d: Deck, t: number): void {
  const depth = d.song.pump
  if (!depth) return
  const p = d.bus.keys.gain
  const lvl = d.song.mix.keys
  p.setTargetAtTime(lvl * (1 - depth), t, 0.004)
  p.setTargetAtTime(lvl, t + 0.035, 0.075)
}

// キック: サイン波の音程を素早く下げる。頭に短い雑音を足して、小さなスピーカーでも輪郭を出す
function kickV(o: { hi: number; lo: number; sweep: number; decay: number; lvl: number; click: number }): Voice {
  return (d, t, e) => {
    const g = vca(d, d.bus.kick)
    strike(g.gain, t, o.lvl * e.g, o.decay, 0.002)
    const body = osc(d, 'sine', o.hi, t, t + o.decay)
    body.frequency.setValueAtTime(o.hi, t)
    body.frequency.exponentialRampToValueAtTime(o.lo, t + o.sweep)
    body.connect(g)
    if (o.click) {
      const c = vca(d, d.bus.kick)
      strike(c.gain, t, o.click * e.g, 0.015)
      noise(d, 'snare', t, t + 0.02).connect(c)
    }
    pumpKeys(d, t)
  }
}

// スネア: 帯域を絞った雑音（響き線）＋ 三角波（胴）
function snareV(o: { lvl: number; decay: number; body: number; hz: number }): Voice {
  return (d, t, e) => {
    const g = vca(d, d.bus.drum)
    strike(g.gain, t, o.lvl * e.g, o.decay)
    noise(d, 'snare', t, t + o.decay).connect(g)
    const b = vca(d, d.bus.drum)
    strike(b.gain, t, o.body * e.g, 0.1, 0.002)
    const tone = osc(d, 'triangle', o.hz, t, t + 0.1)
    tone.frequency.setValueAtTime(o.hz, t)
    tone.frequency.exponentialRampToValueAtTime(o.hz * 0.78, t + 0.08)
    tone.connect(b)
  }
}

// クラップ: 雑音を 3 回すばやく重ねて、何人かが手を叩いたばらつきを出す
function clapV(o: { lvl: number; decay: number }): Voice {
  return (d, t, e) => {
    const g = vca(d, d.bus.drum)
    const p = g.gain
    const pk = o.lvl * e.g
    p.setValueAtTime(0, t)
    for (let i = 0; i < 2; i++) {
      p.linearRampToValueAtTime(pk, t + i * 0.011 + 0.001)
      p.linearRampToValueAtTime(pk * 0.2, t + i * 0.011 + 0.009)
    }
    p.linearRampToValueAtTime(pk, t + 0.023)
    p.setTargetAtTime(0, t + 0.023, o.decay / 4.6)
    noise(d, 'clap', t, t + 0.023 + o.decay).connect(g)
  }
}

// ハイハット: 高い帯域の雑音。オープンは長く伸ばし、次のハイハットで止める（チョーク）
function hatV(o: { lvl: number; decay: number; open: boolean }): Voice {
  return (d, t, e) => {
    const tt = t + Math.random() * 0.003 // わずかに揺らして、機械的に聞こえないようにする
    if (d.open) {
      d.open.gain.setTargetAtTime(0, tt, 0.01)
      d.open = null
    }
    const g = vca(d, d.bus.drum)
    strike(g.gain, tt, o.lvl * e.g * (0.9 + Math.random() * 0.2), o.decay)
    noise(d, 'hat', tt, tt + o.decay).connect(g)
    if (o.open) d.open = g
  }
}

function shakerV(o: { lvl: number; decay: number; attack: number; kind: NoiseKind }): Voice {
  return (d, t, e) => {
    const g = vca(d, d.bus.drum)
    strike(g.gain, t, o.lvl * e.g * (0.9 + Math.random() * 0.2), o.decay, o.attack)
    noise(d, o.kind, t, t + o.decay + o.attack).connect(g)
  }
}

// リム・ウッドブロック: 短いサイン波 2 つ（hz を省くと楽譜の音の高さ）
function blockV(o: { lvl: number; decay: number; ratio: number; hz?: number }): Voice {
  return (d, t, e) => {
    const f = o.hz ?? mtof(e.n)
    const g = vca(d, d.bus.drum)
    strike(g.gain, t, o.lvl * e.g, o.decay)
    osc(d, 'sine', f, t, t + o.decay).connect(g)
    const g2 = vca(d, d.bus.drum)
    strike(g2.gain, t, o.lvl * e.g * 0.45, o.decay * 0.5)
    osc(d, 'sine', f * o.ratio, t, t + o.decay).connect(g2)
  }
}

function tomV(o: { lvl: number; decay: number }): Voice {
  return (d, t, e) => {
    const f = mtof(e.n)
    const g = vca(d, d.bus.drum)
    strike(g.gain, t, o.lvl * e.g, o.decay, 0.002)
    const body = osc(d, 'sine', f, t, t + o.decay)
    body.frequency.setValueAtTime(f * 1.12, t)
    body.frequency.exponentialRampToValueAtTime(f * 0.72, t + o.decay)
    body.connect(g)
  }
}

function crashV(o: { lvl: number; decay: number }): Voice {
  return (d, t, e) => {
    const g = vca(d, d.bus.drum)
    strike(g.gain, t, o.lvl * e.g, o.decay, 0.003)
    noise(d, 'hat', t, t + o.decay).connect(g)
  }
}

// スウェル: 雑音のフィルタを上げながら大きくし、次の小節の頭で切る（逆再生のシンバルの代わり）
function swellV(o: { lvl: number }): Voice {
  return (d, t, e) => {
    const end = t + e.len * d.step
    const f = d.ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = 0.9
    f.frequency.setValueAtTime(500, t)
    f.frequency.exponentialRampToValueAtTime(5000, end)
    const g = vca(d, d.bus.drum)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(o.lvl * e.g, end - 0.01)
    g.gain.linearRampToValueAtTime(0, end + 0.015)
    f.connect(g)
    noise(d, 'white', t, end + 0.02).connect(f)
  }
}

interface SynthSpec {
  bus: BusName
  osc: Array<[OscillatorType, number, number?, number?]> // [波形, ずらし(セント), 周波数の倍率, 音量]
  lvl: number
  a: number
  d: number
  s: number
  r: number
  f?: number // ローパスの周波数（省くとフィルタなし）
  q?: number
  fe?: number // 立ち上がりでフィルタをどれだけ開くか（Hz）
  fd?: number // その戻る速さ（秒）
  fk?: number // 音の高さに応じて開く量（基音の何倍を足すか）
  sweep?: number // 音を伸ばすあいだに、フィルタを何倍まで開くか（パッドの盛り上げ）
  vib?: [number, number, number] // ビブラート [速さ Hz, 深さ セント, かかり始めるまでの秒]
  bend?: number // 下からしゃくり上げる量（セント）
}

// 減算合成の音（ベース・パッド・リード・アルペジオ）。和音はフィルタと包絡を共有して、ノードを減らす
function synthV(sp: SynthSpec): Voice {
  return (d, t, e) => {
    const ctx = d.ctx
    const notes = e.ns ?? [e.n]
    const gate = e.len * d.step
    const amp = vca(d, d.bus[sp.bus])
    const peak = (sp.lvl * e.g) / Math.sqrt(notes.length * sp.osc.length)
    const end = adsr(amp.gain, t, gate, peak, sp.a, sp.d, sp.s, sp.r) + 0.02
    let head: AudioNode = amp
    if (sp.f) {
      const flt = ctx.createBiquadFilter()
      flt.type = 'lowpass'
      flt.Q.value = sp.q ?? 0.7
      const base = sp.f + (sp.fk ?? 0) * mtof(notes[0])
      if (sp.fe) {
        flt.frequency.setValueAtTime(base + sp.fe, t)
        flt.frequency.setTargetAtTime(base, t, (sp.fd ?? 0.2) / 4.6)
      } else if (sp.sweep) {
        flt.frequency.setValueAtTime(base, t)
        flt.frequency.exponentialRampToValueAtTime(base * sp.sweep, t + gate)
      } else flt.frequency.value = base
      flt.connect(amp)
      head = flt
    }
    let vib: GainNode | null = null
    if (sp.vib && gate > sp.vib[2] + 0.1) {
      const [rate, depth, delay] = sp.vib
      vib = ctx.createGain()
      vib.gain.value = 0
      vib.gain.setValueAtTime(0, t + delay)
      vib.gain.linearRampToValueAtTime(depth, t + delay + 0.25)
      osc(d, 'sine', rate, t, end).connect(vib)
    }
    for (const n of notes) {
      for (const [type, det, mul = 1, lv = 1] of sp.osc) {
        const o = osc(d, type, mtof(n) * mul, t, end)
        o.detune.setValueAtTime(det + (sp.bend ?? 0), t)
        if (sp.bend) o.detune.linearRampToValueAtTime(det, t + 0.07)
        if (vib) vib.connect(o.detune)
        if (lv === 1) o.connect(head)
        else {
          const og = ctx.createGain()
          og.gain.value = lv
          o.connect(og).connect(head)
        }
      }
    }
  }
}

// 打って鳴らす音（マリンバ・オルゴール・ハープ）。倍音ごとに減衰の速さを変える
function malletV(o: { bus: BusName; lvl: number; parts: Array<[number, number, number]> }): Voice {
  return (d, t, e) => {
    const notes = e.ns ?? [e.n]
    const norm = 1 / Math.sqrt(notes.length)
    for (const n of notes) {
      for (const [mul, lv, decay] of o.parts) {
        const g = vca(d, d.bus[o.bus])
        strike(g.gain, t, o.lvl * e.g * lv * norm, decay, 0.002)
        osc(d, 'sine', mtof(n) * mul, t, t + decay).connect(g)
      }
    }
  }
}

// エレピ（FM）: 弾いた瞬間だけ倍音が多く、すぐ丸くなる
function epianoV(o: { lvl: number; index: number; idecay: number; a: number; d: number; s: number; r: number; f: number }): Voice {
  return (d, t, e) => {
    const ctx = d.ctx
    const notes = e.ns ?? [e.n]
    const amp = vca(d, d.bus.keys)
    const end = adsr(amp.gain, t, e.len * d.step, (o.lvl * e.g) / Math.sqrt(notes.length), o.a, o.d, o.s, o.r) + 0.02
    const flt = ctx.createBiquadFilter()
    flt.type = 'lowpass'
    flt.frequency.value = o.f
    flt.connect(amp)
    for (const n of notes) {
      const f = mtof(n)
      const car = osc(d, 'sine', f, t, end)
      const mod = osc(d, 'sine', f, t, end)
      const depth = ctx.createGain()
      depth.gain.setValueAtTime(f * o.index, t)
      depth.gain.setTargetAtTime(f * o.index * 0.15, t, o.idecay / 4.6)
      mod.connect(depth).connect(car.frequency)
      car.connect(flt)
    }
  }
}

// ── 楽器（音色）─────────────────────────────────

const kickSoft = kickV({ hi: 140, lo: 50, sweep: 0.06, decay: 0.3, lvl: 0.55, click: 0.06 })
const kickPop = kickV({ hi: 170, lo: 50, sweep: 0.05, decay: 0.26, lvl: 0.6, click: 0.08 })
const kickHard = kickV({ hi: 210, lo: 46, sweep: 0.045, decay: 0.28, lvl: 0.62, click: 0.1 })
const kickHeart = kickV({ hi: 95, lo: 44, sweep: 0.08, decay: 0.38, lvl: 0.42, click: 0.02 })
const snareSoft = snareV({ lvl: 0.26, decay: 0.15, body: 0.14, hz: 190 })
const snarePop = snareV({ lvl: 0.36, decay: 0.15, body: 0.22, hz: 205 })
const snareBig = snareV({ lvl: 0.42, decay: 0.2, body: 0.26, hz: 185 })
const clap = clapV({ lvl: 0.38, decay: 0.17 })
const hatTight = hatV({ lvl: 0.1, decay: 0.035, open: false })
const hatOpen = hatV({ lvl: 0.075, decay: 0.3, open: true })
const shaker = shakerV({ lvl: 0.08, decay: 0.07, attack: 0.012, kind: 'shaker' })
const brush = shakerV({ lvl: 0.09, decay: 0.12, attack: 0.025, kind: 'snare' }) // ブラシで擦る音
const rim = blockV({ lvl: 0.16, decay: 0.045, hz: 1700, ratio: 0.3 })
const rimSoft = blockV({ lvl: 0.18, decay: 0.06, hz: 1400, ratio: 0.33 })
const pok = blockV({ lvl: 0.09, decay: 0.06, hz: 1180, ratio: 2.4 }) // クイズ番組の「ポク」
const clock = blockV({ lvl: 0.08, decay: 0.05, ratio: 2.4 }) // 時計の「チク・タク」（音の高さは楽譜で）
const tom = tomV({ lvl: 0.28, decay: 0.32 })
const crash = crashV({ lvl: 0.075, decay: 1.6 })
const swell = swellV({ lvl: 0.07 })
const swellSoft = swellV({ lvl: 0.035 })

// 受付
const fingerBass = synthV({ bus: 'bass', osc: [['sawtooth', 0]], lvl: 0.4, a: 0.005, d: 0.5, s: 0.5, r: 0.08, f: 450, fe: 700, fd: 0.2, q: 0.8, fk: 1 })
const ePiano = epianoV({ lvl: 0.15, index: 1.2, idecay: 0.6, a: 0.004, d: 1.6, s: 0.3, r: 0.3, f: 2600 })
const marimba = malletV({ bus: 'lead', lvl: 0.24, parts: [[1, 1, 0.5], [4, 0.2, 0.07]] })
const whistle = synthV({ bus: 'lead', osc: [['sine', 0], ['triangle', 0, 1, 0.3]], lvl: 0.13, a: 0.04, d: 0.3, s: 0.8, r: 0.14, vib: [5.2, 14, 0.18] })
// 序盤
const boingBass = synthV({ bus: 'bass', osc: [['square', 0]], lvl: 0.34, a: 0.003, d: 0.22, s: 0.35, r: 0.05, f: 300, fe: 1700, fd: 0.13, q: 5, fk: 1.5 })
const pluck = synthV({ bus: 'keys', osc: [['sawtooth', -7], ['sawtooth', 7]], lvl: 0.32, a: 0.002, d: 0.2, s: 0, r: 0.05, f: 700, fe: 2400, fd: 0.12, q: 1.5 })
const chip = synthV({ bus: 'lead', osc: [['square', 0]], lvl: 0.12, a: 0.003, d: 0.12, s: 0.65, r: 0.05, f: 3000, q: 0.5, vib: [6, 12, 0.16] })
const chipArp = synthV({ bus: 'keys', osc: [['square', 0]], lvl: 0.07, a: 0.002, d: 0.1, s: 0, r: 0.03, f: 2200 })
const xylo = malletV({ bus: 'lead', lvl: 0.2, parts: [[1, 1, 0.3], [3, 0.25, 0.05]] })
// リーチ期
const pulseBass = synthV({ bus: 'bass', osc: [['sawtooth', 0]], lvl: 0.4, a: 0.003, d: 0.13, s: 0.3, r: 0.04, f: 330, fe: 1000, fd: 0.1, q: 3, fk: 1 })
const darkPad = synthV({ bus: 'keys', osc: [['sawtooth', -9], ['sawtooth', 9]], lvl: 0.12, a: 0.35, d: 1, s: 0.85, r: 0.5, f: 600, sweep: 2.4, q: 1.2 })
const ostinato = synthV({ bus: 'keys', osc: [['sawtooth', 0]], lvl: 0.08, a: 0.002, d: 0.12, s: 0, r: 0.03, f: 800, fe: 1500, fd: 0.08, q: 2 })
const strings = synthV({ bus: 'lead', osc: [['sawtooth', -6], ['sawtooth', 6]], lvl: 0.14, a: 0.07, d: 0.4, s: 0.8, r: 0.25, f: 2200, q: 0.7, vib: [5.5, 16, 0.3] })
// ビンゴ期
const discoBass = synthV({ bus: 'bass', osc: [['sawtooth', 0]], lvl: 0.34, a: 0.003, d: 0.16, s: 0.4, r: 0.05, f: 400, fe: 1900, fd: 0.12, q: 3.5, fk: 1.2 })
const organ = synthV({ bus: 'keys', osc: [['square', 0, 1, 0.45], ['sine', 0, 2, 0.6], ['triangle', 4]], lvl: 0.24, a: 0.002, d: 0.32, s: 0.12, r: 0.08, f: 2400, q: 0.6 })
const strPad = synthV({ bus: 'keys', osc: [['sawtooth', -8], ['sawtooth', 8]], lvl: 0.09, a: 0.25, d: 0.8, s: 0.8, r: 0.4, f: 2300, q: 0.5 })
const brass = synthV({ bus: 'lead', osc: [['sawtooth', -5], ['sawtooth', 5]], lvl: 0.15, a: 0.025, d: 0.3, s: 0.75, r: 0.12, f: 800, fe: 2200, fd: 0.25, q: 1.2, fk: 0.8, bend: -45, vib: [5.5, 14, 0.25] })
// オーラス
const driveBass = synthV({ bus: 'bass', osc: [['sawtooth', 0]], lvl: 0.32, a: 0.002, d: 0.12, s: 0.45, r: 0.04, f: 450, fe: 1600, fd: 0.09, q: 2.5, fk: 1 })
const superSaw = synthV({ bus: 'keys', osc: [['sawtooth', -13], ['sawtooth', 13]], lvl: 0.14, a: 0.015, d: 0.6, s: 0.85, r: 0.25, f: 3000, q: 0.4 })
const tranceArp = synthV({ bus: 'keys', osc: [['sawtooth', -6], ['square', 6]], lvl: 0.08, a: 0.002, d: 0.14, s: 0, r: 0.03, f: 800, fe: 2800, fd: 0.1, q: 2 })
const anthem = synthV({ bus: 'lead', osc: [['sawtooth', -8], ['square', 8, 1, 0.6]], lvl: 0.15, a: 0.01, d: 0.25, s: 0.8, r: 0.12, f: 2600, fe: 1200, fd: 0.2, q: 0.9, vib: [6, 16, 0.22] })
// ダブルチャンスと締め
const softBass = synthV({ bus: 'bass', osc: [['triangle', 0], ['sawtooth', 0, 1, 0.3]], lvl: 0.3, a: 0.03, d: 1.2, s: 0.7, r: 0.45, f: 480 })
const warmPad = synthV({ bus: 'keys', osc: [['triangle', -6], ['triangle', 6], ['sawtooth', 0, 1, 0.22]], lvl: 0.14, a: 0.7, d: 1.5, s: 0.85, r: 1.4, f: 1200, q: 0.4, sweep: 1.4 })
const musicBox = malletV({ bus: 'lead', lvl: 0.2, parts: [[1, 1, 1.8], [2, 0.16, 0.6], [3, 0.06, 0.3]] })
const harp = malletV({ bus: 'keys', lvl: 0.11, parts: [[1, 1, 1], [2, 0.12, 0.3]] })

// ── 曲 ─────────────────────────────────────────

// 受付: F メジャー。前半は ii-V で転がるシティポップ、後半は王道進行で明るく
const REC_A = [
  'A4:2 C5:2 F5:3 E5:1 F5:2 A5:2 r:4',
  'G5:3 E5:1 r:2 C#5:2 E5:2 G5:2 r:4',
  'F5:2 A5:2 D5:3 C5:1 D5:2 F5:2 r:4',
  'Eb5:3 C5:1 r:2 A4:2 C5:2 Eb5:2 r:4',
  'D5:2 F5:2 A5:3 G5:1 F5:2 D5:2 r:4',
  'Db5:3 Bb4:1 r:2 G4:2 Bb4:2 Db5:2 r:4',
  'C5:2 E5:2 G5:2 E5:2 F#5:2 A5:2 C6:2 A5:2',
  'Bb5:3 A5:1 G5:2 F5:2 E5:2 C5:2 r:4',
]
const REC_B = [
  'F5:4 A5:4 G5:2 F5:2 D5:4',
  'E5:4 G5:4 Bb5:2 A5:2 G5:4',
  'A5:6 G5:2 E5:4 C5:4',
  'D5:6 E5:2 F5:4 A5:4',
  'Bb5:4 A5:2 G5:2 F5:4 D5:4',
  'E5:4 G5:2 C6:2 Bb5:4 G5:4',
  'A5:6 r:2 C5:2 F5:2 A5:2 C6:2',
  'Bb5:6 A5:2 G5:4 r:4',
]

const RECEPTION: SongDef = {
  title: 'ウェルカム・ラウンジ',
  feel: 'シティポップ風の軽い 16 ビート。エレピの和音、マリンバと口笛のメロディ、シェイカー',
  key: 'F メジャー',
  bpm: 106,
  swing: 0.1,
  vol: 0.58,
  lp: 8000,
  drive: 1.5,
  pump: 0,
  mix: { kick: 0.75, drum: 1.3, bass: 0.8, keys: 0.85, lead: 1.1 },
  send: { drum: 0.05, keys: 0.18, lead: 0.22 },
  echo: { beats: 0.75, fb: 0.22, wet: 0.14 },
  chords: ['Fmaj7', 'Em7 A7', 'Dm7', 'Cm7 F7', 'Bbmaj7', 'Bbm7 Eb7', 'Am7 D7', 'Gm7 C7', 'Bbmaj7', 'C7', 'Am7', 'Dm7', 'Gm7', 'C7', 'Fmaj7', 'Gm7 C7'],
  pre: 'Gm7/C',
  kit: { k: kickSoft, s: snareSoft, h: hatTight, o: hatOpen, p: shaker, r: rim, t: tom, x: crash, w: swell },
  intro(w) {
    w.keys(0, 'x---------------', ePiano, 55)
    w.bass(0, 'R-------........', fingerBass, 33)
    w.drums(0, { p: '1122334455667788', r: '............x.x.', w: '........x.......' })
  },
  compose(w) {
    for (let b = 0; b < CYCLE; b++) {
      const bar = b % 16
      const B = bar >= 8
      const rest = b >= 16 && b < 20 // 2 周目の頭はキックを抜いて、ひと息つく
      const end = bar % 8 === 7 // 段落の終わりはタムで次へ
      w.drums(b, {
        k: rest ? '' : end ? 'x.......x.......' : B ? 'x.....x.x.....x.' : 'x.......x.....x.',
        r: B ? '' : end ? '....x...........' : '....x.......x...',
        s: !B ? '' : end ? '....x...........' : '....x..g....x..g',
        h: end ? 'g.x.g.x.g.......' : B ? 'g.x.g.x.g.x.g.o.' : 'g.x.g.x.g.x.g.x.',
        p: '2424242424242424',
        t: end ? '........H.H.M.L.' : bar % 4 === 3 ? '..............hm' : '',
        x: bar % 8 === 0 && !rest ? 'x...............' : '',
      })
      const two = w.split(b)
      w.bass(b, two ? 'R-----5-R-----5-' : 'R-----R-5-----O-', fingerBass, 33)
      w.keys(b, B ? (two ? 'x-------x-------' : 'x-------x---x---') : two ? 'x-----x-x-----x-' : 'x-----x---x-----', ePiano, 55)
    }
    w.mel(0, REC_A, marimba)
    w.mel(8, REC_B, whistle, 0.75)
    w.mel(20, REC_A.slice(4), marimba, 0.7, { oct: -1 }) // 2 周目は 1 オクターブ下で柔らかく
    w.mel(24, REC_B, whistle, 0.75)
    w.mel(24, REC_B, marimba, 0.45, { harm: true })
  },
}

// 序盤: C メジャー。3-3-2 で弾むベースと裏打ちのスタブ、矩形波のメロディ（クイズ番組風）
const EARLY_A = [
  'C5:1 r:1 E5:1 r:1 G5:2 E5:2 C6:2 r:2 G5:2 r:2',
  'A5:2 G5:2 E5:2 C#5:2 E5:4 r:4',
  'D5:1 r:1 F5:1 r:1 A5:2 F5:2 C6:2 r:2 A5:2 r:2',
  'B5:2 A5:2 G5:2 F5:2 D5:4 r:4',
  'C5:1 r:1 E5:1 r:1 G5:2 E5:2 C6:2 r:2 G5:2 r:2',
  'B5:2 G#5:2 E5:2 D5:2 E5:4 r:4',
  'C6:2 B5:2 A5:2 E5:2 F#5:2 A5:2 D5:2 C5:2',
  'F5:2 E5:2 D5:2 C5:2 B4:2 D5:2 G5:4',
]
const EARLY_B = [
  'A5:3 A5:3 G5:2 A5:4 C6:4',
  'B5:3 B5:3 A5:2 G5:4 D5:4',
  'E5:3 G5:3 B5:2 C6:3 B5:3 A5:2',
  'F5:3 E5:3 D5:2 B4:4 G5:4',
  'A5:3 A5:3 G5:2 A5:4 C6:4',
  'Ab5:3 Ab5:3 G5:2 F5:4 D5:4',
  'E5:2 G5:2 C6:4 A5:2 G5:2 E5:2 C#5:2',
  'D5:4 F5:2 A5:2 G5:2 F5:2 D5:2 B4:2',
]

const EARLY: SongDef = {
  title: 'クイズ・タイム',
  feel: '3-3-2 で弾むベース、裏打ちのスタブ、ピコピコの矩形波メロディ。軽快なクイズ番組風',
  key: 'C メジャー',
  bpm: 122,
  swing: 0,
  vol: 0.62,
  lp: 8000,
  drive: 0,
  pump: 0,
  mix: { kick: 0.75, drum: 1, bass: 0.6, keys: 1.2, lead: 1 },
  send: { drum: 0.06, keys: 0.12, lead: 0.15 },
  echo: { beats: 0.75, fb: 0.28, wet: 0.2 },
  chords: ['C', 'A7', 'Dm7', 'G7', 'C', 'E7', 'Am7 D7', 'Dm7 G7', 'F', 'G', 'Em7 Am7', 'Dm7 G7', 'F', 'Fm6', 'C/G A7', 'Dm7 G7'],
  pre: 'G7',
  kit: { k: kickPop, s: snarePop, c: clap, h: hatTight, o: hatOpen, r: pok, t: tom, x: crash, w: swell },
  intro(w) {
    w.keys(0, 'x-.x-.x.........', pluck, 60, 1)
    w.bass(0, 'R-.R-.R.........', boingBass, 36)
    w.drums(0, { k: 'x..x..x.........', s: '........3456789X', w: '........x.......' })
  },
  compose(w) {
    for (let b = 0; b < CYCLE; b++) {
      const bar = b % 16
      const B = bar >= 8
      const end = bar === 7 || bar === 15
      const half = bar === 3 || bar === 11
      w.drums(b, {
        k: bar === 15 ? 'x...x...x.......' : 'x...x...x...x...',
        c: end ? '....x...........' : '....x.......x...',
        s: bar === 15 ? '........3456789X' : bar === 7 ? '........x.x.xxxx' : half ? '............5678' : B ? '....x.......x...' : '',
        h: end ? 'x.x.x.x.........' : B ? 'xgxgxgxgxgxgxgxg' : '..x...x...x...x.',
        r: !B && bar % 2 === 1 && !end ? '..........x...x.' : '',
        x: bar % 8 === 0 ? 'X...............' : '',
        w: end ? '........x.......' : '',
      })
      const two = w.split(b)
      w.bass(b, two ? 'R-.R-.R.R-.R-.5.' : B ? 'R-.R-.O.R-.R-.5-' : 'R-.R-.R.O-.O-.5.', boingBass, 36)
      w.keys(b, B ? 'x-.x-.x.x-.x-.x.' : '..x...x...x...x.', pluck, 60, B ? 0.7 : 0.8)
    }
    w.mel(0, EARLY_A, chip)
    w.mel(8, EARLY_B, chip)
    // 2 周目の頭はメロディを休み、16 分のアルペジオで「考え中」
    for (let b = 16; b < 20; b++) w.arp(b, '0123012301230123', chipArp, 67)
    w.mel(20, EARLY_A.slice(4), chip)
    w.mel(24, EARLY_B, chip)
    w.mel(24, EARLY_B, xylo, 0.55, { harm: true })
  },
}

// リーチ期: D マイナー。半音ずつ下がる内声（クリシェ）と、♭II（E♭）の不穏さ。時計の音と 16 分・32 分のハイハット
const REACH_B = [
  'A5:6 Bb5:2 A5:8',
  'G5:6 Ab5:2 G5:8',
  'A5:6 Bb5:2 A5:4 F5:4',
  'G5:6 Bb5:2 Ab5:4 G5:4',
  'F5:4 D5:4 Bb4:4 D5:4',
  'E5:4 C5:4 G4:4 C5:4',
  'D5:8 E5:8',
  'C#5:4 E5:4 G5:4 A5:4',
]
const REACH_BUILD = ['....x.......x...', 'x...x...x...x...', 'x.x.x.x.x.x.x.x.', '3344556677889XXX']

const REACH: SongDef = {
  title: 'テンション・クロック',
  feel: 'マイナーの刻み。時計のチクタク、細かいハイハット、うねるパッドと 16 分のベース',
  key: 'D マイナー',
  bpm: 136,
  swing: 0,
  vol: 0.75,
  lp: 9000,
  drive: 1.2,
  pump: 0,
  mix: { kick: 0.75, drum: 1.2, bass: 1.1, keys: 0.95, lead: 1 },
  send: { drum: 0.08, keys: 0.2, lead: 0.25 },
  chords: ['Dm', 'Dmmaj7/C#', 'Dm7/C', 'Dm6/B', 'Bbmaj7', 'Gm7', 'Em7b5', 'A7', 'Dm', 'Eb/D', 'Dm', 'Eb/D', 'Bb', 'C', 'A7sus4', 'A7'],
  pre: 'A7',
  kit: { k: kickPop, s: snarePop, h: hatTight, t: tom, x: crash, w: swell },
  intro(w) {
    w.keys(0, 'x---------------', darkPad, 50)
    w.bass(0, 'R.rrR.rrR.rrR.rr', pulseBass, 33, 0.6)
    w.drums(0, { t: 'L.......L.....LL', h: '1213121312131213', w: 'x...............' })
    for (let q = 0; q < 4; q++) w.hit(0, q * 4, clock, q % 2 ? 0.55 : 0.75, q % 2 ? 76 : 83)
  },
  compose(w) {
    for (let b = 0; b < CYCLE; b++) {
      const bar = b % 16
      const B = bar >= 8
      const calm = b >= 16 && b < 20 // 2 周目の頭: キックとスネアを抜き、時計の音だけで張りつめる
      const build = b >= 20 && b < 24 // そこから 4 小節かけてスネアを細かくしていく
      const end = bar === 7 || bar === 15
      w.drums(b, {
        k: calm ? '' : B ? 'x...x...x...x...' : 'x.....x.......x.',
        s: calm ? '' : build ? REACH_BUILD[b - 20] : bar === 15 ? '........rrrrRRRR' : B ? '....x.......x...' : '........x.......',
        h: end ? 'xgxgxgxgrrrrrrrr' : B ? 'xgxrxgxgxgxrxgxg' : 'xgxgxgxgxgxgxgxr',
        t: build ? '' : bar === 3 || bar === 11 ? '............LLLL' : bar === 7 ? '........H.M.L.LL' : '',
        x: !calm && bar % 8 === 0 ? 'X...............' : '',
        w: end ? '....x...........' : '',
      })
      for (let q = 0; q < 4; q++) w.hit(b, q * 4, clock, q % 2 ? 0.55 : 0.75, q % 2 ? 76 : 83) // チク・タク
      w.bass(b, calm ? 'R-------R-------' : B ? 'RrrrRrrrRrrrRrrr' : 'R.rrR.rrR.rrR.rr', pulseBass, 33)
      w.keys(b, 'x---------------', darkPad, 50)
      w.arp(b, B ? '0102010201020102' : '0.1.2.1.0.1.2.1.', ostinato, B ? 50 : 62)
    }
    w.mel(8, REACH_B, strings)
    w.mel(24, REACH_B, strings)
    w.mel(24, REACH_B, strings, 0.5, { oct: -1 })
  },
}

// ビンゴ期: G メジャー。前半はカノン進行（ベースが 1 音ずつ下がる）、後半は王道進行。ディスコのオクターブベース
const BINGO_A = [
  'B5:3 B5:3 A5:2 B5:4 r:4',
  'A5:3 A5:3 G5:2 A5:4 r:4',
  'G5:3 G5:3 F#5:2 G5:4 r:4',
  'F#5:3 F#5:3 E5:2 F#5:2 A5:2 B5:4',
  'E5:3 E5:3 D5:2 E5:4 r:4',
  'D5:3 D5:3 C5:2 D5:4 r:4',
  'E5:3 E5:3 G5:2 A5:4 C6:4',
  'A5:2 F#5:2 D5:2 F#5:2 A5:2 C6:2 B5:2 A5:2',
]
const BINGO_B = [
  'G5:2 E5:2 G5:2 C6:4 B5:2 A5:2 G5:2',
  'F#5:2 D5:2 F#5:2 A5:4 G5:2 F#5:2 E5:2',
  'D5:2 F#5:2 A5:2 B5:4 A5:2 F#5:2 D5:2',
  'E5:2 G5:2 B5:4 A5:2 G5:2 E5:4',
  'C6:3 B5:3 A5:2 G5:4 E5:4',
  'B5:3 A5:3 F#5:2 D5:4 F#5:4',
  'G5:4 E5:2 G5:2 C6:4 B5:4',
  'A5:4 G5:2 A5:2 F#5:4 r:4',
]
const BINGO_BUILD = ['4...4...4...4...', '5.5.5.5.6.6.6.6.', '6666777788889999', 'rrrrrrrrRRRRXXXX']

const BINGO: SongDef = {
  title: 'ビンゴ・パーティー',
  feel: '四つ打ちのディスコ。オクターブのベース、オルガンのスタブ、ブラスのメロディ。2 周目はブレイクから盛り上げ直す',
  key: 'G メジャー',
  bpm: 128,
  swing: 0.04,
  vol: 0.72,
  lp: 8500,
  drive: 0,
  pump: 0.3,
  mix: { kick: 0.75, drum: 0.9, bass: 0.75, keys: 1, lead: 1.05 },
  send: { drum: 0.06, keys: 0.15, lead: 0.2 },
  echo: { beats: 0.75, fb: 0.2, wet: 0.12 },
  chords: ['G', 'D/F#', 'Em', 'Bm/D', 'C', 'G/B', 'Am7', 'D7', 'C', 'D', 'Bm7', 'Em7', 'Am7', 'Bm7', 'C', 'D7sus4 D7'],
  pre: 'D7sus4',
  kit: { k: kickPop, s: snarePop, c: clap, h: hatTight, o: hatOpen, p: shaker, t: tom, x: crash, w: swell },
  intro(w) {
    w.keys(0, 'x-------........', organ, 60, 1)
    w.bass(0, 'R.O.R.O.R.O.R.O.', discoBass, 31)
    w.drums(0, { k: 'x...x...x...x...', s: '2.3.4.5.6677889X', w: 'x...............' })
  },
  compose(w) {
    for (let b = 0; b < CYCLE; b++) {
      const bar = b % 16
      const B = bar >= 8
      const brk = b >= 16 && b < 20 // 2 周目の頭: キックを抜いたブレイク
      const build = b >= 20 && b < 24 // スネアを細かくしていき、後半の頭で一気に戻す
      w.drums(b, {
        k: brk ? '' : 'x...x...x...x...',
        c: build ? '' : '....x.......x...',
        s: build ? BINGO_BUILD[b - 20] : bar === 15 ? '....3.4.56789XXX' : bar === 7 ? '........x.x.xxxx' : bar === 3 ? '............6789' : B ? '....x.......x...' : '',
        h: brk ? '..o...o...o...o.' : B ? 'gxoxgxoxgxoxgxox' : 'g.o.g.o.g.o.g.o.',
        p: B ? '..x...x...x...x.' : '',
        t: bar === 11 ? '............HHML' : '',
        x: !brk && bar % 8 === 0 ? 'X...............' : '',
        w: bar === 7 || bar === 15 ? '........x.......' : '',
      })
      w.bass(b, brk ? 'R-------R-------' : B ? 'R.OR.RO.R.OR.RO.' : 'R.O.R.O.R.O.R.OR', discoBass, 31)
      w.keys(b, 'x..x..x...x..x..', organ, 60)
      if (B || brk) w.keys(b, w.split(b) ? 'x-------x-------' : 'x---------------', strPad, 55, 0.7, true)
    }
    w.mel(0, BINGO_A, brass)
    w.mel(8, BINGO_B, brass, 0.85)
    w.mel(16, BINGO_A.slice(0, 4), brass, 0.6)
    w.mel(24, BINGO_B, brass, 0.85)
    w.mel(24, BINGO_B, brass, 0.5, { harm: true })
  },
}

// オーラス: E マイナー（G メジャー）。前半は小室進行（vi-IV-V-I）、後半は王道進行。ユーロビート風のドライブ
const FINAL_A = [
  'B5:2 B5:2 A5:2 B5:4 G5:2 E5:4',
  'E5:2 G5:2 C6:2 B5:4 A5:2 G5:4',
  'A5:2 A5:2 G5:2 A5:4 D5:2 F#5:4',
  'G5:6 F#5:2 G5:4 B5:4',
  'B5:2 B5:2 A5:2 B5:4 G5:2 E5:4',
  'E5:2 G5:2 C6:2 B5:4 A5:2 G5:4',
  'D5:2 F#5:2 A5:2 B5:4 A5:2 F#5:4',
  'D#5:4 F#5:4 A5:4 B5:4',
]
const FINAL_B = [
  'E5:2 G5:2 C6:6 B5:2 A5:2 G5:2',
  'F#5:2 A5:2 D6:6 C6:2 B5:2 A5:2',
  'B5:6 A5:2 F#5:4 D5:4',
  'E5:4 G5:4 B5:6 A5:2',
  'G5:2 E5:2 G5:2 C6:6 B5:2 C6:2',
  'D6:6 C6:2 B5:4 A5:4',
  'B5:6 G5:2 E5:4 G5:4',
  'D#5:4 F#5:4 A5:4 B5:4',
]
const FINAL_BUILD = ['x.......x.......', 'x...x...x...x...', 'x.x.x.x.x.x.x.x.', '6677889XrrrrRRRR']

const FINAL: SongDef = {
  title: 'ラスト・スパート',
  feel: 'ユーロビート風の高揚。うねる和音、16 分のアルペジオ、転がるベース、ハモるリード',
  key: 'E マイナー',
  bpm: 150,
  swing: 0,
  vol: 0.64,
  lp: 8500,
  drive: 2,
  pump: 0.45,
  mix: { kick: 0.65, drum: 0.95, bass: 0.85, keys: 0.95, lead: 1.05 },
  send: { drum: 0.06, keys: 0.14, lead: 0.2 },
  echo: { beats: 0.75, fb: 0.25, wet: 0.14 },
  chords: ['Em', 'C', 'D', 'G', 'Em', 'C', 'D', 'B7', 'C', 'D', 'Bm7', 'Em', 'C', 'D', 'Em', 'B7'],
  pre: 'B7',
  kit: { k: kickHard, s: snareBig, c: clap, h: hatTight, o: hatOpen, p: shaker, t: tom, x: crash, w: swell },
  intro(w) {
    w.keys(0, 'x---------------', superSaw, 52, 0.7, true)
    w.arp(0, '0123012301230123', tranceArp, 64, 0.5)
    w.drums(0, { k: 'x...x...x...x...', s: '3.4.5.6.6677889X', w: 'x...............' })
  },
  compose(w) {
    for (let b = 0; b < CYCLE; b++) {
      const bar = b % 16
      const B = bar >= 8
      const brk = b >= 16 && b < 20 // 2 周目の頭: ベースとキックを抜き、メロディを先に聞かせる
      const build = b >= 20 && b < 24
      w.drums(b, {
        k: brk ? (b === 16 ? 'X...............' : '') : bar === 15 ? 'x...x...x.......' : 'x...x...x...x...',
        s: brk ? '' : build ? FINAL_BUILD[b - 20] : bar === 15 ? '........rrrrRRRR' : bar === 7 ? '........3456789X' : bar === 3 || bar === 11 ? '....x.......6789' : '....x.......x...',
        c: brk || build ? '' : '....x.......x...',
        h: brk ? '..g...g...g...g.' : B ? 'gxoxgxoxgxoxgxox' : 'g.o.g.o.g.o.g.o.',
        p: B ? 'gxgxgxgxgxgxgxgx' : '',
        x: !brk && bar % 4 === 0 && (B || bar === 0) ? 'X...............' : '',
        w: bar === 7 || bar === 15 ? '........x.......' : '',
      })
      if (!brk) w.bass(b, B ? '.RRO.RRO.RRO.RRO' : 'R.O.R.O.R.O.R.O.', driveBass, 33)
      w.keys(b, 'x---------------', superSaw, 52, brk ? 0.6 : 0.8, true)
      w.arp(b, B ? '0123432101234321' : '0123012301230123', tranceArp, 64, brk ? 0.5 : 0.7)
    }
    w.mel(0, FINAL_A, anthem)
    w.mel(8, FINAL_B, anthem, 0.85)
    w.mel(16, FINAL_A.slice(0, 4), anthem, 0.65)
    w.mel(24, FINAL_B, anthem, 0.85)
    w.mel(24, FINAL_B, anthem, 0.5, { harm: true })
  },
}

// ダブルチャンスと締め: D♭ メジャー。ゆっくりの柔らかいパッドとオルゴール。最初の 4 小節は打楽器なし
const COOL_A = [
  'F5:4 Ab5:4 C6:6 Bb5:2',
  'Bb5:8 F5:4 Db5:4',
  'C5:4 Eb5:4 Ab5:8',
  'Db6:6 C6:2 Bb5:4 Ab5:4',
  'Gb5:4 Bb5:4 Ab5:4 Gb5:4',
  'Gb5:6 F5:2 Eb5:8',
  'F5:8 r:8',
  'r:8 Ab4:2 Bb4:2 Db5:2 Eb5:2',
]
const COOL_B = [
  'F5:8 Db5:8',
  'Eb5:8 C5:8',
  'Ab5:8 F5:4 Eb5:4',
  'F5:12 r:4',
  'Bb5:8 Ab5:4 F5:4',
  'Gb5:8 Eb5:8',
  'F5:4 Eb5:4 Db5:8',
  'r:8 Ab4:4 Eb5:4',
]

const COOLDOWN: SongDef = {
  title: 'サンキュー・ララバイ',
  feel: 'ゆっくりの柔らかいパッドとオルゴール。鼓動のようなキックとリムで、穏やかに締める',
  key: 'D♭ メジャー',
  bpm: 76,
  swing: 0.12,
  vol: 0.7,
  lp: 6500,
  drive: 1.3,
  pump: 0,
  mix: { kick: 0.7, drum: 2, bass: 0.7, keys: 1, lead: 0.95 },
  send: { drum: 0.08, keys: 0.25, lead: 0.32 },
  echo: { beats: 1.5, fb: 0.3, wet: 0.16 },
  chords: ['Dbmaj7', 'Gbmaj7', 'Fm7', 'Bbm7', 'Ebm7', 'Ab7sus4 Ab7', 'Dbmaj7', 'Gbmaj7/Ab', 'Gbmaj7', 'Ab/Gb', 'Fm7', 'Bbm7', 'Gbmaj7', 'Ebm7 Ab7sus4', 'Dbadd9', 'Ab7sus4'],
  pre: 'Ab7sus4',
  kit: { k: kickHeart, r: rimSoft, p: brush, w: swellSoft },
  intro(w) {
    w.keys(0, 'x---------------', warmPad, 53, 0.8, true)
    w.mel(0, ['r:8 Eb5:4 Ab5:4'], musicBox, 0.6)
  },
  compose(w) {
    for (let b = 0; b < CYCLE; b++) {
      const bar = b % 16
      const B = bar >= 8
      if (b >= 4) {
        w.drums(b, {
          k: 'x.........x.....',
          r: '....x.......x...',
          p: B ? '3534353435343534' : '4.6.4.6.4.6.4.6.',
          w: bar === 7 || bar === 15 ? '........x.......' : '',
        })
      }
      const two = w.split(b)
      w.bass(b, two ? 'R-------R-------' : 'R-------R---5---', softBass, 36)
      w.keys(b, two ? 'x-------x-------' : 'x---------------', warmPad, 53, 0.8, true)
      if (b >= 16 && !B) w.arp(b, '0.1.2.3.2.1.0.1.', harp, 60) // 2 周目の前半はハープの分散和音
    }
    w.mel(0, COOL_A, musicBox, 0.75)
    w.mel(8, COOL_B, musicBox, 0.7)
    w.mel(24, COOL_B, musicBox, 0.7)
    w.mel(24, COOL_B, musicBox, 0.4, { harm: true })
  },
}

const SONGS: Record<BgmScene, SongDef> = { reception: RECEPTION, early: EARLY, reach: REACH, bingo: BINGO, final: FINAL, cooldown: COOLDOWN }

// 楽譜は最初に鳴らすときに一度だけ組み立てる
const compiled = new Map<BgmScene, Song>()

function songOf(scene: BgmScene): Song {
  let song = compiled.get(scene)
  if (!song) {
    const def = SONGS[scene]
    const blank = (n: number): Ev[][] => Array.from({ length: n }, () => [])
    const main = blank(CYCLE * 16)
    const head = blank(16)
    def.compose(writer(main, def.chords.map((row) => row.split(' ').map(chord)), def.kit))
    def.intro(writer(head, [def.pre.split(' ').map(chord)], def.kit))
    song = { ...def, main, head }
    compiled.set(scene, song)
  }
  return song
}

// ── 共通のノードと雑音 ────────────────────────────

// 雑音の帯域 [ローカット, ハイカット]（0 はかけない）。1 次のフィルタを 2 回ずつかける
const NOISE_BAND: Record<NoiseKind, [number, number]> = {
  white: [0, 0],
  hat: [5000, 0],
  snare: [1000, 7000],
  clap: [900, 3000],
  shaker: [3000, 9000],
}

function onePole(x: Float32Array, fc: number, sr: number, high: boolean): void {
  const a = Math.exp((-2 * Math.PI * fc) / sr)
  let y = 0
  for (let i = 0; i < x.length; i++) {
    y = (1 - a) * x[i] + a * y
    x[i] = high ? x[i] - y : y
  }
}

// 打楽器の音源は、帯域を絞った雑音を先に作っておく（1 打ごとにフィルタのノードを作らずにすむ）
function makeNoise(ctx: BaseAudioContext, kind: NoiseKind): AudioBuffer {
  const sr = ctx.sampleRate
  const buf = ctx.createBuffer(1, Math.floor(sr * 1.5), sr)
  const x = buf.getChannelData(0)
  for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1
  const [hp, lp] = NOISE_BAND[kind]
  for (let k = 0; k < 2; k++) {
    if (hp) onePole(x, hp, sr, true)
    if (lp) onePole(x, lp, sr, false)
  }
  let sum = 0
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i]
  const gain = 0.35 / Math.sqrt(sum / x.length) // 種類によらず同じくらいの音量にそろえる
  for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i] * gain))
  return buf
}

// ピーク止め: -10 dBFS までは素通しし、それより上はなめらかに丸めて -5 dBFS で頭打ちにする。
// キックとベースと和音の頭が重なる瞬間だけを削り、BGM だけでマスターのリミッターを動かさない
function ceilingCurve(): Float32Array<ArrayBuffer> {
  const knee = 0.3
  const top = 0.55
  const c = new Float32Array(2048)
  for (let i = 0; i < c.length; i++) {
    const x = (i / (c.length - 1)) * 2 - 1
    const a = Math.abs(x)
    c[i] = Math.sign(x) * (a < knee ? a : knee + (top - knee) * Math.tanh((a - knee) / (top - knee)))
  }
  return c
}

const clipCurves = new Map<number, Float32Array<ArrayBuffer>>()

// やわらかい歪み（小さい音はそのまま通し、大きい音だけ丸める）
function softClip(k: number): Float32Array<ArrayBuffer> {
  let c = clipCurves.get(k)
  if (!c) {
    c = new Float32Array(1024)
    for (let i = 0; i < c.length; i++) c[i] = Math.tanh(k * ((i / (c.length - 1)) * 2 - 1)) / k
    clipCurves.set(k, c)
  }
  return c
}

let shared: Shared | null = null
let decks: Deck[] = []
let current: Deck | null = null
let want: BgmScene | null = null // 鳴らしたい場面（unlock の前に呼ばれたら、ここに覚えておく）
let ducked = false
let timer = 0
let timerMs = 0

function usable(): BaseAudioContext | null {
  const ctx = engine.ctx
  return ctx && ctx.state !== 'closed' ? ctx : null
}

function sharedFor(ctx: BaseAudioContext): Shared {
  if (shared && shared.ctx === ctx) return shared
  decks = [] // 別の AudioContext になった（ふつうは起きない）。古いデッキは捨てる
  current = null
  const duck = ctx.createGain()
  duck.gain.value = ducked ? DUCK : 1
  duck.connect(engine.bus('bgm'))
  const ceiling = ctx.createWaveShaper()
  ceiling.curve = ceilingCurve()
  ceiling.oversample = '2x'
  ceiling.connect(duck)
  const lowCut = ctx.createBiquadFilter()
  lowCut.type = 'highpass'
  lowCut.frequency.value = 280 // 残響に低音を入れると濁るので切る
  const duckW = ctx.createGain()
  duckW.gain.value = ducked ? DUCK : 1
  lowCut.connect(duckW).connect(engine.reverb)
  const noise = {} as Record<NoiseKind, AudioBuffer>
  for (const kind of Object.keys(NOISE_BAND) as NoiseKind[]) noise[kind] = makeNoise(ctx, kind)
  shared = { ctx, input: ceiling, duck, duckW, wet: lowCut, noise }
  return shared
}

// ── デッキ ─────────────────────────────────────

function makeDeck(sh: Shared, scene: BgmScene): Deck {
  const ctx = sh.ctx
  const song = songOf(scene)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = song.lp
  lp.Q.value = 0.5
  const fade = ctx.createGain()
  const fadeW = ctx.createGain()
  fade.gain.value = 0
  fadeW.gain.value = 0
  lp.connect(fade).connect(sh.input)
  fadeW.connect(sh.wet)
  const parts: AudioNode[] = [lp, fade, fadeW]
  const bus = {} as Record<BusName, GainNode>
  for (const name of BUSES) {
    const g = ctx.createGain()
    g.gain.value = song.mix[name]
    parts.push(g)
    let out: AudioNode = g
    if (name === 'bass' && song.drive > 0) {
      const ws = ctx.createWaveShaper()
      ws.curve = softClip(song.drive)
      out = g.connect(ws)
      parts.push(ws)
    }
    out.connect(lp)
    const send = song.send[name]
    if (send) {
      const s = ctx.createGain()
      s.gain.value = send
      out.connect(s).connect(fadeW)
      parts.push(s)
    }
    bus[name] = g
  }
  if (song.echo) {
    // メロディのやまびこ。戻りにローパスをかけて、繰り返すほど丸くする
    const dl = ctx.createDelay(2)
    dl.delayTime.value = (song.echo.beats * 60) / song.bpm
    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 2400
    const fb = ctx.createGain()
    fb.gain.value = song.echo.fb
    const wet = ctx.createGain()
    wet.gain.value = song.echo.wet
    bus.lead.connect(dl).connect(tone).connect(fb).connect(dl)
    tone.connect(wet).connect(lp)
    parts.push(dl, tone, fb, wet)
  }
  const step = 60 / song.bpm / 4
  return {
    scene,
    song,
    ctx,
    noise: sh.noise,
    step,
    t0: ctx.currentTime + 0.05 + 16 * step,
    pos: -16,
    bus,
    fade,
    fadeW,
    parts,
    fd: { t0: 0, t1: 0, v0: 0, v1: 0 },
    dieAt: Infinity,
    live: [],
    open: null,
  }
}

// 等パワーの曲線（上げるときは sin、下げるときは cos）。2 曲が重なっても音量が凹まない
function ease(v0: number, v1: number, x: number): number {
  return v1 > v0 ? v0 + (v1 - v0) * Math.sin((x * Math.PI) / 2) : v1 + (v0 - v1) * Math.cos((x * Math.PI) / 2)
}

function fadeNow(d: Deck, t: number): number {
  const f = d.fd
  if (t >= f.t1) return f.v1
  if (t <= f.t0) return f.v0
  return ease(f.v0, f.v1, (t - f.t0) / (f.t1 - f.t0))
}

// フェードの途中で呼ばれても、いまの音量から続けて動かす
function fadeTo(d: Deck, to: number, sec: number): void {
  const t = d.ctx.currentTime
  const from = fadeNow(d, t)
  d.fd = { t0: t, t1: t + sec, v0: from, v1: to }
  for (const p of [d.fade.gain, d.fadeW.gain]) {
    p.cancelScheduledValues(t)
    p.setValueAtTime(from, t)
    for (let i = 1; i <= 8; i++) p.linearRampToValueAtTime(ease(from, to, i / 8), t + (sec * i) / 8)
  }
}

// 下げて、下がりきったら片付ける
function retire(d: Deck, sec: number): void {
  const end = d.ctx.currentTime + sec
  if (d.dieAt <= end + 0.05) return // もっと早く消える予定なら、そのまま
  fadeTo(d, 0, sec)
  d.dieAt = end + 0.05
}

function kill(d: Deck): void {
  for (const x of d.live) {
    try {
      x.n.stop()
    } catch {
      // すでに止まっている
    }
  }
  d.live.length = 0
  for (const node of d.parts) node.disconnect()
  decks = decks.filter((x) => x !== d)
  if (current === d) current = null
}

function start(sh: Shared, scene: BgmScene): void {
  // 下げている途中の同じ場面があれば、作り直さずに上げ直す（行ったり来たりしても曲がつながる）
  const back = decks.find((d) => d.scene === scene) ?? null
  for (const d of decks) if (d !== back) retire(d, XFADE)
  const d = back ?? makeDeck(sh, scene)
  if (!back) decks.push(d)
  d.dieAt = Infinity
  fadeTo(d, d.song.vol, XFADE)
  current = d
  // 切り替えを連打されたら、古いデッキから素早く片付ける（CPU を守る）
  const others = decks.filter((x) => x !== d)
  for (const old of others.slice(0, Math.max(0, others.length - 2))) retire(old, 0.05)
}

// ── スケジューラ ────────────────────────────────

function playStep(d: Deck, pos: number, t: number): void {
  const s = d.song
  const list = pos < 0 ? s.head[pos + 16] : s.main[pos % s.main.length]
  if (!list || !list.length) return
  const swing = pos & 1 ? s.swing * d.step : 0
  const busy = d.live.length > MAX_VOICES
  for (const e of list) if (!busy || !e.low) e.v(d, t + swing + e.off * d.step, e)
}

function pump(d: Deck, now: number, until: number): void {
  let j = 0
  for (const x of d.live) if (x.end > now) d.live[j++] = x // 鳴り終わった音源を一覧から外す
  d.live.length = j
  // 遅れたとき（タブが裏に回った直後など）は、間に合わない音を鳴らさずに飛ばす
  d.pos = Math.max(d.pos, Math.ceil((now - 0.02 - d.t0) / d.step))
  const on = engine.enabled // 消音中は予約しない（CPU を使わない）。拍は進めておき、戻したら続きから鳴る
  for (;;) {
    const t = d.t0 + d.pos * d.step
    if (t >= until) break
    if (on && t < d.dieAt) playStep(d, d.pos, t)
    d.pos++
  }
}

function tick(): void {
  const ctx = usable()
  if (!ctx) {
    if (!want) stopTimer()
    return
  }
  setTimer(TICK_MS)
  const sh = sharedFor(ctx)
  if (want && !current) start(sh, want) // unlock の前に頼まれていた場面
  const now = ctx.currentTime
  const until = now + (document.hidden ? AHEAD_HIDDEN : AHEAD)
  for (const d of decks) pump(d, now, until)
  for (const d of decks.slice()) if (now >= d.dieAt) kill(d)
  if (!decks.length && !want) stopTimer()
}

function setTimer(ms: number): void {
  if (timer && timerMs === ms) return
  if (timer) window.clearInterval(timer)
  timer = window.setInterval(tick, ms)
  timerMs = ms
}

function stopTimer(): void {
  if (timer) window.clearInterval(timer)
  timer = 0
  timerMs = 0
}

export const bgm: Bgm = {
  play(scene) {
    want = scene
    const ctx = usable()
    if (!ctx) {
      setTimer(WAIT_MS) // unlock の前: 覚えておき、ctx ができたのを見つけたら鳴らし始める
      return
    }
    if (current && current.scene === scene) return
    start(sharedFor(ctx), scene)
    tick() // すぐに最初の音を予約する（タイマーもここで動き出す）
  },
  stop(fadeMs = 1500) {
    want = null
    if (!usable()) return
    for (const d of decks) retire(d, Math.max(0.03, fadeMs / 1000))
    current = null
  },
  duck(on) {
    ducked = on
    if (!shared) return
    const t = shared.ctx.currentTime
    for (const p of [shared.duck.gain, shared.duckW.gain]) p.setTargetAtTime(on ? DUCK : 1, t, on ? 0.08 : 0.3)
  },
}

// いま鳴っている曲の様子（ギャラリーの表示用。拍に合わせた演出にも使える）
export interface BgmStatus {
  scene: BgmScene
  title: string
  feel: string
  key: string
  bpm: number
  bar: number // 1〜16（イントロ中は 0）
  beat: number // 1〜4
  lap: number // 何周目のアレンジか（1 か 2）
  ducked: boolean
  leaving: boolean // フェードアウト中
}

export function bgmStatus(): BgmStatus | null {
  const d = current ?? decks[decks.length - 1]
  if (!d) return null
  const s = d.song
  const p = Math.floor((d.ctx.currentTime - d.t0) / d.step)
  return {
    scene: d.scene,
    title: s.title,
    feel: s.feel,
    key: s.key,
    bpm: s.bpm,
    bar: p < 0 ? 0 : (Math.floor(p / 16) % 16) + 1,
    beat: Math.floor((((p % 16) + 16) % 16) / 4) + 1,
    lap: p < 0 ? 1 : (Math.floor(p / 256) % (CYCLE / 16)) + 1,
    ducked,
    leaving: d !== current,
  }
}

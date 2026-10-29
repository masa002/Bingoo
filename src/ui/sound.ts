import type { Rarity } from '../core/prizes'

// 効果音は音声ファイルを持たず、Web Audio で合成する（ダウンロード不要で、オフラインでも鳴る）。
// 本番では会場の音は大画面（PA）1 系統だけにし、スマホは既定で鳴らさない

class SoundKit {
  enabled = true
  private ctx: AudioContext | null = null
  private out: GainNode | null = null
  private timers: number[] = []
  private held: AudioScheduledSourceNode[] = [] // 途中で止める音（ライザーなど）

  // ブラウザは操作なしの再生を止めるので、最初のクリックで初期化する
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.ctx = new Ctor()
      const limiter = this.ctx.createDynamicsCompressor()
      limiter.threshold.value = -10
      limiter.knee.value = 6
      limiter.ratio.value = 12
      this.out = this.ctx.createGain()
      this.out.gain.value = 0.8
      this.out.connect(limiter).connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  private get ready(): boolean {
    return this.enabled && this.ctx !== null && this.out !== null
  }

  private tone(
    freq: number,
    o: { at?: number; dur?: number; type?: OscillatorType; gain?: number; slide?: number; attack?: number; hold?: boolean } = {},
  ): void {
    if (!this.ready) return
    const ctx = this.ctx!
    const t0 = ctx.currentTime + (o.at ?? 0)
    const dur = o.dur ?? 0.15
    const osc = ctx.createOscillator()
    const amp = ctx.createGain()
    osc.type = o.type ?? 'sine'
    osc.frequency.setValueAtTime(freq, t0)
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t0 + dur)
    // 矩形波をそのまま切ると耳障りなので、立ち上がりと減衰を必ず付ける
    amp.gain.setValueAtTime(0.0001, t0)
    amp.gain.exponentialRampToValueAtTime(o.gain ?? 0.15, t0 + (o.attack ?? 0.01))
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(amp).connect(this.out!)
    osc.start(t0)
    osc.stop(t0 + dur + 0.05)
    if (o.hold) this.held.push(osc)
  }

  private noise(o: { at?: number; dur?: number; gain?: number; freq?: number; to?: number; q?: number; filter?: BiquadFilterType }): void {
    if (!this.ready) return
    const ctx = this.ctx!
    const t0 = ctx.currentTime + (o.at ?? 0)
    const dur = o.dur ?? 0.3
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource()
    src.buffer = buf
    const filter = ctx.createBiquadFilter()
    filter.type = o.filter ?? 'bandpass'
    filter.Q.value = o.q ?? 1
    filter.frequency.setValueAtTime(o.freq ?? 1000, t0)
    if (o.to) filter.frequency.exponentialRampToValueAtTime(o.to, t0 + dur)
    const amp = ctx.createGain()
    amp.gain.setValueAtTime(0.0001, t0)
    amp.gain.exponentialRampToValueAtTime(o.gain ?? 0.2, t0 + 0.02)
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    src.connect(filter).connect(amp).connect(this.out!)
    src.start(t0)
    src.stop(t0 + dur + 0.05)
  }

  // 伸ばしている音（ライザー・鼓動）を止める。開封の瞬間に「ピタッと」止めるのに使う
  silence(): void {
    this.timers.forEach((t) => window.clearInterval(t))
    this.timers = []
    const now = this.ctx?.currentTime ?? 0
    for (const n of this.held) {
      try {
        n.stop(now + 0.02)
      } catch {
        // すでに止まっている
      }
    }
    this.held = []
  }

  tick(): void {
    this.tone(1400, { dur: 0.03, type: 'square', gain: 0.04 })
  }

  step(i: number): void {
    const f = 440 * Math.pow(2, (i * 2) / 12)
    this.tone(f, { dur: 0.18, type: 'triangle', gain: 0.14 })
    this.tone(f * 1.5, { at: 0.05, dur: 0.16, gain: 0.08 })
  }

  holdChange(tier: number): void {
    ;[523, 659, 784, 1046].slice(0, tier + 1).forEach((f, i) => this.tone(f, { at: i * 0.06, dur: 0.2, type: 'triangle', gain: 0.12 }))
  }

  flutter(): void {
    for (let i = 0; i < 8; i++) this.noise({ at: i * 0.07, dur: 0.06, gain: 0.08, freq: 3000 + i * 300, q: 4 })
  }

  pseudoStop(): void {
    this.tone(220, { dur: 0.12, type: 'square', gain: 0.08 })
  }

  nextChime(): void {
    this.tone(988, { dur: 0.12, type: 'triangle', gain: 0.12 })
    this.tone(1319, { at: 0.1, dur: 0.25, type: 'triangle', gain: 0.12 })
  }

  cutin(tier: number): void {
    this.noise({ dur: 0.45, gain: 0.22, freq: 600, to: 5000, q: 0.8 })
    const base = [523, 523, 587, 659][tier] ?? 523
    this.tone(base, { at: 0.12, dur: 0.35, type: 'sawtooth', gain: 0.09 })
    this.tone(base * 1.5, { at: 0.12, dur: 0.35, type: 'square', gain: 0.05 })
  }

  // 上がり続ける音。開封の瞬間に silence() で止める
  riser(sec: number): void {
    if (!this.ready) return
    const ctx = this.ctx!
    const t0 = ctx.currentTime
    const osc = ctx.createOscillator()
    const amp = ctx.createGain()
    const lp = ctx.createBiquadFilter()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(220, t0)
    osc.frequency.exponentialRampToValueAtTime(880, t0 + sec)
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(600, t0)
    lp.frequency.exponentialRampToValueAtTime(5000, t0 + sec)
    amp.gain.setValueAtTime(0.0001, t0)
    amp.gain.exponentialRampToValueAtTime(0.08, t0 + sec)
    osc.connect(lp).connect(amp).connect(this.out!)
    osc.start(t0)
    osc.stop(t0 + sec + 0.8)
    this.held.push(osc)
  }

  heartbeat(bpm: number, ms: number): void {
    if (!this.ready) return
    const beat = () => {
      this.tone(70, { dur: 0.12, gain: 0.35, slide: 45 })
      this.tone(65, { at: 0.18, dur: 0.12, gain: 0.25, slide: 40 })
    }
    beat()
    const id = window.setInterval(beat, 60000 / bpm)
    this.timers.push(id)
    window.setTimeout(() => window.clearInterval(id), ms)
  }

  goldRise(): void {
    for (let i = 0; i < 6; i++) this.tone(1200 + i * 180, { at: i * 0.08, dur: 0.3, gain: 0.05 })
  }

  // 虹専用の確定音。ほかの段階では使わない（この音が鳴ったら確定、と覚えてもらう）
  freeze(): void {
    this.silence()
    this.tone(1568, { dur: 2.2, gain: 0.18, attack: 0.005 })
    this.tone(2093, { dur: 2.2, gain: 0.1, attack: 0.005 })
  }

  crack(): void {
    this.noise({ dur: 1.2, gain: 0.12, freq: 6000, to: 1500, q: 2 })
    ;[1319, 1568, 1976, 2637].forEach((f, i) => this.tone(f, { at: 0.1 + i * 0.12, dur: 0.6, gain: 0.06 }))
  }

  kakutei(): void {
    ;[523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, { at: i * 0.03, dur: 1.4, type: 'triangle', gain: 0.09 }))
  }

  impact(tier: number): void {
    this.tone(160, { dur: 0.35 + tier * 0.1, gain: [0.18, 0.22, 0.3, 0.34, 0.38][tier], slide: 40 })
    this.noise({ dur: 0.25 + tier * 0.08, gain: 0.1 + tier * 0.04, freq: 1800, to: 300, q: 0.7, filter: 'lowpass' })
    this.tone([784, 880, 988, 1046, 1318][tier], { at: 0.04, dur: 0.4 + tier * 0.15, type: 'triangle', gain: 0.12 })
    if (tier >= 3) this.fanfare(tier === 4)
  }

  fanfare(big: boolean): void {
    const notes = big ? [523, 659, 784, 1046, 1318, 1568] : [523, 659, 784, 1046]
    notes.forEach((f, i) => this.tone(f, { at: 0.15 + i * 0.09, dur: 0.3, type: 'triangle', gain: 0.13 }))
    this.tone(notes[notes.length - 1], { at: 0.15 + notes.length * 0.09, dur: big ? 1.4 : 0.8, type: 'triangle', gain: 0.15 })
  }

  stamp(): void {
    this.tone(660, { dur: 0.08, type: 'square', gain: 0.06 })
  }

  reach(): void {
    this.tone(880, { dur: 0.09, type: 'square', gain: 0.09 })
    this.tone(1175, { at: 0.11, dur: 0.28, type: 'square', gain: 0.09 })
  }

  packTear(): void {
    this.noise({ dur: 0.35, gain: 0.2, freq: 2500, to: 900, q: 0.6, filter: 'highpass' })
  }

  rarity(r: Rarity | null): void {
    switch (r) {
      case 'UR':
        this.kakutei()
        this.fanfare(true)
        break
      case 'SR':
        this.fanfare(false)
        break
      case 'R':
        ;[1319, 1760].forEach((f, i) => this.tone(f, { at: i * 0.08, dur: 0.3, type: 'triangle', gain: 0.1 }))
        break
      default:
        this.tone(784, { dur: 0.18, type: 'triangle', gain: 0.1 })
    }
  }
}

export const sound = new SoundKit()

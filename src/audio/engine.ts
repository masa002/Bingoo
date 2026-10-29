// Web Audio の土台。効果音・BGM・残響のバスと、音を作る小さな部品をまとめる。
// 音声ファイルは使わず、すべて合成する（ダウンロード不要で、オフラインでも鳴る）。
//
//   音源 → (フィルタ) → 音量の包絡 → 定位 → [効果音バス | BGM バス] → マスター → リミッター → 出力
//                                         └→ 残響の送り → 残響（合成したホールの響き）→ マスター

export interface FilterSpec {
  type: BiquadFilterType
  freq: number
  to?: number // 終わりの周波数（指数で変える）
  q?: number
}

export interface ToneOptions {
  at?: number // 何秒後に鳴らすか
  dur?: number // 長さ（秒）
  type?: OscillatorType
  gain?: number // 最大音量（0〜1。重ねる前提で 0.05〜0.3 くらい）
  attack?: number // 立ち上がり（秒）
  release?: number // 減衰（秒）。dur の終わりに向けて下がる
  slide?: number // 終わりの周波数（指数で変える）
  detune?: number // セント
  vibrato?: { rate: number; depth: number } // depth はセント
  pan?: number // -1〜1
  reverb?: number // 残響へ送る量 0〜1
  filter?: FilterSpec
  bus?: 'sfx' | 'bgm'
  hold?: boolean // true なら stopHeld() で止める対象にする
}

export interface NoiseOptions {
  at?: number
  dur?: number
  gain?: number
  attack?: number
  release?: number
  pan?: number
  reverb?: number
  filter?: FilterSpec
  bus?: 'sfx' | 'bgm'
  hold?: boolean
}

export class AudioEngine {
  ctx: AudioContext | null = null
  private master: GainNode | null = null
  private sfxBus: GainNode | null = null
  private bgmBus: GainNode | null = null
  private bgmDuck: GainNode | null = null
  private reverbIn: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private readonly held = new Set<AudioScheduledSourceNode>()
  private on = true

  // ブラウザは操作なしの再生を止めるので、最初のクリックで初期化する
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      const ctx = new Ctor()
      this.ctx = ctx
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -8
      limiter.knee.value = 4
      limiter.ratio.value = 20
      limiter.attack.value = 0.003
      limiter.release.value = 0.15
      this.master = ctx.createGain()
      this.master.gain.value = this.on ? 0.85 : 0
      this.master.connect(limiter).connect(ctx.destination)

      this.sfxBus = ctx.createGain()
      this.sfxBus.connect(this.master)
      this.bgmBus = ctx.createGain()
      this.bgmBus.gain.value = 0.55
      this.bgmDuck = ctx.createGain()
      this.bgmBus.connect(this.bgmDuck).connect(this.master)

      const convolver = ctx.createConvolver()
      convolver.buffer = this.impulse(2.4)
      this.reverbIn = ctx.createGain()
      const ret = ctx.createGain()
      ret.gain.value = 0.35
      this.reverbIn.connect(convolver).connect(ret).connect(this.master)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  get ready(): boolean {
    return this.ctx !== null && this.master !== null && this.ctx.state !== 'closed'
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0
  }

  get enabled(): boolean {
    return this.on
  }

  set enabled(on: boolean) {
    this.on = on
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.85 : 0, this.ctx.currentTime, 0.05)
  }

  // 効果音・BGM の出口。自前で組んだノードはここにつなぐ
  bus(name: 'sfx' | 'bgm'): AudioNode {
    return (name === 'bgm' ? this.bgmBus : this.sfxBus)!
  }

  // ここにつなぐとホールの残響が付く
  get reverb(): AudioNode {
    return this.reverbIn!
  }

  // BGM の音量を一時的に下げる（1 = 通常、0 = 無音）。演出の山場や「間」に使う
  duckBgm(level: number, ms = 200): void {
    if (!this.bgmDuck || !this.ctx) return
    this.bgmDuck.gain.setTargetAtTime(level, this.ctx.currentTime, Math.max(0.01, ms / 1000 / 3))
  }

  tone(freq: number, o: ToneOptions = {}): void {
    if (!this.ready || !this.on) return
    const ctx = this.ctx!
    const t0 = ctx.currentTime + (o.at ?? 0)
    const dur = o.dur ?? 0.15
    const osc = ctx.createOscillator()
    osc.type = o.type ?? 'sine'
    osc.frequency.setValueAtTime(freq, t0)
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t0 + dur)
    if (o.detune) osc.detune.value = o.detune
    if (o.vibrato) {
      const lfo = ctx.createOscillator()
      const depth = ctx.createGain()
      lfo.frequency.value = o.vibrato.rate
      depth.gain.value = o.vibrato.depth
      lfo.connect(depth).connect(osc.detune)
      lfo.start(t0)
      lfo.stop(t0 + dur + 0.1)
    }
    this.route(osc, t0, dur, o)
  }

  noise(o: NoiseOptions = {}): void {
    if (!this.ready || !this.on) return
    const ctx = this.ctx!
    const t0 = ctx.currentTime + (o.at ?? 0)
    const dur = o.dur ?? 0.3
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer()
    src.loop = true
    this.route(src, t0, dur, o)
  }

  // silence() で止める対象にする（ライザーや鼓動など、途中で切る音）
  hold<T extends AudioScheduledSourceNode>(node: T): T {
    this.held.add(node)
    node.addEventListener('ended', () => this.held.delete(node))
    return node
  }

  stopHeld(): void {
    const t = this.now + 0.02
    for (const node of this.held) {
      try {
        node.stop(t)
      } catch {
        // すでに止まっている
      }
    }
    this.held.clear()
  }

  // 2 秒の白色雑音（使い回す）
  noiseBuffer(): AudioBuffer {
    if (!this.noiseBuf) {
      const ctx = this.ctx!
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      this.noiseBuf = buf
    }
    return this.noiseBuf
  }

  // 音源に包絡・フィルタ・定位・残響を付けてバスにつなぎ、鳴らす
  private route(src: AudioScheduledSourceNode, t0: number, dur: number, o: ToneOptions | NoiseOptions): void {
    const ctx = this.ctx!
    let node: AudioNode = src
    if (o.filter) {
      const f = ctx.createBiquadFilter()
      f.type = o.filter.type
      f.Q.value = o.filter.q ?? 0.8
      f.frequency.setValueAtTime(o.filter.freq, t0)
      if (o.filter.to) f.frequency.exponentialRampToValueAtTime(o.filter.to, t0 + dur)
      node = node.connect(f)
    }
    const amp = ctx.createGain()
    const peak = Math.max(0.0002, o.gain ?? 0.15)
    const attack = Math.min(o.attack ?? 0.008, dur * 0.9)
    const release = Math.min(o.release ?? dur * 0.9, dur)
    amp.gain.setValueAtTime(0.0001, t0)
    amp.gain.exponentialRampToValueAtTime(peak, t0 + attack)
    amp.gain.setValueAtTime(peak, t0 + Math.max(attack, dur - release))
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    node = node.connect(amp)
    if (o.pan) {
      const p = ctx.createStereoPanner()
      p.pan.value = o.pan
      node = node.connect(p)
    }
    node.connect(this.bus(o.bus ?? 'sfx'))
    if (o.reverb) {
      const send = ctx.createGain()
      send.gain.value = o.reverb
      node.connect(send).connect(this.reverb)
    }
    src.start(t0)
    src.stop(t0 + dur + 0.05)
    if (o.hold) this.hold(src)
  }

  // ホールの残響（指数で減衰するステレオの雑音）
  private impulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!
    const len = Math.floor(ctx.sampleRate * seconds)
    const buf = ctx.createBuffer(2, len, ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch)
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2)
    }
    return buf
  }
}

export const engine = new AudioEngine()

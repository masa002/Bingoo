import { describe, expect, it } from 'vitest'
import type { Msg, MsgOf, PhoneCommand } from '../net/protocol'
import { inflate, type Frame } from '../net/wire'
import { Engine, type EngineHost, type Outbound } from './engine'

// 偽の時計と偽の参加者で、1 ゲームを最後まで回す

class FakeHost implements EngineHost {
  t = 1_000_000
  alarm: number | null = null
  out: Outbound[] = []
  private n = 0
  constructor(private readonly seed: string) {}
  now(): number {
    return this.t
  }
  setAlarm(at: number | null): void {
    this.alarm = at
  }
  emit(out: Outbound): void {
    this.out.push(out)
  }
  secret(): string {
    return `${this.seed}-${this.n++}-0123456789abcdef`
  }
}

interface Run {
  engine: Engine
  host: FakeHost
  log: string[] // 配ったメッセージ（JSON）
  hostMsgs: MsgOf<'host'>[]
}

interface Opts {
  seed: string
  humans: number
  bots: number
  lower: number
  upper: number
  dc: number
  restoreEvery?: number // この回数の出来事ごとに、保存 → 復元をはさむ
  lateJoin?: boolean
}

// 本物の参加者の代わり: メッセージを見て、少し遅れて返事をする（番号ごとに決まった動き）
function react(idx: number, msg: Msg, at: number): { at: number; cmd: PhoneCommand } | null {
  const lag = 300 + ((idx * 37) % 900)
  switch (msg.type) {
    case 'questStart':
      if (idx % 11 === 0) return null // 叩かなかった人（数を送らない）
      return { at: at + msg.introMs + msg.playMs + lag, cmd: { type: 'questScore', score: (idx * 7) % 33 } }
    case 'prizeTime': {
      const mine = msg.entries.find((e) => e.isMe)
      if (!mine?.rarity) return null
      if (idx % 5 === 0) return null // 選ばないまま時間切れの人
      return { at: at + (msg.lastOne?.durationMs ?? 0) + 4000 + lag * 3, cmd: { type: 'choice', kind: mine.choice?.allowed && idx % 2 === 0 ? 'challenge' : 'receive' } }
    }
    case 'dcEntry':
      return msg.meEligible && idx % 4 !== 0 ? { at: at + 2000 + lag * 5, cmd: { type: 'entry' } } : null
    default:
      return null
  }
}

async function play(o: Opts): Promise<Run> {
  const host = new FakeHost(o.seed)
  let engine = await Engine.create(host, 700, { lower: o.lower, upper: o.upper, dc: o.dc })
  const log: string[] = []
  const hostMsgs: MsgOf<'host'>[] = []
  const queue: { at: number; idx: number; cmd: PhoneCommand }[] = []
  const humans: number[] = []
  let events = 0
  let seq = 0

  const flush = (): void => {
    for (const out of host.out.splice(0)) {
      const text = JSON.stringify({ at: out.at, to: out.to, msg: out.msg, personal: out.personal ? [...out.personal] : null })
      log.push(text)
      if (out.msg?.type === 'host') hostMsgs.push(out.msg)
      if (out.to === 'host' || out.to === 'crew') continue
      for (const p of out.personal?.keys() ?? []) expect(engine.isBot(p), 'no personal part for bots').toBe(false)
      // 本物の参加者は、JSON で届いたフレームを画面のメッセージに戻してから反応する
      for (const idx of humans) {
        const p = out.personal?.get(idx)
        if (!out.msg && !p) continue
        const frame = JSON.parse(JSON.stringify({ s: ++seq, at: out.at, b: out.msg ?? undefined, p })) as Frame
        const r = react(idx, inflate(frame, idx), out.at)
        if (r) queue.push({ ...r, idx })
      }
    }
    queue.sort((a, b) => a.at - b.at)
  }

  const maybeRestore = (): void => {
    if (!o.restoreEvery || ++events % o.restoreEvery) return
    const dump = JSON.parse(JSON.stringify(engine.dump()))
    const seats = JSON.parse(JSON.stringify(engine.seats()))
    engine = Engine.restore(host, 700, dump, seats)
  }

  for (let i = 0; i < o.humans; i++) {
    const r = engine.join(`人${i}`)
    if ('error' in r) throw new Error(r.error)
    humans.push(r.idx)
    expect(engine.snapshot(r.idx).me.cardNo).toBe(r.cardNo)
  }
  await engine.command({ type: 'bots', count: o.bots })
  await engine.command({ type: 'next' })
  await engine.command({ type: 'auto', on: true })
  flush()

  for (let guard = 0; guard < 200000; guard++) {
    const last = hostMsgs[hostMsgs.length - 1]
    if (last?.phase === 'done') break
    if (last?.phase === 'over' && !last.busy) {
      host.t += 2000
      await engine.command({ type: 'next' })
      flush()
      continue
    }
    const nextCmd = queue[0]?.at ?? Infinity
    const nextAlarm = host.alarm ?? Infinity
    if (nextCmd === Infinity && nextAlarm === Infinity) throw new Error(`stuck at ${JSON.stringify(last)}`)
    if (nextCmd <= nextAlarm) {
      const c = queue.shift()!
      host.t = Math.max(host.t, c.at)
      engine.player(c.idx, c.cmd)
    } else {
      host.t = Math.max(host.t, nextAlarm + (guard % 7) * 9) // 起こされるのが少し遅れる
      engine.onAlarm()
    }
    flush()
    if (o.lateJoin && engine.game.drawCount === 6 && humans.length === o.humans) {
      const r = engine.join('おくれた人')
      if ('error' in r) throw new Error(r.error)
      humans.push(r.idx)
      expect(engine.snapshot(r.idx).live!.mask).not.toBe(1 << 12) // もう出た番号は開いている
    }
    maybeRestore()
  }
  return { engine, host, log, hostMsgs }
}

function types(run: Run): string[] {
  return run.log.map((x) => (JSON.parse(x) as { msg: Msg | null }).msg?.type ?? 'personal')
}

describe('Engine', () => {
  it('1 ゲームを最後まで進める（本物 40 人 + 仮想 260 人）', async () => {
    const run = await play({ seed: 'a', humans: 40, bots: 260, lower: 10, upper: 3, dc: 3 })
    const e = run.engine
    expect(e.phase).toBe('done')
    const seen = new Set(types(run))
    for (const t of ['joined', 'drawScheduled', 'numberRevealed', 'prizeTime', 'choices', 'idle', 'gameOver', 'dcEntry', 'dcEntrants', 'dcSpin', 'dcEnd', 'host']) expect(seen, t).toContain(t)
    const rows = e.results()
    // 同じ人が 2 つもらわない。配った数は、用意した数を超えない
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length)
    expect(rows.filter((r) => r.how !== 'double-chance').length).toBeLessThanOrEqual(13)
    expect(rows.filter((r) => r.how === 'bingo' || r.how === 'challenge').length).toBeGreaterThanOrEqual(10)
    expect(rows.length).toBeLessThanOrEqual(16)
    expect(e.totals().lowerLeft).toBe(0)
  })

  it('メッセージの時刻は、後戻りしない', async () => {
    const run = await play({ seed: 'b', humans: 12, bots: 88, lower: 5, upper: 3, dc: 3 })
    let last = 0
    for (const x of run.log) {
      const o = JSON.parse(x) as { at: number; to: string }
      if (o.to === 'host') continue
      expect(o.at).toBeGreaterThanOrEqual(last)
      last = o.at
    }
  })

  it('途中で何度止まっても、保存した状態から同じ結果になる', async () => {
    const base = { seed: 'c', humans: 25, bots: 175, lower: 8, upper: 3, dc: 3 }
    const a = await play(base)
    const b = await play({ ...base, restoreEvery: 3 })
    expect(b.engine.phase).toBe('done')
    // 主催の画面への知らせは、復元のたびに送り直すので比べない
    const shared = (run: Run): string[] => run.log.filter((x) => (JSON.parse(x) as { to: string }).to !== 'host')
    expect(shared(b)).toEqual(shared(a))
    expect(b.engine.results()).toEqual(a.engine.results())
  })

  it('イベント（虹玉・モグラ撃退）と、途中からの参加', async () => {
    const host = new FakeHost('d')
    const engine = await Engine.create(host, 700, { lower: 30, upper: 8, dc: 5 })
    for (let i = 0; i < 5; i++) engine.join(`人${i}`)
    await engine.command({ type: 'bots', count: 500 })
    await engine.command({ type: 'next' })
    const step = (): void => {
      host.t = host.alarm!
      engine.onAlarm()
    }
    const until = (type: Msg['type']): Outbound => {
      for (let i = 0; i < 2000; i++) {
        const hit = host.out.find((o) => o.msg?.type === type)
        if (hit) {
          host.out = []
          return hit
        }
        step()
      }
      throw new Error(`no ${type}`)
    }
    until('idle')
    await engine.command({ type: 'trigger', kind: 'wild' })
    await engine.command({ type: 'next' })
    const wild = until('eventPlay')
    expect(wild.personal!.size).toBe(5)
    until('idle')
    await engine.command({ type: 'trigger', kind: 'mole' })
    await engine.command({ type: 'next' })
    const brief = until('questBrief')
    expect(brief.personal!.size).toBe(5)
    expect(engine.hostState().hold).toBe('スタート ▶')
    await engine.command({ type: 'next' })
    until('questStart')
    engine.player(0, { type: 'questScore', score: 9999 })
    engine.player(1, { type: 'questScore', score: Number.NaN })
    const result = until('questResult')
    const me0 = result.personal!.get(0)!.me as { score: number }
    const me1 = result.personal!.get(1)!.me as { score: number }
    expect(me0.score).toBe(40) // 届いた数は、範囲に丸める
    expect(me1.score).toBe(0)
    const late = engine.join('おくれた人')
    expect('idx' in late && late.idx).toBe(505)
    expect(engine.publicState('X').players).toBe(506)
  })

  it('参加だけして止まっても、参加者の表から戻せる', async () => {
    const host = new FakeHost('f')
    const engine = await Engine.create(host, 700, { lower: 5, upper: 3, dc: 3 })
    engine.join('はな')
    await engine.command({ type: 'bots', count: 30 })
    await engine.command({ type: 'next' })
    for (let i = 0; i < 12 && engine.game.drawCount < 2; i++) {
      host.t = host.alarm!
      engine.onAlarm()
    }
    // 状態を保存したあとに、途中から 1 人参加した（保存されるのは、参加者の表だけ）
    const dump = JSON.parse(JSON.stringify(engine.dump()))
    const late = engine.join('おくれた人')
    if ('error' in late) throw new Error(late.error)
    const seats = JSON.parse(JSON.stringify(engine.seats()))
    const back = Engine.restore(host, 700, dump, seats)
    expect(back.game.size).toBe(32)
    expect(back.snapshot(late.idx)).toEqual(engine.snapshot(late.idx))
    expect(back.snapshot(0)).toEqual(engine.snapshot(0))
  })

  it('やり直すと、同じ人のまま配り直す', async () => {
    const host = new FakeHost('e')
    const engine = await Engine.create(host, 700, { lower: 5, upper: 3, dc: 3 })
    const a = engine.join('はな')
    await engine.command({ type: 'bots', count: 20 })
    const before = engine.snapshot(0)
    await engine.command({ type: 'reset', settings: { lower: 7, upper: 3, dc: 3 } })
    const after = engine.snapshot(0)
    expect('idx' in a && a.idx).toBe(0)
    expect(after.me.name).toBe('はな')
    expect(after.seed).not.toBe(before.seed)
    expect(after.totals.lowerTotal).toBe(7)
    expect(engine.game.size).toBe(21)
    expect(engine.roster).toBe(2)
  })
})

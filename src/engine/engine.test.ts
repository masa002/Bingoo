import { describe, expect, it } from 'vitest'
import { HELD_REASON, RANKS, type Rarity } from '../core/prizes'
import type { Msg, MsgOf, PhoneCommand } from '../net/protocol'
import { inflate, type Frame } from '../net/wire'
import { Engine, type EngineDump, type EngineHost, type Outbound } from './engine'

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
  react?: typeof react // 本物の参加者の動き（なければ react）
  watch?: (out: Outbound) => void // 配ったメッセージを、そのつど見る
}

// 本物の参加者の代わり: メッセージを見て、少し遅れて返事をする（番号ごとに決まった動き）
function react(idx: number, msg: Msg, at: number): { at: number; cmd: PhoneCommand }[] {
  const lag = 300 + ((idx * 37) % 900)
  switch (msg.type) {
    case 'questStart':
      if (idx % 11 === 0) return [] // 叩かなかった人（数を送らない）
      return [{ at: at + msg.introMs + msg.playMs + lag, cmd: { type: 'questScore', score: (idx * 7) % 33 } }]
    case 'prizeTime': {
      const mine = msg.entries.find((e) => e.isMe)
      if (!mine?.rarity) return []
      if (idx % 13 === 0) return [] // スマホが眠っていた人（何も送らない）
      // 起きているスマホは、発表が画面に出たらすぐ「見ました」を送る
      const seen = { at: at + 40 + (idx % 9) * 25, cmd: { type: 'prizeSeen' } as PhoneCommand }
      if (idx % 5 === 0) return [seen] // 選ばないまま時間切れの人
      return [seen, { at: at + (msg.lastOne?.durationMs ?? 0) + 4000 + lag * 3, cmd: { type: 'choice', kind: mine.choice?.allowed && idx % 2 === 0 ? 'challenge' : 'receive' } }]
    }
    case 'dcEntry':
      return msg.meEligible && idx % 4 !== 0 ? [{ at: at + 2000 + lag * 5, cmd: { type: 'entry' } }] : []
    default:
      return []
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
      o.watch?.(out)
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
        for (const r of (o.react ?? react)(idx, inflate(frame, idx), out.at)) queue.push({ ...r, idx })
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
    // カードの No. は、その人のスマホに出ている No. と同じ
    for (const r of rows) expect(e.game.players.some((p) => p.name === r.name && p.cardNo === r.cardNo && e.snapshot(p.idx).me.cardNo === r.cardNo)).toBe(true)
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

  it('2 人の主催がほぼ同時に「次へ」を押しても、1 回しか進まない', async () => {
    const host = new FakeHost('twice')
    const engine = await Engine.create(host, 700, { lower: 5, upper: 2, dc: 5 })
    for (let i = 0; i < 50; i++) engine.join(`人${i}`)
    const t = driver(engine, host)
    await engine.command({ type: 'next' })
    t.untilIdle()
    expect(engine.phase).toBe('playing')

    // モグラ撃退の説明: 2 回目の「次へ」が、説明を飛ばしていた
    await engine.command({ type: 'trigger', kind: 'mole' })
    const idle = engine.hostState().step
    await engine.command({ type: 'next', from: idle })
    expect(engine.hostState().hold).toBe('スタート ▶')
    host.out = []
    await engine.command({ type: 'next', from: idle })
    expect(engine.hostState().hold).toBe('スタート ▶')
    // 捨てたら、押した画面に、いまの位置を送り直す
    const resent = host.out.filter((o) => o.msg?.type === 'host').map((o) => o.msg as MsgOf<'host'>)
    expect(resent.length).toBe(1)
    expect(resent[0].step).toBe(engine.hostState().step)
    // 説明の位置から押した「スタート」は効く
    await engine.command({ type: 'next', from: engine.hostState().step })
    expect(engine.hostState().hold).toBe(null)
    t.untilIdle()

    // 前の回の「次へ」が、あとから届いても効かない
    await engine.command({ type: 'next', from: idle })
    expect(engine.hostState().busy).toBe(false)

    // ゲームの終わりまで進める
    for (let i = 0; i < 2000 && !(engine.phase === 'over' && !engine.hostState().busy); i++) {
      if (engine.hostState().busy) t.step()
      else await engine.command({ type: 'next', from: engine.hostState().step })
    }
    expect(engine.phase).toBe('over')

    // 「ダブルチャンスへ」: 2 回目の「次へ」が、受付をすぐ締めていた
    const over = engine.hostState().step
    await engine.command({ type: 'next', from: over })
    expect(engine.phase).toBe('dc-entry')
    host.t += 300
    const eligible = engine.game.players.find((p) => !engine.results().some((r) => r.cardNo === p.cardNo))!.idx
    expect(engine.player(eligible, { type: 'entry' })).toBe(true)
    expect(engine.player(eligible, { type: 'entry' })).toBe(false) // 同じ操作の連打は、何も変えない（保存もしない）
    await engine.command({ type: 'next', from: over })
    expect(engine.phase).toBe('dc-entry')
    expect(engine.hostState().hold).toBe('参加をしめきる ▶')
    // from のない「次へ」は、今までどおり効く（デモ・試験用）
    await engine.command({ type: 'next' })
    expect(engine.phase).toBe('dc-spin')
  })

  it('参加者の操作は、受け付けたときだけ true を返す（保存する側は false なら書かない）', async () => {
    const host = new FakeHost('changed')
    const engine = await Engine.create(host, 700, { lower: 5, upper: 2, dc: 5 })
    engine.join('はな')
    await engine.command({ type: 'bots', count: 20 })
    expect(engine.player(0, { type: 'entry' })).toBe(false) // ダブルチャンスの受付の外
    expect(engine.player(0, { type: 'choice', kind: 'receive' })).toBe(false) // 選ぶ時間の外
    expect(engine.player(0, { type: 'prizeSeen' })).toBe(false)
    expect(engine.player(0, { type: 'questScore', score: 3 })).toBe(false)
    expect(engine.player(0, { type: 'questProgress', score: 3 })).toBe(false)
    expect(engine.player(0, { type: 'join' })).toBe(false)
    expect(engine.player(5, { type: 'questScore', score: 3 })).toBe(false) // 仮想の参加者の分は受け付けない
    expect(engine.player(99, { type: 'entry' })).toBe(false)
  })

  it('上位チャレンジに成功した人は、かならず狙ったランク以上の景品をもらう', async () => {
    let wins = 0
    let offered = 0
    let held = 0
    const bad: string[] = []
    for (const seed of ['ch0', 'ch1', 'ch2']) {
      const target = new Map<number, Rarity>()
      await play({
        seed,
        humans: 400,
        bots: 0,
        lower: 60,
        upper: 4,
        dc: 3,
        // 挑戦を出された人は、みんな挑む
        react: (idx, msg, at) => {
          if (msg.type !== 'prizeTime') return react(idx, msg, at)
          const mine = msg.entries.find((e) => e.isMe)
          if (!mine?.rarity) return []
          return [
            { at: at + 50, cmd: { type: 'prizeSeen' } },
            { at: at + (msg.lastOne?.durationMs ?? 0) + 1500 + (idx % 7) * 100, cmd: { type: 'choice', kind: mine.choice?.allowed ? 'challenge' : 'receive' } },
          ]
        },
        watch: (out) => {
          for (const [idx, p] of out.personal ?? []) if (p.type === 'challengeDeal') target.set(idx, p.target as Rarity)
          if (out.msg?.type !== 'prizeTime') return
          for (const e of out.msg.entries) {
            if (e.choice?.allowed) offered++
            if (e.choice?.reason === HELD_REASON) held++
            if (e.kind !== 'challenge') continue
            wins++
            const want = target.get(e.idx)!
            if (!e.rarity || RANKS.indexOf(e.rarity) < RANKS.indexOf(want)) bad.push(`${seed}: ${e.idx} は ${want} を狙って ${e.rarity ?? 'なし'}`)
          }
        },
      })
    }
    expect(bad).toEqual([])
    // 確かめたい場面（挑戦が多くて、上位の景品が足りなくなる）が、本当に起きている
    expect(wins).toBeGreaterThan(0)
    expect(offered).toBeGreaterThan(0)
    expect(held).toBeGreaterThan(0)
  })

  it('モグラ撃退: 叩いた数が届かなかったリーチの人は、やられない', async () => {
    const host = new FakeHost('mole')
    const engine = await Engine.create(host, 700, { lower: 40, upper: 3, dc: 3 })
    const humans = Array.from({ length: 80 }, (_, i) => i)
    for (const i of humans) engine.join(`人${i}`)
    await engine.command({ type: 'bots', count: 400 })
    const t = driver(engine, host)
    await engine.command({ type: 'next' })
    const reachers = (): number[] => humans.filter((i) => engine.game.players[i].reach > 0 && engine.game.players[i].bingoDraw === null)
    for (let i = 0; i < 60 && reachers().length < 8; i++) {
      t.untilIdle()
      if (reachers().length < 8) await engine.command({ type: 'next' })
    }
    t.untilIdle()
    const reach = reachers()
    expect(reach.length).toBeGreaterThanOrEqual(8)
    await engine.command({ type: 'trigger', kind: 'mole' })
    await engine.command({ type: 'next' }) // 説明
    await engine.command({ type: 'next' }) // スタート
    // 半分は 0 匹と送る（挑んで負けた人）。残りは何も送らない（つなぎ直しの途中・眠っていたスマホ）
    const sent = reach.filter((_, k) => k % 2 === 0)
    const silent = reach.filter((_, k) => k % 2 === 1)
    for (const i of sent) expect(engine.player(i, { type: 'questScore', score: 0 })).toBe(true)
    const masks = new Map(silent.map((i) => [i, engine.game.players[i].mask]))
    const result = t.until('questResult')
    type Me = MsgOf<'questResult'>['me']
    for (const i of silent) {
      const me = result.personal!.get(i)!.me as Me
      expect(me.lost).toBe(false)
      expect(me.rank).toBe(0)
      expect(me.reachAfter).toBe(me.reachBefore)
      expect(engine.game.players[i].mask).toBe(masks.get(i))
    }
    // 挑んで 0 匹だった人は、守れる数に届かずにやられる（決まりそのものは変わっていない）
    for (const i of sent) {
      const me = result.personal!.get(i)!.me as Me
      expect(me.lost).toBe(true)
      expect(me.need).toBeGreaterThan(0)
    }
  })

  it('眠っているスマホの当選者は待たない。「見ました」が来た人は、選ぶまで待つ', async () => {
    const host = new FakeHost('seen')
    const engine = await Engine.create(host, 700, { lower: 30, upper: 3, dc: 3 })
    for (let i = 0; i < 150; i++) engine.join(`人${i}`)
    const t = driver(engine, host)
    await engine.command({ type: 'next' })
    await engine.command({ type: 'auto', on: true })
    const nextPrize = (): MsgOf<'prizeTime'> & { at: number } => {
      for (;;) {
        const o = t.until('prizeTime')
        const m = o.msg as MsgOf<'prizeTime'>
        if (!m.lastOne && m.entries.some((e) => e.rarity)) return { ...m, at: o.at }
      }
    }
    // だれも何も送らない（全員のスマホが眠っている）: 発表から 5 秒で、受け取る扱いにして進む（40 秒は待たない）
    let p = nextPrize()
    expect(t.until('choices').at - p.at).toBe(700 + 5000)
    // 1 人が「見ました」だけ送った: その人が選ぶのを、長くても 40 秒待つ
    p = nextPrize()
    host.t += 300
    expect(engine.player(p.entries.find((e) => e.rarity)!.idx, { type: 'prizeSeen' })).toBe(true)
    expect(t.until('choices').at - p.at).toBe(700 + 40000)
    // 全員が「見ました」と選択を送った: そろった時点で進む
    p = nextPrize()
    host.t += 300
    const winners = p.entries.filter((e) => e.rarity).map((e) => e.idx)
    for (const i of winners) engine.player(i, { type: 'prizeSeen' })
    host.t += 2000
    for (const i of winners) engine.player(i, { type: 'choice', kind: 'receive' })
    expect(t.until('choices').at - p.at).toBe(2300)
    // この変更の前に保存した状態（seen がない）から戻したときは、今までどおり全員を待つ
    p = nextPrize()
    const dump = JSON.parse(JSON.stringify(engine.dump())) as EngineDump
    const s = dump.step as { k: string; until: number; seen?: number[]; seenBy?: number; end?: number }
    expect(s.k).toBe('choice')
    s.until = s.end!
    delete s.seen
    delete s.seenBy
    delete s.end
    const old = Engine.restore(host, 700, dump, JSON.parse(JSON.stringify(engine.seats())))
    host.out = []
    expect(driver(old, host).until('choices').at - p.at).toBe(700 + 40000)
  })
})

// 時刻を、次に起こしてもらう時刻まで進めて起こす
function driver(engine: Engine, host: FakeHost) {
  const step = (): void => {
    host.t = host.alarm!
    engine.onAlarm()
  }
  return {
    step,
    // 主催の「次へ」を待つところまで進める
    untilIdle(): void {
      for (let i = 0; i < 5000 && engine.hostState().busy; i++) step()
    },
    // その型のメッセージが出るまで進める（出たら、それまでの分は捨てる）
    until(type: Msg['type']): Outbound {
      for (let i = 0; i < 20000; i++) {
        const hit = host.out.find((o) => o.msg?.type === type)
        if (hit) {
          host.out = host.out.slice(host.out.indexOf(hit) + 1)
          return hit
        }
        host.out = []
        step()
      }
      throw new Error(`no ${type}`)
    },
  }
}

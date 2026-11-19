import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type LinkState } from './link'
import type { Msg } from './protocol'
import { apiBase, connect, createApi } from './remote'
import type { Frame } from './wire'

// 偽の WebSocket・EventSource・fetch と、偽のタイマーで、つなぎ方と「時刻どおりに渡す」を確かめる

const API = 'http://x/api'
const AHEAD = 5000 // サーバーの時計は、端末より 5 秒進んでいる

class FakeWS {
  static all: FakeWS[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onSend: ((text: string) => void) | null = null
  constructor(readonly url: string) {
    FakeWS.all.push(this)
  }
  send(text: string): void {
    this.sent.push(text)
    this.onSend?.(text)
  }
  close(): void {
    this.readyState = 3
  }
  // ここから下は、試験がサーバーの代わりに呼ぶ
  accept(): void {
    this.readyState = 1
    this.onopen?.()
  }
  push(d: unknown): void {
    this.onmessage?.({ data: typeof d === 'string' ? d : JSON.stringify(d) })
  }
  fail(): void {
    this.readyState = 3
    this.onclose?.()
  }
  // 片道 lag ms の回線の先で、ping に返事をするサーバー
  serve(lag = 20): this {
    this.onSend = (text) => {
      if (text === 'ping') return void setTimeout(() => this.push('pong'), lag * 2)
      const up = JSON.parse(text) as { t: string; c: number }
      if (up.t === 'ping') setTimeout(() => this.push({ t: 'pong', c: up.c, now: Date.now() + AHEAD - lag }), lag * 2)
    }
    this.accept()
    return this
  }
  cmds(): unknown[] {
    return this.sent.filter((t) => t.startsWith('{"t":"cmd"')).map((t) => (JSON.parse(t) as { cmd: unknown }).cmd)
  }
}

class FakeES {
  static all: FakeES[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeES.all.push(this)
  }
  close(): void {}
}

const serverNow = (): number => Date.now() + AHEAD
const notice = (s: number, at: number, text = `n${s}`): Frame => ({ s, at, b: { type: 'notice', text } })
const texts = (got: Msg[]): string[] => got.map((m) => (m.type === 'notice' ? m.text : m.type))
const last = <T>(list: T[]): T => list[list.length - 1]

// つないで、時計が合うところまで進める
function live(opts: { role?: 'player' | 'stage' | 'host'; idx?: number; lag?: number } = {}) {
  const link = connect({ api: API, code: 'ABC234', role: opts.role ?? 'stage', idx: opts.idx, token: opts.role ? 'tok' : undefined, transport: 'ws' })
  const ws = last(FakeWS.all).serve(opts.lag)
  vi.advanceTimersByTime(1500)
  const got: Msg[] = []
  link.hub.subscribe((m) => got.push(m))
  return { link, ws, got }
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  FakeWS.all = []
  FakeES.all = []
  vi.stubGlobal('WebSocket', FakeWS)
  vi.stubGlobal('EventSource', FakeES)
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('時刻をそろえて渡す', () => {
  it('サーバーの時刻で at になった瞬間に渡す', () => {
    const { link, ws, got } = live()
    expect(link.state()).toEqual({ status: 'live', transport: 'ws' })
    ws.push(notice(1, serverNow() + 700))
    vi.advanceTimersByTime(699)
    expect(got).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(texts(got)).toEqual(['n1'])
  })

  it('回線の速さが違う 2 台でも、同じ瞬間に渡す', () => {
    const fast = live({ lag: 15 })
    const slow = live({ lag: 300 })
    const at = serverNow() + 700
    const seen: [string, number][] = []
    fast.link.hub.subscribe(() => seen.push(['fast', Date.now()]))
    slow.link.hub.subscribe(() => seen.push(['slow', Date.now()]))
    setTimeout(() => fast.ws.push(notice(1, at)), 15)
    setTimeout(() => slow.ws.push(notice(1, at)), 300)
    vi.advanceTimersByTime(2000)
    expect(seen.map(([who, t]) => [who, t + AHEAD - at])).toEqual([
      ['fast', 0],
      ['slow', 0],
    ])
  })

  it('at の順に渡す。過ぎている分は、すぐに順番どおり渡す', () => {
    const { ws, got } = live()
    const now = serverNow()
    ws.push(notice(1, now + 700)) // ふつうの配信（少し先）
    ws.push(notice(2, now)) // 主催宛てのような「いますぐ」の分は、追い越す
    expect(texts(got)).toEqual(['n2'])
    ws.push(notice(3, now - 200)) // 遅れて届いた分
    ws.push(notice(4, now - 100))
    expect(texts(got)).toEqual(['n2', 'n3', 'n4'])
    vi.advanceTimersByTime(700)
    expect(texts(got)).toEqual(['n2', 'n3', 'n4', 'n1'])
  })

  it('同じ通し番号を 2 回渡さない', () => {
    const { ws, got } = live()
    ws.push(notice(1, serverNow()))
    ws.push(notice(1, serverNow()))
    ws.push(notice(2, serverNow()))
    ws.push(notice(1, serverNow()))
    expect(texts(got)).toEqual(['n1', 'n2'])
  })

  it('snapshot が来たら、それより前の待っている分は渡さない', () => {
    const { ws, got } = live()
    ws.push(notice(7, serverNow() + 700))
    ws.push({ s: 7, at: serverNow(), b: { type: 'snapshot', drawn: [] } })
    ws.push(notice(8, serverNow() + 100))
    vi.advanceTimersByTime(1000)
    expect(texts(got)).toEqual(['snapshot', 'n8'])
  })

  it('時計が合う前に届いた分は、合ってから渡す。合わなければ 1 秒で渡す', () => {
    const link = connect({ api: API, code: 'ABC234', role: 'stage', transport: 'ws' })
    const got: Msg[] = []
    link.hub.subscribe((m) => got.push(m))
    const ws = last(FakeWS.all)
    ws.accept() // ping に返事をしないサーバー
    ws.push(notice(1, serverNow() + 700))
    vi.advanceTimersByTime(999)
    expect(got).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(got).toHaveLength(1)
  })

  it('自分の番号で、本人宛ての部分と「自分かどうか」を戻す', () => {
    const { ws, got } = live({ role: 'player', idx: 3 })
    const who = [
      { name: 'あ', isMe: false, idx: 2 },
      { name: 'い', isMe: false, idx: 3 },
    ]
    ws.push({ s: 1, at: serverNow(), b: { type: 'joined', count: 9, meJoined: false }, p: { meJoined: true } })
    ws.push({ s: 2, at: serverNow(), b: { type: 'choices', challengers: who, totals: {} } })
    expect(got[0]).toEqual({ type: 'joined', count: 9, meJoined: true })
    expect((got[1] as Extract<Msg, { type: 'choices' }>).challengers.map((w) => w.isMe)).toEqual([false, true])
  })

  it('渡すのが 3 秒より遅れた分は流さず、after なしでつなぎ直す（snapshot をもらう）', () => {
    const { link, ws, got } = live()
    ws.push(notice(1, serverNow() + 700))
    ws.push(notice(2, serverNow() + 700))
    vi.setSystemTime(Date.now() + 10_000) // タブが裏に回って、タイマーが止まっていた
    vi.advanceTimersByTime(700)
    expect(got).toHaveLength(0)
    expect(link.state().status).toBe('retrying')
    vi.advanceTimersByTime(300)
    expect(FakeWS.all).toHaveLength(2)
    expect(last(FakeWS.all).url).not.toContain('after=')
  })
})

describe('つなぎ直し', () => {
  it('切れたら retrying。待ち時間は倍々で、最後の通し番号を after に付ける', () => {
    const { link, ws } = live()
    const states: LinkState[] = []
    link.onState((s) => states.push(s))
    ws.push(notice(41, serverNow()))
    ws.push(notice(42, serverNow() + 700)) // まだ渡していなくても、受け取った分は数える
    ws.fail()
    expect(link.state().status).toBe('retrying')
    vi.advanceTimersByTime(499)
    expect(FakeWS.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWS.all).toHaveLength(2)
    expect(FakeWS.all[1].url).toBe('ws://x/api/g/ABC234/ws?role=stage&after=42')
    FakeWS.all[1].fail() // つながる前に切れた → 次は 1 秒
    vi.advanceTimersByTime(999)
    expect(FakeWS.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeWS.all).toHaveLength(3)
    FakeWS.all[2].serve()
    vi.advanceTimersByTime(100)
    expect(states.map((s) => s.status)).toEqual(['live', 'retrying', 'live'])
  })

  it('待ち時間に 0〜100% のばらつきを足す', () => {
    const { ws } = live()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    ws.fail()
    vi.advanceTimersByTime(749)
    expect(FakeWS.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWS.all).toHaveLength(2)
  })

  it('待ち時間は最大 8 秒（ばらつきを足す前）', () => {
    live().ws.fail()
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(8000)
      last(FakeWS.all).fail()
    }
    const n = FakeWS.all.length
    vi.advanceTimersByTime(7999)
    expect(FakeWS.all).toHaveLength(n)
    vi.advanceTimersByTime(1)
    expect(FakeWS.all).toHaveLength(n + 1)
  })

  it('bye が来たら、もうつながない', () => {
    const { link, ws } = live({ role: 'player', idx: 1 })
    ws.push({ t: 'bye', reason: 'replaced' })
    expect(link.state()).toEqual({ status: 'closed', transport: 'ws', reason: 'replaced' })
    vi.advanceTimersByTime(60_000)
    expect(FakeWS.all).toHaveLength(1)
  })

  it('25 秒ごとに ping を送り、10 秒返事がなければつなぎ直す', () => {
    const { link, ws } = live() // ここまでで、開いてから 1.5 秒
    vi.advanceTimersByTime(23_500 + 5000)
    expect(ws.sent).toContain('ping')
    expect(link.state().status).toBe('live')
    ws.onSend = null // 返事が来なくなった
    vi.advanceTimersByTime(20_000 + 9_999) // 50 秒めの ping から 10 秒待つ
    expect(link.state().status).toBe('live')
    vi.advanceTimersByTime(1)
    expect(link.state().status).toBe('retrying')
  })

  it('画面に戻ってきたら、たまった古い分を捨ててつなぎ直し、生きていない ws は 3 秒で見切る', () => {
    const handlers: (() => void)[] = []
    const doc = { visibilityState: 'visible', addEventListener: (_: string, fn: () => void) => handlers.push(fn), removeEventListener: () => {} }
    vi.stubGlobal('document', doc)
    const { link, ws, got } = live()
    ws.push(notice(1, serverNow() + 700))
    vi.setSystemTime(Date.now() + 60_000) // 裏にいる間、タイマーは動かなかった
    handlers.forEach((fn) => fn())
    expect(got).toHaveLength(0)
    expect(FakeWS.all).toHaveLength(2) // 待たずに、すぐつなぎ直す
    expect(last(FakeWS.all).url).not.toContain('after=')
    const ws2 = last(FakeWS.all).serve()
    vi.advanceTimersByTime(1500)
    expect(link.state().status).toBe('live')
    ws2.onSend = null // 眠っている間に、黙って切れていた
    handlers.forEach((fn) => fn())
    vi.advanceTimersByTime(2999)
    expect(link.state().status).toBe('live')
    vi.advanceTimersByTime(1)
    expect(link.state().status).toBe('retrying')
  })

  it('close したら、もう何もしない', () => {
    const { link, ws, got } = live()
    ws.push(notice(1, serverNow() + 700))
    link.close()
    vi.advanceTimersByTime(300_000)
    expect(got).toHaveLength(0)
    expect(link.state().status).toBe('closed')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('操作を送る', () => {
  it('つながっていない間の操作は 10 通まで取っておき、つながったら送る', () => {
    const { link, ws } = live({ role: 'player', idx: 1 })
    link.send({ type: 'entry' })
    expect(ws.cmds()).toEqual([{ type: 'entry' }])
    ws.fail()
    link.send({ type: 'questProgress', score: 5 }) // 途中経過は取っておかない
    link.send({ type: 'questScore', score: 12 })
    link.send({ type: 'questScore', score: 12 }) // 同じ操作は 1 回分
    link.send({ type: 'choice', kind: 'receive' })
    vi.advanceTimersByTime(500)
    const next = last(FakeWS.all).serve()
    vi.advanceTimersByTime(100)
    expect(next.cmds()).toEqual([
      { type: 'questScore', score: 12 },
      { type: 'choice', kind: 'receive' },
    ])
    next.fail()
    for (let i = 0; i < 15; i++) link.send({ type: 'questScore', score: i })
    vi.advanceTimersByTime(1000) // すぐ切れたあとなので、待ち時間は倍
    const third = last(FakeWS.all).serve()
    vi.advanceTimersByTime(100)
    expect(third.cmds()).toHaveLength(10)
    expect(last(third.cmds())).toEqual({ type: 'questScore', score: 14 })
  })

  it('主催の操作は、切れて 5 秒より後には送らない', () => {
    const { link, ws } = live({ role: 'host' })
    ws.fail()
    link.send({ type: 'next' })
    vi.advanceTimersByTime(500)
    last(FakeWS.all).fail()
    vi.advanceTimersByTime(1000)
    last(FakeWS.all).fail()
    vi.advanceTimersByTime(2000)
    last(FakeWS.all).fail()
    link.send({ type: 'auto', on: true })
    vi.advanceTimersByTime(4000)
    const ws2 = last(FakeWS.all).serve()
    vi.advanceTimersByTime(100)
    expect(ws2.cmds()).toEqual([{ type: 'auto', on: true }])
  })
})

describe('ws が通らないとき', () => {
  it('2 回続けてだめなら sse、それも 2 回だめなら poll', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      return json(url.endsWith('/time') ? { now: serverNow() } : { now: serverNow(), frames: [] })
    })
    const link = connect({ api: API, code: 'ABC234', role: 'stage' })
    const kinds: string[] = []
    link.onState((s) => kinds.push(`${s.status}:${s.transport}`))
    FakeWS.all[0].fail()
    await vi.advanceTimersByTimeAsync(500)
    FakeWS.all[1].fail()
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWS.all).toHaveLength(2)
    expect(FakeES.all).toHaveLength(1)
    FakeES.all[0].onerror?.()
    await vi.advanceTimersByTimeAsync(2000)
    FakeES.all[1].onerror?.()
    await vi.advanceTimersByTimeAsync(4000)
    expect(calls.some((u) => u.startsWith(`${API}/g/ABC234/poll?role=stage`))).toBe(true)
    expect(kinds).toEqual(['connecting:ws', 'connecting:sse', 'connecting:poll', 'live:poll'])
  })

  it('sse: 流れてきた分を時刻どおりに渡し、操作は POST でまとめて送る', async () => {
    const posts: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) })
      return json({ now: serverNow() })
    })
    const link = connect({ api: API, code: 'ABC234', role: 'player', idx: 4, token: 'tok', transport: 'sse' })
    const got: Msg[] = []
    link.hub.subscribe((m) => got.push(m))
    await vi.advanceTimersByTimeAsync(1000)
    const es = FakeES.all[0]
    expect(es.url).toBe(`${API}/g/ABC234/sse?role=player&idx=4&token=tok`)
    es.onmessage?.({ data: JSON.stringify(notice(1, serverNow() + 700)) })
    expect(link.state().status).toBe('live')
    await vi.advanceTimersByTimeAsync(699)
    expect(got).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(got).toHaveLength(1)
    link.send({ type: 'questScore', score: 3 })
    link.send({ type: 'entry' })
    await vi.advanceTimersByTimeAsync(100)
    expect(posts).toEqual([{ url: `${API}/g/ABC234/cmd?role=player&idx=4&token=tok`, body: { cmds: [{ type: 'questScore', score: 3 }, { type: 'entry' }] } }])
    es.onerror?.() // 切れたら、自分で after を付けてつなぎ直す
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeES.all[1].url).toContain('after=1')
  })

  it('poll: 1.5 秒おきに続きをもらう。bye で止まる', async () => {
    const polls: string[] = []
    const replies: (() => object)[] = [
      () => ({ frames: [notice(1, serverNow() - 900), notice(2, serverNow() - 100)] }),
      () => ({ frames: [notice(2, serverNow() - 1600), notice(3, serverNow() - 50)] }),
      () => ({ frames: [], bye: 'closed' }),
    ]
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/time')) return json({ now: serverNow() })
      polls.push(url)
      return json({ now: serverNow(), ...replies.shift()?.() })
    })
    const link = connect({ api: API, code: 'ABC234', role: 'stage', transport: 'poll' })
    const got: Msg[] = []
    link.hub.subscribe((m) => got.push(m))
    await vi.advanceTimersByTimeAsync(10)
    expect(link.state().status).toBe('live')
    expect(texts(got)).toEqual(['n1', 'n2'])
    await vi.advanceTimersByTimeAsync(1500)
    expect(texts(got)).toEqual(['n1', 'n2', 'n3'])
    await vi.advanceTimersByTimeAsync(1500)
    expect(polls.map((u) => new URL(u).searchParams.get('after'))).toEqual([null, '2', '3'])
    expect(link.state()).toEqual({ status: 'closed', transport: 'poll', reason: 'closed' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(polls).toHaveLength(3)
  })

  it('poll で通じたあと、ws を試して、通じたら乗りかえる', async () => {
    vi.stubGlobal('fetch', async () => json({ now: serverNow(), frames: [] }))
    vi.stubGlobal('EventSource', undefined)
    const link = connect({ api: API, code: 'ABC234', role: 'stage' })
    FakeWS.all[0].fail()
    await vi.advanceTimersByTimeAsync(500)
    FakeWS.all[1].fail()
    await vi.advanceTimersByTimeAsync(1000)
    expect(link.state()).toEqual({ status: 'live', transport: 'poll' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWS.all).toHaveLength(3)
    FakeWS.all[2].serve()
    await vi.advanceTimersByTimeAsync(100)
    expect(link.state()).toEqual({ status: 'live', transport: 'ws' })
  })
})

describe('HTTP', () => {
  it('apiBase: ビルドのときに決めていなければ /api', () => {
    expect(apiBase()).toBe('/api')
  })

  it('createApi: ゲームがなければ null。断られたら、返ってきた文をそのまま投げる', async () => {
    const seen: [string, string][] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push([init?.method ?? 'GET', url])
      if (url.endsWith('/state')) return json({ error: 'このゲームは見つかりません' }, 404)
      if (url.endsWith('/join')) return json({ error: 'もう参加をしめきりました' }, 409)
      return json({ idx: 0 })
    })
    const api = createApi('/api/')
    expect(await api.state('ABC234')).toBeNull()
    const err = await api.join('ABC234', { name: 'あ' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ message: 'もう参加をしめきりました', status: 409 })
    await api.results('ABC234', 'a.b')
    expect(seen).toEqual([
      ['GET', '/api/g/ABC234/state'],
      ['POST', '/api/g/ABC234/join'],
      ['GET', '/api/g/ABC234/results?role=host&token=a.b'],
    ])
  })
})

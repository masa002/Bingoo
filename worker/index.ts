import { CREW_SHARD, MAX_PLAYERS, cleanSettings, shardOf, type CreateReq, type JoinReq, type LoginReq } from '../src/net/wire'
import { cleanCode, newCode, readText, safeEqual, type AppEnv } from './auth'
import type { Fail, GameDO } from './game'

// Worker の入口。/api を、ゲームの進行役（GameDO）と接続の受け口（RoomDO）に振り分ける。
// 画面のファイル（dist/）は、Worker を通らずに配られる（wrangler.jsonc の assets）。URL の一覧は src/net/wire.ts

export { GameDO } from './game'
export { RoomDO } from './room'

// GitHub Pages に置いた画面からも使えるように、/api はどこからでも呼べるようにする（認証はトークンで、Cookie は使わない）
const CORS = { 'access-control-allow-origin': '*' }
const PREFLIGHT = { ...CORS, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }
// 本文の長さの上限。文字数で 512K まで（景品の名前を上限いっぱいに入れた設定でも、20 万文字ほど）。
// 読む前に断るための上限はバイト数で、日本語は 1 文字 3 バイトなので、その分ゆとりを持たせる
const BODY_MAX = 512 * 1024
const BODY_MAX_BYTES = 2 * 1024 * 1024

function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache } })
}

function fail(status: number, error: string): Response {
  return json({ error }, status)
}

function isFail(x: object): x is Fail {
  return 'error' in x && 'status' in x
}

const NOT_FOUND = 'このゲームは見つかりません'
const NO_PAGE = 'このページはありません'

// 日本寄りに置く希望を出す（場所は固定できない。最初に作られるときにだけ効く）
function gameOf(env: AppEnv, code: string): DurableObjectStub<GameDO> {
  return env.GAME.get(env.GAME.idFromName(code), { locationHint: 'apac' })
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  // 大きすぎる本文は、読む前（content-length）か、読んでいる途中で断る（全部をメモリに読みこまない）
  const text = await readText(request, BODY_MAX_BYTES)
  if (text === null || text.length > BODY_MAX) return null
  try {
    const body: unknown = JSON.parse(text)
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const UNREADABLE = '送られた内容を読めませんでした'

async function createGame(request: Request, env: AppEnv): Promise<Response> {
  const body = (await readBody(request)) as Partial<CreateReq> | null
  if (!body) return fail(400, UNREADABLE)
  if (!env.ADMIN_KEY) {
    // 管理キーを入れ忘れたまま公開して、だれでもゲームを作れる状態にならないように。手元（DEV=1）だけは、なくても通す
    if (env.DEV !== '1') return fail(503, '管理キーが設定されていません')
  } else if (typeof body.adminKey !== 'string' || !(await safeEqual(body.adminKey, env.ADMIN_KEY))) {
    return fail(401, '管理キーが違います')
  }
  const settings = cleanSettings(body.settings)
  if (!settings) return fail(400, '景品の数が正しくありません')
  // もうあるコードに当たったら、別のコードで作り直す
  for (let tries = 0; tries < 5; tries++) {
    const code = newCode()
    const res = await gameOf(env, code).create(code, settings)
    if (res) return json(res)
  }
  return fail(500, 'ゲームを作れませんでした。もう一度ためしてください')
}

// だれでも見られる今の状態。参加の画面を開いた全員が聞きに来るので、1 秒だけ Cache に置く
async function publicState(request: Request, env: AppEnv, ctx: ExecutionContext, code: string): Promise<Response> {
  const key = new Request(new URL(`/api/g/${code}/state`, request.url).href)
  try {
    const hit = await caches.default.match(key)
    if (hit) return hit
  } catch {}
  const state = await gameOf(env, code).publicState()
  if (!state) return fail(404, NOT_FOUND)
  const res = json(state, 200, 'public, max-age=1')
  try {
    ctx.waitUntil(caches.default.put(key, res.clone()).catch(() => {}))
  } catch {}
  return res
}

// 接続（ws・sse・poll・cmd）は、役割と番号から受け口を決めて、そのまま渡す。トークンは受け口が確かめる
function toRoom(request: Request, env: AppEnv, code: string, url: URL): Promise<Response> | Response {
  const role = url.searchParams.get('role')
  let shard: string
  if (role === 'player') {
    const n = url.searchParams.get('idx') ?? ''
    if (!/^\d{1,6}$/.test(n) || Number(n) >= MAX_PLAYERS) return fail(400, 'つなぎ方が正しくありません')
    shard = shardOf(Number(n))
  } else if (role === 'stage' || role === 'host') {
    shard = CREW_SHARD
  } else {
    return fail(400, 'つなぎ方が正しくありません')
  }
  const name = `${code}:${shard}`
  const req = new Request(request)
  // partyserver が受け口の名前を知るための予備（ふだんは Durable Object の ID から分かる）
  req.headers.set('x-partykit-room', name)
  return env.ROOM.get(env.ROOM.idFromName(name), { locationHint: 'apac' }).fetch(req)
}

async function api(request: Request, env: AppEnv, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname.split('/').filter(Boolean) // ['api', ...]
  const method = request.method
  if (path.length === 2 && path[1] === 'time' && method === 'GET') return json({ now: Date.now() })
  if (path.length === 2 && path[1] === 'games' && method === 'POST') return createGame(request, env)
  if (path[1] !== 'g' || path.length < 4) return fail(404, NO_PAGE)

  const code = cleanCode(path[2])
  if (!code) return fail(404, NOT_FOUND)
  const what = path.slice(3).join('/')

  if (method === 'GET') {
    switch (what) {
      case 'state':
        return publicState(request, env, ctx, code)
      case 'ws':
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'つなぎ方が正しくありません')
        return toRoom(request, env, code, url)
      case 'sse':
      case 'poll':
        return toRoom(request, env, code, url)
      case 'results': {
        const res = await gameOf(env, code).results(url.searchParams.get('token') ?? '')
        if (!res) return fail(404, NOT_FOUND)
        return Array.isArray(res) ? json(res) : fail(res.status, res.error)
      }
    }
  } else if (method === 'POST') {
    switch (what) {
      case 'cmd':
        return toRoom(request, env, code, url)
      case 'join':
      case 'host/login': {
        const body = await readBody(request)
        if (!body) return fail(400, UNREADABLE)
        const game = gameOf(env, code)
        const res = what === 'join' ? await game.join(body as unknown as JoinReq) : await game.login(body as unknown as LoginReq)
        if (!res) return fail(404, NOT_FOUND)
        return isFail(res) ? fail(res.status, res.error) : json(res)
      }
    }
  }
  return fail(404, NO_PAGE)
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    // /api のほかは画面のファイル（ふだんは Worker を通らずに配られるので、ここには来ない）
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT })
    let res: Response
    try {
      res = await api(request, env, ctx, url)
    } catch (err) {
      console.error(`${request.method} ${url.pathname} failed`, err)
      res = fail(500, 'サーバーで問題が起きました。少し待って、もう一度ためしてください')
    }
    // WebSocket の応答は、そのまま返す（作り直すと、つながらなくなる）
    if (res.status === 101) return res
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v)
    return out
  },
} satisfies ExportedHandler<AppEnv>

import type { PrizeNames, Rarity } from '../core/prizes'
import { Rng } from '../core/rng'
import { personalBeats, type Tier } from '../core/show'
import type { Msg, Phase, PhoneCommand } from './protocol'

// 本番の通信の約束。サーバー（worker/）とブラウザ（src/net/remote.ts）の両方がこのファイルを使う。
// 画面に渡すメッセージの中身は protocol.ts の Msg のまま。ここで決めるのは、運び方だけ

// ---- 数字 -------------------------------------------------------------------

// サーバーは、メッセージに「この時刻に画面へ渡す」（at）を付けて、その LEAD_MS だけ前に送る。
// 端末はサーバーの時刻に合わせた時計で at まで待ってから画面へ渡すので、回線の遅れが LEAD_MS より短ければ、
// 全員の画面が同じ瞬間に動く（番号が出る瞬間も同じ）。遅れて届いた分は、届いてすぐ渡す
export const LEAD_MS = 700
// 接続の受け口（Room）1 つが受け持つ参加者の数。参加者の番号（idx）で決まる
export const SHARD_SIZE = 800
export const MAX_PLAYERS = 12000
export const NAME_MAX = 12 // 表示名の長さ（文字）
// モグラ撃退で 1 人が叩ける数の上限（10 秒で出るモグラは約 31 匹）。端末から届いた数は、この範囲に丸める
export const QUEST_MAX_SCORE = 40
// 受け口が、つなぎ直した端末のために覚えておくメッセージの数
export const RING_SIZE = 96
// つなぎ直したとき、見逃したメッセージがこの時間より新しければ続きから流す。古ければ、いまの状態（snapshot）を渡す。
// 端末は、3 秒より遅れた分を流さずに捨てる（remote.ts）。それより短くして、続きを流したのに捨てられる、をなくす
export const RESUME_MS = 2500

export type Role = 'player' | 'stage' | 'host'

// 参加者 idx の受け口の名前。大画面と主催は 'crew'
export function shardOf(idx: number): string {
  return `p${Math.floor(idx / SHARD_SIZE)}`
}
export const CREW_SHARD = 'crew'

// ---- サーバー → 端末 --------------------------------------------------------

// メッセージ 1 通。b が全員宛ての部分、p が本人宛ての部分。
// p があれば b に上書きする（いちばん上の項目ごと）。b がなければ、p がメッセージそのもの
export interface Frame {
  s: number // 通し番号（ゲームごとに 1 から）
  at: number // サーバーの時刻（ms）。この時刻に画面へ渡す
  b?: Msg
  p?: Record<string, unknown>
}

// 進行と関係のない知らせ
export type Control =
  | { t: 'pong'; c: number; now: number } // 時計合わせの返事。c は端末が送った値、now はサーバーの時刻
  | { t: 'bye'; reason: 'replaced' | 'closed' | 'auth' } // replaced: 同じ人が別の端末・タブでつないだ。closed: ゲームが片付けられた

export type Down = Frame | Control

// WebSocket の生存確認。受け口は眠ったまま 'pong' を返す（文字列そのまま。JSON ではない）
export const KEEPALIVE = { ping: 'ping', pong: 'pong' } as const

// ---- 端末 → サーバー --------------------------------------------------------

export type HostCommand =
  | { type: 'next' } // 「次へ」「スタート」「参加をしめきる」「締めくくりへ」
  | { type: 'auto'; on: boolean } // 自動進行
  | { type: 'trigger'; kind: 'wild' | 'mole' | null } // 次の「次へ」でイベントを起こす（null で取り消す）
  | { type: 'bots'; count: number } // リハーサル用の仮想の参加者を足す（受付中だけ）
  | { type: 'reset'; settings?: LiveSettings } // 最初からやり直す（参加者はそのまま。カードは配り直す）

export type Up =
  | { t: 'ping'; c: number } // 時計合わせ
  | { t: 'cmd'; cmd: PhoneCommand | HostCommand }

// ---- ゲームの設定 -----------------------------------------------------------

export interface LiveSettings {
  lower: number // 下位（C・R）の数
  upper: number // 上位（SR・UR）の数
  dc: number // ダブルチャンス用の数
  prizeNames?: PrizeNames // 実際の景品の名前（なければ見本の名前）
}

// 景品の数の範囲（画面の入力と、サーバーの検査で同じものを使う）
export const SETTINGS_LIMITS = { lower: [1, 1000], upper: [0, 200], dc: [0, 200], nameMax: 40 } as const

// 端末から届いた設定を確かめて、きれいにする。おかしければ null
export function cleanSettings(x: unknown): LiveSettings | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const out = { lower: 0, upper: 0, dc: 0 } as LiveSettings
  for (const key of ['lower', 'upper', 'dc'] as const) {
    const v = o[key]
    const [min, max] = SETTINGS_LIMITS[key]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return null
    out[key] = v
  }
  const names = o.prizeNames
  if (names && typeof names === 'object') {
    const clean: PrizeNames = {}
    for (const rank of ['C', 'R', 'SR', 'UR', 'DC'] as const) {
      const list = (names as Record<string, unknown>)[rank]
      if (!Array.isArray(list)) continue
      const items = list
        .filter((s): s is string => typeof s === 'string')
        .map((s) => [...s.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, SETTINGS_LIMITS.nameMax).join(''))
        .filter((s) => s !== '')
        .slice(0, 1000)
      if (items.length) clean[rank] = items
    }
    if (Object.keys(clean).length) out.prizeNames = clean
  }
  return out
}

// ---- HTTP -------------------------------------------------------------------
// どれも /api の下。:code はゲームのコード（英数字 6 文字）
//
// POST /api/games                 ゲームを作る（管理キーが要る）       CreateReq → CreateRes
// GET  /api/g/:code/state         だれでも見られる今の状態（1 秒キャッシュ） → PublicState
// POST /api/g/:code/join          参加する（つなぎ直しのときは idx と token を付ける） JoinReq → JoinRes
// POST /api/g/:code/host/login    主催のログイン                         LoginReq → LoginRes
// GET  /api/g/:code/ws            WebSocket（下の「つなぐときの問い合わせ」を付ける）
// GET  /api/g/:code/sse           WebSocket が通らないときの代わり（text/event-stream。data: に Down の JSON）
// GET  /api/g/:code/poll          それも通らないときの代わり → PollRes
// POST /api/g/:code/cmd           sse・poll の端末からのコマンド         { cmds: (PhoneCommand | HostCommand)[] }
// GET  /api/g/:code/results       当選者の一覧（主催だけ）               → ResultRow[]
// GET  /api/time                  → { now }（sse・poll の時計合わせ）
//
// つなぐときの問い合わせ（ws・sse・poll・cmd・results で同じ）:
//   role=player&idx=..&token=..   参加者（token は join でもらったもの）
//   role=stage                    大画面（だれでも見られる）
//   role=host&token=..            主催（token は host/login でもらったもの）
//   after=..                      最後に受け取った通し番号（初めてなら付けない）
// エラーは { error: string }（人に見せる日本語）と、4xx・5xx の状態コード

export interface CreateReq {
  adminKey: string
  settings: LiveSettings
  totp: boolean // 主催のログインに、認証アプリの 6 桁の数字も求める
}
export interface CreateRes {
  code: string
  hostKey: string // 主催キー（このときだけ表示する。なくしたら作り直し）
  totpUri: string | null // otpauth://…（認証アプリに登録する。totp が false なら null）
}

export interface PublicState {
  code: string
  phase: Phase
  players: number
  drawn: number[]
  canJoin: boolean
  totp: boolean // 主催のログインに、認証アプリの 6 桁も要る
}

export interface JoinReq {
  name: string
  idx?: number
  token?: string
}
export interface JoinRes {
  idx: number
  token: string
  name: string
}

export interface LoginReq {
  hostKey: string
  totp?: string
}
export interface LoginRes {
  token: string
  expiresAt: number // この時刻を過ぎたら、もう一度ログインする（つないでいる間は切れない）
}

export interface PollRes {
  now: number
  frames: Frame[]
  bye?: 'closed' | 'auth'
}

export interface ResultRow {
  name: string
  rarity: Rarity | null
  prize: string
  how: 'bingo' | 'challenge' | 'double-chance'
  bot: boolean
}

// ---- 本人宛ての部分を、画面のメッセージに戻す ------------------------------

// drawScheduled の本人宛ては、拍の列そのものではなく、拍を作る種（k）で送る（1 万人に配るので小さくする）
export interface PersonalDraw {
  tier: Tier
  waiting: string[]
  k: number
}

// フレームを、画面に渡すメッセージにする。me は自分の参加者の番号（大画面・主催は -1）
export function inflate(frame: Frame, me: number): Msg {
  const msg = { ...(frame.b ?? {}), ...(frame.p ?? {}) } as Msg
  if (msg.type === 'drawScheduled') {
    const p = msg.personal as unknown as PersonalDraw | { tier: Tier; waiting: string[]; beats: [] }
    if ('k' in p) msg.personal = { tier: p.tier, waiting: p.waiting, beats: personalBeats(p.tier, msg.revealAt, new Rng(`beat/${p.k}`)) }
  }
  // 名前の一覧に、自分かどうかを付ける
  for (const value of Object.values(msg)) {
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (item && typeof item === 'object' && 'idx' in item) (item as { isMe: boolean }).isMe = (item as { idx: number }).idx === me
    }
  }
  if (msg.type === 'lastOneBrief') msg.meIn = msg.entrants.some((e) => e.isMe)
  return msg
}

// ---- Game → Room（サーバーの中） -------------------------------------------

// Game が Room に渡す 1 通。b と p は、もう JSON の文字列にしてある（Room は文字列をつなぐだけで送れる）
export interface Delivery {
  s: number
  at: number
  to: 'all' | 'players' | 'crew' | 'host' // all: 参加者と大画面と主催。crew: 大画面と主催
  b: string | null
  p: Record<number, string> | null // 参加者の番号 → 本人宛ての JSON（その Room が受け持つ人の分だけ）
}

// Delivery から、端末に送る文字列（Frame の JSON）を作る
export function frameText(d: Delivery, idx: number | null): string | null {
  const p = idx === null ? undefined : d.p?.[idx]
  if (d.b === null && p === undefined) return null
  return `{"s":${d.s},"at":${d.at}${d.b === null ? '' : `,"b":${d.b}`}${p === undefined ? '' : `,"p":${p}`}}`
}

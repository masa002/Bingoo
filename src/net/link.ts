import type { Clock } from '../demo/clock'
import type { LocalHub } from './hub'
import type { PhoneCommand } from './protocol'
import type { CreateReq, CreateRes, HostCommand, JoinReq, JoinRes, LoginReq, LoginRes, PublicState, ResultRow, Role } from './wire'

// 本番のサーバーとつなぐ口。画面（src/live/）はこの型だけを見る。中身は remote.ts

export type Transport = 'ws' | 'sse' | 'poll'

// connecting: 最初につないでいる。live: つながっている。retrying: 切れたので、つなぎ直している。
// closed: もうつながない（ゲームが片付けられた・別の端末でつないだ・認証が切れた）
export type LinkStatus = 'connecting' | 'live' | 'retrying' | 'closed'

export interface LinkState {
  status: LinkStatus
  transport: Transport
  reason?: 'replaced' | 'closed' | 'auth' // status が closed のときの理由
}

export interface LinkOptions {
  api: string // API の場所（'/api' か 'https://…/api'）
  code: string
  role: Role
  idx?: number // 参加者のとき
  token?: string // 参加者・主催のとき
  transport?: Transport // 試験用: この方式だけを使う
}

export interface Link {
  // サーバーからのメッセージは、決められた時刻（Frame.at）に、ここへ流れる。画面はデモと同じように subscribe するだけ
  readonly hub: LocalHub
  // 速度 1 の時計（画面の部品がデモと同じ形で受け取る）
  readonly clock: Clock
  send(cmd: PhoneCommand | HostCommand): void
  state(): LinkState
  // 状態が変わるたびに呼ぶ（登録したときにも、いまの状態で 1 回呼ぶ）。戻り値で登録を外す
  onState(fn: (s: LinkState) => void): () => void
  close(): void
}

// HTTP の口。失敗したら ApiError を投げる（message は、人に見せる日本語）
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export interface Api {
  create(req: CreateReq): Promise<CreateRes>
  state(code: string): Promise<PublicState | null> // ゲームがなければ null
  join(code: string, req: JoinReq): Promise<JoinRes>
  login(code: string, req: LoginReq): Promise<LoginRes>
  results(code: string, hostToken: string): Promise<ResultRow[]>
}

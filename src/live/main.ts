import { ApiError } from '../net/link'
import { h } from '../ui/dom'
import './live.css'

// 本番（サーバーにつなぐ）の入口。URL の問い合わせで画面を振り分ける。
//   ?g=CODE              参加者のスマホ
//   ?g=CODE&view=stage   会場の大画面
//   ?g=CODE&view=host    主催コンソール
//   ?host                ゲームを作る
// 画面ごとに分けて読み込む（参加者のスマホに、主催の画面や QR の部品を配らない）

export function mountLive(app: HTMLElement, params: URLSearchParams): void {
  const view = params.get('view')
  // 本番の画面は、どれも画面いっぱいに自分で敷く。後ろのページが動かないようにする（live.css の html.lv-on）
  document.documentElement.classList.add('lv-on')
  // 画面ごとに、読み込みを別々の関数にしておく。1 つの if 〜 else に並べると、ビルドのときに 1 つの式にまとめられて、
  // 「先に読み込む CSS」の一覧が最初の 1 つの分だけになる（主催コンソールの CSS が読み込まれなかった）
  const screens = {
    create: () => import('./host').then((m) => m.mountCreate(app, params)),
    host: () => import('./host').then((m) => m.mountHost(app, params)),
    stage: () => import('./stage').then((m) => m.mountStage(app, params)),
    player: () => import('./player').then((m) => m.mountPlayer(app, params)),
  }
  const open = !params.has('g') ? screens.create : view === 'host' ? screens.host : view === 'stage' ? screens.stage : screens.player
  // 読み込みの途中で電波が切れたとき。何も出ないままにしない
  open().catch((e) => {
    console.error(e)
    page(app, { title: '読み込めませんでした', text: '電波のいい場所で、もう一度ためしてね', button: 'もう一度', onButton: () => location.reload() })
  })
}

// ---- 参加者の画面と大画面で使う、共通の道具 ---------------------------------

export const NOT_FOUND = 'このゲームは見つかりません'

// ゲームのコード。前後の空白だけ取る（大文字・小文字は、サーバーの決まりにまかせる）
export function codeOf(params: URLSearchParams): string {
  return (params.get('g') ?? '').trim()
}

// 人に見せる失敗の理由。サーバーが返した文（ApiError）は、そのまま見せる。それ以外は、つながらなかった
export function reasonOf(e: unknown): string {
  return e instanceof ApiError && e.message ? e.message : 'つながりません。少し待って、もう一度ためしてね'
}

export interface MessageOptions {
  title: string
  text?: string
  button?: string
  onButton?: () => void
  busy?: boolean // 待っている間（ゆっくり明滅させる）
}

// ひと言の画面（つないでいます・見つかりません・終わりました など）の中身。
// 文は textContent で入れる（サーバーが返した文が混ざっても、HTML として解釈しない）
function messageBox(className: string, o: MessageOptions): HTMLElement {
  const root = h('div', className, `<div class="lv-box"><div class="lv-logo">BINGOO</div><p class="lv-title"></p></div>`)
  const box = root.firstElementChild as HTMLElement
  const title = box.querySelector<HTMLElement>('.lv-title')!
  title.textContent = o.title
  title.classList.toggle('lv-busy', o.busy === true)
  if (o.text) {
    const text = h('p', 'lv-text')
    text.textContent = o.text
    box.append(text)
  }
  if (o.button) {
    const button = h('button', 'lv-primary')
    button.type = 'button'
    button.textContent = o.button
    button.addEventListener('click', () => o.onButton?.())
    box.append(button)
  }
  return root
}

// 画面をまるごと、ひと言の画面に差し替える
export function page(app: HTMLElement, o: MessageOptions): void {
  app.replaceChildren(messageBox('lv lv-page', o))
}

// いまの画面の上に、ひと言の画面を重ねる（下の画面は触れなくなる）。戻り値を remove() すれば消える
export function sheet(parent: HTMLElement, o: MessageOptions): HTMLElement {
  const root = messageBox('lv lv-page lv-sheet', o)
  parent.append(root)
  return root
}

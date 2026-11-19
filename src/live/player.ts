import { ApiError } from '../net/link'
import { apiBase, connect, createApi } from '../net/remote'
import { NAME_MAX, type JoinRes, type PublicState } from '../net/wire'
import { h, q } from '../ui/dom'
import { PhoneView } from '../ui/phone'
import { NOT_FOUND, codeOf, page, reasonOf, sheet } from './main'

// 本番の参加者のスマホ（?g=CODE）。名前を入れて参加 → サーバーにつないで、デモと同じスマホの画面（PhoneView）を画面いっぱいに出す。
// 参加の控え（番号とトークン）はスマホに残すので、読み込み直しても、同じ人・同じカードで戻れる

interface Saved {
  idx: number
  token: string
  name: string
}

const keyOf = (code: string) => `bingoo:${code}`

function load(code: string): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(keyOf(code)) ?? 'null') as Partial<Saved> | null
    return v && typeof v.idx === 'number' && typeof v.token === 'string' && typeof v.name === 'string' ? { idx: v.idx, token: v.token, name: v.name } : null
  } catch {
    return null // プライベートブラウズなどで使えないときは、控えなしで動く（読み込み直すと、入り直しになる）
  }
}

function save(code: string, value: Saved | null): void {
  try {
    if (value) localStorage.setItem(keyOf(code), JSON.stringify(value))
    else localStorage.removeItem(keyOf(code))
  } catch {
    // 置けなくても、画面は動く
  }
}

export function mountPlayer(app: HTMLElement, params: URLSearchParams): void {
  const code = codeOf(params)
  const base = apiBase()
  const api = createApi(base)
  document.title = 'Bingoo'
  // 音は、最初は出さない（会場で 1,000 台が鳴ると、大画面の音が聞こえなくなる）。本人が右上のボタンで入れたときだけ鳴る（ui/phone.ts）
  void open()

  async function open(): Promise<void> {
    page(app, { title: 'つないでいます…', busy: true })
    const retry = (e: unknown) => page(app, { title: reasonOf(e), button: 'もう一度', onButton: () => void open() })
    let state: PublicState | null
    try {
      state = code ? await api.state(code) : null
    } catch (e) {
      return retry(e)
    }
    if (!state) return page(app, { title: NOT_FOUND, text: '会場の QR コードを、もう一度読み取ってみてね' })
    // 前に参加したスマホは、名前を聞かずに同じ人として戻る
    const saved = load(code)
    let refused = ''
    if (saved) {
      try {
        return play(await api.join(code, saved))
      } catch (e) {
        // 断られた（4xx）ときは、理由を見せて名前から入り直してもらう。つながらなかっただけなら、控えはそのままで、もう一度
        if (!(e instanceof ApiError) || e.status < 400 || e.status >= 500) return retry(e)
        refused = e.message
      }
    }
    if (!state.canJoin) return page(app, { title: refused || 'このゲームは、もう参加を締め切りました' })
    askName(saved?.name ?? '', refused)
  }

  function askName(name: string, error: string): void {
    const root = h(
      'div',
      'lv lv-page',
      `<form class="lv-box lv-form" novalidate>
        <div class="lv-logo">BINGOO</div>
        <p class="lv-title">ビンゴ大会に参加しよう！</p>
        <label class="lv-label" for="lv-name">あなたの名前</label>
        <input id="lv-name" class="lv-input" type="text" maxlength="${NAME_MAX}" autocomplete="nickname" autocapitalize="off" enterkeyhint="go" placeholder="ニックネームでも OK">
        <small class="lv-hint">この名前が、会場の画面に出ます（${NAME_MAX} 文字まで）</small>
        <p class="lv-error" role="alert"></p>
        <button class="lv-primary" type="submit">参加する</button>
      </form>`,
    )
    app.replaceChildren(root)
    const input = q<HTMLInputElement>(root, '.lv-input')
    const button = q<HTMLButtonElement>(root, '.lv-primary')
    const note = q(root, '.lv-error')
    input.value = name
    note.textContent = error
    q<HTMLFormElement>(root, 'form').addEventListener('submit', (e) => {
      e.preventDefault()
      if (button.disabled) return
      const value = input.value.trim()
      if (!value) {
        note.textContent = '名前を入れてね'
        input.focus()
        return
      }
      note.textContent = ''
      button.disabled = true
      button.textContent = '参加しています…'
      api.join(code, { name: value }).then(play, (err) => {
        // 断られたら、返ってきた文をそのまま見せる（満員・締め切り・使えない名前など）
        note.textContent = reasonOf(err)
        button.disabled = false
        button.textContent = '参加する'
      })
    })
  }

  function play(me: JoinRes): void {
    save(code, { idx: me.idx, token: me.token, name: me.name })
    const root = h('div', 'lv lv-player', '<div class="lv-phone"></div><div class="lv-bar" role="status"></div>')
    app.replaceChildren(root)
    const link = connect({ api: base, code, role: 'player', idx: me.idx, token: me.token })
    new PhoneView(q(root, '.lv-phone'), link.hub, link.clock, (cmd) => link.send(cmd), { live: true })

    // 最初の状態が届くまでは、空のカードを見せない
    const cover = sheet(root, { title: 'つないでいます…', busy: true })
    let shown = false
    const off = link.hub.subscribe((m) => {
      if (m.type !== 'snapshot') return
      shown = true
      cover.remove()
      off()
    })

    const bar = q(root, '.lv-bar')
    let stopped = false
    link.onState((s) => {
      if (stopped) return
      // ゲームが片付けられたあとも、受け取った景品は見えるままにする（帯で知らせるだけ）
      const ended = s.status === 'closed' && s.reason === 'closed'
      const text = s.status === 'retrying' ? 'つなぎ直しています…' : ended && shown ? 'ゲームは終わりました' : ''
      bar.textContent = text
      bar.classList.toggle('on', text !== '')
      if (s.status !== 'closed' || (ended && shown)) return
      // もうつながらない。次にできることを 1 つだけ出す
      stopped = true
      cover.remove()
      if (ended) {
        // カードを 1 度も出せないまま、片付けられていた
        sheet(root, { title: 'ゲームは終わりました' })
      } else if (s.reason === 'replaced') {
        sheet(root, {
          title: 'ほかの画面で開いています',
          text: '別のタブか、別のスマホで開いたので、こちらは止まりました',
          button: 'この画面で続ける',
          onButton: () => location.reload(),
        })
      } else {
        sheet(root, {
          title: 'もう一度、参加してください',
          button: '参加する',
          onButton: () => {
            save(code, null)
            location.reload()
          },
        })
      }
    })

    keepAwake()
  }
}

// ゲームの間、画面が消えないようにする（使えない端末では何もしない）。画面を離れると外れるので、戻ったら頼み直す
function keepAwake(): void {
  if (!('wakeLock' in navigator)) return
  const ask = () => {
    if (document.visibilityState === 'visible') navigator.wakeLock.request('screen').catch(() => {})
  }
  ask()
  document.addEventListener('visibilitychange', ask)
}

import qrcode from 'qrcode-generator'
import { engine } from '../audio'
import { apiBase, connect, createApi } from '../net/remote'
import type { PublicState } from '../net/wire'
import { esc, h, q } from '../ui/dom'
import { StageView } from '../ui/stage'
import { NOT_FOUND, codeOf, page, reasonOf, sheet } from './main'

// 本番の会場の大画面（?g=CODE&view=stage）。サーバーにつないで、デモと同じ大画面（StageView）を画面いっぱいに出す。
// 受付の間は、参加用の QR を出す。音（BGM と効果音）は、この画面から鳴らす

export function mountStage(app: HTMLElement, params: URLSearchParams): void {
  const code = codeOf(params)
  const base = apiBase()
  const api = createApi(base)
  document.title = `Bingoo 大画面 ${code}`

  // 音はブラウザの決まりで、最初の操作のあとでないと鳴らせない。先に 1 回クリックしてもらってから、つなぐ
  const gate = h(
    'div',
    'lv lv-page lv-gate',
    `<div class="lv-box">
      <div class="lv-logo">BINGOO</div>
      <p class="lv-title">会場の大画面</p>
      <button class="lv-primary" type="button" data-a="start">クリックして始める</button>
      <button class="lv-second" type="button" data-a="full">全画面にして始める</button>
      <small class="lv-hint">音は、この画面から出ます。あとから F キーでも、全画面に切りかえられます</small>
    </div>`,
  )
  app.replaceChildren(gate)
  q(gate, '[data-a="start"]').addEventListener('click', () => void start())
  q(gate, '[data-a="full"]').addEventListener('click', () => {
    fullscreen(true)
    void start()
  })
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) fullscreen(!document.fullscreenElement)
  })

  async function start(): Promise<void> {
    engine.unlock()
    page(app, { title: 'つないでいます…', busy: true })
    let state: PublicState | null
    try {
      state = code ? await api.state(code) : null
    } catch (e) {
      return page(app, { title: reasonOf(e), button: 'もう一度', onButton: () => void start() })
    }
    if (!state) return page(app, { title: NOT_FOUND })

    const root = h('div', 'lv lv-stage', '<div class="lv-screen"></div><div class="lv-badge" role="status"></div>')
    app.replaceChildren(root)
    const link = connect({ api: base, code, role: 'stage' })
    // 参加者のデータは持たないので、「会場のようす」に渡す人はいない
    new StageView(q(root, '.lv-screen'), link.hub, link.clock, () => [], { live: { joinHtml: joinHtml(code) } })

    // 最初の状態が届くまでは、空の盤を見せない
    const cover = sheet(root, { title: 'つないでいます…', busy: true })
    let shown = false
    const off = link.hub.subscribe((m) => {
      if (m.type !== 'snapshot') return
      shown = true
      cover.remove()
      off()
    })

    // つながっていない間は、すみに小さく出す（演出のじゃまをしない）
    const badge = q(root, '.lv-badge')
    link.onState((s) => {
      let text = ''
      if (s.status === 'retrying') text = 'つなぎ直しています…'
      else if (s.status === 'closed') text = s.reason === 'closed' ? 'ゲームは終わりました' : 'つながりが切れました。読み込み直してください'
      // 盤を 1 度も出せないまま、もうつながらなくなったときは、真ん中に出す
      if (s.status === 'closed' && !shown) return page(app, { title: text })
      badge.textContent = text
      badge.classList.toggle('on', text !== '')
    })
  }
}

function fullscreen(on: boolean): void {
  // 全画面にできない環境（埋め込みなど）では、何もしない
  if (on) void document.documentElement.requestFullscreen?.().catch(() => {})
  else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
}

// 受付の画面に出す、参加の案内（QR・URL・コード）。StageView が、人数の左に並べる
function joinHtml(code: string): string {
  const url = `${location.origin}${location.pathname}?g=${encodeURIComponent(code)}`
  return `
    <div class="lv-qr">${qrSvg(url)}</div>
    <div class="lv-how">
      <p class="lv-how-lead">スマホのカメラで読み取って、参加してね</p>
      <div class="lv-how-url">${esc(url.replace(/^https?:\/\//, ''))}</div>
      <div class="lv-how-code"><span>コード</span><b>${esc(code)}</b></div>
    </div>`
}

// QR は、白地に黒で描く（濃紺の背景のままだと、読み取れないカメラがある）。まわりの余白は、決まりどおり 4 マス
function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const pad = 4
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`
  const size = n + pad * 2
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="参加用の QR コード" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

import qrcode from 'qrcode-generator'
import { PrizeStock, type PrizeNames, type Rarity } from '../core/prizes'
import type { Rng } from '../core/rng'
import { ApiError, type Api, type Link, type LinkState } from '../net/link'
import type { Msg, MsgOf, Phase, Totals } from '../net/protocol'
import { apiBase, connect, createApi } from '../net/remote'
import type { CreateRes, LiveSettings, ResultRow } from '../net/wire'
import { esc, fmt, h, q } from '../ui/dom'
import './host.css'

// 本番の主催の画面。「ゲームを作る」（?host）と「主催コンソール」（?g=CODE&view=host）。
// 主催コンソールは、当日の司会が緊張した状態で使う。いま何が起きていて、次に何を押せばいいかを、
// いちばん上の 1 行と 1 つのボタンで伝える。言葉は、デモの主催コンソール（src/ui/host.ts）に合わせてある

// ---- 共通の道具 -------------------------------------------------------------

const NET_ERROR = 'サーバーにつながりません。少し待って、もう一度ためしてください'

function say(e: unknown): string {
  return e instanceof ApiError && e.message ? e.message : NET_ERROR
}

// ログインのトークンは、タブを閉じたら消える場所に置く（共用の PC に残さない）
const tokenKey = (code: string) => `bingoo:host:${code}`
function load<T>(store: () => Storage, key: string): T | null {
  try {
    const text = store().getItem(key)
    return text ? (JSON.parse(text) as T) : null
  } catch {
    return null // プライベートブラウズなどで使えないときは、控えなしで動く
  }
}

function save(store: () => Storage, key: string, value: unknown): void {
  try {
    if (value === null) store().removeItem(key)
    else store().setItem(key, JSON.stringify(value))
  } catch {
    // 置けなくても、画面は動く
  }
}

const session = () => sessionStorage

// 3 つの画面の URL
function urlsOf(code: string): { join: string; stage: string; host: string } {
  const base = `${location.origin}${location.pathname}?g=${encodeURIComponent(code)}`
  return { join: base, stage: `${base}&view=stage`, host: `${base}&view=host` }
}

// QR は、白地に黒で描く（濃紺の背景のままだと、読み取れないカメラがある）。まわりの余白は 4 マス
function qrSvg(text: string, label: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const pad = 4
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`
  const size = n + pad * 2
  return `<svg class="lh-qr" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // http（暗号化なし）で開いているときなどは、古いやり方で試す
    const ta = h('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.append(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}

// data-copy の付いたボタンを、コピーのボタンにする。押せたことが分かるように、少しの間だけ言葉を変える
function bindCopy(root: HTMLElement): void {
  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]')
    if (!btn) return
    void copyText(btn.dataset.copy ?? '').then((ok) => {
      btn.textContent = ok ? 'コピーしました' : 'コピーできませんでした'
      btn.classList.toggle('done', ok)
      setTimeout(() => {
        btn.textContent = 'コピー'
        btn.classList.remove('done')
      }, 1600)
    })
  })
  // URL の欄は、押したら全部選ぶ（コピーのボタンが効かない環境でも、手で写せるように）
  root.addEventListener('focusin', (e) => {
    const input = e.target as HTMLElement
    if (input instanceof HTMLInputElement && input.readOnly) input.select()
  })
}

function urlRow(label: string, url: string, open: string | null): string {
  return `<div class="lh-url">
    <span>${label}</span>
    <input readonly value="${esc(url)}" aria-label="${esc(label)}" />
    <button type="button" class="lh-btn" data-copy="${esc(url)}">コピー</button>
    ${open ? `<a class="lh-btn" href="${esc(url)}" target="_blank" rel="noopener">${open}</a>` : ''}
  </div>`
}

// ---- 景品の数 ---------------------------------------------------------------
// 呼び方は大画面に合わせる（「景品」「上位景品」）。「下位」は、お客さんの前では使わない言葉なので出さない

type CountKey = 'lower' | 'upper' | 'dc'

const COUNTS: readonly { k: CountKey; label: string; note: string; presets: number[]; min: number; max: number; init: number }[] = [
  { k: 'lower', label: '景品', note: 'ビンゴした人が、1 つずつもらえます', presets: [5, 10, 30, 50], min: 1, max: 1000, init: 30 },
  { k: 'upper', label: '上位景品', note: '上位チャレンジに成功した人がもらえます。残ったら、ダブルチャンスに回ります', presets: [3, 5, 8, 10], min: 0, max: 200, init: 8 },
  { k: 'dc', label: 'ダブルチャンスの景品', note: '最後のガラポンで当たった人がもらえます', presets: [3, 5, 10], min: 0, max: 200, init: 5 },
]

function countsHtml(values: Partial<Record<CountKey, number>>): string {
  return COUNTS.map(
    (c) => `<div class="lh-count" data-k="${c.k}">
      <label>${c.label}<span class="lh-num"><input type="number" inputmode="numeric" min="${c.min}" max="${c.max}" value="${values[c.k] ?? c.init}" /> 個</span></label>
      <div class="lh-chips">${c.presets.map((v) => `<button type="button" data-v="${v}">${v}</button>`).join('')}</div>
      <small>${c.note}</small>
    </div>`,
  ).join('')
}

// 数字のボタンを押したら、その数を入れる。数が変わるたびに onChange を呼ぶ
function bindCounts(root: HTMLElement, onChange: () => void): void {
  const mark = () => {
    root.querySelectorAll<HTMLElement>('.lh-count').forEach((row) => {
      const value = q<HTMLInputElement>(row, 'input').value
      row.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === value))
    })
    onChange()
  }
  root.querySelectorAll<HTMLElement>('.lh-count').forEach((row) => {
    const input = q<HTMLInputElement>(row, 'input')
    input.addEventListener('input', mark)
    row.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((b) =>
      b.addEventListener('click', () => {
        input.value = b.dataset.v ?? ''
        mark()
      }),
    )
  })
  mark()
}

function readCounts(root: HTMLElement): Record<CountKey, number> {
  const out = { lower: 0, upper: 0, dc: 0 }
  for (const c of COUNTS) {
    const n = Math.round(Number(q<HTMLInputElement>(root, `.lh-count[data-k="${c.k}"] input`).value))
    out[c.k] = Number.isFinite(n) ? Math.min(c.max, Math.max(c.min, n)) : c.init
  }
  return out
}

// ランクごとの数。分け方は core の PrizeStock が決めているので、同じ式をここに写さず、実際に作って数える
function rankCounts(lower: number, upper: number): Record<Rarity, number> {
  const stock = new PrizeStock(lower, upper, { shuffle: <T>(x: T[]) => x } as unknown as Rng)
  return { C: stock.left('C'), R: stock.left('R'), SR: stock.left('SR'), UR: stock.left('UR') }
}

// ---- ゲームを作る（?host） --------------------------------------------------

const NAME_ROWS: readonly { k: Rarity | 'DC'; label: string }[] = [
  { k: 'C', label: '景品 C' },
  { k: 'R', label: '景品 R' },
  { k: 'SR', label: '上位景品 SR' },
  { k: 'UR', label: '上位景品 UR' },
  { k: 'DC', label: 'ダブルチャンス' },
]

export function mountCreate(app: HTMLElement, _params: URLSearchParams): void {
  const api = createApi(apiBase())
  const root = h('div', 'lh')
  app.replaceChildren(root)
  document.title = 'Bingoo ゲームを作る'
  bindCopy(root)

  root.innerHTML = `
    <main class="lh-card">
      <p class="lh-brand">Bingoo</p>
      <h1>ゲームを作る</h1>
      <form class="lh-form" novalidate>
        <label class="lh-field"><span>管理キー</span>
          <input type="password" name="adminKey" autocomplete="off" spellcheck="false" />
        </label>
        <h2>景品の数</h2>
        <div class="lh-counts">${countsHtml({})}</div>
        <details class="lh-names">
          <summary>景品の名前を入れる<small>入れなければ、見本の名前で始まります</small></summary>
          <p class="lh-note">1 行に 1 個ずつ書いてください。数より少ないときは、上から順にくり返して使います。C → R → SR → UR の順に、いい景品です</p>
          ${NAME_ROWS.map((r) => `<label class="lh-field" data-rank="${r.k}"><span>${r.label}<i></i></span><textarea rows="3" placeholder="1 行に 1 個"></textarea></label>`).join('')}
        </details>
        <p class="lh-note">主催コンソールに入るときは、主催キーと、認証アプリ（Google Authenticator など）に出る 6 けたの数字の両方が要ります。作ったあとに、司会をする人のスマホで認証アプリに登録します</p>
        <p class="lh-error" role="alert" hidden></p>
        <button class="lh-primary" type="submit">ゲームを作る</button>
      </form>
    </main>`

  const form = q<HTMLFormElement>(root, '.lh-form')
  const error = q(root, '.lh-error')
  const submit = q<HTMLButtonElement>(root, '.lh-primary')
  const fail = (text: string) => {
    error.textContent = text
    error.hidden = !text
  }

  // 名前の欄の見出しに、そのランクが何個になるかを出す（名前をいくつ書けばいいかが分かる）
  bindCounts(form, () => {
    const c = readCounts(form)
    const ranks: Record<string, number> = { ...rankCounts(c.lower, c.upper), DC: c.dc }
    for (const r of NAME_ROWS) q(form, `[data-rank="${r.k}"] i`).textContent = `（${ranks[r.k]} 個）`
  })

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (submit.disabled) return
    const adminKey = q<HTMLInputElement>(form, '[name="adminKey"]').value.trim()
    if (!adminKey) {
      fail('管理キーを入れてください')
      q<HTMLInputElement>(form, '[name="adminKey"]').focus()
      return
    }
    const prizeNames: PrizeNames = {}
    for (const r of NAME_ROWS) {
      const lines = q<HTMLTextAreaElement>(form, `[data-rank="${r.k}"] textarea`)
        .value.split(/\r?\n/)
        .map((s) => s.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 1000)
      if (lines.length) prizeNames[r.k] = lines
    }
    const settings: LiveSettings = { ...readCounts(form), ...(Object.keys(prizeNames).length ? { prizeNames } : {}) }
    fail('')
    // 2 回押して、ゲームを 2 つ作らないように
    submit.disabled = true
    submit.textContent = '作っています…'
    api.create({ adminKey, settings }).then(
      (res) => {
        showCreated(root, res)
      },
      (err: unknown) => {
        submit.disabled = false
        submit.textContent = 'ゲームを作る'
        fail(say(err))
      },
    )
  })
}

function showCreated(root: HTMLElement, res: CreateRes): void {
  const urls = urlsOf(res.code)
  // 認証アプリに手で入れるための文字列（QR が読めないとき）
  const secret = /[?&]secret=([^&]+)/.exec(res.totpUri)?.[1] ?? ''
  root.innerHTML = `
    <main class="lh-card">
      <p class="lh-brand">Bingoo</p>
      <h1>ゲームができました</h1>
      <p class="lh-code">コード <b>${esc(res.code)}</b></p>
      <section class="lh-keybox">
        <h2>主催キー</h2>
        <div class="lh-secret"><code>${esc(res.hostKey)}</code><button type="button" class="lh-btn" data-copy="${esc(res.hostKey)}">コピー</button></div>
        <p class="lh-warn">主催キーが見られるのは、いまだけです。なくすと、ゲームを作り直すことになります。いま、控えてください</p>
      </section>
      <section class="lh-keybox">
        <h2>認証アプリに登録する</h2>
        <p class="lh-note">認証アプリ（Google Authenticator など）で、この QR を読み取ってください。主催コンソールに入るときに、アプリに出る 6 けたの数字が要ります</p>
        <div class="lh-totp">${qrSvg(res.totpUri, '認証アプリに登録する QR')}</div>
        ${secret ? `<p class="lh-note">読み取れないときは、この文字を入れてください</p><div class="lh-secret"><code>${esc(secret)}</code><button type="button" class="lh-btn" data-copy="${esc(secret)}">コピー</button></div>` : ''}
        <p class="lh-warn">この QR が見られるのも、いまだけです。司会をする人のスマホで、いま登録してください。もう 1 人の主催の人も、ここで一緒に登録しておくと安心です</p>
        <p class="lh-warn">主催キーと 6 けたの数字は、大画面に映したり、声に出したり、チャットに書いたりしないでください</p>
      </section>
      <h2>3 つの URL</h2>
      ${urlRow('参加用（みんなのスマホ）', urls.join, null)}
      ${urlRow('大画面用（会場のスクリーン）', urls.stage, null)}
      ${urlRow('主催用（主催コンソール）', urls.host, null)}
      <p class="lh-note">参加用の QR は、大画面と主催コンソールに出ます</p>
      <label class="lh-check lh-kept"><input type="checkbox" /> 主催キーを控えました</label>
      <button class="lh-primary" type="button" disabled>主催コンソールを開く ▶</button>
    </main>`
  root.scrollTop = 0

  // 控える前に閉じたら、主催キーは二度と出せない。チェックを付けるまでは、閉じる前に確かめる
  const kept = q<HTMLInputElement>(root, '.lh-kept input')
  const open = q<HTMLButtonElement>(root, '.lh-primary')
  const guard = (e: BeforeUnloadEvent) => e.preventDefault()
  window.addEventListener('beforeunload', guard)
  kept.addEventListener('change', () => {
    open.disabled = !kept.checked
    if (kept.checked) window.removeEventListener('beforeunload', guard)
    else window.addEventListener('beforeunload', guard)
  })
  open.addEventListener('click', () => {
    open.disabled = true
    // ログインの画面へ。認証アプリの 6 けたを入れてもらうことで、登録できたかも確かめられる
    location.assign(urls.host)
  })
}

// ---- 主催コンソール（?g=CODE&view=host） ------------------------------------

export function mountHost(app: HTMLElement, params: URLSearchParams): void {
  const code = (params.get('g') ?? '').trim()
  const api = createApi(apiBase())
  const root = h('div', 'lh')
  app.replaceChildren(root)
  document.title = `Bingoo 主催コンソール ${code}`
  bindCopy(root)

  // 主催コンソールに入れないときの知らせ。次にできることを 1 つだけ添える
  const message = (text: string, then: 'wait' | 'retry' | 'create') => {
    root.innerHTML = `
      <main class="lh-card lh-narrow">
        <p class="lh-brand">Bingoo</p>
        <h1>主催コンソール</h1>
        <p class="lh-lead">${esc(text)}</p>
        ${then === 'retry' ? '<button class="lh-primary" type="button">もう一度ためす</button>' : then === 'create' ? `<a class="lh-btn" href="${esc(location.pathname)}?host">新しいゲームを作る</a>` : ''}
      </main>`
    root.querySelector('.lh-primary')?.addEventListener('click', start)
  }

  let totp = false // 主催のログインに、認証アプリの 6 けたも要る（ゲームの状態から分かる）
  const login = (note: string) => showLogin(root, api, code, totp, note, enter)

  const enter = (token: string) => {
    const link = connect({ api: apiBase(), code, role: 'host', token })
    const view: HostConsole = new HostConsole(root, api, link, code, token, (why) => {
      view.destroy()
      link.close()
      if (why === 'auth') {
        save(session, tokenKey(code), null)
        login('もう一度ログインしてください')
      } else if (why === 'closed') message('このゲームは終わりました', 'create')
      else message('別の画面でつないだので、この画面は止めました', 'retry')
    })
  }

  function start(): void {
    if (!code) return message('このゲームは見つかりません', 'create')
    message('確かめています…', 'wait')
    api.state(code).then(
      (state) => {
        if (!state) return message('このゲームは見つかりません', 'create')
        totp = state.totp
        const saved = load<{ token: string; expiresAt: number }>(session, tokenKey(code))
        if (saved?.token && saved.expiresAt > Date.now()) enter(saved.token)
        else login('')
      },
      (err: unknown) => message(say(err), 'retry'),
    )
  }
  start()
}

function showLogin(root: HTMLElement, api: Api, code: string, totp: boolean, note: string, enter: (token: string) => void): void {
  root.innerHTML = `
    <main class="lh-card lh-narrow">
      <p class="lh-brand">Bingoo</p>
      <h1>主催コンソール</h1>
      <p class="lh-code">コード <b>${esc(code)}</b></p>
      <form class="lh-form" novalidate>
        ${note ? `<p class="lh-lead">${note}</p>` : ''}
        <label class="lh-field"><span>主催キー</span>
          <input type="password" name="hostKey" autocomplete="current-password" spellcheck="false" />
        </label>
        ${
          totp
            ? `<label class="lh-field"><span>認証アプリの 6 けたの数字</span>
          <input name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" />
        </label>`
            : ''
        }
        <p class="lh-error" role="alert" hidden></p>
        <button class="lh-primary" type="submit">ログイン</button>
      </form>
    </main>`
  const form = q<HTMLFormElement>(root, '.lh-form')
  const key = q<HTMLInputElement>(form, '[name="hostKey"]')
  const error = q(form, '.lh-error')
  const submit = q<HTMLButtonElement>(form, '.lh-primary')
  const fail = (text: string) => {
    error.textContent = text
    error.hidden = !text
  }
  key.focus()
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (submit.disabled) return
    const hostKey = key.value.trim()
    const digits = (form.querySelector<HTMLInputElement>('[name="totp"]')?.value ?? '').replace(/\D/g, '')
    if (!hostKey) return fail('主催キーを入れてください')
    if (totp && digits.length !== 6) return fail('認証アプリの 6 けたの数字を入れてください')
    fail('')
    submit.disabled = true
    submit.textContent = '確かめています…'
    api.login(code, { hostKey, ...(digits ? { totp: digits } : {}) }).then(
      (res) => {
        save(session, tokenKey(code), res)
        enter(res.token)
      },
      (err: unknown) => {
        submit.disabled = false
        submit.textContent = 'ログイン'
        fail(say(err))
      },
    )
  })
}

const HOW: Record<ResultRow['how'], string> = { bingo: 'ビンゴ', challenge: '上位チャレンジ', 'double-chance': 'ダブルチャンス' }

const CONSOLE_HTML = `
<header class="lh-top">
  <b class="lh-brand">Bingoo</b><span class="lh-tag">主催コンソール</span>
  <span class="lh-game">コード <b data-k="code"></b></span>
  <span class="lh-link" data-s="connecting">つないでいます…</span>
</header>
<div class="lh-grid">
  <div class="lh-col">
    <section class="lh-main">
      <div class="lh-status" role="status" aria-live="polite">つないでいます…</div>
      <button class="lh-next" type="button" disabled>次へ ▶</button>
      <div class="lh-under">
        <label class="lh-check lh-auto"><input type="checkbox" /> 自動進行</label>
        <span class="lh-keys">Space キーでも押せます</span>
      </div>
      <p class="lh-notice" role="alert" hidden></p>
    </section>
    <section class="lh-stats">
      <div class="lh-stat"><span>参加</span><b data-k="players">0</b><small>人</small><em data-k="bots"></em></div>
      <div class="lh-stat"><span>つながっている端末</span><b data-k="connected">–</b><small>台</small></div>
      <div class="lh-stat"><span>抽選</span><b data-k="draws">0</b><small>回</small></div>
      <div class="lh-stat"><span>景品 残り</span><b data-k="lower">–</b><small data-k="lowerOf">個</small></div>
      <div class="lh-stat"><span>上位景品 残り</span><b data-k="upper">–</b><small data-k="upperOf">個</small></div>
      <div class="lh-stat"><span>リーチ</span><b data-k="reach">0</b><small>人</small></div>
      <div class="lh-stat"><span>ビンゴ</span><b data-k="winners">0</b><small>人</small></div>
    </section>
    <section class="lh-panel lh-events">
      <h2>イベントを起こす<small>押すと、次の「次へ」で起きます</small></h2>
      <div class="lh-btns">
        <button type="button" class="lh-btn" data-ev="wild">🌈 全員確定（虹玉）</button>
        <button type="button" class="lh-btn" data-ev="mole">モグラ撃退クエスト</button>
      </div>
      <p class="lh-note">押さなくても、景品の減り方に合わせて自動で出ます（ビンゴが速すぎればモグラ撃退、なかなか出なければ虹玉）</p>
    </section>
  </div>
  <div class="lh-col">
    <section class="lh-panel lh-share">
      <h2>参加用・大画面用の URL</h2>
      <div class="lh-share-in">
        <div class="lh-share-qr"></div>
        <div class="lh-share-urls"></div>
      </div>
    </section>
    <section class="lh-panel lh-results">
      <h2>当選者<small data-k="resultCount"></small></h2>
      <div class="lh-btns">
        <button type="button" class="lh-btn lh-reload">更新</button>
        <button type="button" class="lh-btn lh-csv" disabled>CSV で保存</button>
      </div>
      <p class="lh-note lh-results-msg">まだ当選者はいません</p>
      <div class="lh-table" hidden>
        <table>
          <thead><tr><th>名前</th><th>景品</th><th>ランク</th><th>もらい方</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
    <details class="lh-panel lh-rehearsal">
      <summary>リハーサル・やり直し</summary>
      <h3>仮想の参加者を足す<small>受付中だけ</small></h3>
      <div class="lh-btns">
        ${[30, 100, 500, 1000].map((n) => `<button type="button" class="lh-btn" data-bots="${n}">+${fmt(n)} 人</button>`).join('')}
      </div>
      <p class="lh-note">本番の前に、流れを確かめるための人です。足した人は、あとから消せません</p>
      <h3>最初からやり直す</h3>
      <div class="lh-btns"><button type="button" class="lh-btn lh-danger lh-reset">最初からやり直す…</button></div>
      <p class="lh-note">番号も当選者も消して、受付からやり直します。参加している人は、そのまま残ります</p>
    </details>
    <p class="lh-hash"></p>
  </div>
</div>
<div class="lh-modal" hidden>
  <div class="lh-dialog" role="dialog" aria-modal="true" aria-labelledby="lh-dialog-title">
    <h2 id="lh-dialog-title"></h2>
    <div class="lh-dialog-body"></div>
    <div class="lh-dialog-btns">
      <button type="button" class="lh-btn lh-cancel">やめる</button>
      <button type="button" class="lh-btn lh-danger lh-ok"></button>
    </div>
  </div>
</div>
`

class HostConsole {
  private readonly el: HTMLDivElement
  private readonly cleanup: (() => void)[] = []
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  // サーバーから届いた、いまの状態
  private host: MsgOf<'host'> | null = null
  private hostAt = -Infinity // host を受け取った時刻（つなぎ直しのあと、古い host を信じないため）
  private totals: Totals | null = null
  private phase: Phase = 'reception'
  private players = 0
  private hash = ''
  private linkState: LinkState = { status: 'connecting', transport: 'ws' }
  private ready = false // 最初の状態（snapshot か host）が届いた

  // いまの状況の 1 行。届いたメッセージごとに決める。null のときは、フェーズから決める
  private event: (() => string) | null = null
  private dcCount = 0
  private armed: 'wild' | 'mole' | null = null // 次の「次へ」で起きるイベント

  // 主ボタンの二度押しを防ぐ
  private awaiting = false // 押した。サーバーの返事（host）を待っている
  private guardUntil = 0 // ボタンの名前が変わった直後は、少しの間だけ押せなくする
  private lastLabel = ''

  private rows: ResultRow[] = []
  private loading = false
  private again = false
  private modalClose: (() => void) | null = null
  private dead = false // 片付けたあと（ログインの画面に戻ったあと）は、何も描かない

  constructor(
    root: HTMLElement,
    private readonly api: Api,
    private readonly link: Link,
    private readonly code: string,
    private readonly token: string,
    private readonly onClosed: (why: NonNullable<LinkState['reason']>) => void,
  ) {
    this.el = h('div', 'lh-console', CONSOLE_HTML)
    root.replaceChildren(this.el)
    this.$('[data-k="code"]').textContent = code

    const urls = urlsOf(code)
    this.$('.lh-share-qr').innerHTML = `${qrSvg(urls.join, '参加用の QR')}<span>参加用の QR</span>`
    this.$('.lh-share-urls').innerHTML = urlRow('参加用（みんなのスマホ）', urls.join, null) + urlRow('大画面用（会場のスクリーン）', urls.stage, '開く')

    this.bind()
    this.cleanup.push(link.hub.subscribe((m) => this.on(m)))
    this.cleanup.push(link.onState((s) => this.onLink(s)))
    this.render()
  }

  destroy(): void {
    this.dead = true
    for (const fn of this.cleanup) fn()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private $<T extends HTMLElement = HTMLElement>(selector: string): T {
    return q<T>(this.el, selector)
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
  }

  private listen<K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void): void {
    document.addEventListener(type, fn)
    this.cleanup.push(() => document.removeEventListener(type, fn))
  }

  // ---- 操作 -----------------------------------------------------------------

  private bind(): void {
    this.$('.lh-next').addEventListener('click', () => this.next())

    const auto = this.$<HTMLInputElement>('.lh-auto input')
    auto.addEventListener('change', () => {
      this.link.send({ type: 'auto', on: auto.checked })
      // チェックに残ったままだと、Space がチェックの切り替えになる。Space はいつも「次へ」にしたい
      auto.blur()
    })

    this.el.querySelectorAll<HTMLButtonElement>('[data-ev]').forEach((b) =>
      b.addEventListener('click', () => {
        // もう一度押すと、取り消す
        const kind = this.armed === b.dataset.ev ? null : (b.dataset.ev as 'wild' | 'mole')
        this.link.send({ type: 'trigger', kind })
        this.armed = kind
        b.blur()
        this.render()
      }),
    )

    this.el.querySelectorAll<HTMLButtonElement>('[data-bots]').forEach((b) =>
      b.addEventListener('click', () => {
        const count = Number(b.dataset.bots)
        // 足した人は消せない（やり直しても残る）。本番の受付で押してしまうと取り返しがつかないので、確かめる
        this.confirm({
          title: `仮想の参加者を ${fmt(count)} 人足しますか？`,
          body: '<p>足した人は、あとから消せません（最初からやり直しても残ります）。</p><p>お客さんが入る本番のゲームでは、足さないでください。</p>',
          ok: `${fmt(count)} 人足す`,
          onOk: () => this.link.send({ type: 'bots', count }),
        })
      }),
    )

    this.$('.lh-reset').addEventListener('click', () => this.askReset())
    this.$('.lh-reload').addEventListener('click', () => void this.loadResults())
    this.$('.lh-csv').addEventListener('click', () => this.saveCsv())

    // Space で「次へ」（デモと同じ）。文字を打っている間と、確かめの窓が出ている間は効かせない。
    // ボタンやチェックに残ったフォーカスが Space を横取りしないように、keyup も止める
    const onSpace = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || this.modalClose) return
      const t = e.target as HTMLElement
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
      if (t instanceof HTMLInputElement && t.type !== 'checkbox' && !t.readOnly) return
      e.preventDefault()
      // 押しっぱなしで何度も進めない
      if (e.type === 'keydown' && !e.repeat) this.next()
    }
    this.listen('keydown', onSpace)
    this.listen('keyup', onSpace)
    this.listen('keydown', (e) => {
      if (e.key === 'Escape') this.modalClose?.()
    })

    // スマホで司会をしている間に、画面が消えて接続が切れないように（使えない端末では何もしない）
    const wake = () => {
      if (document.visibilityState === 'visible' && 'wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {})
    }
    this.listen('visibilitychange', wake)
    this.el.addEventListener('pointerdown', wake, { once: true })
  }

  private next(): void {
    const btn = this.$<HTMLButtonElement>('.lh-next')
    if (btn.disabled) return
    this.link.send({ type: 'next' })
    // 返事が来るまで押せなくする。続けて押すと、次の段階のボタン（「参加をしめきる」など）まで押したことになる
    this.awaiting = true
    this.later(2500, () => {
      this.awaiting = false
      this.render()
    })
    this.render()
  }

  // ---- 届いたメッセージ -----------------------------------------------------

  private onLink(s: LinkState): void {
    if (this.dead) return
    this.linkState = s
    if (s.status === 'closed') {
      // 登録したその場で呼ばれることがあるので、組み立てが終わってから知らせる
      this.later(0, () => this.onClosed(s.reason ?? 'closed'))
      return
    }
    this.render()
  }

  private on(m: Msg): void {
    if (this.dead) return
    if ('totals' in m) {
      this.totals = m.totals
      this.phase = m.totals.phase
    }
    const n = (x: number) => fmt(x)
    switch (m.type) {
      case 'snapshot':
        // つないだ直後か、最初からやり直したとき。やり直しのときは、直前（LEAD_MS だけ前）に新しい host が届いている。
        // つなぎ直しのときは、切れている間の host を見逃しているかもしれないので、古いものは信じない
        // （古い busy を信じると、「次へ」が押せないまま止まる）
        if (performance.now() - this.hostAt > 1500 || this.host?.phase !== m.totals.phase) this.host = null
        this.ready = true
        this.hash = m.deckHash
        this.players = m.live?.count ?? m.size
        this.event = null
        this.armed = null
        this.notice('')
        void this.loadResults()
        break
      case 'host': {
        const before = this.host
        this.host = m
        this.hostAt = performance.now()
        this.ready = true
        this.awaiting = false
        this.players = m.players
        this.hash = m.deckHash
        this.armed = m.event
        // 当選者の一覧は、発表が終わってから取り直す（ガラポンの最中に取ると、大画面より先に見えてしまう）
        if ((m.phase !== before?.phase || m.hold !== before?.hold) && (m.phase === 'done' || (m.phase === 'dc-spin' && m.hold))) void this.loadResults()
        break
      }
      case 'joined':
        this.players = m.count
        break
      case 'eventPlay':
        this.turnStarted()
        this.event = () => '🌈 全員確定（虹玉）！'
        break
      case 'questBrief':
        this.turnStarted()
        this.event = () => `緊急クエスト「モグラ撃退」の説明中 — 説明が終わったら「スタート」（${m.autoMs ? `自動進行: ${m.autoMs / 1000} 秒で開始` : '押さなくても 60 秒で開始'}）`
        break
      case 'lastOneBrief':
        this.event = () => `ラストワン争奪の説明中 — 景品 ${n(m.prizes)} 個を ${n(m.entrants.length)} 人で。説明が終わったら「スタート」（${m.autoMs ? `自動進行: ${m.autoMs / 1000} 秒で開始` : '押さなくても 60 秒で開始'}）`
        break
      case 'questStart':
        this.event = () => `モグラ撃退の最中 — みんながスマホでたたいています（リーチの ${n(m.targets)} 人がピンチ）`
        break
      case 'questProgress':
        return
      case 'questResult':
        this.event = () => `モグラ撃退の結果 — 守った ${n(m.defended)} 人／やられた ${n(m.lost)} 人`
        break
      case 'finalBall':
        this.turnStarted()
        this.event = () => `この 1 球で、景品がなくなります（残り ${n(m.prizesLeft)} 個）`
        break
      case 'drawScheduled':
        this.turnStarted()
        this.event = () => `抽選中（${n(m.drawNo)} 回目）— まもなく番号が出ます`
        break
      case 'numberRevealed': {
        const extra = [m.newBingo ? `ビンゴ ${n(m.newBingo)} 人` : '', m.challengeWins.length ? `上位チャレンジ成功 ${n(m.challengeWins.length)} 人` : ''].filter(Boolean).join('・')
        this.event = () => `${m.label} が出ました（${extra || '結果を表示中'}）`
        break
      }
      case 'prizeTime':
        if (m.lastOne) this.event = () => 'ラストワン争奪 — 同時にビンゴした人が、スマホでガラポン中'
        else if (m.entries.some((e) => e.choice?.allowed)) this.event = () => '景品を開けています — 受け取るか上位チャレンジか、スマホで選んでもらっています'
        else this.event = () => '景品を開けています'
        break
      case 'choices':
        if (m.challengers.length) this.event = () => `${n(m.challengers.length)} 人が、上位チャレンジに進みました`
        break
      case 'idle':
        this.event = () =>
          this.host?.auto
            ? `抽選 ${n(m.totals.drawCount)} 回目まで終了 — 自動で次の抽選に進みます`
            : `待機中 — 抽選 ${n(m.totals.drawCount)} 回目まで終了。「次へ」で次の抽選`
        void this.loadResults()
        break
      case 'bulkDrawn':
        this.event = () => `待機中 — 抽選 ${n(m.totals.drawCount)} 回目まで進めました。「次へ」で次の抽選`
        break
      case 'gameOver':
        this.event = () => '景品がぜんぶ出ました。「ダブルチャンスへ」で進む'
        void this.loadResults()
        break
      case 'dcEntry':
        this.dcCount = 0
        this.event = () => `ダブルチャンスの参加を受付中（いま ${n(this.dcCount)} 人）—「参加をしめきる」で進む（押さなくても ${m.seconds} 秒でしめきります）`
        break
      case 'dcEntrants':
        this.dcCount = m.count
        break
      case 'dcSpin':
        this.event = () => `ガラポン中（参加 ${n(m.entrants)} 人）— このあと当たった人を発表します`
        break
      case 'dcEnd':
        this.event = null // フェーズ（done）の言葉を出す
        void this.loadResults()
        break
      case 'notice':
        this.notice(m.text)
        return
      default:
        break
    }
    this.render()
  }

  // 次の抽選かイベントが始まった。前の知らせと、手で起こしたイベントの印を消す
  private turnStarted(): void {
    this.armed = null
    this.notice('')
  }

  private notice(text: string): void {
    const el = this.$('.lh-notice')
    el.textContent = text
    el.hidden = !text
  }

  // ---- 表示 -----------------------------------------------------------------

  // host がまだ届いていないとき（つないだ直後）は、フェーズから決める。
  // 押しても効かない場面で押せてしまうことはあるが、サーバーが受け流すので害はない
  private flow(): { phase: Phase; busy: boolean; hold: string | null; auto: boolean } {
    if (this.host) return this.host
    const hold = this.phase === 'dc-entry' ? '参加をしめきる ▶' : this.phase === 'dc-spin' ? '締めくくりへ ▶' : null
    return { phase: this.phase, busy: false, hold, auto: false }
  }

  private phaseStatus(f: { phase: Phase; busy: boolean; hold: string | null }): string {
    switch (f.phase) {
      case 'reception':
        return this.players === 0 ? '受付中 — まだだれも参加していません' : '受付中 — 参加がそろったら「受付を締め切って開始」'
      case 'playing':
        if (f.hold) return `ゲーム中 —「${f.hold.replace(' ▶', '')}」で進む`
        return f.busy ? 'ゲーム中 — 大画面の動きが終わるまで、少し待ってください' : `待機中 — 抽選 ${fmt(this.totals?.drawCount ?? 0)} 回目まで終了。「次へ」で次の抽選`
      case 'over':
        return '景品がぜんぶ出ました。「ダブルチャンスへ」で進む'
      case 'dc-entry':
        return 'ダブルチャンスの参加を受付中 —「参加をしめきる」で進む'
      case 'dc-spin':
        return f.hold ? '当たった人を発表中 — 読み上げが終わったら「締めくくりへ」' : 'ガラポン中 — このあと当たった人を発表します'
      case 'done':
        return 'おつかれさまでした。景品を渡すときは、「当選者」の一覧を見てください'
    }
  }

  private render(): void {
    const f = this.flow()
    const live = this.linkState.status === 'live'

    // 接続の状態
    const link = this.$('.lh-link')
    link.dataset.s = this.linkState.status
    link.textContent = live ? 'つながっています' : this.linkState.status === 'retrying' ? 'つなぎ直しています…' : 'つないでいます…'

    // いまの状況の 1 行
    let status = this.event ? this.event() : this.phaseStatus(f)
    // 発表のあとは新しいメッセージが来ないので、合図待ちになったことはここで出す（デモと同じ）
    if (f.hold && f.phase === 'dc-spin') status = '当たった人を発表中 — 読み上げが終わったら「締めくくりへ」'
    // 切れている間はボタンを押せない。なぜ押せないのかを、いちばん読む場所に出す
    if (!this.ready) status = 'つないでいます…'
    else if (!live) status = 'つなぎ直しています… つながるまで、少し待ってください'
    this.$('.lh-status').textContent = status

    // 主ボタン。司会の合図を待っている間（説明の画面、当選者の発表）は、同じボタンがその合図になる
    const label = f.hold ?? (f.phase === 'reception' ? '受付を締め切って開始 ▶' : f.phase === 'over' ? 'ダブルチャンスへ ▶' : f.phase === 'dc-entry' ? '参加をしめきる ▶' : '次へ ▶')
    const now = performance.now()
    if (label !== this.lastLabel) {
      // 名前が変わった瞬間に押すと、前のつもりで次の操作をしてしまう。ひと呼吸だけ押せなくする
      if (this.lastLabel) {
        this.guardUntil = now + 500
        this.later(520, () => this.render())
      }
      this.lastLabel = label
    }
    const next = this.$<HTMLButtonElement>('.lh-next')
    next.textContent = label
    const cannot = !f.hold && (f.busy || f.phase === 'dc-spin' || f.phase === 'done' || (f.phase === 'reception' && this.players === 0))
    // 切れている間に押した分は、つながったときにまとめて届いてしまう。つながっている間だけ押せるようにする
    next.disabled = !this.ready || !live || this.awaiting || now < this.guardUntil || cannot

    const auto = this.$<HTMLInputElement>('.lh-auto input')
    auto.checked = f.auto
    auto.disabled = !this.ready || !live || f.phase === 'done'

    // 数字
    const t = this.totals
    const set = (k: string, text: string) => (this.$(`[data-k="${k}"]`).textContent = text)
    set('players', fmt(this.players))
    set('bots', this.host?.bots ? `うち仮想 ${fmt(this.host.bots)} 人` : '')
    set('connected', this.host ? fmt(this.host.connected) : '–')
    set('draws', fmt(t?.drawCount ?? this.host?.drawCount ?? 0))
    set('lower', t ? fmt(t.lowerLeft) : '–')
    set('lowerOf', t ? `/ ${fmt(t.lowerTotal)} 個` : '個')
    set('upper', t ? fmt(t.upperLeft) : '–')
    set('upperOf', t ? `/ ${fmt(t.upperTotal)} 個` : '個')
    set('reach', fmt(t?.reachHolders ?? 0))
    set('winners', fmt(t?.winners ?? 0))

    // イベントとリハーサル
    const canEvent = this.ready && live && (f.phase === 'reception' || f.phase === 'playing')
    this.el.querySelectorAll<HTMLButtonElement>('[data-ev]').forEach((b) => {
      b.disabled = !canEvent
      b.classList.toggle('on', canEvent && this.armed === b.dataset.ev)
    })
    const canBots = this.ready && live && f.phase === 'reception'
    this.el.querySelectorAll<HTMLButtonElement>('[data-bots]').forEach((b) => (b.disabled = !canBots))
    this.$<HTMLButtonElement>('.lh-reset').disabled = !this.ready || !live

    this.$('.lh-hash').textContent = this.hash ? `抽選順と景品の並びのハッシュ ${this.hash}` : ''
  }

  // ---- 確かめの窓 -----------------------------------------------------------

  private confirm(o: { title: string; body: string; ok: string; onOk: (body: HTMLElement) => void; setup?: (body: HTMLElement) => void }): void {
    const modal = this.$('.lh-modal')
    const body = this.$('.lh-dialog-body')
    const ok = this.$<HTMLButtonElement>('.lh-ok')
    const cancel = this.$<HTMLButtonElement>('.lh-cancel')
    this.$('#lh-dialog-title').textContent = o.title
    body.innerHTML = o.body
    ok.textContent = o.ok
    o.setup?.(body)
    modal.hidden = false
    // はじめは「やめる」にフォーカスを置く（Enter や Space を押しただけでは、実行にならないように）
    cancel.focus()
    const close = () => {
      modal.hidden = true
      this.modalClose = null
      ok.onclick = cancel.onclick = modal.onclick = null
    }
    this.modalClose = close
    cancel.onclick = close
    modal.onclick = (e) => {
      if (e.target === modal) close()
    }
    ok.onclick = () => {
      o.onOk(body)
      close()
    }
  }

  private askReset(): void {
    const now = this.host?.settings // いまの景品の数と名前（サーバーから届いている）
    const t = this.totals
    const bots = this.host?.bots ?? 0
    this.confirm({
      title: '最初からやり直しますか？',
      body: `
        <p>番号も当選者も、ぜんぶ消えます。参加している人はそのまま残って、カードは配り直しになります。</p>
        ${bots ? `<p>仮想の参加者 ${fmt(bots)} 人も、そのまま残ります。</p>` : ''}
        <label class="lh-check lh-change"><input type="checkbox" /> 景品の数も変える</label>
        <div class="lh-counts" hidden>
          ${countsHtml({ lower: now?.lower ?? t?.lowerTotal, upper: now?.upper ?? t?.upperTotal, dc: now?.dc })}
        </div>`,
      ok: 'ぜんぶ消して、最初からやり直す',
      setup: (body) => {
        const change = q<HTMLInputElement>(body, '.lh-change input')
        const counts = q(body, '.lh-counts')
        bindCounts(counts, () => {})
        change.addEventListener('change', () => (counts.hidden = !change.checked))
      },
      onOk: (body) => {
        if (!q<HTMLInputElement>(body, '.lh-change input').checked) {
          // 設定を付けなければ、サーバーがいまの設定（景品の名前も）のままやり直す
          this.link.send({ type: 'reset' })
          return
        }
        // 景品の名前は、いまのまま使う
        const settings: LiveSettings = { ...readCounts(body), ...(now?.prizeNames ? { prizeNames: now.prizeNames } : {}) }
        this.link.send({ type: 'reset', settings })
      },
    })
  }

  // ---- 当選者の一覧 ---------------------------------------------------------

  private async loadResults(): Promise<void> {
    // 取っている最中にまた頼まれたら、終わってからもう 1 回だけ取る
    if (this.loading) {
      this.again = true
      return
    }
    this.loading = true
    const reload = this.$<HTMLButtonElement>('.lh-reload')
    reload.disabled = true
    try {
      const rows = await this.api.results(this.code, this.token)
      if (this.dead) return
      this.rows = rows
      this.renderResults('')
    } catch (e) {
      if (this.dead) return
      // ログインの期限が切れていたら、ログインからやり直す
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        this.onClosed('auth')
        return
      }
      this.renderResults('一覧を取れませんでした。「更新」を押してください')
    } finally {
      this.loading = false
      reload.disabled = false
    }
    if (this.again && !this.dead) {
      this.again = false
      void this.loadResults()
    }
  }

  private renderResults(error: string): void {
    const rows = this.rows
    const bots = rows.filter((r) => r.bot).length
    this.$('[data-k="resultCount"]').textContent = rows.length ? `${fmt(rows.length)} 人${bots ? `（うち仮想 ${fmt(bots)} 人）` : ''}` : ''
    const msg = this.$('.lh-results-msg')
    msg.textContent = error || 'まだ当選者はいません'
    msg.hidden = !error && rows.length > 0
    this.$('.lh-table').hidden = rows.length === 0
    this.$<HTMLButtonElement>('.lh-csv').disabled = rows.length === 0
    this.$('.lh-table tbody').innerHTML = rows
      .map(
        (r) =>
          `<tr${r.bot ? ' class="bot"' : ''}><td>${esc(r.name)}${r.bot ? '<i>仮想</i>' : ''}</td><td>${esc(r.prize)}</td><td>${r.rarity ? `<b data-r="${r.rarity}">${r.rarity}</b>` : '–'}</td><td>${HOW[r.how] ?? ''}</td></tr>`,
      )
      .join('')
  }

  private saveCsv(): void {
    // 名前は参加者が自由に入れた文字。表計算ソフトが式として読まないように、記号で始まるものには ' を付ける
    const cell = (s: string) => `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`
    const lines = [['名前', '景品', 'ランク', 'もらい方', '仮想'], ...this.rows.map((r) => [r.name, r.prize, r.rarity ?? '', HOW[r.how] ?? '', r.bot ? '仮想' : ''])]
    // 先頭の BOM は、Excel で文字化けしないため
    const blob = new Blob(['﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
    const a = h('a')
    a.href = URL.createObjectURL(blob)
    a.download = `bingoo-${this.code}-当選者.csv`
    document.body.append(a)
    a.click()
    a.remove()
    this.later(1000, () => URL.revokeObjectURL(a.href))
  }
}

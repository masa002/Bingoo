import { engine, sfx } from '../audio'
import { labelOf } from '../core/card'
import type { Impact } from '../core/game'
import { TIER_NAME, TIER_SHAPE, type Tier } from '../core/show'
import type { Clock } from '../demo/clock'
import type { DemoAuthority, EventKind, HitKind, Settings } from '../demo/authority'
import type { LocalHub } from '../net/hub'
import type { Msg } from '../net/protocol'
import { h, q } from './dom'

// 主催コンソール（本番と同じ）と、その下の操作パネル（デモ専用）

const options = (values: number[]) => values.map((v) => `<option>${v}</option>`).join('')

const HOST_HTML = `
<section class="hc">
  <h2>主催コンソール</h2>
  <div class="hc-status">準備中</div>
  <button class="hc-next">次へ ▶</button>
  <button class="hc-push" disabled>発表する</button>
  <div class="hc-row">
    <label><input type="checkbox" class="hc-sound" checked /> 音</label>
    <button class="hc-new">新しいゲーム</button>
  </div>
  <p class="hc-keys">キー操作: Space 次へ ／ P 発表する</p>
  <p class="hc-hash"></p>
</section>
<details class="dp" open>
  <summary><b>操作パネル</b><i>DEMO</i><small>デモ専用（本番の主催卓にはありません）</small></summary>
  <div class="dp-msg"></div>
  <h4>進み方</h4>
  <div class="hc-row">
    <label><input type="checkbox" class="hc-auto" /> 自動進行</label>
  </div>
  <div class="hc-row hc-speed">速度
    <button data-speed="0.5">×0.5</button><button data-speed="1" class="on">×1</button><button data-speed="2">×2</button><button data-speed="4">×4</button>
  </div>
  <h4>イベント（次の「次へ」で起きる）</h4>
  <div class="dp-ev">
    <button data-ev="wild">🌈 全員確定（虹玉）</button><button data-ev="mole">モグラ撃退クエスト</button><button data-ev="moleMe">モグラ撃退（自分が本当にねらわれる）</button>
  </div>
  <p class="dp-note">指定しなくても、景品の減り方に合わせて自動で出ます（ビンゴが速すぎればモグラ撃退、なかなか出なければ虹玉）。モグラ撃退では、全員のスマホにボスモグラが出ます。本当にマスを埋められるのは、リーチの人のうち、たたいた数が少なかった人だけです</p>
  <h4>次の番号 <label class="dp-spoil-label"><input type="checkbox" class="dp-spoil" /> ネタバレ表示</label></h4>
  <div class="dp-grid"></div>
  <p class="dp-legend">数字をクリックで次の番号に指定。ネタバレ: <b class="b">B</b>=ビンゴになる人数 <b class="r">R</b>=リーチになる人数 ★=あなたがビンゴ ●=あなたがリーチ ・=あなたのカードにある</p>
  <h4>次の演出の段階（大画面）</h4>
  <div class="dp-tiers">
    <button data-tier="auto" class="on">自動</button>${[0, 1, 2, 3].map((t) => `<button data-tier="${t}">${TIER_SHAPE[t as Tier]} ${TIER_NAME[t as Tier]}</button>`).join('')}
  </div>
  <div class="dp-kind">
    <button data-kind="any" class="on">どちらでも</button><button data-kind="hit">当たり</button><button data-kind="gase">ガセ</button>
  </div>
  <p class="dp-note">選ぶと、その色をうそなく出せる番号が自動で選ばれます。大画面の虹は「全員確定」のときだけです</p>
  <h4>あなたのカード</h4>
  <div class="dp-me">
    <button data-me="hit">次で当てる</button><button data-me="reach">リーチにする</button><button data-me="bingo">次でビンゴ</button>
  </div>
  <p class="dp-note">上位チャレンジ中は、「次でビンゴ」でチャレンジ成功の番号が出ます</p>
  <h4>進める</h4>
  <div class="dp-ff"><button data-ff="5">5 回進める</button><button data-ff="10">10 回進める</button></div>
  <p class="dp-note">演出なしで番号を進めます。ビンゴが出る番号の手前で止まります</p>
  <h4>ゲーム設定</h4>
  <div class="dp-set">
    <label>人数 <select class="dp-size">${options([30, 100, 1000, 10000])}</select></label>
    <label>下位の景品 <select class="dp-lower">${options([5, 10, 30, 50])}</select></label>
  </div>
  <div class="dp-set">
    <label>上位の景品 <select class="dp-upper">${options([3, 5, 8, 10])}</select></label>
    <label>ダブルチャンス <select class="dp-dc">${options([3, 5, 10])}</select></label>
  </div>
  <div class="dp-set">
    <label>シード <input class="dp-seed" spellcheck="false" /></label>
    <button class="dp-new">新しいゲーム</button>
  </div>
</details>
`

export class HostView {
  private readonly root: HTMLDivElement
  private pushReady = false
  private hash = ''

  constructor(
    host: HTMLElement,
    hub: LocalHub,
    private readonly clock: Clock,
    private readonly auth: DemoAuthority,
    private readonly restart: (s: Settings) => void,
  ) {
    this.root = h('div', 'host', HOST_HTML)
    host.append(this.root)
    this.bind()
    hub.subscribe((m) => this.on(m))
    auth.onChange = () => this.render()
  }

  private $<T extends HTMLElement = HTMLElement>(selector: string): T {
    return q<T>(this.root, selector)
  }

  private bind(): void {
    this.$('.hc-next').addEventListener('click', () => this.next())
    this.$('.hc-push').addEventListener('click', () => this.push())
    this.$<HTMLInputElement>('.hc-auto').addEventListener('change', (e) => {
      this.auth.auto = (e.target as HTMLInputElement).checked
      if (this.auth.auto && (this.auth.holding || (!this.auth.busy && this.auth.phase !== 'over'))) this.next()
    })
    this.$<HTMLInputElement>('.hc-sound').addEventListener('change', (e) => {
      engine.enabled = (e.target as HTMLInputElement).checked
    })
    this.root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) =>
      b.addEventListener('click', () => {
        this.clock.speed = Number(b.dataset.speed)
        this.root.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('on', x === b))
      }),
    )
    this.root.querySelectorAll<HTMLButtonElement>('[data-ev]').forEach((b) =>
      b.addEventListener('click', () => this.auth.triggerEvent(b.dataset.ev as EventKind)),
    )
    this.$<HTMLInputElement>('.dp-spoil').addEventListener('change', () => this.render())
    this.$('.dp-grid').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-n]')
      if (!btn || btn.disabled) return
      const n = Number(btn.dataset.n)
      this.auth.setForcedNumber(this.auth.forcedNumber === n ? null : n)
    })
    this.root.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach((b) =>
      b.addEventListener('click', () => {
        const t = b.dataset.tier === 'auto' ? null : (Number(b.dataset.tier) as Tier)
        this.auth.setForcedTier(t, this.auth.forcedKind)
      }),
    )
    this.root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) =>
      b.addEventListener('click', () => this.auth.setForcedTier(this.auth.forcedTier, b.dataset.kind as HitKind)),
    )
    this.root.querySelectorAll<HTMLButtonElement>('[data-me]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.me === 'hit') this.auth.meHitNext()
        else if (b.dataset.me === 'reach') this.auth.meToReach()
        else this.auth.meBingoNext()
      }),
    )
    this.root.querySelectorAll<HTMLButtonElement>('[data-ff]').forEach((b) =>
      b.addEventListener('click', () => this.auth.fastForward(Number(b.dataset.ff))),
    )
    const newGame = (seed: string) => {
      const num = (sel: string) => Number(this.$<HTMLSelectElement>(sel).value)
      this.restart({ seed: seed || Math.random().toString(36).slice(2, 8), size: num('.dp-size'), lower: num('.dp-lower'), upper: num('.dp-upper'), dc: num('.dp-dc') })
    }
    this.$('.dp-new').addEventListener('click', () => newGame(this.$<HTMLInputElement>('.dp-seed').value.trim()))
    // 主催コンソールの「新しいゲーム」は、いまの設定のまま、別の展開で始める
    this.$('.hc-new').addEventListener('click', () => newGame(''))
    document.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        this.next()
      } else if (e.key === 'p' || e.key === 'P') {
        this.push()
      }
    })
  }

  private next(): void {
    engine.unlock()
    sfx.uiTap()
    void this.auth.next()
  }

  private push(): void {
    if (!this.pushReady) return
    this.pushReady = false
    this.auth.push()
    this.render()
  }

  private on(m: Msg): void {
    switch (m.type) {
      case 'snapshot': {
        const s = this.auth.settings
        this.$<HTMLInputElement>('.dp-seed').value = s.seed
        this.$<HTMLSelectElement>('.dp-size').value = String(s.size)
        this.$<HTMLSelectElement>('.dp-lower').value = String(s.lower)
        this.$<HTMLSelectElement>('.dp-upper').value = String(s.upper)
        this.$<HTMLSelectElement>('.dp-dc').value = String(s.dc)
        this.$('.dp-msg').textContent = ''
        this.hash = m.deckHash
        this.status('受付中 — 参加がそろったら「受付を締め切って開始」')
        break
      }
      case 'eventPlay':
        this.status('🌈 全員確定（虹玉）！')
        break
      case 'questBrief':
        this.status(`緊急クエスト「モグラ撃退」の説明中 — 説明が終わったら「スタート」（${m.autoMs ? `自動進行: ${m.autoMs / 1000} 秒で開始` : '押さなくても 60 秒で開始'}）`)
        break
      case 'lastOneBrief':
        this.status(`ラストワン争奪の説明中 — 景品 ${m.prizes} 個を ${m.entrants.length} 人で。説明が終わったら「スタート」（${m.autoMs ? `自動進行: ${m.autoMs / 1000} 秒で開始` : '押さなくても 60 秒で開始'}）`)
        break
      case 'questStart':
        this.status(`モグラ撃退の最中 — みんながスマホでたたいています（リーチの ${m.targets.toLocaleString('ja-JP')} 人がピンチ）`)
        break
      case 'questProgress':
        return
      case 'questResult':
        this.status(`モグラ撃退の結果 — 守った ${m.defended.toLocaleString('ja-JP')} 人／やられた ${m.lost.toLocaleString('ja-JP')} 人`)
        break
      case 'finalBall':
        this.status(`この 1 球で、景品がなくなります（残り ${m.prizesLeft} 個）`)
        break
      case 'drawScheduled':
        this.$('.dp-msg').textContent = ''
        this.status(`抽選中 ${TIER_SHAPE[m.tier]} ${TIER_NAME[m.tier]}`)
        break
      case 'awaitPush':
        this.pushReady = true
        this.status('「発表する」を押してください（3 秒たつと自動で発表）')
        break
      case 'numberRevealed':
        this.pushReady = false
        this.status(`${m.label} が出ました（結果を表示中）`)
        break
      case 'prizeTime':
        if (m.lastOne) this.status('ラストワン争奪 — 同時にビンゴした人が、スマホでガラポン中')
        else this.status(m.entries.some((e) => e.isMe) ? '景品を開けています（あなたのスマホで開けてください）' : '景品を開けています')
        break
      case 'idle':
        this.status(`待機中 — 抽選 ${m.totals.drawCount} 回目まで終了。「次へ」で次の抽選`)
        break
      case 'bulkDrawn':
        this.status(`待機中 — 抽選 ${m.totals.drawCount} 回目まで進めました。「次へ」で次の抽選`)
        break
      case 'gameOver':
        this.status('景品がぜんぶ出ました。「ダブルチャンスへ」で進む')
        break
      case 'dcEntry':
        this.status('ダブルチャンスの参加を受付中 —「参加をしめきる」で進む')
        break
      case 'dcSpin':
        this.status('ガラポン中 — このあと当たった人を発表します')
        break
      case 'dcEnd':
        this.status('おつかれさまでした。もう一度遊ぶなら「新しいゲーム」')
        break
      case 'notice':
        this.$('.dp-msg').textContent = m.text
        return
      default:
        break
    }
    this.render()
  }

  private status(text: string): void {
    this.$('.hc-status').textContent = text
  }

  render(): void {
    const auth = this.auth
    if (!auth.game) return
    const g = auth.game
    const busy = auth.busy
    const phase = auth.phase
    const next = this.$<HTMLButtonElement>('.hc-next')
    // 司会の合図を待っている間（説明の画面、当選者の発表）は、同じボタンがその合図になる
    const holding = auth.holding
    next.textContent = holding
      ? auth.holdLabel
      : phase === 'reception'
        ? '受付を締め切って開始 ▶'
        : phase === 'over'
          ? 'ダブルチャンスへ ▶'
          : phase === 'dc-entry'
            ? '参加をしめきる ▶'
            : '次へ ▶'
    next.disabled = !holding && ((busy && phase !== 'dc-entry') || phase === 'dc-spin' || phase === 'done')
    if (holding && phase === 'dc-spin') this.status('当たった人を発表中 — 読み上げが終わったら「締めくくりへ」')
    // 終わったら、次に押すのは「新しいゲーム」
    this.$('.hc-new').classList.toggle('primary', phase === 'done')
    this.$('.hc-hash').textContent = this.hash ? `抽選順と景品の並びのハッシュ ${this.hash.slice(0, 16)}…${auth.isTampered ? '（デモ操作で変更あり）' : ''}` : ''
    this.$<HTMLButtonElement>('.hc-push').disabled = !this.pushReady
    this.$('.hc-push').classList.toggle('ready', this.pushReady)
    const playing = phase === 'reception' || phase === 'playing'

    // 次の番号の盤（ネタバレ表示はデモ専用。本番の主催卓には出さない）
    const spoil = this.$<HTMLInputElement>('.dp-spoil').checked
    const impacts = new Map<number, Impact>(spoil && playing ? auth.previewAll().map((i) => [i.n, i]) : [])
    const deckNext = g.nextInDeck()
    this.$('.dp-grid').innerHTML = Array.from({ length: 75 }, (_, i) => {
      const n = i + 1
      const head = i % 15 === 0 ? `<div class="dp-letter">${'BINGO'[i / 15]}<small>${n}〜${n + 14}</small></div>` : ''
      const drawn = g.isDrawn(n)
      const imp = impacts.get(n)
      const cls = ['dp-n']
      if (drawn) cls.push('drawn')
      if (auth.forcedNumber === n) cls.push('forced')
      if (spoil && n === deckNext && auth.forcedNumber === null) cls.push('deck')
      if (imp?.newBingo) cls.push('hot')
      const me = imp ? (imp.me.bingo || imp.me.challenge ? '★' : imp.me.reach ? '●' : imp.me.hit ? '・' : '') : ''
      const info = imp && !drawn ? `<small>${imp.newBingo ? `<b class="b">B${imp.newBingo}</b>` : ''}<b class="r">R${imp.newReach}</b>${me}</small>` : ''
      return `${head}<button class="${cls.join(' ')}" data-n="${n}" ${drawn || busy || !playing ? 'disabled' : ''} title="${labelOf(n)}">${n}${info}</button>`
    }).join('')

    this.root.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach((b) => {
      const t = b.dataset.tier === 'auto' ? null : Number(b.dataset.tier)
      b.classList.toggle('on', t === auth.forcedTier)
    })
    this.root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === auth.forcedKind))
    this.root.querySelectorAll<HTMLButtonElement>('[data-me], [data-ff], [data-ev]').forEach((b) => (b.disabled = busy || !playing))
  }
}

import { labelOf } from '../core/card'
import type { Impact } from '../core/game'
import { TIER_NAME, TIER_SHAPE, type Tier } from '../core/show'
import type { Clock } from '../demo/clock'
import type { DemoAuthority, HitKind, Settings } from '../demo/authority'
import type { LocalHub } from '../net/hub'
import type { Msg } from '../net/protocol'
import { h, q } from './dom'
import { sound } from './sound'

// 主催コンソール（本番と同じ）と、その下の操作パネル（デモ専用）

const HOST_HTML = `
<section class="hc">
  <h2>主催コンソール</h2>
  <div class="hc-status">準備中</div>
  <button class="hc-next">次へ ▶</button>
  <button class="hc-push" disabled>PUSH</button>
  <div class="hc-row">
    <label><input type="checkbox" class="hc-auto" /> 自動進行</label>
    <label><input type="checkbox" class="hc-sound" checked /> 大画面の音</label>
  </div>
  <div class="hc-row hc-speed">速度
    <button data-speed="0.5">×0.5</button><button data-speed="1" class="on">×1</button><button data-speed="2">×2</button><button data-speed="4">×4</button>
  </div>
  <p class="hc-keys">キー操作: Space 次へ ／ P PUSH</p>
</section>
<section class="dp">
  <h3>操作パネル <small>デモ専用</small></h3>
  <div class="dp-msg"></div>
  <h4>次の番号 <label class="dp-spoil-label"><input type="checkbox" class="dp-spoil" /> ネタバレ表示</label></h4>
  <div class="dp-grid"></div>
  <p class="dp-legend">数字をクリックで次の番号に指定。ネタバレ: <b class="b">B</b>=新規ビンゴ人数 <b class="r">R</b>=新規リーチ人数 ★=あなたがビンゴ ●=あなたがリーチ ・=あなたにヒット</p>
  <h4>次の演出の段階</h4>
  <div class="dp-tiers">
    <button data-tier="auto" class="on">自動</button>${[0, 1, 2, 3, 4].map((t) => `<button data-tier="${t}">${TIER_SHAPE[t as Tier]} ${TIER_NAME[t as Tier]}</button>`).join('')}
  </div>
  <div class="dp-kind">
    <button data-kind="any" class="on">どちらでも</button><button data-kind="hit">当たり</button><button data-kind="gase">ガセ</button>
  </div>
  <p class="dp-note">虹は本当にビンゴが出るときだけ。指定すると、その段階を正直に出せる番号をエンジンが選びます</p>
  <h4>あなたのカード</h4>
  <div class="dp-me">
    <button data-me="hit">次でヒット</button><button data-me="reach">リーチにする</button><button data-me="bingo">次でビンゴ</button>
  </div>
  <h4>進める</h4>
  <div class="dp-ff"><button data-ff="5">5 回進める</button><button data-ff="10">10 回進める</button></div>
  <p class="dp-note">演出なしで進めます。ビンゴが出る回の手前で止まります</p>
  <h4>ゲーム設定</h4>
  <div class="dp-set">
    <label>人数 <select class="dp-size"><option>30</option><option>100</option><option>1000</option><option>10000</option></select></label>
    <label>景品 <select class="dp-prizes"><option>5</option><option>10</option><option>30</option><option>50</option></select></label>
  </div>
  <div class="dp-set">
    <label>シード <input class="dp-seed" spellcheck="false" /></label>
    <button class="dp-new">新しいゲーム</button>
  </div>
</section>
`

export class HostView {
  private readonly root: HTMLDivElement
  private phase: 'reception' | 'drawing' | 'push' | 'result' | 'prize' | 'idle' | 'over' = 'reception'

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
      if (this.auth.auto && !this.auth.busy) this.next()
    })
    this.$<HTMLInputElement>('.hc-sound').addEventListener('change', (e) => {
      sound.enabled = (e.target as HTMLInputElement).checked
    })
    this.root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) =>
      b.addEventListener('click', () => {
        this.clock.speed = Number(b.dataset.speed)
        this.root.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('on', x === b))
      }),
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
    this.$('.dp-new').addEventListener('click', () => {
      const seed = this.$<HTMLInputElement>('.dp-seed').value.trim() || Math.random().toString(36).slice(2, 8)
      this.restart({
        seed,
        size: Number(this.$<HTMLSelectElement>('.dp-size').value),
        prizeCount: Number(this.$<HTMLSelectElement>('.dp-prizes').value),
      })
    })
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
    sound.unlock()
    void this.auth.next()
  }

  private push(): void {
    if (this.phase === 'push') this.auth.push()
  }

  private on(m: Msg): void {
    switch (m.type) {
      case 'snapshot':
        this.phase = 'reception'
        this.$<HTMLInputElement>('.dp-seed').value = m.seed
        this.$<HTMLSelectElement>('.dp-size').value = String(m.size)
        this.$<HTMLSelectElement>('.dp-prizes').value = String(m.prizeCount)
        this.$('.dp-msg').textContent = ''
        break
      case 'drawScheduled':
        this.phase = 'drawing'
        this.$('.dp-msg').textContent = ''
        this.status(`抽選中 ${TIER_SHAPE[m.tier]} ${TIER_NAME[m.tier]}`)
        break
      case 'awaitPush':
        this.phase = 'push'
        this.status('PUSH を押してください（3 秒で自動）')
        break
      case 'numberRevealed':
        this.phase = 'result'
        this.status(`結果表示中 ${m.label}`)
        break
      case 'prizeTime':
        this.phase = 'prize'
        this.status('景品ガチャ中')
        break
      case 'idle':
        this.phase = 'idle'
        break
      case 'gameOver':
        this.phase = 'over'
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
    this.$<HTMLButtonElement>('.hc-next').disabled = busy || auth.over
    this.$<HTMLButtonElement>('.hc-push').disabled = this.phase !== 'push'
    this.$('.hc-push').classList.toggle('ready', this.phase === 'push')
    if (this.phase === 'reception') this.status('受付中（「次へ」で締め切って開始）')
    else if (this.phase === 'idle') this.status(`待機中 — 抽選 ${g.drawCount} 回目まで終了`)
    else if (this.phase === 'over') this.status('終了（景品がなくなりました）')

    // 次の番号の盤（ネタバレ表示はデモ専用。本番の主催卓には出さない）
    const spoil = this.$<HTMLInputElement>('.dp-spoil').checked
    const impacts = new Map<number, Impact>(spoil ? auth.previewAll().map((i) => [i.n, i]) : [])
    const next = g.nextInDeck()
    this.$('.dp-grid').innerHTML = Array.from({ length: 75 }, (_, i) => {
      const n = i + 1
      const drawn = g.isDrawn(n)
      const imp = impacts.get(n)
      const cls = ['dp-n']
      if (drawn) cls.push('drawn')
      if (auth.forcedNumber === n) cls.push('forced')
      if (spoil && n === next && auth.forcedNumber === null) cls.push('deck')
      if (imp?.newBingo) cls.push('hot')
      const me = imp ? (imp.me.bingo ? '★' : imp.me.reach ? '●' : imp.me.hit ? '・' : '') : ''
      const info = imp && !drawn ? `<small>${imp.newBingo ? `<b class="b">B${imp.newBingo}</b>` : ''}<b class="r">R${imp.newReach}</b>${me}</small>` : ''
      return `<button class="${cls.join(' ')}" data-n="${n}" ${drawn || busy ? 'disabled' : ''} title="${labelOf(n)}">${n}${info}</button>`
    }).join('')

    this.root.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach((b) => {
      const t = b.dataset.tier === 'auto' ? null : Number(b.dataset.tier)
      b.classList.toggle('on', t === auth.forcedTier)
    })
    this.root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === auth.forcedKind))
    this.root.querySelectorAll<HTMLButtonElement>('[data-me], [data-ff]').forEach((b) => (b.disabled = busy || auth.over))
  }
}

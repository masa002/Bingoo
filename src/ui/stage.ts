import { bgm, engine, sfx, type BgmScene } from '../audio'
import { LETTERS } from '../core/card'
import { TIER_WORD } from '../core/show'
import type { Player } from '../core/game'
import type { Clock } from '../demo/clock'
import { Particles, RAINBOW } from '../fx/particles'
import { DoubleChanceStage } from '../fx/stage/doublechance'
import { DrawMachine } from '../fx/stage/draw'
import { playAllKakutei, playFinalBall } from '../fx/stage/events'
import { openLastOneBrief, playLastOneGarapon } from '../fx/stage/lastone'
import { MoleQuestStage } from '../fx/stage/quest'
import type { LocalHub } from '../net/hub'
import type { Msg, MsgOf, PrizeEntry, Totals } from '../net/protocol'
import { countUp, esc, fit, fmt, h, q, tierGuide } from './dom'

// 会場の大画面（1920×1080 で組んで縮小表示する）。抽選機・イベント・ダブルチャンスの演出は fx/ の部品で、
// この画面は HUD・結果・会場ビュー・番号の盤と、メッセージから部品への振り分けを受け持つ。音（PA）はこの画面だけが鳴らす

export type VenueSource = () => readonly Player[]

const STAGE_HTML = `
<header class="st-hud">
  <div class="st-logo">BINGOO</div>
  <div class="st-stat"><span>参加</span><b data-k="size">0</b><small>人</small></div>
  <div class="st-stat"><span>リーチ</span><b data-k="reach">0</b><small>人</small></div>
  <div class="st-stat"><span>ビンゴ</span><b data-k="bingo">0</b><small>人</small></div>
  <div class="st-stat"><span>景品 あと</span><b data-k="lower">0</b></div>
  <div class="st-stat st-upper"><span>上位景品 あと</span><b data-k="upper">0</b></div>
  <div class="st-stat st-chal"><span>上位チャレンジ中</span><b data-k="chal">0</b><small>人</small></div>
  <div class="st-odds">ビンゴが出る番号 あと <b data-k="hits">0</b> / <i data-k="remaining">75</i></div>
</header>
<section class="st-result">
  <div class="st-last"><small>今回の番号</small><b>--</b></div>
  <div class="st-chips">
    <div class="chip"><span>持っていた人</span><b data-r="hits"></b></div>
    <div class="chip"><span>新しくリーチ</span><b data-r="reach"></b></div>
    <div class="chip chip-bingo"><span>ビンゴ</span><b data-r="bingo"></b></div>
  </div>
  <ol class="st-names"></ol>
</section>
<section class="st-venue">
  <span class="st-venue-label">会場ビュー</span>
  <canvas width="606" height="170"></canvas>
  <span class="st-venue-legend"><i class="r"></i>リーチ<i class="g"></i>いまの番号を持つ人<i class="v"></i>チャレンジ中<i class="m"></i>あなた</span>
</section>
<div class="st-board"></div>
<canvas class="st-fx" width="1920" height="1080"></canvas>
<div class="st-overlay"></div>
`

export class StageView {
  private readonly root: HTMLDivElement
  private readonly fx: Particles
  private readonly venue: Venue
  private readonly machine: DrawMachine
  private dc: DoubleChanceStage | null = null
  private quest: MoleQuestStage | null = null
  private lastOne: AbortController | null = null
  private lastOneBrief: { close(): void } | null = null
  private timers: number[] = []
  private cancelBeats: () => void = () => {}
  private drawn = new Set<number>()
  private last = 0
  private scene: BgmScene = 'reception'
  private firstBingo = false
  private resultTimer = 0

  constructor(
    host: HTMLElement,
    hub: LocalHub,
    private readonly clock: Clock,
    venueSource: VenueSource,
  ) {
    this.root = h('div', 'stage', STAGE_HTML)
    host.append(this.root)
    fit(this.root, 1920, 1080)
    this.fx = new Particles(this.$<HTMLCanvasElement>('.st-fx'))
    this.venue = new Venue(this.$<HTMLCanvasElement>('.st-venue canvas'), this.$('.st-venue-label'), venueSource)
    this.machine = new DrawMachine(this.root, { speed: clock.speed })
    this.buildBoard()
    hub.subscribe((m) => this.on(m))
  }

  private $<T extends HTMLElement = HTMLElement>(selector: string): T {
    return q<T>(this.root, selector)
  }

  private on(m: Msg): void {
    switch (m.type) {
      case 'snapshot':
        return this.onSnapshot(m)
      case 'joined': {
        const count = this.root.querySelector('.rcp-count b')
        if (count) count.textContent = fmt(m.count)
        // デモの案内（スマホ枠の「参加する」）は、参加したら消す
        this.root.querySelector('.rcp-join')?.classList.toggle('done', m.meJoined)
        return
      }
      case 'eventPlay':
        return this.onEvent(m)
      case 'finalBall':
        this.hideOverlay()
        this.setScene('final')
        this.eventOn(m.durationMs)
        void playFinalBall(this.root, { speed: this.clock.speed, prizesLeft: m.prizesLeft })
        return
      case 'drawScheduled':
        return this.onScheduled(m)
      case 'awaitPush':
        this.machine.awaitPush()
        return
      case 'numberRevealed':
        return this.onRevealed(m)
      case 'questBrief':
        return this.onQuestBrief(m)
      case 'questStart':
        return this.onQuestStart(m)
      case 'lastOneBrief':
        this.eventOn()
        this.lastOneBrief?.close()
        this.lastOneBrief = openLastOneBrief(this.root, { speed: this.clock.speed, prizes: m.prizes, entrants: m.entrants, autoMs: m.autoMs })
        return
      case 'questProgress':
        this.quest?.setTotal(m.total)
        return
      case 'questResult':
        void this.onQuestResult(m)
        return
      case 'bulkDrawn':
        m.numbers.forEach((n) => this.drawn.add(n))
        this.last = m.numbers[m.numbers.length - 1]
        this.renderBoard()
        this.setTotals(m.totals)
        this.venue.refresh()
        return
      case 'prizeTime':
        return this.onPrizeTime(m)
      case 'choices':
        this.setTotals(m.totals)
        // 同じ人を 2 行に出さない。景品の行を「上位チャレンジへ」に書き換える
        for (const c of m.challengers) {
          const li = [...this.root.querySelectorAll<HTMLElement>('.st-names li')].find((x) => x.dataset.name === c.name)
          if (li) {
            li.classList.add('chal')
            const small = li.querySelector('small') ?? li.appendChild(document.createElement('small'))
            small.textContent = '上位チャレンジへ'
          } else {
            this.addNames([{ ...c, label: '上位チャレンジへ' }], 'chal')
          }
        }
        return
      case 'idle':
        this.setTotals(m.totals)
        return
      case 'gameOver':
        return this.onGameOver(m)
      case 'dcEntry':
        return this.onDcEntry(m)
      case 'dcEntrants':
        this.dc?.setEntrants(m.count)
        return
      case 'dcSpin':
        return this.onDcSpin(m)
      case 'dcEnd':
        void this.dc?.finish()
        this.later(6000, () => bgm.stop(3000))
        return
      case 'challengeDeal':
      case 'challengeEnd':
      case 'notice':
        return
    }
  }

  // ---- 受付・盤面 ----------------------------------------------------------

  private onSnapshot(m: MsgOf<'snapshot'>): void {
    this.cancelAll()
    this.resetSound()
    this.fx.clear()
    this.dc?.destroy()
    this.dc = null
    this.firstBingo = false
    this.quest?.destroy()
    this.quest = null
    this.lastOne?.abort()
    this.lastOne = null
    this.lastOneBrief?.close()
    this.lastOneBrief = null
    this.eventOff()
    this.machine.setSpeed(this.clock.speed)
    this.machine.reset()
    this.drawn = new Set(m.drawn)
    this.last = 0
    this.renderBoard()
    this.setTotals(m.totals)
    this.clearResult()
    this.venue.reset(m.size)
    this.scene = 'reception'
    bgm.play('reception')
    this.showOverlay(`
      <div class="rcp">
        <h2 class="st-head">受付中</h2>
        <div class="rcp-count"><b>0</b> / ${fmt(m.size)} 人</div>
        <p class="rcp-join">スマホで「参加する」を押してください</p>
        <div class="rcp-guide">
          <h3>演出の見方</h3>
          <p>色が熱いほど、その番号でビンゴやリーチが出やすくなります（外れることもあります）</p>
          <ol class="tier-guide">${tierGuide(TIER_WORD, '静か')}</ol>
          <p>大画面の色は <b>会場の期待度</b>、スマホの色は <b>あなたのカードの期待度</b> です。虹は、出た画面の持ち主が必ず当たります</p>
        </div>
      </div>`)
  }

  private buildBoard(): void {
    this.$('.st-board').innerHTML = LETTERS.map(
      (letter, r) =>
        `<div class="st-row"><div class="st-letter">${letter}</div>${Array.from({ length: 15 }, (_, i) => {
          const n = r * 15 + i + 1
          return `<div class="st-cell" data-n="${n}">${n}</div>`
        }).join('')}</div>`,
    ).join('')
  }

  private renderBoard(): void {
    this.root.querySelectorAll<HTMLElement>('.st-cell').forEach((cell) => {
      const n = Number(cell.dataset.n)
      cell.classList.toggle('on', this.drawn.has(n))
      cell.classList.toggle('last', n === this.last)
    })
  }

  private setTotals(t: Totals): void {
    const set = (k: string, v: string) => {
      this.$(`[data-k="${k}"]`).textContent = v
    }
    set('size', fmt(t.size))
    set('reach', fmt(t.reachHolders))
    set('bingo', fmt(t.winners))
    set('lower', String(t.lowerLeft))
    set('upper', String(t.upperLeft))
    set('chal', fmt(t.challengers))
    set('remaining', String(t.remaining))
    set('hits', String(t.hitsLeft))
    // 誰も挑んでいない間は、用語だけが浮くので出さない
    this.$('.st-chal').classList.toggle('off', t.challengers === 0)
    // BGM は会場の局面で切り替える（序盤 → リーチ期 → ビンゴ期 → オーラス）
    if (t.phase === 'playing') {
      if (t.lowerLeft <= 3 && t.winners > 0) this.setScene('final')
      else if (t.winners > 0) this.setScene('bingo')
      else if (t.reachHolders >= t.size * 0.05) this.setScene('reach')
      else this.setScene('early')
    }
  }

  private setScene(scene: BgmScene): void {
    const order: BgmScene[] = ['reception', 'early', 'reach', 'bingo', 'final', 'cooldown']
    if (order.indexOf(scene) < order.indexOf(this.scene)) return // 局面は戻さない
    this.scene = scene
    bgm.play(scene)
  }

  // ---- イベント -------------------------------------------------------------

  // 全画面のイベントの間は、前の抽選のカード・結果・会場ビューを隠し、HUD と盤を暗くする
  // （終わった抽選の色と言葉が、別のイベントの最中に見えると、意味がぶつかる）。ms を渡すと、その時間で戻す
  private eventOn(ms?: number): void {
    this.root.classList.add('is-event')
    if (ms !== undefined) this.later(ms, () => this.eventOff())
  }

  private eventOff(): void {
    this.root.classList.remove('is-event')
  }

  private onEvent(m: MsgOf<'eventPlay'>): void {
    this.hideOverlay()
    this.cancelAll()
    this.clearResult()
    this.eventOn(m.durationMs)
    void playAllKakutei(this.root, { speed: this.clock.speed, total: m.total, newReach: m.newReach, newDouble: m.newDouble })
    this.later(m.resultAt - 2500, () => this.venue.rainbow())
    this.later(m.resultAt, () => {
      this.setTotals(m.totals)
      this.venue.refresh()
    })
  }

  // 緊急クエスト「モグラ撃退」。まず説明の画面を出して、司会の「スタート」を待つ
  private onQuestBrief(m: MsgOf<'questBrief'>): void {
    this.hideOverlay()
    this.cancelAll()
    this.clearResult()
    this.eventOn()
    this.quest?.destroy()
    this.quest = new MoleQuestStage(this.root, { speed: this.clock.speed })
    this.quest.brief({ playMs: m.playMs, targets: m.targets, players: m.players, autoMs: m.autoMs })
  }

  // 「3・2・1」のあと、会場全員がスマホで叩いている様子と合計、結果を見せる
  private onQuestStart(m: MsgOf<'questStart'>): void {
    this.hideOverlay()
    this.eventOn()
    this.quest ??= new MoleQuestStage(this.root, { speed: this.clock.speed })
    this.quest.setSpeed(this.clock.speed)
    this.quest.start({ introMs: m.introMs, playMs: m.playMs, targets: m.targets, players: m.players })
  }

  private async onQuestResult(m: MsgOf<'questResult'>): Promise<void> {
    const quest = this.quest
    this.setTotals(m.totals)
    this.venue.refresh()
    if (!quest) return
    quest.setSpeed(this.clock.speed) // 結果は、いまの速度で見せる（権威の待ち時間とそろえる）
    await quest.result({ total: m.total, targets: m.targets, defended: m.defended, lost: m.lost, lostReach: m.lostReach, top: m.top })
    if (this.quest !== quest) return
    quest.destroy()
    this.quest = null
    this.eventOff()
  }

  // ---- 抽選 -----------------------------------------------------------------

  private onScheduled(m: MsgOf<'drawScheduled'>): void {
    this.hideOverlay()
    this.cancelAll()
    this.clearResult()
    this.eventOff()
    this.setScene('early')
    this.machine.setSpeed(this.clock.speed)
    this.machine.reset()
    this.machine.setPool(Array.from({ length: 75 }, (_, i) => i + 1).filter((n) => !this.drawn.has(n)))
    this.machine.start(m.beats, m.plan, m.style)
    // 会場ビュー（デモ専用）は、赤以上の溜めでリーチの人のスマホが光る様子を見せる
    this.cancelBeats = this.clock.run(
      m.beats.filter((b) => b.kind === 'sea'),
      () => this.venue.sea(),
    )
  }

  private onRevealed(m: MsgOf<'numberRevealed'>): void {
    this.cancelBeats()
    // 番号は、主役のカードが開いた瞬間（着地）に、右の欄・盤・会場ビューにも出す。先に脇で見せない。
    // カードの帯は、着地のあと結果の言葉に差し替える（「ビンゴが出そう！」のまま残さない）
    let shown = false
    const show = () => {
      if (shown) return
      shown = true
      window.clearTimeout(this.resultTimer)
      this.showResult(m)
    }
    void this.machine.reveal(m.n, m.tier, { onLand: show, result: resultWord(m) })
    this.resultTimer = window.setTimeout(show, this.clock.scale(1500)) // 着地の合図が来なかったときの保険
    this.timers.push(this.resultTimer)
  }

  private showResult(m: MsgOf<'numberRevealed'>): void {
    this.drawn.add(m.n)
    this.last = m.n
    this.venue.reveal(m.n, m.totals.drawCount)
    this.renderBoard()
    this.setTotals(m.totals)
    this.$('.st-result').classList.add('on')
    this.$('.st-last b').textContent = m.label
    // 人数の数え上げは、番号を見せたあとに始める
    const dur = this.clock.scale(900)
    this.later(250, () => {
      countUp(this.$('[data-r="hits"]'), m.hits, dur)
      countUp(this.$('[data-r="reach"]'), m.newReach, dur, '+')
      countUp(this.$('[data-r="bingo"]'), m.newBingo, dur)
      this.$('.chip-bingo').classList.toggle('hot', m.newBingo > 0)
    })
    const list = this.$('.st-names')
    list.innerHTML = ''
    this.addNames(m.challengeWins.map((x) => ({ ...x, label: '上位チャレンジ成功' })), 'chal')
    this.addNames(m.names, '')
    if (m.newBingo > m.names.length) list.append(h('li', 'more', `ほか ${fmt(m.newBingo - m.names.length)} 人`))
    this.fitNames()
    const wins = m.newBingo + m.challengeWins.length
    if (wins > 0) {
      this.later(600, () => {
        sfx.fanfare(wins >= 10 ? 'big' : wins >= 3 ? 'medium' : 'small')
        this.fx.speed = this.clock.speed
        this.fx.rain(Math.min(1000, 160 + 60 * wins), RAINBOW)
      })
      if (!this.firstBingo) {
        this.firstBingo = true
        this.setScene('bingo')
      }
    }
  }

  private addNames(names: { name: string; isMe: boolean; label?: string }[], cls: string): void {
    const list = this.$('.st-names')
    names.forEach((x, i) => {
      const li = h('li', [cls, x.isMe ? 'me' : ''].join(' ').trim(), `<span>${x.isMe ? 'あなた' : esc(x.name)}</span>${x.label ? `<small>${x.label}</small>` : ''}`)
      li.dataset.name = x.name
      li.style.animationDelay = `${this.clock.scale(400 + 150 * i)}ms`
      list.append(li)
    })
  }

  // 名前は会場がいちばん沸く情報なので、大きく出す。名前があるときは、会場ビュー（デモ用）の場所まで欄を広げる。
  // 3 人までは 1 列で特大、それより多ければ 2 列
  private fitNames(): void {
    const count = this.$('.st-names').children.length
    this.root.classList.toggle('has-names', count > 0)
    this.$('.st-names').classList.toggle('few', count > 0 && count <= 3)
  }

  private clearResult(): void {
    this.$('.st-result').classList.remove('on')
    this.$('.st-last b').textContent = '--'
    for (const k of ['hits', 'reach', 'bingo']) this.$(`[data-r="${k}"]`).textContent = ''
    this.$('.chip-bingo').classList.remove('hot')
    this.$('.st-names').innerHTML = ''
    this.fitNames()
  }

  // ---- 景品（当たった瞬間はスマホで見せる。大画面は名前と結果だけ） --------

  private onPrizeTime(m: MsgOf<'prizeTime'>): void {
    const list = this.$('.st-names')
    list.innerHTML = ''
    // 【C】のような記号だけでは伝わらないので、「景品 C」と書く
    const label = (e: PrizeEntry) =>
      e.rarity === null
        ? 'ガラポンで外れ'
        : `${e.kind === 'challenge' ? 'チャレンジ成功 ' : ''}景品 ${e.rarity}${e.rankUp ? '（ランクアップ）' : ''}`
    this.addNames(
      m.entries.slice(0, 12).map((e) => ({ name: e.name, isMe: e.isMe, label: label(e) })),
      '',
    )
    if (m.entries.length > 12) list.append(h('li', 'more', `ほか ${fmt(m.entries.length - 12)} 人`))
    this.fitNames()
    if (m.lastOne) {
      this.eventOn(m.lastOne.durationMs)
      const pool = m.entries.filter((e) => e.kind === 'normal')
      this.lastOneBrief?.close()
      this.lastOneBrief = null
      this.lastOne?.abort()
      this.lastOne = new AbortController()
      void playLastOneGarapon(this.root, {
        signal: this.lastOne.signal,
        speed: this.clock.speed,
        prizes: pool.filter((e) => e.rarity).length,
        dropAt: m.lastOne.dropAt,
        durationMs: m.lastOne.durationMs,
        entrants: pool.map((e) => ({ name: e.name, isMe: e.isMe, win: e.rarity !== null })),
      })
    }
  }

  private onGameOver(m: MsgOf<'gameOver'>): void {
    this.setTotals(m.totals)
    this.showOverlay(`
      <div class="fin">
        <h2 class="st-head">すべての景品の当選者が決まりました！</h2>
        <div class="fin-stats"><span>抽選 <b>${m.totals.drawCount}</b> 回</span><span>ビンゴ <b>${fmt(m.totals.winners)}</b> 人</span></div>
        <p>${m.leftoverUpper ? `残った上位景品 ${m.leftoverUpper} 個は、ダブルチャンスに回ります。` : ''}このあと、ダブルチャンス！</p>
      </div>`)
    sfx.fanfare('big')
    this.fx.rain(500, RAINBOW)
  }

  // ---- ダブルチャンス -------------------------------------------------------

  private onDcEntry(m: MsgOf<'dcEntry'>): void {
    this.hideOverlay()
    this.cancelAll()
    this.eventOn()
    this.setScene('cooldown')
    this.dc?.destroy()
    // デモでは同じ PC から鳴るので、自分がガラポンを回すときは音をスマホ側に任せる（本番は大画面が鳴らす）
    this.dc = new DoubleChanceStage(this.root, { speed: this.clock.speed, sound: !m.meEligible })
    this.dc.entry(m.seconds)
  }

  private onDcSpin(m: MsgOf<'dcSpin'>): void {
    const dc = this.dc
    if (!dc) return
    dc.setEntrants(m.entrants)
    dc.spin()
    m.winners.forEach((w, i) => this.later(5000 + i * 900, () => dc.addWinner(w)))
  }

  // ---- 共通 -----------------------------------------------------------------

  private showOverlay(html: string): void {
    const ov = this.$('.st-overlay')
    ov.innerHTML = html
    ov.classList.add('on')
  }

  private hideOverlay(): void {
    this.$('.st-overlay').classList.remove('on')
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, this.clock.scale(ms)))
  }

  private cancelAll(): void {
    this.cancelBeats()
    this.timers.forEach((t) => window.clearTimeout(t))
    this.timers = []
  }

  // 新しいゲームで抽選の途中から抜けたとき、伸ばしていた音と下げていた BGM を戻す
  private resetSound(): void {
    sfx.silence()
    engine.duckBgm(1)
  }
}

// 番号が出たあと、カードの帯に出す結果の言葉（会場で何が起きたか）
function resultWord(m: MsgOf<'numberRevealed'>): string {
  if (m.newBingo > 0) return `ビンゴ ${fmt(m.newBingo)} 人！`
  if (m.challengeWins.length > 0) return `チャレンジ成功 ${fmt(m.challengeWins.length)} 人！`
  if (m.newReach > 0) return `リーチ +${fmt(m.newReach)} 人`
  return 'ビンゴなし'
}

// 会場ビュー: 仮想参加者全員のスマホを点で並べる（デモ専用。一人では見られない「会場が光る」様子を見る窓）
class Venue {
  private readonly ctx: CanvasRenderingContext2D
  private mode: 'idle' | 'sea' | 'rainbow' = 'idle'
  private flashN = 0
  private flashDraw = 0
  private flashUntil = 0
  private spotUntil = 0
  private until = 0
  private raf = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly label: HTMLElement,
    private readonly source: VenueSource,
  ) {
    this.ctx = canvas.getContext('2d')!
  }

  reset(size: number): void {
    const step = Math.max(1, Math.ceil(size / 1000))
    this.label.textContent = `会場ビュー（デモ: 仮想 ${fmt(size)} 台${step > 1 ? `・1/${step} を表示` : ''}）`
    this.mode = 'idle'
    this.flashN = 0
    this.refresh()
  }

  sea(): void {
    this.mode = 'sea'
    this.run(5000)
  }

  rainbow(): void {
    this.mode = 'rainbow'
    this.run(5000)
  }

  reveal(n: number, drawNo: number): void {
    this.mode = 'idle'
    this.flashN = n
    this.flashDraw = drawNo
    this.flashUntil = performance.now() + 1500
    this.spotUntil = performance.now() + 5000
    this.run(5100)
  }

  refresh(): void {
    this.draw(performance.now())
  }

  private run(ms: number): void {
    this.until = Math.max(this.until, performance.now() + ms)
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.loop(t))
  }

  private loop(t: number): void {
    this.draw(t)
    if (t < this.until) {
      this.raf = requestAnimationFrame((tt) => this.loop(tt))
    } else {
      this.raf = 0
      this.mode = 'idle'
      this.draw(t)
    }
  }

  private draw(t: number): void {
    const players = this.source()
    const { ctx, canvas } = this
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)
    if (!players.length) return
    const step = Math.max(1, Math.ceil(players.length / 1000))
    const count = Math.ceil(players.length / step)
    const cols = Math.ceil(Math.sqrt((count * W) / H))
    const rows = Math.ceil(count / cols)
    const pitch = Math.min(W / cols, H / rows)
    const dot = Math.max(2, pitch * 0.7)
    const ox = (W - cols * pitch) / 2
    const oy = (H - rows * pitch) / 2
    const flash = t < this.flashUntil ? (this.flashUntil - t) / 1500 : 0
    const spot = t < this.spotUntil
    let k = 0
    for (let i = 0; i < players.length; i += step, k++) {
      const p = players[i]
      let color = '#1c2445'
      if (this.mode === 'rainbow') {
        color = `hsl(${(t / 11 + k * 7) % 360} 90% 62%)` // 明るさは一定のまま、色だけゆっくり回す
      } else if (spot && p.bingoDraw === this.flashDraw) {
        color = `hsl(${(t / 6 + k * 13) % 360} 95% 65%)` // 今回ビンゴの人を虹色に（係員が見つける目印にもなる）
      } else if (flash > 0 && p.cells.includes(this.flashN)) {
        color = `rgba(245, 197, 66, ${0.35 + 0.65 * flash})`
      } else if (p.challenge) {
        color = '#b98cff'
      } else if (p.bingoDraw !== null) {
        color = '#8a6d1d'
      } else if (p.reach > 0) {
        color = this.mode === 'sea' ? `rgba(255, 90, 60, ${0.6 + 0.4 * Math.sin(t / 159)})` : '#5c2a20'
      }
      const x = ox + (k % cols) * pitch + (pitch - dot) / 2
      const y = oy + Math.floor(k / cols) * pitch + (pitch - dot) / 2
      ctx.fillStyle = color
      ctx.fillRect(x, y, dot, dot)
      if (p.isMe) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 2
        ctx.strokeRect(x - 2, y - 2, dot + 4, dot + 4)
      }
    }
  }
}

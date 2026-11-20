import { engine, sfx } from '../audio'
import { FREE_MASK, bingoCells, deriveCard, labelOf, lineState, popcount, waitingCells } from '../core/card'
import { CH_FREE, CH_LINES, challengeBingo } from '../core/game'
import { MY_TIER_WORD, TIER_QUIET } from '../core/show'
import type { Rarity } from '../core/prizes'
import type { Clock } from '../demo/clock'
import { playBingo, playReach, playWildResult, type AoriOutcome } from '../fx/phone/aori'
import { CardView } from '../fx/phone/card'
import { AWARD_NAME, BALL_INFO, askEntry, playFinalResult, playGarapon } from '../fx/phone/garapon'
import { openLastOneBrief, playLastOneGarapon } from '../fx/phone/lastone'
import { askChoice, playChallengeResult, playChallengeStart, playPackOpen } from '../fx/phone/prize'
import { MoleQuest } from '../fx/phone/quest'
import { HandSpin } from '../fx/phone/spin'
import { numHtml } from '../fx/phone/ball'
import { RARITY_NAME, type BallColor } from '../fx/theme'
import type { LocalHub } from '../net/hub'
import type { LiveState, Msg, MsgOf, PhoneCommand, PrizeEntry, Totals, Who } from '../net/protocol'
import { esc, fit, fmt, h, q, replay, tierGuide } from './dom'

// 参加者のスマホ（390×844 で組んで縮小表示する）。カード・手元の抽選演出・緊急クエスト・景品・ガラポンの演出は fx/ の部品。
// 自分のカードはシードとカード番号から手元で作り、届いた番号で自分で塗る（本番と同じ）。
// 抽選は大画面と同じ拍で溜め、番号は大画面と同時に開く。熱さだけを自分のカードに合わせる。
//
// 画面の並び（上から）: 名前と番号・右上のボタン → リーチの帯 → カード → 出た番号（いまの番号と、これまでの番号）→ 知らせ → 景品 →
// 会場のようす（いちばん下）。カードの位置（y 約 112〜518）は演出の部品が前提にしているので動かさない。
// 番号は、どこでも「列の文字の玉 ＋ 数字」（fx/phone/ball.ts の numHtml）で見せる。
//
// 会場のようす: 大画面に出ていること（ビンゴした人・景品の残り・モグラ撃退の結果・ダブルチャンスの当たりなど）を、
// 大画面が見えない人（オンラインで参加する人）のために、いちばん下に控えめに出す（主役は自分のカードと手元の演出）。
// 出すのは、大画面と同じ瞬間か、それより後。番号の結果は、自分の結果（あおり → 着地 → スタンプ）が終わってから

const PHONE_HTML = `
<div class="ph-status"><span class="ph-time">9:41</span><span>●●● 100%</span></div>
<div class="ph-head">
  <div class="ph-who"><b class="ph-name">あなた</b><small class="ph-no"></small></div>
  <div class="ph-tools"><button class="ph-help" type="button" aria-label="色の見方"><i>？</i></button></div>
</div>
<div class="ph-chips"><div class="ph-wait"></div></div>
<div class="ph-cardhost"></div>
<div class="ph-rule"></div>
<div class="ph-drawn">
  <div class="ph-latest"><small>いま出た番号</small><b class="ph-latest-n none">--</b></div>
  <div class="ph-past"><small>これまで <b class="ph-drawn-n">0</b> 個</small><div class="ph-history"></div></div>
</div>
<div class="ph-note"></div>
<div class="ph-prize"></div>
<div class="ph-venue">
  <div class="ph-venue-h"><b>会場では</b><span class="ph-count"></span></div>
  <div class="ph-stats">
    <span><small>ビンゴ</small><b data-k="bingo">0</b><small>人</small></span>
    <span><small>リーチ</small><b data-k="reach">0</b><small>人</small></span>
    <span><small>景品 残り</small><b data-k="lower">0</b><small>個</small></span>
  </div>
  <div class="ph-news"></div>
</div>
<div class="ph-toast"></div>
<div class="ph-overlay"></div>
`

const HISTORY_MAX = 8 // 「これまで」に並べる番号の数（いま出た番号は別に大きく出す）
const NAMES_MAX = 3 // 会場のようすに並べる名前の数（あとは「ほか N 人」）
const DC_WIN_AT = 5000 // ダブルチャンスの当たった人が、大画面に出はじめる時刻（ガラポンが始まってから。ui/stage.ts と同じ）
const DC_WIN_GAP = 900 // 2 人目からの間隔

// 演出の見方（色 → 自分のカードに何が起きそうか）。参加の画面と、右上の「？」で出す
const GUIDE_HTML = `
<div class="ph-guide">
  <h4>色の見方</h4>
  <p>次の番号が <b>あなたのカード</b>にありそうなほど、青 → 緑 → 赤 → 金に変わります（なかった、もあります）。</p>
  <ol class="tier-guide">${tierGuide(MY_TIER_WORD, TIER_QUIET)}</ol>
  <p>色は <b>あなただけ</b>のもの。となりの人とは違います。虹が出たら、ビンゴ確定！</p>
</div>`

// 本番（サーバーにつないだ本物のスマホ）用の指定。何も渡さなければ、いままでのデモ
export interface PhoneOptions {
  // 枠とにせもののステータスバーを出さない・音は自分のスマホから全部鳴らす・参加はもう済んでいる（最初の画面は「はじめる」）・
  // つなぎ直したら snapshot.live からいまの状態に戻る・モグラ撃退の途中経過を送る
  live?: boolean
}

// 本番のスマホの音の切りかえ（右上のボタン）。最初は音なし: 会場では大画面から鳴るので、1,000 台が一斉に鳴るとうるさい。
// 会場の外から参加する人は大画面の音が聞こえないので、自分で入れられるようにする。選んだものはスマホに残す
const SOUND_KEY = 'bingoo:sound'
const SPEAKER = (on: boolean) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>${
    on
      ? '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
      : '<path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  }</svg>`

function loadSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1'
  } catch {
    return false
  }
}

function saveSound(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? '1' : '0')
  } catch {
    // 残せなくても、この画面の間は効く
  }
}

// 本番で、受付中に「はじめる」を押した人に出しておく知らせ（ゲームが動き出したら消す）
const WAIT_NOTE = '始まるまで、このまま待っていてね'
// 本番で、終わったあとにつないだ人に出す（締めくくりの画面と同じ言葉）
const END_NOTE = 'おつかれさまでした。ご参加ありがとうございました'
// ダブルチャンスの知らせ（大画面が見えない人もいるので、「大画面で」とは書かない。当たった人は、会場のようすの欄に出る）
const DC_TAKEN_NOTE = '景品をもらった人は、ダブルチャンスはお休み。発表を楽しんでね'
const DC_SPIN_NOTE = 'ダブルチャンスの当たりを発表中！'
const QUEST_REPORT_MS = 2000 // モグラ撃退の途中経過を送る間隔

interface MyChallenge {
  cells: number[]
  mask: number
  target: Rarity
  view: CardView
}

// 開けた番号が自分のカードにとって何だったか（手元で計算する）
interface Judge {
  n: number
  outcome: AoriOutcome
  cell: number // 本カードのマス（なければ -1）
  chCell: number // チャレンジカードのマス（なければ -1）
  reachBefore: number
  reachAfter: number
  justWon: boolean
  chWon: boolean
}

export class PhoneView {
  private readonly root: HTMLDivElement
  private readonly card: CardView
  private readonly spin: HandSpin
  private readonly quest: MoleQuest
  private cells: number[] = []
  private mask = FREE_MASK
  private filled = 0
  private wild = 0
  private won = false
  private joined = false
  private rank = 0
  private name = 'あなた'
  private cardNo = 0
  private history: number[] = []
  private stats = { hits: 0, maxReach: 0, nearMiss: 0, won: undefined as string | undefined }
  private challenge: MyChallenge | null = null
  private generation = 0
  private drawNo = 0 // いまの抽選
  private celebration: Promise<void> = Promise.resolve() // 当たりの演出が終わるまで（景品パックはその後に出す）
  private lastOneBrief: { close(): void } | null = null
  private lastOneOn = false // ラストワン争奪の説明の画面を出してよい間（ガラポンが始まったら出さない）
  private noteTimer = 0
  private dcEnded: Promise<void> = Promise.resolve() // 大画面の締めくくり（スマホの最後の結果は、これに合わせて出す）
  private dcEndNow: (() => void) | null = null
  private dcEligible = true
  private readonly live: boolean
  private begun = false // 本番: 「はじめる」を押した（つなぎ直しで、参加の画面をもう一度出さない）
  private soundOn = false // 本番: 自分のスマホから音を出す
  private waitNote = false // 本番: 「始まるまで…」の知らせを出している
  private venueDraw = 0 // 会場のようすに出した、いちばん新しい抽選（古い抽選の結果で上書きしない）
  private prizeHead = '' // いちばん新しい抽選の見出し（「(O)61 ビンゴ 2 人！」）。景品が決まったときに、そのまま使う
  private timers: number[] = [] // 会場のようすを、大画面に合わせて遅れて出す予定（新しいゲームで取り消す）
  private game = '' // いまのゲーム（シードと山の控え）。景品の発表を見たと送ったかを、ゲームをまたいで取り違えないように
  private seenPrize = '' // 「景品の発表を見た」を送った発表（つなぎ直しで同じ発表が届いても、2 回は送らない）

  constructor(
    host: HTMLElement,
    hub: LocalHub,
    private readonly clock: Clock,
    private readonly send: (cmd: PhoneCommand) => void,
    opts: PhoneOptions = {},
  ) {
    this.live = opts.live ?? false
    // 画面の中身がちょうど 390×844 になるように、枠は外側の要素で描く（本番は枠なしで、画面いっぱいに合わせる）
    const frame = h('div', this.live ? 'phone-frame live' : 'phone-frame')
    this.root = h('div', this.live ? 'phone live' : 'phone', PHONE_HTML)
    frame.append(this.root)
    host.append(frame)
    if (this.live) fit(frame, 390, 844)
    else fit(frame, 410, 864)
    this.card = new CardView(this.$('.ph-cardhost'), { size: 5, speed: clock.speed })
    // デモでは大画面と同じ PC から鳴るので、手元の演出は自分だけの音にする（本番のスマホは 'all'）
    const sound = this.live ? 'all' : 'personal'
    this.spin = new HandSpin(this.root, { speed: clock.speed, sound })
    this.quest = new MoleQuest(this.root, { speed: clock.speed, sound })
    this.$('.ph-help').addEventListener('click', () => this.showGuide())
    if (this.live) this.setupSound()
    hub.subscribe((m) => this.on(m))
  }

  // 本番: 音の切りかえのボタン。ブラウザは、画面に触れたあとでないと音を出させないので、
  // 音ありを選んでいる人は、最初に触れたときに音の仕組みを起こす（読み込み直したあとも、どこかに触れれば鳴る）
  private setupSound(): void {
    const btn = h('button', 'ph-sound')
    btn.type = 'button'
    this.$('.ph-help').before(btn)
    btn.addEventListener('click', () => this.setSound(!this.soundOn))
    document.addEventListener('pointerdown', () => this.soundOn && engine.unlock(), { capture: true })
    this.setSound(loadSound(), false)
  }

  private setSound(on: boolean, tap = true): void {
    this.soundOn = on
    engine.enabled = on
    if (on) engine.unlock()
    if (tap) {
      saveSound(on)
      if (on) sfx.uiTap() // 入れたら、すぐ小さく鳴らして、聞こえるか分かるようにする
    }
    const btn = this.$<HTMLButtonElement>('.ph-sound')
    btn.innerHTML = `${SPEAKER(on)}<span>${on ? '音あり' : '音なし'}</span>`
    btn.classList.toggle('on', on)
    btn.setAttribute('aria-pressed', String(on))
    btn.setAttribute('aria-label', on ? '音を消す' : '音を出す')
  }

  private $<T extends HTMLElement = HTMLElement>(selector: string): T {
    return q<T>(this.root, selector)
  }

  private get speed(): number {
    return this.clock.speed
  }

  private on(m: Msg): void {
    if (this.waitNote && (m.type === 'drawScheduled' || m.type === 'eventPlay' || m.type === 'questBrief' || m.type === 'questStart')) {
      this.waitNote = false
      this.setNote('')
    }
    switch (m.type) {
      case 'snapshot':
        return this.onSnapshot(m)
      case 'joined':
        this.setCount(m.count)
        return
      case 'eventPlay':
        if (!this.joined) this.join()
        return this.onEvent(m)
      case 'finalBall':
        // 大画面の「この 1 球で景品がなくなる」と同時に（結果ではなく、これから起きることなので、先に出してよい）
        this.setNews(`<b>この 1 球で景品がなくなる！</b><span>景品 残り ${fmt(m.prizesLeft)} 個</span>`)
        return
      case 'idle':
        this.setTotals(m.totals)
        return
      case 'choices':
        this.setTotals(m.totals)
        if (m.challengers.length) this.setNews(`<b>上位チャレンジに挑戦！</b>${this.namesHtml(m.challengers)}`)
        return
      case 'questProgress':
        this.quest.setTotal(m.total)
        return
      case 'dcEntrants':
        this.setNews(`<b>ダブルチャンス</b><span>エントリー ${fmt(m.count)} 人</span>`)
        return
      case 'drawScheduled':
        if (!this.joined) this.join() // 受付を締め切ったら自動で参加する
        this.syncSpeed()
        return this.onScheduled(m)
      case 'numberRevealed':
        void this.onRevealed(m)
        return
      case 'questBrief':
        if (!this.joined) this.join(false)
        this.syncSpeed()
        // モグラは、いま見えているカード（上位チャレンジ中は 3×3）のマスから顔を出す
        this.quest.brief(this.challenge?.view ?? this.card, { playMs: m.playMs, target: m.me.target, cell: m.me.cell, label: m.me.label, autoMs: m.autoMs })
        return
      case 'questStart':
        if (!this.joined) this.join(false)
        void this.onQuestStart(m)
        return
      case 'lastOneBrief':
        void this.onLastOneBrief(m)
        return
      case 'questResult':
        void this.onQuestResult(m)
        return
      case 'bulkDrawn':
        this.onBulk(m.numbers)
        this.setTotals(m.totals)
        return
      case 'prizeTime': {
        this.closeLastOneBrief()
        const mine = m.entries.find((e) => e.isMe)
        if (mine) {
          this.sendPrizeSeen(mine)
          void this.onMyPrize(mine, m.lastOne ? { ...m.lastOne, entries: m.entries } : null)
        }
        void this.prizeNews(m)
        return
      }
      case 'challengeDeal':
        void this.onChallengeDeal(m)
        return
      case 'challengeEnd':
        void this.onChallengeEnd()
        return
      case 'gameOver':
        // 節目の知らせは、見逃しても分かるように画面に残す（数字は会場のようすの欄に出る）
        this.setTotals(m.totals)
        this.setNews('')
        this.setNote('景品がぜんぶ出ました。このあとはダブルチャンス！')
        return
      case 'dcEntry':
        void this.onDcEntry(m)
        return
      case 'dcSpin':
        this.dcEnded = new Promise((r) => (this.dcEndNow = r))
        void this.onDcSpin(m)
        return
      case 'dcEnd':
        if (this.dcEndNow) this.dcEndNow()
        // 本番で、ガラポンのあとにつないだ人は、締めくくりの画面を持っていない。知らせだけ出す
        else if (this.live) this.setNote(END_NOTE)
        return
      default:
        return
    }
  }

  private syncSpeed(): void {
    this.card.setSpeed(this.speed)
    this.spin.setSpeed(this.speed)
    this.quest.setSpeed(this.speed)
    this.challenge?.view.setSpeed(this.speed)
  }

  // ---- 参加とカード ---------------------------------------------------------

  private onSnapshot(m: MsgOf<'snapshot'>): void {
    this.generation++
    this.spin.cancel()
    this.quest.cancel()
    this.closeLastOneBrief()
    this.drawNo = 0
    this.celebration = Promise.resolve()
    // 前のゲームで残った景品・ガラポンの画面を片付ける
    this.root.querySelectorAll('.fxg, .fxp, .fxlp').forEach((n) => n.remove())
    this.clearChallenge()
    this.name = m.me.name
    this.cardNo = m.me.cardNo
    this.game = `${m.seed}/${m.deckHash}`
    if (!m.drawn.length) this.seenPrize = '' // まだ番号が出ていない（新しいゲーム）: 景品の発表は、まだない
    this.cells = deriveCard(m.seed, m.me.cardNo)
    this.mask = FREE_MASK
    this.filled = 0
    this.wild = 0
    this.won = false
    this.rank = 0
    this.history = []
    this.stats = { hits: 0, maxReach: 0, nearMiss: 0, won: undefined }
    this.joined = false
    this.waitNote = false
    this.dcEligible = true
    this.setNote('')
    this.setPrize(null, null)
    this.dcEnded = Promise.resolve()
    this.dcEndNow = null
    this.venueDraw = 0
    this.prizeHead = ''
    this.timers.forEach((t) => window.clearTimeout(t))
    this.timers = []
    // 本番では、つないだ時点の状態（live）が付いてくる。デモでは付かない
    const live = this.live ? m.live : undefined
    this.$('.ph-name').textContent = this.name
    this.$('.ph-no').textContent = `No.${String(this.cardNo).padStart(5, '0')}`
    this.setLatest(null)
    // 会場のようす: つないだ時点の数字（本番のつなぎ直しでも、分かる範囲で出す）
    this.setTotals(m.totals)
    if (live) this.setCount(live.count)
    this.setNews('')
    this.syncSpeed()
    this.card.setCells(this.cells)
    if (live) this.restore(m.drawn, live)
    this.renderCard()
    this.renderHistory()
    if (live && live.phase !== 'reception') {
      // もう始まっている: 参加の画面は出さずに、いまのカードを見せる
      this.joined = true
      this.closeOverlay()
      return
    }
    if (this.live && this.begun) {
      // 受付中のつなぎ直し・主催のやり直し: 「はじめる」は押してあるので、新しいカードを配るだけ
      this.closeOverlay()
      this.join()
      this.setWaitNote()
      return
    }
    this.overlay(`
      <div class="ph-join">
        <div class="ph-logo">BINGOO</div>
        <p>ビンゴ大会へようこそ！</p>
        <button class="ph-join-btn">${this.live ? 'はじめる' : '参加する'}</button>
        ${
          this.live
            ? this.soundOn
              ? ''
              : `<button class="ph-join-sound">${SPEAKER(true)}音ありで はじめる</button>
        <small>会場の外から参加するなら、音ありがおすすめ。あとで右上のボタンでも切りかえられます</small>`
            : `<small>このデモでは、あなた以外の ${fmt(m.size - 1)} 人はコンピューターです</small>`
        }
        ${GUIDE_HTML}
      </div>`)
    const start = () => {
      if (this.joined) return // 閉じたあとの画面に残ったボタンが押されても、何もしない
      this.join()
      if (!this.live) return
      this.begun = true
      this.setWaitNote()
    }
    q(this.root, '.ph-join-btn').addEventListener('click', start)
    this.root.querySelector('.ph-join-sound')?.addEventListener('click', () => {
      this.setSound(true)
      start()
    })
  }

  private setWaitNote(): void {
    this.waitNote = true
    this.setNote(WAIT_NOTE)
  }

  // 本番: つないだ（つなぎ直した）時点の自分の状態を、そのまま写す。進行中だった演出は追いかけない（次のメッセージから普通に動く）
  private restore(drawn: number[], s: LiveState): void {
    this.mask = s.mask | FREE_MASK
    this.filled = s.filled
    this.wild = s.wild
    this.rank = s.rank
    this.won = s.rank > 0 || lineState(this.mask, this.filled).bingo > 0
    this.history = [...drawn]
    this.stats.hits = popcount(this.mask & ~FREE_MASK)
    this.stats.maxReach = lineState(this.mask, this.filled).reach
    if (drawn.length) this.setLatest(drawn[drawn.length - 1])
    if (s.challenge) {
      this.openChallenge(s.challenge.cells, s.challenge.target, s.challenge.mask | (1 << CH_FREE))
    } else if (s.prize) {
      this.stats.won = s.prize.name
      this.setPrize(s.prize.name, s.prize.rarity)
    }
    this.dcEligible = s.prize === null
    // 節目の知らせは、あとからつないだ人にも見えるようにする（大画面が見えない人もいるので、「大画面で」とは書かない）
    if (s.phase === 'over') this.setNote('景品がぜんぶ出ました。このあとはダブルチャンス！')
    else if (s.phase === 'dc-entry') {
      if (s.prize) this.setNote(DC_TAKEN_NOTE)
      else if (s.dcEntered) this.setNote('ダブルチャンスに参加ずみ。このまま待ってね。まもなくガラポン！')
      // 受付の途中でつなぎ直した人にも、残りの時間でエントリーの画面を出す（残りが少なすぎるときは、押しても間に合わないので出さない）
      else if (s.dcLeftMs >= 4000) void this.onDcEntry({ type: 'dcEntry', seconds: Math.floor(s.dcLeftMs / 1000), eligible: 0, meEligible: true })
      else this.setNote('いま、ダブルチャンスの受付中！')
    } else if (s.phase === 'dc-spin') this.setNote(DC_SPIN_NOTE)
    else if (s.phase === 'done') this.setNote(END_NOTE)
  }

  // 演出の見方は、参加したあとも右上の「？」から見返せる
  private showGuide(): void {
    if (!this.joined || this.$('.ph-overlay').classList.contains('on')) return
    this.overlay(`
      <div class="ph-join">
        ${GUIDE_HTML}
        <button class="ph-join-btn ph-close">閉じる</button>
      </div>`)
    q(this.root, '.ph-close').addEventListener('click', () => this.closeOverlay())
  }

  // 見逃すと困る知らせ（景品がなくなった、など）は、トーストではなく画面に残す。ms を渡すと、その時間で消す
  private setNote(text: string, ms?: number): void {
    window.clearTimeout(this.noteTimer)
    const el = this.$('.ph-note')
    el.textContent = text
    el.classList.toggle('on', text !== '')
    if (text && ms !== undefined) this.noteTimer = window.setTimeout(() => this.setNote(''), this.clock.scale(ms))
    this.fitBottom()
  }

  // 知らせと景品が両方出ていて、下が足りないとき（ゲームの終わりごろ）は、出た番号の欄を詰める（styles.css の .phone.tight）。
  // 出来事も出ていれば、会場の数字の行を省く（tight-news）。古い iPhone（iOS 15.3 まで）は :has() が効かないので、クラスで切りかえる
  private fitBottom(): void {
    const on = (s: string) => this.$(s).classList.contains('on')
    const tight = on('.ph-note') && on('.ph-prize')
    this.root.classList.toggle('tight', tight)
    this.root.classList.toggle('tight-news', tight && on('.ph-news'))
  }

  // 受け取った景品は、画面に出したままにする（会場で引き換えるときに見せられるように）
  private setPrize(prize: string | null, rarity: Rarity | null): void {
    const el = this.$('.ph-prize')
    el.classList.toggle('on', prize !== null)
    // レア度の呼び名（コモンなど）は、小さくしすぎないよう、札の中ではなく見出しの行に出す
    el.innerHTML =
      prize === null
        ? ''
        : `<small><span>あなたの景品</span>${rarity ? `<em>${RARITY_NAME[rarity]}</em>` : ''}</small><div>${
            rarity ? `<i data-r="${rarity}">${rarity}</i>` : ''
          }<b>${esc(prize)}</b></div>`
    this.fitBottom()
  }

  // deal を false にすると、カードを配る動きを省く（すぐにカードのマスの位置を測る演出が続くとき）
  private join(deal = true): void {
    if (this.joined) return
    this.joined = true
    // 本番では、名前を入れたときにもう参加している（1 万台がいっせいに送らないように、ここでは送らない）
    if (!this.live) this.send({ type: 'join' })
    this.closeOverlay()
    if (deal) void this.card.deal()
  }

  private renderCard(): void {
    const bits = (x: number) => [...Array(25).keys()].filter((i) => x & (1 << i))
    this.card.setMarks(this.mask, {
      waiting: this.won ? [] : waitingCells(this.mask, this.filled),
      line: bingoCells(this.mask),
      filled: bits(this.filled),
      wild: bits(this.wild & this.mask),
    })
    this.renderChip()
  }

  // カードの上の帯: リーチの「あと〇〇」、上がったら順位、上位チャレンジ中はそのリーチ
  private renderChip(): void {
    const el = this.$('.ph-wait')
    const lines = lineState(this.mask, this.filled).reach
    const ch = this.challenge
    // 「あと」のあとの番号は、番号の玉を並べる（ほかの所と同じ見せ方）
    const rest = (nums: number[]) => `<span class="ph-rest"><small>あと</small>${nums.map((n) => numHtml(n)).join('')}</span>`
    if (ch) {
      const left = challengeWaiting(ch.mask).map((c) => ch.cells[c])
      el.className = left.length ? 'ph-wait on chal' : 'ph-wait chal'
      el.innerHTML = `<b>上位チャレンジ中</b><small>${ch.target} ねらい</small>${left.length ? rest(left) : ''}`
    } else if (this.won) {
      el.className = 'ph-wait done'
      el.innerHTML = `<b>ビンゴ！</b>${this.rank ? `<span>第 ${this.rank} 位</span>` : ''}`
    } else if (lines) {
      el.className = 'ph-wait on'
      const kind = lines >= 3 ? 'トリプルリーチ' : lines === 2 ? 'ダブルリーチ' : 'リーチ'
      el.innerHTML = `<b>${kind}</b>${rest(waitingCells(this.mask, this.filled).map((c) => this.cells[c]))}`
    } else {
      el.className = 'ph-wait'
      el.textContent = ''
    }
  }

  private waitingLabels(): string[] {
    return waitingCells(this.mask, this.filled).map((c) => labelOf(this.cells[c]))
  }

  // これまでに出た番号（いま出た番号は除いて、新しい順）。自分のカードにあった番号は、スタンプと同じ桃色の地にする
  private renderHistory(): void {
    this.$('.ph-drawn-n').textContent = String(this.history.length)
    this.$('.ph-history').innerHTML = this.history
      .slice(-HISTORY_MAX - 1, -1)
      .reverse()
      .map((n) => `<span class="${this.cells.includes(n) ? 'mine' : ''}">${numHtml(n)}</span>`)
      .join('')
  }

  // いま出た番号（null で「--」。none のクラスで控えめにする。古い iPhone では :has() が効かないので、クラスで分ける）
  private setLatest(n: number | null): void {
    const el = this.$('.ph-latest-n')
    el.innerHTML = n === null ? '--' : numHtml(n)
    el.classList.toggle('none', n === null)
  }

  // ---- 全員確定（虹玉）の自分の結果 ------------------------------------------

  private onEvent(m: MsgOf<'eventPlay'>): void {
    const gen = this.generation
    // 会場のようす（大画面が結果を出すのと同じ時刻か、自分の結果のあと）
    const venue = () => {
      if (gen !== this.generation) return
      this.setTotals(m.totals)
      const more = [m.newReach > 0 ? `リーチ +${fmt(m.newReach)} 人` : '', m.newDouble > 0 ? `ダブルリーチ +${fmt(m.newDouble)} 人` : ''].filter(Boolean)
      this.setNews(`<b>全員確定！</b><span>${more.length ? more.join('・') : 'みんなのカードが 1 マスあいた'}</span>`)
    }
    window.setTimeout(async () => {
      const { cell, label, reachBefore, reachAfter } = m.me
      if (gen !== this.generation) return
      if (cell === null) {
        // 大画面は「全員に当たり」と言っているので、何も起きない人には理由を出す
        if (this.won) this.setNote('あなたは、もうビンゴ済み。マスがあくのは、まだビンゴしていない人のカードです', m.durationMs - m.resultAt + 2500)
        venue()
        return
      }
      await this.card.wildOpen(cell)
      this.mask |= 1 << cell
      this.wild |= 1 << cell
      this.filled &= ~(1 << cell)
      this.stats.maxReach = Math.max(this.stats.maxReach, reachAfter)
      this.renderCard()
      await playWildResult(this.root, { label, newReach: reachAfter > reachBefore, speed: this.speed })
      venue()
    }, this.clock.scale(m.resultAt))
  }

  // ---- 緊急クエスト「モグラ撃退」 ---------------------------------------------
  // 狙われた人は自分のリーチのマスを守るために叩く。やられるのは、叩いた数が会場の下位に入った人

  private async onQuestStart(m: MsgOf<'questStart'>): Promise<void> {
    const gen = this.generation
    this.syncSpeed()
    // モグラは、いま見えているカード（上位チャレンジ中は 3×3）のマスから顔を出す
    const card = this.challenge?.view ?? this.card
    const stopReport = this.live ? this.reportQuest() : null
    const score = await this.quest.play(card, { introMs: m.introMs, playMs: m.playMs, target: m.me.target, cell: m.me.cell, label: m.me.label })
    stopReport?.()
    if (gen === this.generation) this.send({ type: 'questScore', score })
  }

  // 本番: たたいている間、いまの数をときどき送る（大画面の「会場でたたいた数」が、たたいている最中に増えていくように）。
  // 全員が同じ瞬間に送らないよう、最初の 1 回までの間を人ごとにずらす。戻り値で止める
  private reportQuest(): () => void {
    let sent = 0
    let interval = 0
    const report = () => {
      const score = this.quest.current
      if (score === sent) return
      sent = score
      this.send({ type: 'questProgress', score })
    }
    const first = window.setTimeout(() => {
      report()
      interval = window.setInterval(report, QUEST_REPORT_MS)
    }, Math.random() * QUEST_REPORT_MS)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(interval)
    }
  }

  private async onQuestResult(m: MsgOf<'questResult'>): Promise<void> {
    const gen = this.generation
    const me = m.me
    this.quest.setSpeed(this.speed) // 結果は、いまの速度で見せる（権威の待ち時間とそろえる）
    await this.quest.result({ score: me.score, lost: me.lost, need: me.need, total: m.total, rank: me.rank, players: m.totals.size })
    if (gen !== this.generation) return
    // 会場のようす: 自分の結果を見せ終わってから（大画面は、もう結果を出している）
    this.setTotals(m.totals)
    const sum =
      m.targets > 0
        ? `<span><i class="ok">◆</i>守りきった ${fmt(m.defended)} 人</span><span><i class="ng">▼</i>やられた ${fmt(m.lost)} 人</span>`
        : `<span>会場みんなで ${fmt(m.total)} 匹</span>`
    const king = m.top.length ? `<em class="ph-news-sub">★ 撃退王 ${this.namesHtml(m.top)}</em>` : ''
    this.setNews(`<b>モグラ撃退</b>${sum}${king}`)
    if (!me.lost || me.cell === null) return
    this.mask &= ~(1 << me.cell)
    this.wild &= ~(1 << me.cell)
    this.filled |= 1 << me.cell
    this.renderCard()
  }

  // ---- 抽選（自分の段階で溜め、番号は大画面と同時に出る） ----------------------

  private onScheduled(m: MsgOf<'drawScheduled'>): void {
    const drawn = new Set(this.history)
    this.drawNo = m.drawNo
    this.spin.start({
      tier: m.personal.tier,
      waiting: m.personal.waiting,
      pool: Array.from({ length: 75 }, (_, i) => i + 1).filter((n) => !drawn.has(n)),
      beats: m.personal.beats,
      revealAt: m.revealAt,
      venueBeats: m.beats, // 番号が見える瞬間を、大画面の抽選機に合わせる
      venueVariant: m.style,
    })
  }

  // 大画面の公開と同時に手元でも番号に着地させ、自分のカードに押す
  private async onRevealed(m: MsgOf<'numberRevealed'>): Promise<void> {
    if (m.drawNo !== this.drawNo) {
      // 本番で、抽選の途中からつないだ: 回す演出は見ていないので、番号だけをカードに押す（押しそこねると、カードがずれたままになる）
      if (this.live) this.catchUp(m)
      return
    }
    const gen = this.generation
    let done = () => {}
    this.celebration = new Promise<void>((r) => (done = r))
    let told = false
    // 会場の結果は、自分の結果（着地 → 当たり・はずれ → スタンプ・リーチ）のあとに出す。途中で抜けても、同じゲームなら必ず出す
    const venue = () => {
      if (told || gen !== this.generation) return
      told = true
      this.drawVenue(m)
    }
    try {
      const j = this.judge(m.n)
      if (j.justWon) this.rank = m.totals.winners - m.newBingo + 1
      // いま出た番号と、これまでの番号は、手元の演出の下に先に出しておく（演出が引っ込むと見える）
      this.setLatest(m.n)
      replay(this.$('.ph-latest'), 'pop')
      this.history.push(m.n)
      this.renderHistory()
      await this.spin.reveal(m.n)
      if (gen !== this.generation) return
      await this.spin.resolve({ outcome: j.outcome, label: m.label })
      if (gen !== this.generation) return
      await this.applyNumber(j)
      venue()
      if (gen !== this.generation || !j.justWon) return
      await playBingo(this.root, { rank: this.rank, speed: this.speed })
    } finally {
      venue()
      done()
    }
  }

  // 会場のようすに、この番号の結果を出す（大画面の結果の欄と同じ言葉）。古い抽選の結果で、新しい結果を上書きしない
  private drawVenue(m: MsgOf<'numberRevealed'>): void {
    if (m.drawNo < this.venueDraw) return
    this.venueDraw = m.drawNo
    this.setTotals(m.totals)
    const parts: string[] = []
    if (m.newBingo > 0) parts.push(`<b>ビンゴ ${fmt(m.newBingo)} 人！</b>${this.namesHtml(m.names, m.newBingo)}`)
    if (m.challengeWins.length > 0) parts.push(`<b>チャレンジ成功 ${fmt(m.challengeWins.length)} 人！</b>${this.namesHtml(m.challengeWins)}`)
    if (!parts.length) parts.push(m.newReach > 0 ? `<b>リーチ +${fmt(m.newReach)} 人</b>` : '<span>ビンゴなし</span>')
    this.setNews(`${numHtml(m.n)}${parts.join('')}`, m.newBingo + m.challengeWins.length > 0)
    // 景品が決まったら、この見出し（「ビンゴ 2 人！」）のまま、名前に景品のレア度を添える
    this.prizeHead = m.newBingo > 0 ? `${numHtml(m.n)}<b>ビンゴ ${fmt(m.newBingo)} 人！</b>` : m.challengeWins.length > 0 ? `${numHtml(m.n)}<b>チャレンジ成功 ${fmt(m.challengeWins.length)} 人！</b>` : ''
  }

  private catchUp(m: MsgOf<'numberRevealed'>): void {
    if (this.history.includes(m.n)) return
    const j = this.judge(m.n)
    if (j.justWon) this.rank = m.totals.winners - m.newBingo + 1
    this.setLatest(m.n)
    this.drawVenue(m)
    this.history.push(m.n)
    if (j.cell >= 0) {
      this.mask |= 1 << j.cell
      this.filled &= ~(1 << j.cell)
      this.stats.hits++
      this.stats.maxReach = Math.max(this.stats.maxReach, j.reachAfter)
      if (j.justWon) this.won = true
    }
    const ch = this.challenge
    if (ch && j.chCell >= 0) {
      ch.mask |= 1 << j.chCell
      this.stats.hits++
    }
    this.renderCard()
    this.renderChallenge()
    this.renderHistory()
  }

  private judge(n: number): Judge {
    const before = lineState(this.mask, this.filled)
    const cell = this.won ? -1 : this.cells.indexOf(n)
    const after = cell >= 0 ? lineState(this.mask | (1 << cell), this.filled) : before
    const justWon = cell >= 0 && after.bingo > 0
    const ch = this.challenge
    const chCell = ch ? ch.cells.indexOf(n) : -1
    const chWon = !!ch && chCell >= 0 && challengeBingo(ch.mask | (1 << chCell))
    let outcome: AoriOutcome = 'none'
    if (justWon || chWon) outcome = 'bingo'
    else if (cell >= 0 && after.reach > before.reach) outcome = after.reach >= 2 ? 'double' : 'reach'
    else if (cell >= 0 || chCell >= 0) outcome = 'hit'
    return { n, outcome, cell, chCell, reachBefore: before.reach, reachAfter: after.reach, justWon, chWon }
  }

  // 開けた番号を、自分のカードに押す
  private async applyNumber(j: Judge): Promise<void> {
    const gen = this.generation
    if (j.outcome === 'none' && !this.won && j.reachBefore > 0) this.stats.nearMiss++
    if (j.cell >= 0) {
      this.mask |= 1 << j.cell
      this.filled &= ~(1 << j.cell)
      this.stats.hits++
      this.stats.maxReach = Math.max(this.stats.maxReach, j.reachAfter)
      if (j.justWon) this.won = true
      await this.card.stamp(j.cell)
      if (gen !== this.generation) return
      this.renderCard()
      if (j.justWon) {
        await this.card.celebrateLine(bingoCells(this.mask))
      } else if (j.reachAfter > j.reachBefore) {
        await playReach(this.root, { lines: j.reachAfter, waiting: this.waitingLabels(), speed: this.speed })
      }
    }
    const ch = this.challenge
    if (ch && j.chCell >= 0) {
      ch.mask |= 1 << j.chCell
      this.stats.hits++
      await ch.view.stamp(j.chCell)
      if (gen !== this.generation) return
      this.renderChallenge()
      if (j.chWon) await ch.view.celebrateLine(challengeLineCells(ch.mask))
    }
  }

  private onBulk(numbers: number[]): void {
    let mine = 0
    for (const n of numbers) {
      this.history.push(n)
      const cell = this.cells.indexOf(n)
      if (cell >= 0 && !this.won) {
        this.mask |= 1 << cell
        this.filled &= ~(1 << cell)
        mine++
      }
      const ch = this.challenge
      const c = ch ? ch.cells.indexOf(n) : -1
      if (ch && c >= 0) ch.mask |= 1 << c
    }
    this.stats.hits += mine
    this.stats.maxReach = Math.max(this.stats.maxReach, lineState(this.mask, this.filled).reach)
    this.renderCard()
    this.renderChallenge()
    this.renderHistory()
    this.setLatest(numbers[numbers.length - 1])
    this.toast(`早送り: ${numbers.length} 個出ました（カードにあったのは ${mine} 個）`)
  }

  // ---- ラストワン争奪の説明 ---------------------------------------------------

  // 争奪に入る人には、ビンゴの演出が終わってから説明の画面を出す。入らない人には、ひと言だけ知らせる
  private async onLastOneBrief(m: MsgOf<'lastOneBrief'>): Promise<void> {
    if (!m.meIn) {
      this.toast(`景品が足りない！ 同時にビンゴした ${fmt(m.entrants.length)} 人が、ガラポンで勝負！`)
      this.setNews(`<b>景品が足りない！</b><span>同時にビンゴした ${fmt(m.entrants.length)} 人が、ガラポンで勝負</span>`)
      return
    }
    const gen = this.generation
    this.lastOneOn = true
    await this.celebration
    if (gen !== this.generation || !this.lastOneOn) return
    this.lastOneBrief = openLastOneBrief(this.root, { speed: this.speed, prizes: m.prizes, contestants: m.entrants.length, autoMs: m.autoMs })
  }

  private closeLastOneBrief(): void {
    this.lastOneOn = false
    this.lastOneBrief?.close()
    this.lastOneBrief = null
  }

  // ---- 景品と上位チャレンジ -------------------------------------------------

  // 景品の発表に自分が入っていたら、受け取ってすぐ「見た」を送る（開封の演出の終わりは待たない）。
  // サーバーは、これを送ってきた人（スマホが起きている人）の選択だけを待つ。眠っているスマホのために、全員を待たせない。
  // つなぎ直しで同じ発表がもう一度届いても、送るのは 1 回まで（同じゲームの、同じ回の、同じ種類の当たりは 1 つだけ）
  private sendPrizeSeen(e: PrizeEntry, key = `${this.game}#${this.history.length}#${e.kind}`): void {
    if (key === this.seenPrize) return
    // 画面が裏に回っている（ほかのアプリを見ている）間は、まだ見ていないので送らない。表に戻ったときに送る
    // （その前につなぎ直したら、同じゲームの状態ではなくなるので送らない）
    if (document.visibilityState === 'hidden') {
      const gen = this.generation
      const back = () => {
        if (document.visibilityState === 'hidden') return
        document.removeEventListener('visibilitychange', back)
        if (gen === this.generation) this.sendPrizeSeen(e, key)
      }
      document.addEventListener('visibilitychange', back)
      return
    }
    this.seenPrize = key
    this.send({ type: 'prizeSeen' })
  }

  private async onMyPrize(e: PrizeEntry, lastOne: { dropAt: number; durationMs: number; entries: PrizeEntry[] } | null): Promise<void> {
    const gen = this.generation
    if (lastOne && e.kind === 'normal') {
      // ラストワン争奪: 大画面の発表と同時に玉が出るので、当たりの演出の終わりを待たずに始める
      const pool = lastOne.entries.filter((x) => x.kind === 'normal')
      await playLastOneGarapon(this.root, {
        speed: this.speed,
        dropAt: lastOne.dropAt,
        durationMs: lastOne.durationMs,
        color: ballColor(e.rarity),
        prize: e.prize ?? undefined,
        contestants: pool.length,
        prizes: pool.filter((x) => x.rarity).length,
      })
      // 外れ（運がなかった・ダブルチャンスの玉 3 個）は、ガラポンの画面で伝え終わっている
      if (gen !== this.generation || !e.rarity) return
    } else {
      await this.celebration
      if (gen !== this.generation) return
    }
    if (e.kind === 'challenge') {
      this.clearChallenge()
      await playChallengeResult(this.root, { speed: this.speed, success: true, rarity: e.rarity ?? undefined, prize: e.prize ?? undefined })
    } else {
      await playPackOpen(this.root, {
        speed: this.speed,
        rarity: e.rarity,
        prize: e.prize ?? '',
        glow: e.glow,
        upgrade: e.upgrade,
        rankUp: e.rankUp,
      })
    }
    if (gen !== this.generation || !e.rarity) return
    let kind: 'receive' | 'challenge' = 'receive'
    if (e.choice) {
      kind = await askChoice(this.root, {
        speed: this.speed,
        rarity: e.rarity,
        prize: e.prize ?? '',
        seconds: 10,
        challenge: e.choice,
      })
    }
    if (gen !== this.generation) return
    if (kind === 'receive') {
      this.stats.won = e.prize ?? undefined
      this.setPrize(e.prize, e.rarity)
    }
    this.send({ type: 'choice', kind })
  }

  // 上位チャレンジの 3×3 カードは、上がった本カードの代わりに同じ場所へ大きく置く
  private async onChallengeDeal(m: MsgOf<'challengeDeal'>): Promise<void> {
    const gen = this.generation
    await playChallengeStart(this.root, { speed: this.speed, target: m.target })
    if (gen !== this.generation) return
    await this.openChallenge(m.cells, m.target, 1 << CH_FREE).deal()
  }

  // 3×3 のカードを置く（配る動きは、呼ぶ側で）。本番のつなぎ直しでは、途中まで開いた mask で置く
  private openChallenge(cells: number[], target: Rarity, mask: number): CardView {
    this.clearChallenge()
    const host = this.$('.ph-cardhost')
    host.classList.add('challenge')
    // 条件は、挑んでいる間ずっと見えるようにする
    this.$('.ph-rule').textContent = `1 列そろえば ${target} の景品！ 景品がなくなるまでにそろわないと、景品なし`
    this.setPrize(null, null)
    const view = new CardView(host, { size: 3, speed: this.speed, title: `上位チャレンジ ${target}` })
    this.challenge = { cells, mask, target, view }
    view.setCells(cells)
    this.renderChallenge()
    return view
  }

  private async onChallengeEnd(): Promise<void> {
    if (!this.challenge) return
    this.clearChallenge()
    await playChallengeResult(this.root, { speed: this.speed, success: false })
  }

  private renderChallenge(): void {
    const ch = this.challenge
    if (!ch) return
    ch.view.setMarks(ch.mask, { waiting: challengeWaiting(ch.mask), line: challengeLineCells(ch.mask) })
    this.renderChip()
  }

  private clearChallenge(): void {
    if (!this.challenge) return
    this.challenge.view.destroy()
    this.challenge = null
    this.$('.ph-cardhost').classList.remove('challenge')
    this.$('.ph-rule').textContent = ''
    this.renderChip()
  }

  // ---- ダブルチャンス -------------------------------------------------------

  private async onDcEntry(m: MsgOf<'dcEntry'>): Promise<void> {
    this.dcEligible = m.meEligible
    if (!m.meEligible) {
      this.setNote(DC_TAKEN_NOTE)
      return
    }
    const entered = await askEntry(this.root, { speed: this.speed, seconds: m.seconds })
    if (entered) this.send({ type: 'entry' })
  }

  private async onDcSpin(m: MsgOf<'dcSpin'>): Promise<void> {
    const gen = this.generation
    this.setNote('')
    // 当たった人は、大画面と同じ時刻に 1 人ずつ出す（ui/stage.ts と同じ間合い）
    const winners = m.winners.map((w, i) => ({ ...w, at: DC_WIN_AT + i * DC_WIN_GAP }))
    // 最後の結果の画面は、大画面の締めくくりと同時に出す（大画面が当選者を発表している間に、先に終わらせない）
    if (m.balls.length) {
      const win = m.balls.find((b) => b.color !== 'white')
      await playGarapon(this.root, { speed: this.speed, balls: m.balls, stats: { ...this.finalStats(), won: win?.prize ?? this.stats.won }, outro: this.dcEnded, winners })
      return
    }
    // エントリーしないまま締め切られたときは、残っているエントリー画面を閉じて、発表を待つ。当たった人は、会場のようすの欄に出す
    this.root.querySelectorAll('.fxg').forEach((n) => n.remove())
    this.setNote(DC_SPIN_NOTE)
    winners.forEach((w, i) => this.later(w.at, () => this.dcNews(winners.slice(0, i + 1))))
    await this.dcEnded
    if (gen !== this.generation) return
    this.setNote('')
    // 締めの音は、景品を獲得済みの人のときは大画面が鳴らしている（デモでは同じ PC から鳴るので、重ねない。本番は自分のスマホで鳴らす）
    await playFinalResult(this.root, { speed: this.speed, stats: this.finalStats(), sound: this.live || this.dcEligible })
  }

  // 会場のようすの「ダブルチャンス 当たった人」。特賞（虹の玉）の人は「ほか」に入れず、必ず別の行で出す（いちばんの見せ場）
  private dcNews(list: readonly (Who & { color: BallColor })[]): void {
    const top = list.filter((w) => w.color === 'rainbow')
    const others = list.filter((w) => w.color !== 'rainbow')
    const award = top.length ? `<em class="ph-news-sub">${BALL_INFO.rainbow.shape} ${AWARD_NAME.rainbow} ${top.map((w) => whoHtml(w)).join(SEP)}</em>` : ''
    this.setNews(`<b>ダブルチャンス 当たった人</b>${others.length ? this.namesHtml(others) : ''}${award}`, false, top.length > 0)
  }

  private finalStats() {
    return { ...this.stats, rank: this.won && this.rank ? this.rank : undefined }
  }

  // ---- 会場のようす（大画面に出ていることを、いちばん下に控えめに） --------------
  // 色は中立（期待度の色は、自分のカードの話だけに使う）。結果の良し悪しだけは、大画面と同じ緑 ◆・灰青 ▼

  private setTotals(t: Totals): void {
    const set = (k: string, v: number) => {
      this.$(`.ph-stats [data-k="${k}"]`).textContent = fmt(v)
    }
    set('bingo', t.winners)
    set('reach', t.reachHolders)
    set('lower', t.lowerLeft)
    if (t.size > 0) this.setCount(t.size)
  }

  // 参加している人数（本番は、始まったあとにも人が入ってくる）
  private setCount(n: number): void {
    this.$('.ph-count').textContent = n > 0 ? `参加 ${fmt(n)} 人` : ''
  }

  // いちばん新しい出来事（1〜2 行）。big は、ビンゴが出たときなど、少しだけ目立たせる。
  // tall は、名前の行の下に、もう 1 行（特賞の人など、「ほか」に入れたくない行）を出すとき（3 行まで）
  private setNews(html: string, big = false, tall = false): void {
    const el = this.$('.ph-news')
    el.innerHTML = html
    el.classList.toggle('on', html !== '')
    el.classList.toggle('big', big)
    el.classList.toggle('tall', tall)
    if (html) replay(el, 'pop')
    this.fitBottom()
  }

  // 名前の並び（NAMES_MAX 人まで。あとは「ほか N 人」）。自分は「あなた」の札
  private namesHtml(list: readonly Pick<Who, 'name' | 'isMe'>[], total = list.length): string {
    // 自分がいれば、いちばん前に出す（見落とさないように）
    const sorted = [...list].sort((a, b) => Number(b.isMe) - Number(a.isMe))
    const shown = sorted.slice(0, NAMES_MAX)
    const rest = Math.max(0, total - shown.length)
    const names = shown.map((x) => whoHtml(x)).join(SEP)
    return `<span class="ph-names">${names}${rest ? `<small>ほか ${fmt(rest)} 人</small>` : ''}</span>`
  }

  // 景品が決まった人（大画面の名前の欄と同じ）。ラストワン争奪は、玉が出る（大画面が発表する）時刻まで待つ。
  // 自分が当たっていれば、自分の演出（パックの開封）の後ろで出す
  private async prizeNews(m: MsgOf<'prizeTime'>): Promise<void> {
    const gen = this.generation
    if (m.lastOne) await new Promise((r) => this.later(m.lastOne!.dropAt, () => r(undefined)))
    else await this.celebration
    if (gen !== this.generation || !m.entries.length) return
    const sorted = [...m.entries].sort((a, b) => Number(b.isMe) - Number(a.isMe))
    const shown = sorted.slice(0, NAMES_MAX)
    const tag = (e: PrizeEntry) => (e.rarity ? `<i class="ph-r" data-r="${e.rarity}">${e.rarity}</i>` : '<i class="ph-r">はずれ</i>')
    const rows = shown.map((e) => `<span class="ph-nb">${whoHtml(e)}${tag(e)}</span>`).join(SEP)
    const rest = m.entries.length - shown.length
    const more = rest > 0 ? `<small>ほか ${fmt(rest)} 人</small>` : ''
    this.setNews(`${this.prizeHead || '<b>景品が決まった！</b>'}<span class="ph-names">${rows}${more}</span>`, true)
  }

  // 時計の速さに合わせて、あとで動かす（新しいゲームで取り消す）
  private later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, this.clock.scale(ms)))
  }

  // ---- 共通 -----------------------------------------------------------------

  private overlay(html: string): void {
    const ov = this.$('.ph-overlay')
    ov.innerHTML = html
    ov.classList.add('on')
  }

  private closeOverlay(): void {
    this.$('.ph-overlay').classList.remove('on')
  }

  private toast(text: string): void {
    const el = this.$('.ph-toast')
    el.textContent = text
    replay(el, 'on')
  }
}

// 会場のようすの名前 1 人分（自分は「あなた」の札）と、名前の区切り
function whoHtml(x: { name: string; isMe: boolean }): string {
  return x.isMe ? '<em class="ph-me">あなた</em>' : `<span class="ph-who-n">${esc(x.name)}</span>`
}
const SEP = '<i class="ph-sep">・</i>'

// ラストワン争奪のガラポンの玉の色（外れは白）
function ballColor(rarity: Rarity | null): BallColor {
  if (rarity === 'UR') return 'rainbow'
  if (rarity === 'SR') return 'gold'
  return rarity ? 'red' : 'white'
}

function challengeWaiting(mask: number): number[] {
  return [...new Set(CH_LINES.filter((l) => popcount(l & ~mask) === 1).map((l) => 31 - Math.clz32(l & ~mask)))]
}

function challengeLineCells(mask: number): number[] {
  let all = 0
  for (const line of CH_LINES) if ((mask & line) === line) all |= line
  return [...Array(9).keys()].filter((i) => all & (1 << i))
}

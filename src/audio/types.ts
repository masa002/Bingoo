import type { Glow, Rarity, Tier } from '../fx/theme'

// 効果音と BGM の名前の一覧。演出のコードはこの名前だけを呼び、中身（合成のしかた）は知らない。
// 実装は、抽選まわり = sfx-draw.ts、イベント・景品・ガラポン = sfx-events.ts、BGM = bgm.ts

export interface DrawSfx {
  uiTap(): void // ボタンを押した
  tick(): void // リールのコマ送り（短く軽い。連続で鳴っても耳障りにならない）
  holdChange(tier: Tier): void // 保留（期待度）の色が上がった
  step(index: number, tier: Tier): void // ステップアップ。段が上がるほど音程も上がる
  flutter(): void // 群予告（カードが群れで画面を横切る）
  pseudoStop(): void // 疑似連: 止まりかけ
  nextChime(): void // 疑似連: 「NEXT」で回り直す
  cutin(tier: Tier): void // カットイン（緑・赤・金）
  telop(): void // テロップが出る（控えめ）
  riser(sec: number): void // 上がり続ける音。silence() でピタッと止める
  heartbeat(bpm: number, ms: number): void // 鼓動のループ（ms で自然に止まる）
  ma(): void // 間（ま）に入る瞬間。BGM を落とし、空気だけ残す
  goldRise(): void // 金の粒子が立ち上る
  pushReady(): void // PUSH 待ちに入った
  impact(tier: Tier): void // 番号が着地（段階で強さが変わる）
  fanfare(size: 'small' | 'medium' | 'big'): void // ビンゴが出た（人数で大きさを変える）
  kakutei(): void // パチンコの確定音（キュインキュイン→ちゅいーん）。虹のときだけ使う
  crack(): void // 虹のヒビが広がる
  rainbowChord(): void // 虹の和音（全員確定のピーク）
  finalBall(): void // 「この1球で景品が尽きる」の予告
  silence(): void // 伸ばしている音（ライザー・鼓動）を止める
}

export interface GaraponVoice {
  setSpeed(rps: number): void // 回転の速さ（毎秒の回転数、0〜6 くらい）
  stop(): void
}

export interface EventSfx {
  stamp(): void // カードに穴が開く
  reach(lines: number): void // リーチ（2 本以上なら大きく）
  bingo(): void // 自分のビンゴ
  aoriStart(tier: Tier): void // 手元のあおりが始まる
  aoriPulse(tier: Tier): void // あおりの途中の高まり（何度か呼ぶ）
  aoriSuccess(tier: Tier): void // あおりが成功した
  aoriFail(): void // あおりが失敗した（確変失敗のような、がっかりするが重すぎない音）
  wildBall(): void // 虹玉（全員確定のワイルド）が出た
  wildOpen(): void // 虹玉でマスが開いた
  moleAppear(): void // モグラが顔を出す
  moleDig(): void // モグラが掘る
  moleFill(): void // モグラが穴を埋めた（自分がやられた）
  moleSafe(): void // セーフ（自分は無事）
  packAppear(glow: Glow): void // 景品パックが出てくる（光で先バレ。ガセあり）
  packTear(): void // パックを破る
  cardFlip(): void // カードがめくれる
  rarity(r: Rarity | null): void // レア度の発表。null はダブルチャンス券
  rankUp(): void // 在庫切れで 1 ランクアップ
  countdown(secondsLeft: number): void // 選択の残り秒数（残り 3 秒からは強く）
  choose(kind: 'receive' | 'challenge'): void // 受け取る／上位チャレンジを選んだ
  challengeDeal(): void // チャレンジ用の 3×3 カードが配られる
  challengeSuccess(): void
  challengeFail(): void
  lastOne(win: boolean): void // ラストワン争奪の結果
  entry(): void // ダブルチャンスにエントリーした
  garaponStart(): GaraponVoice // ガラポンが回り始める。返り値で速さを変えて止める
  garaponDrop(): void // 玉が転がり出る
  garaponWin(color: 'red' | 'gold' | 'rainbow'): void // 当たりの鐘（カランカラン）
  garaponMiss(): void // はずれ（熱を冷ます側なので、やさしく）
  outro(): void // 締めくくり（おつかれさまでした）
}

// 手元のスロット（抽選のたびに、自分のスマホで回して STOP で止める）の音
export interface SpinSfx {
  spinStart(): void // 手元のリールが回り出す
  spinTap(power: number): void // 連打の 1 打（power はゲージの量 0〜1。上がるほど少し高く明るく）。1 秒に十数回鳴るので軽く
  spinLevel(level: number, tier: Tier): void // ゲージの段階が上がった（level 1〜4）。予告の格（tier）に合わせて強さを変える
  stopReady(): void // STOP が押せるようになった（気づかせるが、短く）
  stopPress(): void // STOP を押した（気持ちいい手応え）
  reelLand(tier: Tier): void // 手元のリールが番号に止まる（自分の段階に合わせた着地）
}

export type BgmScene = 'reception' | 'early' | 'reach' | 'bingo' | 'final' | 'cooldown'

export interface Bgm {
  play(scene: BgmScene): void // 場面を切り替える（クロスフェード）。同じ場面なら何もしない
  stop(fadeMs?: number): void
  duck(on: boolean): void // 演出の山場で BGM を下げる／戻す
}

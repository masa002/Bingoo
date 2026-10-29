// デモ用の時計。速度を変えると、待ち時間と演出の尺がまとめて縮む。
// 本番では、サーバー時刻に合わせた時計に差し替える
export class Clock {
  speed = 1

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms) / this.speed))
  }

  // 拍の列を時刻どおりに呼ぶ。戻り値の関数で取り消せる
  run<T extends { at: number }>(beats: readonly T[], fn: (beat: T) => void): () => void {
    const timers = beats.map((b) => window.setTimeout(() => fn(b), b.at / this.speed))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }

  // 実時間 ms を、今の速度での実際の待ち時間にする
  scale(ms: number): number {
    return ms / this.speed
  }
}

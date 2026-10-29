import type { Msg } from './protocol'

// デモ用の配信。本番では WebSocket などのアダプタに差し替える。
// 本番と同じく、メッセージは毎回 JSON にしてから渡す（直列化の不具合を隠さないため）
export class LocalHub {
  private readonly listeners = new Set<(msg: Msg) => void>()

  subscribe(fn: (msg: Msg) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  publish(msg: Msg): void {
    const wire = JSON.stringify(msg)
    for (const fn of this.listeners) fn(JSON.parse(wire) as Msg)
  }
}

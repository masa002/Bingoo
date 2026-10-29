// 紙吹雪と火花。Canvas 2D で描き、粒が無くなったら描画ループを止める（電池のため）

export const TIER_COLORS = ['#3b82f6', '#22c55e', '#ef4444', '#f5c542', '#ffffff'] as const
export const RAINBOW = ['#ff5a5a', '#ffb84d', '#fff15a', '#5aff8c', '#5ad2ff', '#a85aff'] as const
export const GOLD = ['#f5c542', '#ffe08a', '#fff4cc', '#d9a520'] as const

type Shape = 'rect' | 'spark' | 'dot'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  g: number
  life: number
  max: number
  size: number
  color: string
  rot: number
  vr: number
  shape: Shape
}

export class Particles {
  speed = 1
  private readonly ctx: CanvasRenderingContext2D
  private list: Particle[] = []
  private running = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cap = 2400,
  ) {
    this.ctx = canvas.getContext('2d')!
  }

  burst(
    x: number,
    y: number,
    o: { count: number; colors: readonly string[]; speed?: number; gravity?: number; life?: number; size?: number; shape?: Shape },
  ): void {
    for (let i = 0; i < o.count && this.list.length < this.cap; i++) {
      const a = Math.random() * Math.PI * 2
      const v = (o.speed ?? 10) * (0.3 + Math.random() * 0.9)
      this.list.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - (o.shape === 'rect' ? 3 : 0),
        g: o.gravity ?? 0.25,
        life: 0,
        max: (o.life ?? 70) * (0.6 + Math.random() * 0.6),
        size: (o.size ?? 8) * (0.5 + Math.random()),
        color: o.colors[i % o.colors.length],
        rot: Math.random() * 6.28,
        vr: (Math.random() - 0.5) * 0.4,
        shape: o.shape ?? 'rect',
      })
    }
    this.start()
  }

  rain(count: number, colors: readonly string[]): void {
    for (let i = 0; i < count && this.list.length < this.cap; i++) {
      this.list.push({
        x: Math.random() * this.canvas.width,
        y: -20 - Math.random() * 400,
        vx: (Math.random() - 0.5) * 2,
        vy: 2 + Math.random() * 3,
        g: 0.05,
        life: 0,
        max: 220 + Math.random() * 100,
        size: 8 + Math.random() * 8,
        color: colors[i % colors.length],
        rot: Math.random() * 6.28,
        vr: (Math.random() - 0.5) * 0.3,
        shape: 'rect',
      })
    }
    this.start()
  }

  rise(count: number, colors: readonly string[], x0: number, x1: number, y: number): void {
    for (let i = 0; i < count && this.list.length < this.cap; i++) {
      this.list.push({
        x: x0 + Math.random() * (x1 - x0),
        y: y + Math.random() * 60,
        vx: (Math.random() - 0.5) * 0.6,
        vy: -1 - Math.random() * 2.5,
        g: -0.01,
        life: 0,
        max: 90 + Math.random() * 60,
        size: 3 + Math.random() * 5,
        color: colors[i % colors.length],
        rot: 0,
        vr: 0,
        shape: 'dot',
      })
    }
    this.start()
  }

  clear(): void {
    this.list = []
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private start(): void {
    if (this.running) return
    this.running = true
    requestAnimationFrame(() => this.frame())
  }

  private frame(): void {
    const { ctx, canvas } = this
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const k = this.speed
    this.list = this.list.filter((p) => p.life < p.max && p.y < canvas.height + 60)
    for (const p of this.list) {
      p.life += k
      p.vy += p.g * k
      p.x += p.vx * k
      p.y += p.vy * k
      p.vx *= 0.99
      p.rot += p.vr * k
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.max)
      ctx.fillStyle = p.color
      if (p.shape === 'rect') {
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2)
        ctx.restore()
      } else if (p.shape === 'spark') {
        ctx.strokeStyle = p.color
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(p.x - p.vx * 3, p.y - p.vy * 3)
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
    if (this.list.length) requestAnimationFrame(() => this.frame())
    else this.running = false
  }
}

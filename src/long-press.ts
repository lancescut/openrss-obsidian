export const LONG_PRESS_MS = 560
export const LONG_PRESS_MOVE_TOLERANCE = 12

type Schedule = (callback: () => void, delayMs: number) => number
type CancelSchedule = (timerId: number) => void

export class LongPressGesture {
  private timerId: number | null = null
  private pointerId: number | null = null
  private startX = 0
  private startY = 0
  private trigger: (() => void) | null = null

  constructor(
    private readonly schedule: Schedule,
    private readonly cancelSchedule: CancelSchedule,
    private readonly delayMs = LONG_PRESS_MS,
    private readonly moveTolerance = LONG_PRESS_MOVE_TOLERANCE,
  ) {}

  start(pointerId: number, x: number, y: number, trigger: () => void): void {
    this.cancel()
    this.pointerId = pointerId
    this.startX = x
    this.startY = y
    this.trigger = trigger
    this.timerId = this.schedule(() => {
      const pendingTrigger = this.trigger
      this.reset(false)
      pendingTrigger?.()
    }, this.delayMs)
  }

  move(pointerId: number, x: number, y: number): boolean {
    if (this.pointerId !== pointerId) return false
    if (Math.hypot(x - this.startX, y - this.startY) > this.moveTolerance) {
      this.cancel()
    }
    return true
  }

  end(pointerId: number): boolean {
    if (this.pointerId !== pointerId) return false
    this.cancel()
    return true
  }

  cancel(): void {
    this.reset(true)
  }

  private reset(cancelTimer: boolean): void {
    if (cancelTimer && this.timerId !== null) this.cancelSchedule(this.timerId)
    this.timerId = null
    this.pointerId = null
    this.trigger = null
  }
}

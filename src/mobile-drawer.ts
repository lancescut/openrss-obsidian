export type MobileDrawerAction = 'open' | 'close' | 'toggle' | 'select'

export function nextMobileDrawerOpen(current: boolean, action: MobileDrawerAction): boolean {
  if (action === 'open') return true
  if (action === 'toggle') return !current
  return false
}

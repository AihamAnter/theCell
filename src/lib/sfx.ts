export type SfxName =
  | 'turn'
  | 'time_running'
  | 'clue'
  | 'reveal_correct'
  | 'reveal_incorrect'
  | 'reveal_assassin'
  | 'win'
  | 'lose'

const SFX_PATHS: Record<SfxName, string> = {
  turn: '/sfx/turn.mp3',
  time_running: '/sfx/time-running.wav',
  clue: '/sfx/clue.wav',
  reveal_correct: '/sfx/reveal-corrct.wav',
  reveal_incorrect: '/sfx/reveal-incorrct.wav',
  reveal_assassin: '/sfx/reveal-assasin.wav',
  win: '/sfx/win.wav',
  lose: '/sfx/lose.wav'
}

const cache = new Map<SfxName, HTMLAudioElement>()
const managed = new Map<SfxName, HTMLAudioElement>()

function getAudio(name: SfxName): HTMLAudioElement {
  const found = cache.get(name)
  if (found) return found
  const next = new Audio(SFX_PATHS[name])
  next.preload = 'auto'
  cache.set(name, next)
  return next
}

export function playSfx(name: SfxName, volume = 1): void {
  const base = getAudio(name)
  const instance = base.cloneNode(true) as HTMLAudioElement
  instance.volume = Math.max(0, Math.min(1, volume))
  void instance.play().catch(() => {
    // Ignore autoplay/user-gesture failures.
  })
}

export function playManagedSfx(name: SfxName, volume = 1): void {
  const active = managed.get(name) ?? getAudio(name)
  managed.set(name, active)
  active.pause()
  active.currentTime = 0
  active.volume = Math.max(0, Math.min(1, volume))
  void active.play().catch(() => {
    // Ignore autoplay/user-gesture failures.
  })
}

export function stopSfx(name: SfxName): void {
  const active = managed.get(name)
  if (!active) return
  active.pause()
  active.currentTime = 0
}

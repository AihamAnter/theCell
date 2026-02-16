import type { Lobby } from './lobbies'

export type GameSettings = {
  mode: 'classic' | 'powers'
  privacy: 'private' | 'public' | 'friends'
  allowSpectators: boolean

  useTurnTimer: boolean
  turnSeconds: number
  overtimeSeconds: number

  allowUnlimitedGuesses: boolean
  allowBonusGuess: boolean

  enforceOneWordClue: boolean
  strictNoBoardWordClues: boolean
  allowHyphenatedWords: boolean
  allowAbbreviations: boolean
  allowProperNouns: boolean
  allowHomophones: boolean
  allowTranslations: boolean

  streakToUnlockDice: number
  allowTimeCut: boolean
  allowRandomPeek: boolean
  allowShuffle: boolean
}

function readStr(obj: Record<string, unknown>, key: string, fallback: string): string {
  const v = obj[key]
  return typeof v === 'string' && v.trim() ? v : fallback
}

function readBool(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = obj[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true') return true
    if (s === 'false') return false
  }
  return fallback
}

function readNum(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

export function settingsFromLobby(lobby: Lobby): GameSettings {
  const s = (lobby.settings ?? {}) as Record<string, unknown>

  const modeRaw = readStr(s, 'mode', 'classic').toLowerCase()
  const mode = modeRaw === 'powers' ? 'powers' : 'classic'

  const privacyRaw = readStr(s, 'privacy', 'private').toLowerCase()
  const privacy = privacyRaw === 'public' ? 'public' : privacyRaw === 'friends' ? 'friends' : 'private'

  return {
    mode,
    privacy,

    allowSpectators: readBool(s, 'allowSpectators', true),

    useTurnTimer: readBool(s, 'useTurnTimer', true),
    turnSeconds: Math.max(15, Math.min(300, Math.floor(readNum(s, 'turnSeconds', 60)))),
    overtimeSeconds: Math.max(0, Math.min(120, Math.floor(readNum(s, 'overtimeSeconds', 15)))),

    allowUnlimitedGuesses: readBool(s, 'allowUnlimitedGuesses', false),
    allowBonusGuess: readBool(s, 'allowBonusGuess', true),

    enforceOneWordClue: readBool(s, 'enforceOneWordClue', true),
    strictNoBoardWordClues: readBool(s, 'strictNoBoardWordClues', true),
    allowHyphenatedWords: readBool(s, 'allowHyphenatedWords', false),
    allowAbbreviations: readBool(s, 'allowAbbreviations', false),
    allowProperNouns: readBool(s, 'allowProperNouns', false),
    allowHomophones: readBool(s, 'allowHomophones', false),
    allowTranslations: readBool(s, 'allowTranslations', false),

    streakToUnlockDice: Math.max(2, Math.min(8, Math.floor(readNum(s, 'streakToUnlockDice', 4)))),
    allowTimeCut: readBool(s, 'allowTimeCut', true),
    allowRandomPeek: readBool(s, 'allowRandomPeek', true),
    allowShuffle: readBool(s, 'allowShuffle', true)
  }
}

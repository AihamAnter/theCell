import { supabase } from './supabaseClient'
import type { Lobby } from './lobbies'

export type LobbyMode = 'classic' | 'powers'
export type LobbyPrivacy = 'private' | 'public' | 'friends'
export type LobbyLanguage = 'english' | 'arabic'

export type LobbySettingsForm = {
  // columns
  name: string
  maxPlayers: number
  boardSize: number

  // settings json
  mode: LobbyMode
  language: LobbyLanguage
  privacy: LobbyPrivacy

  passwordRequired: boolean

  allowSpectators: boolean
  spectatorsCanChat: boolean

  autoBalanceTeams: boolean
  playersPerTeam: number
  requireSpymaster: boolean
  showKeyCardToSpymasterOnly: boolean

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

  firstTeamCards: number
  secondTeamCards: number
  neutralCards: number
  assassinCards: number

  streakToUnlockDice: number
  allowTimeCut: boolean
  allowRandomPeek: boolean
  allowShuffle: boolean

  profanityFilter: boolean
  kickOnRepeatedViolations: boolean

  colorblindPatterns: boolean
  reduceMotion: boolean
  largerText: boolean
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

function readNumAny(obj: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const k of keys) {
    const n = readNum(obj, k, Number.NaN)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return null
}

function readNumFromScopes(
  root: Record<string, unknown>,
  keys: string[],
  scopes: Array<Record<string, unknown> | null>,
  fallback: number
): number {
  const top = readNumAny(root, keys, Number.NaN)
  if (Number.isFinite(top)) return top
  for (const s of scopes) {
    if (!s) continue
    const v = readNumAny(s, keys, Number.NaN)
    if (Number.isFinite(v)) return v
  }
  return fallback
}

export function defaultCardCounts(boardSize: number): Pick<
  LobbySettingsForm,
  'firstTeamCards' | 'secondTeamCards' | 'neutralCards' | 'assassinCards'
> {
  const size = Math.max(9, Math.min(100, Math.floor(boardSize || 25)))
  const assassinCards = 1
  // approx “classic” density scaled from 5x5 (9 / 8 / 7 / 1)
  const firstTeamCards = Math.max(1, Math.min(size - 2, Math.ceil(size * 0.36)))
  const secondTeamCards = Math.max(1, Math.min(size - 2, firstTeamCards - 1))
  const neutralCards = Math.max(0, size - assassinCards - firstTeamCards - secondTeamCards)
  return { firstTeamCards, secondTeamCards, neutralCards, assassinCards }
}

export const DEFAULT_SETTINGS_FORM: LobbySettingsForm = {
  name: 'Lobby',
  mode: 'classic',
  maxPlayers: 8,
  boardSize: 25,

  language: 'english',
  privacy: 'private',
  passwordRequired: false,

  allowSpectators: true,
  spectatorsCanChat: false,

  autoBalanceTeams: true,
  playersPerTeam: 2,
  requireSpymaster: true,
  showKeyCardToSpymasterOnly: true,

  useTurnTimer: true,
  turnSeconds: 60,
  overtimeSeconds: 15,

  allowUnlimitedGuesses: false,
  allowBonusGuess: true,

  enforceOneWordClue: true,
  strictNoBoardWordClues: true,
  allowHyphenatedWords: false,
  allowAbbreviations: false,
  allowProperNouns: false,
  allowHomophones: false,
  allowTranslations: false,

  ...defaultCardCounts(25),

  streakToUnlockDice: 4,
  allowTimeCut: true,
  allowRandomPeek: true,
  allowShuffle: true,

  profanityFilter: true,
  kickOnRepeatedViolations: false,

  colorblindPatterns: true,
  reduceMotion: false,
  largerText: false
}

export function formFromLobby(lobby: Lobby): LobbySettingsForm {
  const s = (lobby.settings ?? {}) as Record<string, unknown>
  const scopes = [asRecord(s.cardCounts), asRecord(s.card_counts), asRecord(s.cards), asRecord(s.counts)]

  const modeRaw = readStr(s, 'mode', 'classic').toLowerCase()
  const mode: LobbyMode = modeRaw === 'powers' ? 'powers' : 'classic'

  const privacyRaw = readStr(s, 'privacy', 'private').toLowerCase()
  const privacy: LobbyPrivacy =
    privacyRaw === 'public' ? 'public' : privacyRaw === 'friends' ? 'friends' : 'private'

  const languageRaw = readStr(s, 'language', 'english').toLowerCase()
  const language: LobbyLanguage = languageRaw === 'arabic' ? 'arabic' : 'english'

  const boardSize = typeof lobby.board_size === 'number' ? lobby.board_size : DEFAULT_SETTINGS_FORM.boardSize
  const countsDefault = defaultCardCounts(boardSize)

  return {
    ...DEFAULT_SETTINGS_FORM,

    name: lobby.name ?? DEFAULT_SETTINGS_FORM.name,
    maxPlayers: typeof lobby.max_players === 'number' ? lobby.max_players : DEFAULT_SETTINGS_FORM.maxPlayers,
    boardSize,

    mode,
    privacy,
    language,

    passwordRequired: readBool(s, 'passwordRequired', DEFAULT_SETTINGS_FORM.passwordRequired),

    allowSpectators: readBool(s, 'allowSpectators', DEFAULT_SETTINGS_FORM.allowSpectators),
    spectatorsCanChat: readBool(s, 'spectatorsCanChat', DEFAULT_SETTINGS_FORM.spectatorsCanChat),

    autoBalanceTeams: readBool(s, 'autoBalanceTeams', DEFAULT_SETTINGS_FORM.autoBalanceTeams),
    playersPerTeam: Math.max(1, Math.min(4, Math.floor(readNum(s, 'playersPerTeam', DEFAULT_SETTINGS_FORM.playersPerTeam)))),
    requireSpymaster: readBool(s, 'requireSpymaster', DEFAULT_SETTINGS_FORM.requireSpymaster),
    showKeyCardToSpymasterOnly: readBool(
      s,
      'showKeyCardToSpymasterOnly',
      DEFAULT_SETTINGS_FORM.showKeyCardToSpymasterOnly
    ),

    useTurnTimer: readBool(s, 'useTurnTimer', DEFAULT_SETTINGS_FORM.useTurnTimer),
    turnSeconds: Math.max(15, Math.min(300, Math.floor(readNum(s, 'turnSeconds', DEFAULT_SETTINGS_FORM.turnSeconds)))),
    overtimeSeconds: Math.max(0, Math.min(120, Math.floor(readNum(s, 'overtimeSeconds', DEFAULT_SETTINGS_FORM.overtimeSeconds)))),

    allowUnlimitedGuesses: readBool(s, 'allowUnlimitedGuesses', DEFAULT_SETTINGS_FORM.allowUnlimitedGuesses),
    allowBonusGuess: readBool(s, 'allowBonusGuess', DEFAULT_SETTINGS_FORM.allowBonusGuess),

    enforceOneWordClue: readBool(s, 'enforceOneWordClue', DEFAULT_SETTINGS_FORM.enforceOneWordClue),
    strictNoBoardWordClues: readBool(s, 'strictNoBoardWordClues', DEFAULT_SETTINGS_FORM.strictNoBoardWordClues),
    allowHyphenatedWords: readBool(s, 'allowHyphenatedWords', DEFAULT_SETTINGS_FORM.allowHyphenatedWords),
    allowAbbreviations: readBool(s, 'allowAbbreviations', DEFAULT_SETTINGS_FORM.allowAbbreviations),
    allowProperNouns: readBool(s, 'allowProperNouns', DEFAULT_SETTINGS_FORM.allowProperNouns),
    allowHomophones: readBool(s, 'allowHomophones', DEFAULT_SETTINGS_FORM.allowHomophones),
    allowTranslations: readBool(s, 'allowTranslations', DEFAULT_SETTINGS_FORM.allowTranslations),

    firstTeamCards: Math.max(
      0,
      Math.floor(
        readNumFromScopes(s, ['firstTeamCards', 'first_team_cards', 'red_cards', 'team_a_cards'], scopes, countsDefault.firstTeamCards)
      )
    ),
    secondTeamCards: Math.max(
      0,
      Math.floor(
        readNumFromScopes(s, ['secondTeamCards', 'second_team_cards', 'blue_cards', 'team_b_cards'], scopes, countsDefault.secondTeamCards)
      )
    ),
    neutralCards: Math.max(
      0,
      Math.floor(readNumFromScopes(s, ['neutralCards', 'neutral_cards'], scopes, countsDefault.neutralCards))
    ),
    assassinCards: Math.max(
      1,
      Math.floor(
        readNumFromScopes(s, ['assassinCards', 'assassin_cards', 'assassinCount', 'assassin_count'], scopes, countsDefault.assassinCards)
      )
    ),

    streakToUnlockDice: Math.max(2, Math.min(8, Math.floor(readNum(s, 'streakToUnlockDice', DEFAULT_SETTINGS_FORM.streakToUnlockDice)))),
    allowTimeCut: readBool(s, 'allowTimeCut', DEFAULT_SETTINGS_FORM.allowTimeCut),
    allowRandomPeek: readBool(s, 'allowRandomPeek', DEFAULT_SETTINGS_FORM.allowRandomPeek),
    allowShuffle: readBool(s, 'allowShuffle', DEFAULT_SETTINGS_FORM.allowShuffle),

    profanityFilter: readBool(s, 'profanityFilter', DEFAULT_SETTINGS_FORM.profanityFilter),
    kickOnRepeatedViolations: readBool(s, 'kickOnRepeatedViolations', DEFAULT_SETTINGS_FORM.kickOnRepeatedViolations),

    colorblindPatterns: readBool(s, 'colorblindPatterns', DEFAULT_SETTINGS_FORM.colorblindPatterns),
    reduceMotion: readBool(s, 'reduceMotion', DEFAULT_SETTINGS_FORM.reduceMotion),
    largerText: readBool(s, 'largerText', DEFAULT_SETTINGS_FORM.largerText)
  }
}

export function validateLobbySettingsForm(form: LobbySettingsForm): string[] {
  const errs: string[] = []

  if (!form.name.trim()) errs.push('Room name is required.')
  if (form.maxPlayers < 2 || form.maxPlayers > 32) errs.push('Max players must be 2..32.')
  if (form.boardSize < 9 || form.boardSize > 100) errs.push('Board size must be 9..100.')

  if (form.playersPerTeam < 1 || form.playersPerTeam > 4) errs.push('Players per team must be 1..4.')

  if (form.useTurnTimer) {
    if (form.turnSeconds < 15 || form.turnSeconds > 300) errs.push('Turn seconds must be 15..300.')
    if (form.overtimeSeconds < 0 || form.overtimeSeconds > 120) errs.push('Overtime seconds must be 0..120.')
  }

  const sum =
    (form.firstTeamCards || 0) + (form.secondTeamCards || 0) + (form.neutralCards || 0) + (form.assassinCards || 0)
  if (sum !== form.boardSize) errs.push(`Card counts must add up to board size. (now ${sum} / ${form.boardSize})`)

  return errs
}

export async function loadLobbyForSettings(code: string): Promise<Lobby> {
  const clean = code.trim().toUpperCase()
  if (!clean) throw new Error('Lobby code required')

  const { data, error } = await supabase.from('lobbies').select('*').eq('code', clean).single()
  if (error) throw error
  return data as Lobby
}

export async function saveLobbySettings(
  lobbyId: string,
  form: LobbySettingsForm,
  baseSettings?: Record<string, unknown>
): Promise<void> {
  const name = form.name.trim()
  if (!name) throw new Error('Lobby name required')

  const errors = validateLobbySettingsForm(form)
  if (errors.length) throw new Error(errors[0])

  const merged: Record<string, unknown> = {
    ...(baseSettings ?? {}),

    mode: form.mode,
    language: form.language,
    privacy: form.privacy,

    passwordRequired: form.passwordRequired,

    allowSpectators: form.allowSpectators,
    spectatorsCanChat: form.spectatorsCanChat,

    autoBalanceTeams: form.autoBalanceTeams,
    playersPerTeam: form.playersPerTeam,
    requireSpymaster: form.requireSpymaster,
    showKeyCardToSpymasterOnly: form.showKeyCardToSpymasterOnly,

    useTurnTimer: form.useTurnTimer,
    turnSeconds: form.turnSeconds,
    overtimeSeconds: form.overtimeSeconds,

    allowUnlimitedGuesses: form.allowUnlimitedGuesses,
    allowBonusGuess: form.allowBonusGuess,

    enforceOneWordClue: form.enforceOneWordClue,
    strictNoBoardWordClues: form.strictNoBoardWordClues,
    allowHyphenatedWords: form.allowHyphenatedWords,
    allowAbbreviations: form.allowAbbreviations,
    allowProperNouns: form.allowProperNouns,
    allowHomophones: form.allowHomophones,
    allowTranslations: form.allowTranslations,

    firstTeamCards: form.firstTeamCards,
    secondTeamCards: form.secondTeamCards,
    neutralCards: form.neutralCards,
    assassinCards: form.assassinCards,
    // Compatibility aliases for backend/RPC versions that read snake_case or *_count keys.
    first_team_cards: form.firstTeamCards,
    second_team_cards: form.secondTeamCards,
    neutral_cards: form.neutralCards,
    assassin_cards: form.assassinCards,
    assassinCount: form.assassinCards,
    assassin_count: form.assassinCards,
    cardCounts: {
      firstTeamCards: form.firstTeamCards,
      secondTeamCards: form.secondTeamCards,
      neutralCards: form.neutralCards,
      assassinCards: form.assassinCards
    },
    card_counts: {
      first_team_cards: form.firstTeamCards,
      second_team_cards: form.secondTeamCards,
      neutral_cards: form.neutralCards,
      assassin_cards: form.assassinCards
    },
    cards: {
      red_cards: form.firstTeamCards,
      blue_cards: form.secondTeamCards,
      neutral_cards: form.neutralCards,
      assassin_cards: form.assassinCards
    },

    streakToUnlockDice: form.streakToUnlockDice,
    allowTimeCut: form.allowTimeCut,
    allowRandomPeek: form.allowRandomPeek,
    allowShuffle: form.allowShuffle,

    profanityFilter: form.profanityFilter,
    kickOnRepeatedViolations: form.kickOnRepeatedViolations,

    colorblindPatterns: form.colorblindPatterns,
    reduceMotion: form.reduceMotion,
    largerText: form.largerText
  }

  const { error } = await supabase
    .from('lobbies')
    .update({
      name,
      max_players: form.maxPlayers,
      board_size: form.boardSize,
      settings: merged
    })
    .eq('id', lobbyId)

  if (error) throw error
}

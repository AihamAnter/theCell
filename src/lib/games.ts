import { supabase } from './supabaseClient'
import i18n from '../i18n' 
export type Game = {
  id: string
  lobby_id: string
  created_by: string
  status: 'setup' | 'active' | 'finished' | 'abandoned'
  current_turn_team: 'red' | 'blue' | null
  winning_team: 'red' | 'blue' | null
  clue_word: string | null
  clue_number: number | null
  guesses_remaining: number | null
  turn_started_at?: string | null
  red_remaining: number
  blue_remaining: number
  state: Record<string, unknown>
  started_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

export type GameCard = {
  game_id: string
  pos: number
  word: string
  revealed: boolean
  revealed_color: 'red' | 'blue' | 'neutral' | 'assassin' | null
  revealed_by: string | null
  revealed_at: string | null
}

export type CardColor = 'red' | 'blue' | 'neutral' | 'assassin'

export type RevealResult = {
  revealed_color: CardColor
  game_status: 'setup' | 'active' | 'finished' | 'abandoned'
  current_turn: 'red' | 'blue'
  winning_team: 'red' | 'blue' | null
  guesses_remaining: number | null
  turn_started_at?: string | null
  red_remaining: number
  blue_remaining: number
}

export type SpymasterKeyRow = { pos: number; color: CardColor }

function formatRpcError(context: string, err: unknown): Error {
  if (typeof err === 'object' && err !== null) {
    const anyErr = err as Record<string, unknown>
    const message = typeof anyErr.message === 'string' ? anyErr.message : 'Unknown error'
    const code = typeof anyErr.code === 'string' ? anyErr.code : ''
    const details = typeof anyErr.details === 'string' ? anyErr.details : ''
    const hint = typeof anyErr.hint === 'string' ? anyErr.hint : ''

    const extra = [code && `code=${code}`, details && `details=${details}`, hint && `hint=${hint}`]
      .filter(Boolean)
      .join(' | ')

    return new Error(`${context}: ${message}${extra ? ` (${extra})` : ''}`)
  }
  return new Error(`${context}: Unknown error`)
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

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return null
}

function readCountFromSettings(
  settings: Record<string, unknown>,
  keys: string[],
  fallback: number
): number {
  const scopes: Array<Record<string, unknown> | null> = [
    settings,
    asRecord(settings.cardCounts),
    asRecord(settings.card_counts),
    asRecord(settings.cards),
    asRecord(settings.counts)
  ]
  for (const scope of scopes) {
    if (!scope) continue
    for (const k of keys) {
      const n = readNum(scope, k, Number.NaN)
      if (Number.isFinite(n)) return Math.floor(n)
    }
  }
  return fallback
}

async function tryStartGameRpc(payload: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase.rpc('start_game', payload)
  if (error) return null
  return typeof data === 'string' ? data : null
}

export async function startGame(lobbyId: string): Promise<string> {
  const language = i18n.language === 'ar' ? 'ar' : 'en'
  let settings: Record<string, unknown> = {}
  try {
    const { data: lobbyRow } = await supabase.from('lobbies').select('settings').eq('id', lobbyId).single()
    settings = ((lobbyRow as any)?.settings ?? {}) as Record<string, unknown>
  } catch {
    settings = {}
  }

  const firstTeamCards = Math.max(0, readCountFromSettings(settings, ['firstTeamCards', 'first_team_cards', 'red_cards', 'team_a_cards'], 9))
  const secondTeamCards = Math.max(0, readCountFromSettings(settings, ['secondTeamCards', 'second_team_cards', 'blue_cards', 'team_b_cards'], 8))
  const neutralCards = Math.max(0, readCountFromSettings(settings, ['neutralCards', 'neutral_cards'], 7))
  const assassinCards = Math.max(1, readCountFromSettings(settings, ['assassinCards', 'assassin_cards', 'assassinCount', 'assassin_count'], 1))

  const base = { p_lobby_id: lobbyId, p_language: language }
  const attempts: Array<Record<string, unknown>> = [
    {
      ...base,
      p_first_team_cards: firstTeamCards,
      p_second_team_cards: secondTeamCards,
      p_neutral_cards: neutralCards,
      p_assassin_cards: assassinCards
    },
    {
      ...base,
      p_team_a_cards: firstTeamCards,
      p_team_b_cards: secondTeamCards,
      p_neutral_cards: neutralCards,
      p_assassin_cards: assassinCards
    },
    {
      ...base,
      p_red_cards: firstTeamCards,
      p_blue_cards: secondTeamCards,
      p_neutral_cards: neutralCards,
      p_assassin_cards: assassinCards
    },
    {
      ...base,
      p_assassin_cards: assassinCards
    },
    base
  ]

  for (const payload of attempts) {
    const id = await tryStartGameRpc(payload)
    if (id) return id
  }

  throw new Error('[start_game] failed for all known RPC signatures')
}

export async function setClue(gameId: string, word: string, number: number): Promise<void> {
  const { error } = await supabase.rpc('set_clue', {
    p_game_id: gameId,
    p_clue_word: word,
    p_clue_number: number
  })
  if (error) throw formatRpcError('[set_clue]', error)
}

export async function endTurn(gameId: string): Promise<void> {
  const { error } = await supabase.rpc('end_turn', { p_game_id: gameId })
  if (error) throw formatRpcError('[end_turn]', error)
}

export async function revealCard(gameId: string, pos: number): Promise<RevealResult> {
  const { data, error } = await supabase.rpc('reveal_card', {
    p_game_id: gameId,
    p_pos: pos
  })

  if (error) throw formatRpcError('[reveal_card]', error)

  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') throw new Error('[reveal_card] returned empty data')

  return row as RevealResult
}

export async function loadGame(gameId: string): Promise<Game> {
  const { data, error } = await supabase.from('games').select('*').eq('id', gameId).single()
  if (error) throw error
  return data as Game
}

export async function loadGameCards(gameId: string): Promise<GameCard[]> {
  const { data, error } = await supabase
    .from('game_cards')
    .select('*')
    .eq('game_id', gameId)
    .order('pos', { ascending: true })

  if (error) throw error
  return (data ?? []) as GameCard[]
}

export async function loadSpymasterKey(gameId: string): Promise<SpymasterKeyRow[]> {
  const { data, error } = await supabase.rpc('get_spymaster_key', { p_game_id: gameId })
  if (error) throw formatRpcError('[get_spymaster_key]', error)
  return (data ?? []) as SpymasterKeyRow[]
}

import { supabase } from './supabaseClient'

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

export async function startGame(lobbyId: string): Promise<string> {
  const { data, error } = await supabase.rpc('start_game', {
    p_lobby_id: lobbyId,
    p_words: null,
    p_language: 'en'
  })

  if (error) throw formatRpcError('[start_game]', error)
  if (typeof data !== 'string') throw new Error('[start_game] returned invalid data')
  return data
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

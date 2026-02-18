import { supabase } from './supabaseClient'

export type DiceOption =
  | 'time_bonus_next'
  | 'peek_assassin'
  | 'peek_team_card'
  | 'time_penalty_next'
  | 'clue_word_max4_next'
  | 'clue_cap2_next'

export type HelperAction = 'time_cut' | 'random_peek' | 'shuffle_unrevealed'

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

export async function useDiceOption(gameId: string, option: DiceOption, params: Record<string, unknown> = {}) {
  const { data, error } = await supabase.rpc('use_dice_option', {
    p_game_id: gameId,
    p_option: option,
    p_params: params
  })
  if (error) throw formatRpcError('[use_dice_option]', error)
  return data as Record<string, unknown>
}

export async function useHelperAction(gameId: string, action: HelperAction, params: Record<string, unknown> = {}) {
  const { data, error } = await supabase.rpc('use_helper_action', {
    p_game_id: gameId,
    p_action: action,
    p_params: params
  })
  if (error) throw formatRpcError('[use_helper_action]', error)
  return data as Record<string, unknown>
}

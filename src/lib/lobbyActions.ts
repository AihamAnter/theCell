import { supabase } from './supabaseClient'

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

export async function stopPlaying(lobbyId: string): Promise<void> {
  const { error } = await supabase.rpc('stop_playing', { p_lobby_id: lobbyId })
  if (error) throw formatRpcError('[stop_playing]', error)
}

export async function restartLobby(lobbyId: string): Promise<string> {
  const { data, error } = await supabase.rpc('restart_lobby', { p_lobby_id: lobbyId })
  if (error) throw formatRpcError('[restart_lobby]', error)
  if (typeof data !== 'string') throw new Error('[restart_lobby] returned invalid data')
  return data
}

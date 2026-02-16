import { supabase } from './supabaseClient'

export type Lobby = {
  id: string
  code: string
  name: string
  owner_id: string
  status: 'open' | 'in_game' | 'closed'
  settings: Record<string, unknown>
  max_players: number
  board_size: number
  created_at: string
  updated_at: string
}

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

export async function createLobby(input?: {
  name?: string
  maxPlayers?: number
  boardSize?: number
  settings?: Record<string, unknown>
}): Promise<{ lobbyId: string; lobbyCode: string }> {
  const name = input?.name ?? 'Lobby'
  const maxPlayers = input?.maxPlayers ?? 8
  const boardSize = input?.boardSize ?? 25
  const settings = input?.settings ?? {}

  const { data, error } = await supabase.rpc('create_lobby', {
    p_name: name,
    p_max_players: maxPlayers,
    p_board_size: boardSize,
    p_settings: settings
  })

  if (error) throw formatRpcError('[create_lobby]', error)

  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') throw new Error('[create_lobby] returned empty data')

  const outLobbyId = (row as Record<string, unknown>).out_lobby_id
  const outLobbyCode = (row as Record<string, unknown>).out_lobby_code

  if (typeof outLobbyId !== 'string' || typeof outLobbyCode !== 'string') {
    throw new Error('[create_lobby] returned invalid data')
  }

  return { lobbyId: outLobbyId, lobbyCode: outLobbyCode }
}

export async function joinLobby(code: string): Promise<string> {
  const clean = code.trim().toUpperCase()
  if (!clean) throw new Error('Lobby code required')

  const { data, error } = await supabase.rpc('join_lobby', { p_code: clean })
  if (error) throw formatRpcError('[join_lobby]', error)

  if (typeof data !== 'string') throw new Error('[join_lobby] returned invalid data')
  return data
}

export async function joinLobbyAsSpectator(code: string): Promise<string> {
  const clean = code.trim().toUpperCase()
  if (!clean) throw new Error('Lobby code required')

  const { data, error } = await supabase.rpc('join_lobby_spectator', { p_code: clean })
  if (error) throw formatRpcError('[join_lobby_spectator]', error)

  if (typeof data !== 'string') throw new Error('[join_lobby_spectator] returned invalid data')
  return data
}

export async function quickMatch(input?: {
  mode?: 'classic' | 'powers'
}): Promise<{ lobbyId: string; lobbyCode: string; created: boolean }> {
  const mode = input?.mode ?? 'classic'

  const { data, error } = await supabase.rpc('quick_match', {
    p_mode: mode
  })

  if (error) throw formatRpcError('[quick_match]', error)

  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') throw new Error('[quick_match] returned empty data')

  const outLobbyId = (row as Record<string, unknown>).out_lobby_id
  const outLobbyCode = (row as Record<string, unknown>).out_lobby_code
  const outCreated = (row as Record<string, unknown>).out_created

  if (typeof outLobbyId !== 'string' || typeof outLobbyCode !== 'string') {
    throw new Error('[quick_match] returned invalid data')
  }

  return {
    lobbyId: outLobbyId,
    lobbyCode: outLobbyCode,
    created: Boolean(outCreated)
  }
}

export async function getLobbyByCode(code: string): Promise<Lobby> {
  const { data, error } = await supabase.from('lobbies').select('*').eq('code', code).single()
  if (error) throw error
  return data as Lobby
}

export async function getLobbyById(lobbyId: string): Promise<Lobby> {
  const { data, error } = await supabase.from('lobbies').select('*').eq('id', lobbyId).single()
  if (error) throw error
  return data as Lobby
}

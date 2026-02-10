import { supabase } from './supabaseClient'
import type { Lobby } from './lobbies'

export type LobbySettingsForm = {
  name: string
  mode: 'classic' | 'powers'
  maxPlayers: number
  boardSize: number
}

export async function loadLobbyForSettings(code: string): Promise<Lobby> {
  const clean = code.trim().toUpperCase()
  if (!clean) throw new Error('Lobby code required')

  const { data, error } = await supabase.from('lobbies').select('*').eq('code', clean).single()
  if (error) throw error
  return data as Lobby
}

export async function saveLobbySettings(lobbyId: string, form: LobbySettingsForm): Promise<void> {
  const name = form.name.trim()
  if (!name) throw new Error('Lobby name required')

  if (form.maxPlayers < 2 || form.maxPlayers > 32) throw new Error('Max players must be 2..32')
  if (form.boardSize < 9 || form.boardSize > 100) throw new Error('Board size must be 9..100')

  const { error } = await supabase
    .from('lobbies')
    .update({
      name,
      max_players: form.maxPlayers,
      board_size: form.boardSize,
      settings: { mode: form.mode }
    })
    .eq('id', lobbyId)

  if (error) throw error
}

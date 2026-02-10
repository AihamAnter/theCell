import { supabase } from './supabaseClient'

export type PublicProfile = {
  user_id: string
  display_name: string | null
  avatar_url: string | null
}

function supaErr(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as any
    const msg = typeof e.message === 'string' ? e.message : 'Unknown error'
    const details = typeof e.details === 'string' ? e.details : ''
    const hint = typeof e.hint === 'string' ? e.hint : ''
    const code = typeof e.code === 'string' ? e.code : ''
    const extra = [code && `code=${code}`, details && `details=${details}`, hint && `hint=${hint}`]
      .filter(Boolean)
      .join(' | ')
    return extra ? `${msg} (${extra})` : msg
  }
  return 'Unknown error'
}

export async function getLobbyProfiles(lobbyId: string): Promise<PublicProfile[]> {
  const clean = lobbyId.trim()
  if (!clean) return []

  const { data, error } = await supabase.rpc('get_lobby_profiles', { p_lobby_id: clean })
  if (error) throw new Error(supaErr(error))

  return (data ?? []) as PublicProfile[]
}

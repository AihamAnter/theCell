import { supabase } from './supabaseClient'

export type Profile = {
  user_id: string
  display_name: string
  avatar_url: string | null
  bio: string | null
  preferences: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type UpdateMyProfileInput = {
  display_name: string
  bio: string
  avatar_url?: string | null
  preferences?: Record<string, unknown>
}

export async function getMyProfile(): Promise<Profile> {
  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
  if (sessionErr) throw sessionErr
  const userId = sessionData.session?.user?.id
  if (!userId) throw new Error('No session')

  const { data, error } = await supabase.from('profiles').select('*').eq('user_id', userId).single()
  if (error) throw error

  return data as Profile
}

export async function updateMyProfile(input: UpdateMyProfileInput): Promise<void> {
  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
  if (sessionErr) throw sessionErr
  const userId = sessionData.session?.user?.id
  if (!userId) throw new Error('No session')

  const displayName = (input.display_name ?? '').trim()
  if (!displayName) throw new Error('Display name is required')

  const bio = (input.bio ?? '').trim()

  const patch: Record<string, unknown> = {
    display_name: displayName,
    bio
  }

  if (typeof input.avatar_url !== 'undefined') {
    const au = (input.avatar_url ?? '').trim()
    patch.avatar_url = au.length ? au : null
  }

  if (typeof input.preferences !== 'undefined') {
    patch.preferences = input.preferences ?? {}
  }

  const { error } = await supabase.from('profiles').update(patch).eq('user_id', userId)
  if (error) throw error
}

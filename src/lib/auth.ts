import { supabase } from './supabaseClient'

export async function ensureSession(): Promise<void> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) throw sessionError

  if (sessionData.session) {
    console.log('[auth] session already exists')
    return
  }

  console.log('[auth] no session, signing in anonymously...')
  const { data, error: anonError } = await supabase.auth.signInAnonymously()
  if (anonError) throw anonError

  console.log('[auth] anonymous signed in:', data.user?.id)
}

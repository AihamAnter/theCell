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

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  return data.user
}

export async function signInWithEmailPassword(email: string, password: string) {
  const cleanEmail = (email ?? '').trim()
  const cleanPassword = String(password ?? '')
  if (!cleanEmail || !cleanPassword) throw new Error('Email and password are required.')
  const { data, error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: cleanPassword })
  if (error) throw error
  return data
}

/**
 * If the current user is anonymous, this upgrades them in-place by attaching email+password.
 * This keeps the same user id, so your game/profile data stays.
 *
 * Note: if your project requires email confirmation, Supabase will send a confirmation email.
 * The account may show as anonymous until the email is confirmed.
 */
export async function upgradeAnonymousWithEmailPassword(email: string, password: string) {
  const cleanEmail = (email ?? '').trim()
  const cleanPassword = String(password ?? '')
  if (!cleanEmail || !cleanPassword) throw new Error('Email and password are required.')

  const user = await getCurrentUser()
  const isAnon = Boolean((user as any)?.is_anonymous)

  if (!isAnon) {
    // Not anonymous: do a normal signUp (creates a new user id)
    const { data, error } = await supabase.auth.signUp({ email: cleanEmail, password: cleanPassword })
    if (error) throw error
    return { mode: 'signup' as const, data }
  }

  // Anonymous: upgrade current user in-place (keeps same id)
  const { data, error } = await supabase.auth.updateUser({ email: cleanEmail, password: cleanPassword })
  if (error) throw error
  return { mode: 'upgrade' as const, data }
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

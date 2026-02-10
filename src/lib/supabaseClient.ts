import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY as string | undefined

if (!supabaseUrl) {
  throw new Error('Missing env var: VITE_SUPABASE_URL')
}

if (!supabaseKey) {
  throw new Error('Missing env var: VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY')
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  },
  db: {
    schema: 'public'
  }
})

// dev helper: allows `window.supabase` in the browser console
if (import.meta.env.DEV) {
  ;(window as unknown as { supabase?: SupabaseClient }).supabase = supabase
}

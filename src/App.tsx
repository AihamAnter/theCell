import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'
import { ensureSession } from './lib/auth'

import HomeRoute from './routes/HomeRoute'
import LobbyRoute from './routes/LobbyRoute'
import GameRoute from './routes/GameRoute'
import ProfileRoute from './routes/ProfileRoute'
import SettingsRoute from './routes/SettingsRoute'

type BootState = 'booting' | 'ready' | 'error'

export default function App() {
  const [bootState, setBootState] = useState<BootState>('booting')
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        await ensureSession()

        const { data, error } = await supabase.rpc('healthcheck')
        if (error) throw error
        console.log('[supabase] healthcheck ok:', data)

        if (!cancelled) setBootState('ready')
      } catch (err) {
        console.error('[boot] failed:', err)
        if (!cancelled) {
          const msg =
            typeof err === 'object' && err !== null && 'message' in err ? String((err as any).message) : 'boot failed'
          setBootError(msg)
          setBootState('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  if (bootState === 'booting') {
    return (
      <div style={{ padding: 16 }}>
        <h3>Connecting…</h3>
        <p>Signing you in.</p>
      </div>
    )
  }

  if (bootState === 'error') {
    return (
      <div style={{ padding: 16 }}>
        <h3>Connection error</h3>
        <p>{bootError}</p>
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/" element={<HomeRoute />} />
      <Route path="/lobby/:code" element={<LobbyRoute />} />
      <Route path="/game/:id" element={<GameRoute />} />
      <Route path="/profile" element={<ProfileRoute />} />
      <Route path="/settings/:code" element={<SettingsRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

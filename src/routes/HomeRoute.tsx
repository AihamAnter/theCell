import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import HomePage from '../components/HomePage'
import { createLobby, joinLobby } from '../lib/lobbies'

export default function HomeRoute() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState<string | null>(null)

  async function handleCreateLobby(mode: 'classic' | 'powers') {
    try {
      setBusy('Creating lobby…')

      const settings = mode === 'powers' ? { mode: 'powers' } : { mode: 'classic' }

      const { lobbyCode } = await createLobby({
        name: mode === 'powers' ? 'Powers Lobby' : 'Classic Lobby',
        maxPlayers: 8,
        boardSize: 25,
        settings
      })

      navigate(`/lobby/${lobbyCode}`)
    } catch (err) {
      console.error('[home] create lobby failed:', err)
      alert(err instanceof Error ? err.message : 'Create lobby failed')
    } finally {
      setBusy(null)
    }
  }

  async function handleJoinLobby(code: string) {
    try {
      setBusy('Joining lobby…')
      await joinLobby(code)
      navigate(`/lobby/${code.trim().toUpperCase()}`)
    } catch (err) {
      console.error('[home] join lobby failed:', err)
      alert(err instanceof Error ? err.message : 'Join lobby failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <HomePage
        onJoinLobby={handleJoinLobby}
        onCreateLobby={handleCreateLobby}
        onOpenProfile={() => navigate('/profile')}
        onOpenSettings={() => navigate('/')}
      />

      {busy && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            zIndex: 9999
          }}
        >
          <div style={{ padding: 16, borderRadius: 12, border: '1px solid #2a2a35', background: '#111118' }}>
            {busy}
          </div>
        </div>
      )}
    </div>
  )
}

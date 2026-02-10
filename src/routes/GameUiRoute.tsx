import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import GameBoard from '../components/GameBoard'
import { useGameView } from '../lib/gameView'

export default function GameUiRoute() {
  const { id } = useParams()
  const navigate = useNavigate()

  const gameId = useMemo(() => (id ?? '').trim(), [id])
  const { state, actions } = useGameView(gameId)

  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          position: 'fixed',
          top: 10,
          left: 10,
          zIndex: 99999,
          padding: '6px 10px',
          borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(0,0,0,0.55)',
          color: '#fff',
          fontSize: 12
        }}
      >
        UI mode • {state.gameId ? `game ${state.gameId.slice(0, 8)}` : 'no game id'}
      </div>

      <GameBoard
        state={state}
        actions={actions}
        onBackToHome={() => {
          if (!gameId) return navigate('/')
          navigate(`/game/${gameId}`)
        }}
        onBackToLobby={() => {
          if (!state.lobbyCode) return navigate('/')
          navigate(`/lobby/${state.lobbyCode}`)
        }}
        onOpenProfile={() => navigate('/profile')}
        onOpenSettings={() => {
          if (!state.lobbyCode) return
          navigate(`/settings/${state.lobbyCode}`)
        }}
      />

      {state.loading && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99998,
            background: 'rgba(0,0,0,0.55)',
            color: '#fff',
            display: 'grid',
            placeItems: 'center'
          }}
        >
          Loading…
        </div>
      )}

      {state.error && !state.loading && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99998,
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            padding: 16
          }}
        >
          <div style={{ maxWidth: 520, width: '100%', border: '1px solid #ff4d4f', borderRadius: 12, padding: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Game UI error</div>
            <div style={{ opacity: 0.9 }}>{state.error}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button onClick={() => actions.refresh()}>Retry</button>
              <button onClick={() => navigate(`/game/${gameId}`)} disabled={!gameId}>
                Back to classic
              </button>
              <button onClick={() => (state.lobbyCode ? navigate(`/lobby/${state.lobbyCode}`) : navigate('/'))}>
                Back to lobby
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

import { useMemo, useState } from 'react'
import type { CardColor, GameCard } from '../lib/games'
import type { GameViewActions, GameViewState, LobbyMemberView, Team } from '../lib/gameView'

type Props = {
  state: GameViewState
  actions: GameViewActions
  onBackToHome: () => void
  onBackToLobby: () => void
  onOpenProfile: () => void
  onOpenSettings: () => void
}

function displayNameFor(m: LobbyMemberView, index: number): string {
  const n = (m.profiles?.display_name ?? '').trim()
  if (n) return n
  return `Player ${index + 1}`
}

function keyLetter(c: CardColor): string {
  if (c === 'assassin') return 'A'
  if (c === 'neutral') return 'N'
  if (c === 'red') return 'R'
  return 'B'
}

function teamLabel(t: Team | null): string {
  if (t === 'red') return 'Red'
  if (t === 'blue') return 'Blue'
  return '—'
}

function guardNumber(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 9) return 9
  return Math.floor(n)
}

function winnerText(w: any): string {
  const s = String(w ?? '').toLowerCase()
  if (s === 'red') return 'Red wins'
  if (s === 'blue') return 'Blue wins'
  if (s) return `Winner: ${s}`
  return 'Game over'
}

export default function GameBoard(props: Props) {
  const { state, actions, onBackToHome, onBackToLobby, onOpenProfile, onOpenSettings } = props

  const game = state.game
  const me = state.me

  const [clueWord, setClueWord] = useState('')
  const [clueNumber, setClueNumber] = useState(1)
  const [busy, setBusy] = useState<string | null>(null)

  const boardSize = useMemo(() => {
    const n = state.cards.length
    const r = Math.round(Math.sqrt(n))
    return r > 0 ? r : 5
  }, [state.cards.length])

  const playableMembers = useMemo(
    () => state.members.filter((m) => m.role === 'owner' || m.role === 'player'),
    [state.members]
  )

  const redTeam = useMemo(() => playableMembers.filter((m) => m.team === 'red'), [playableMembers])
  const blueTeam = useMemo(() => playableMembers.filter((m) => m.team === 'blue'), [playableMembers])
  const spectators = useMemo(() => state.members.filter((m) => m.role === 'spectator'), [state.members])

  const status = (game?.status ?? 'unknown') as string
  const isActive = status === 'active'
  const isSetup = status === 'setup'
  const isEnded = !isActive && !isSetup && Boolean(game)

  const myTeam = me?.team ?? null
  const isMyTurn = Boolean(game && myTeam && game.current_turn_team === myTeam)
  const hasClue = game?.guesses_remaining !== null && game?.guesses_remaining !== undefined

  const canGiveClue = Boolean(isActive && me?.isSpymaster && isMyTurn)
  const canReveal = Boolean(isActive && !me?.isSpymaster && isMyTurn && hasClue)
  const canEndTurn = Boolean(isActive && !me?.isSpymaster && isMyTurn && hasClue)

  const realtimeBadge = useMemo(() => {
    const s = state.realtimeStatus
    if (s === 'SUBSCRIBED') return 'realtime: OK'
    if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') return 'realtime: OFF (polling)'
    return 'realtime: …'
  }, [state.realtimeStatus])

  async function doSendClue() {
    if (!canGiveClue) return
    const w = clueWord.trim()
    if (!w) return
    const n = guardNumber(clueNumber)

    try {
      setBusy('Setting clue…')
      await actions.sendClue(w, n)
      setClueWord('')
      setClueNumber(1)
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : 'failed to set clue')
    } finally {
      setBusy(null)
    }
  }

  async function doReveal(card: GameCard) {
    if (!canReveal) return
    if (card.revealed) return

    try {
      setBusy('Revealing…')
      await actions.reveal(card.pos)
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : 'failed to reveal')
    } finally {
      setBusy(null)
    }
  }

  async function doEndTurn() {
    if (!canEndTurn) return
    try {
      setBusy('Ending turn…')
      await actions.endTurn()
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : 'failed to end turn')
    } finally {
      setBusy(null)
    }
  }

  const myMemberIndex = useMemo(() => {
    if (!me?.userId) return -1
    return state.members.findIndex((m) => m.user_id === me.userId)
  }, [me?.userId, state.members])

  const myDisplayName = useMemo(() => {
    if (!me || myMemberIndex < 0) return '—'
    return displayNameFor(state.members[myMemberIndex], myMemberIndex)
  }, [me, myMemberIndex, state.members])

  return (
    <div style={{ minHeight: '100vh', background: '#0b0b0f', color: '#fff', padding: 16, position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={onBackToLobby}>Lobby</button>
        <button onClick={onBackToHome}>Classic</button>
        <button onClick={onOpenSettings} disabled={!state.lobbyCode}>
          Settings
        </button>
        <button onClick={onOpenProfile}>Profile</button>

        {me?.isSpymaster && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 8, opacity: 0.95 }}>
            <input type="checkbox" checked={state.showKey} onChange={(e) => actions.setShowKey(e.target.checked)} />
            <span>Key</span>
          </label>
        )}

        <div style={{ opacity: 0.8, fontSize: 12, marginLeft: 8 }}>{realtimeBadge}</div>

        <button onClick={() => actions.refresh()} style={{ marginLeft: 'auto' }}>
          Refresh
        </button>
      </div>

      <div style={{ padding: 12, border: '1px solid #2a2a35', borderRadius: 12, background: '#111118' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ opacity: 0.9 }}>
            You: <b>{myDisplayName}</b> • team <b>{teamLabel(myTeam)}</b> • role <b>{me?.isSpymaster ? 'spymaster' : 'operative'}</b>
          </div>
          <div style={{ opacity: 0.9 }}>
            Turn: <b>{teamLabel(game?.current_turn_team ?? null)}</b> • guesses left: <b>{game?.guesses_remaining ?? '—'}</b>
          </div>
        </div>

        <div style={{ marginTop: 8, opacity: 0.9 }}>
          Clue: <b>{game?.clue_word ?? '—'}</b>{' '}
          {game?.clue_number !== null && game?.clue_number !== undefined ? `(${game?.clue_number})` : ''}
        </div>

        <div style={{ marginTop: 8, opacity: 0.9 }}>
          Red left: <b>{game?.red_remaining ?? '—'}</b> • Blue left: <b>{game?.blue_remaining ?? '—'}</b> • status:{' '}
          <b>{status}</b>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr 280px', gap: 12, marginTop: 12 }}>
        <div style={{ padding: 12, border: '1px solid #2a2a35', borderRadius: 12, background: '#111118' }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Red Team</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {redTeam.map((m, idx) => (
              <div
                key={m.user_id}
                style={{
                  padding: 10,
                  borderRadius: 10,
                  border: '1px solid #1f1f29',
                  background: '#0d0d14',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 10
                }}
              >
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ fontWeight: 800 }}>{displayNameFor(m, idx)}</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    {m.is_spymaster ? 'spymaster' : 'operative'}
                    {m.is_ready ? ' • ready' : ''}
                  </div>
                </div>
              </div>
            ))}
            {redTeam.length === 0 && <div style={{ opacity: 0.75 }}>no players</div>}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          {canGiveClue && (
            <div style={{ padding: 12, border: '1px solid #2a2a35', borderRadius: 12, background: '#111118' }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>Give clue</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  value={clueWord}
                  onChange={(e) => setClueWord(e.target.value)}
                  placeholder="word"
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid #2a2a35',
                    background: '#0d0d14',
                    color: '#fff',
                    minWidth: 180
                  }}
                />
                <input
                  type="number"
                  value={clueNumber}
                  onChange={(e) => setClueNumber(Number(e.target.value))}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid #2a2a35',
                    background: '#0d0d14',
                    color: '#fff',
                    width: 120
                  }}
                />
                <button onClick={doSendClue} disabled={busy !== null || clueWord.trim().length === 0}>
                  Set clue
                </button>
              </div>
            </div>
          )}

          {!me?.isSpymaster && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={doEndTurn} disabled={!canEndTurn || busy !== null}>
                End turn
              </button>
              {!canReveal && isActive && <div style={{ opacity: 0.8 }}>You can reveal only on your turn, after a clue.</div>}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${boardSize}, minmax(0, 1fr))`, gap: 8 }}>
            {state.cards.map((c) => {
              const hint = state.showKey ? state.keyByPos.get(c.pos) : undefined
              const hintText = hint ? keyLetter(hint) : ''

              return (
                <button
                  key={c.pos}
                  onClick={() => doReveal(c)}
                  disabled={busy !== null || !isActive || c.revealed || !canReveal}
                  style={{
                    position: 'relative',
                    padding: 12,
                    borderRadius: 12,
                    border: '1px solid #1f1f29',
                    background: '#111118',
                    color: '#fff',
                    textAlign: 'left',
                    minHeight: 62,
                    opacity: c.revealed ? 0.65 : 1,
                    cursor: c.revealed || !canReveal ? 'not-allowed' : 'pointer'
                  }}
                >
                  {hintText && !c.revealed && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        fontSize: 12,
                        opacity: 0.85,
                        fontFamily: 'monospace',
                        border: '1px solid rgba(255,255,255,0.15)',
                        padding: '2px 6px',
                        borderRadius: 8
                      }}
                    >
                      {hintText}
                    </div>
                  )}

                  <div style={{ fontWeight: 900 }}>{c.word}</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                    {c.revealed ? (
                      <>
                        revealed • <b>{c.revealed_color ?? '—'}</b>
                      </>
                    ) : (
                      <>hidden</>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ padding: 12, border: '1px solid #2a2a35', borderRadius: 12, background: '#111118' }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Blue Team</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {blueTeam.map((m, idx) => (
              <div
                key={m.user_id}
                style={{
                  padding: 10,
                  borderRadius: 10,
                  border: '1px solid #1f1f29',
                  background: '#0d0d14',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 10
                }}
              >
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ fontWeight: 800 }}>{displayNameFor(m, idx)}</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    {m.is_spymaster ? 'spymaster' : 'operative'}
                    {m.is_ready ? ' • ready' : ''}
                  </div>
                </div>
              </div>
            ))}
            {blueTeam.length === 0 && <div style={{ opacity: 0.75 }}>no players</div>}
          </div>

          {spectators.length > 0 && (
            <>
              <div style={{ marginTop: 14, fontWeight: 900, opacity: 0.95 }}>Spectators</div>
              <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                {spectators.map((m, idx) => (
                  <div key={m.user_id} style={{ opacity: 0.85, fontSize: 13 }}>
                    {displayNameFor(m, idx)}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {(isSetup || isEnded) && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            background: 'rgba(0,0,0,0.72)',
            display: 'grid',
            placeItems: 'center',
            padding: 16
          }}
        >
          <div style={{ width: '100%', maxWidth: 560, borderRadius: 14, border: '1px solid #2a2a35', background: '#111118', padding: 16 }}>
            <div style={{ fontWeight: 900, fontSize: 20 }}>
              {isSetup ? 'Waiting to start' : winnerText((game as any)?.winning_team)}
            </div>

            <div style={{ marginTop: 10, opacity: 0.85, lineHeight: 1.4 }}>
              {isSetup
                ? 'This game is not active yet. Go back to the lobby to start it.'
                : 'The game has ended. You can return to the lobby or open the classic screen.'}
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              <button onClick={onBackToLobby}>Back to lobby</button>
              <button onClick={onBackToHome}>Open classic</button>
              <button onClick={() => actions.refresh()}>Refresh</button>
            </div>
          </div>
        </div>
      )}

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
          <div style={{ padding: 16, borderRadius: 12, border: '1px solid #2a2a35', background: '#111118' }}>{busy}</div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
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

type ToastTone = 'info' | 'success' | 'warning' | 'danger'
type ToastItem = { id: string; text: string; tone: ToastTone }

const TOAST_MS = 2400
const ONLINE_MS = 25_000
const REVEAL_COOLDOWN_MS = 900

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

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return fallback
    return v === '1'
  } catch {
    return fallback
  }
}

function writeBool(key: string, val: boolean) {
  try {
    localStorage.setItem(key, val ? '1' : '0')
  } catch {
    // ignore
  }
}

function colorLabel(c: any): string {
  const s = String(c ?? '').toLowerCase()
  if (s === 'red') return 'red'
  if (s === 'blue') return 'blue'
  if (s === 'neutral') return 'neutral'
  if (s === 'assassin') return 'assassin'
  return s || 'unknown'
}

function isOnline(lastSeen: string | null | undefined): boolean {
  if (!lastSeen) return false
  const ms = Date.parse(lastSeen)
  if (!Number.isFinite(ms)) return false
  return Date.now() - ms <= ONLINE_MS
}

function statusPill(lastSeen: string | null | undefined): { text: string; bg: string } {
  if (isOnline(lastSeen)) return { text: 'online', bg: 'rgba(40,190,120,0.16)' }
  return { text: 'away', bg: 'rgba(255,255,255,0.06)' }
}

export default function GameBoard(props: Props) {
  const { state, actions, onBackToHome, onBackToLobby, onOpenProfile, onOpenSettings } = props

  const game = state.game
  const me = state.me

  const [clueWord, setClueWord] = useState('')
  const [clueNumber, setClueNumber] = useState(1)
  const [busy, setBusy] = useState<string | null>(null)

  const [confirmReveal, setConfirmReveal] = useState<boolean>(() => readBool('oneclue_confirm_reveal', true))
  useEffect(() => {
    writeBool('oneclue_confirm_reveal', confirmReveal)
  }, [confirmReveal])

  // action locks / cooldowns
  const inFlightRef = useRef<{ clue: boolean; reveal: boolean; end: boolean }>({ clue: false, reveal: false, end: false })
  const lastRevealAtRef = useRef<number>(0)

  // Toasts
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const toastTimeoutsRef = useRef<number[]>([])
  const didInitRef = useRef(false)

  function addToast(text: string, tone: ToastTone = 'info') {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    setToasts((prev) => [...prev, { id, text, tone }])

    const t = window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id))
      toastTimeoutsRef.current = toastTimeoutsRef.current.filter((x) => x !== t)
    }, TOAST_MS)

    toastTimeoutsRef.current.push(t)
  }

  useEffect(() => {
    return () => {
      toastTimeoutsRef.current.forEach((t) => window.clearTimeout(t))
      toastTimeoutsRef.current = []
    }
  }, [])

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

  const membersById = useMemo(() => {
    const map = new Map<string, LobbyMemberView>()
    for (const m of state.members) map.set(m.user_id, m)
    return map
  }, [state.members])

  const status = (game?.status ?? 'unknown') as string
  const isActive = status === 'active'
  const isSetup = status === 'setup'
  const isEnded = !isActive && !isSetup && Boolean(game)

  const myTeam = me?.team ?? null
  const turnTeam = (game?.current_turn_team ?? null) as Team | null
  const isMyTurn = Boolean(game && myTeam && turnTeam === myTeam)
  const hasClue = game?.guesses_remaining !== null && game?.guesses_remaining !== undefined

  const canGiveClue = Boolean(isActive && me?.isSpymaster && isMyTurn)
  const canRevealBase = Boolean(isActive && !me?.isSpymaster && isMyTurn && hasClue)
  const canEndTurnBase = Boolean(isActive && !me?.isSpymaster && isMyTurn && hasClue)

  const revealCooldownOk = Date.now() - lastRevealAtRef.current >= REVEAL_COOLDOWN_MS
  const canReveal = canRevealBase && revealCooldownOk && !inFlightRef.current.reveal
  const canEndTurn = canEndTurnBase && !inFlightRef.current.end

  const realtimeBadge = useMemo(() => {
    const s = state.realtimeStatus
    if (s === 'SUBSCRIBED') return 'realtime: OK'
    if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') return 'realtime: OFF (polling)'
    return 'realtime: …'
  }, [state.realtimeStatus])

  const myMemberIndex = useMemo(() => {
    if (!me?.userId) return -1
    return state.members.findIndex((m) => m.user_id === me.userId)
  }, [me?.userId, state.members])

  const myDisplayName = useMemo(() => {
    if (!me || myMemberIndex < 0) return '—'
    return displayNameFor(state.members[myMemberIndex], myMemberIndex)
  }, [me, myMemberIndex, state.members])

  const turnPill = useMemo(() => {
    const isRed = turnTeam === 'red'
    const isBlue = turnTeam === 'blue'

    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          borderRadius: 999,
          border: '1px solid rgba(255,255,255,0.12)',
          background: isRed ? 'rgba(255,60,60,0.18)' : isBlue ? 'rgba(80,140,255,0.18)' : 'rgba(255,255,255,0.06)'
        }}
      >
        <span style={{ opacity: 0.85 }}>Turn</span>
        <b>{teamLabel(turnTeam)}</b>
        <span style={{ opacity: 0.85 }}>{isMyTurn ? '(you)' : ''}</span>
      </span>
    )
  }, [turnTeam, isMyTurn])

  const blockReason = useMemo(() => {
    if (!isActive) return null
    if (me?.isSpymaster) return null
    if (!isMyTurn) return 'Not your turn.'
    if (!hasClue) return 'Wait for your spymaster to give a clue.'
    if (!revealCooldownOk) return 'Wait a moment…'
    return null
  }, [isActive, me?.isSpymaster, isMyTurn, hasClue, revealCooldownOk])

  // Event detection for toasts
  const prevGameRef = useRef<any>(null)
  const prevCardsRef = useRef<Map<number, any>>(new Map())

  useEffect(() => {
    if (!game) return
    if (!didInitRef.current) {
      didInitRef.current = true
      prevGameRef.current = game
      const m = new Map<number, any>()
      for (const c of state.cards) m.set(Number(c.pos), c)
      prevCardsRef.current = m
      return
    }

    const prev = prevGameRef.current
    prevGameRef.current = game

    if (prev) {
      if (prev.current_turn_team !== game.current_turn_team && game.current_turn_team) {
        addToast(`Turn: ${teamLabel(game.current_turn_team as any)}`, 'info')
      }

      const prevClue = (prev.clue_word ?? '').trim()
      const nextClue = (game.clue_word ?? '').trim()
      if (prevClue !== nextClue && nextClue) {
        addToast(`Clue: ${nextClue} (${game.clue_number ?? '—'})`, 'info')
      }

      if (prev.status !== game.status && String(game.status) !== 'active' && String(game.status) !== 'setup') {
        addToast(winnerText((game as any).winning_team), 'success')
      }
    }
  }, [game]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!didInitRef.current) return
    if (!state.cards || state.cards.length === 0) return

    const prevMap = prevCardsRef.current
    const nextMap = new Map<number, any>()
    for (const c of state.cards) nextMap.set(Number(c.pos), c)

    for (const c of state.cards) {
      const pos = Number(c.pos)
      const prev = prevMap.get(pos)

      if (prev && !prev.revealed && c.revealed) {
        const actorId = c.revealed_by ? String(c.revealed_by) : ''
        const actor = actorId ? membersById.get(actorId) : null
        const actorName = actor ? displayNameFor(actor, state.members.findIndex((x) => x.user_id === actor.user_id)) : 'Someone'
        const actorTeam = actor?.team ?? null
        const rc = colorLabel(c.revealed_color)

        let tone: ToastTone = 'info'
        let text = `${actorName} revealed "${c.word}" (${rc}).`

        if (rc === 'assassin') {
          tone = 'danger'
          const win = (state.game as any)?.winning_team ? winnerText((state.game as any).winning_team) : 'Game over'
          text = `${actorName} revealed the assassin. ${win}.`
        } else if (actorTeam && rc === String(actorTeam)) {
          tone = 'success'
          text = `${actorName} found a ${rc} agent: "${c.word}".`
        } else if (rc === 'neutral') {
          tone = 'info'
          text = `${actorName} hit neutral: "${c.word}".`
        } else {
          tone = 'warning'
          text = `${actorName} hit enemy: "${c.word}" (${rc}).`
        }

        addToast(text, tone)
      }
    }

    prevCardsRef.current = nextMap
  }, [state.cards, membersById, state.members, state.game]) // eslint-disable-line react-hooks/exhaustive-deps

  async function doSendClue() {
    if (!canGiveClue) return
    if (inFlightRef.current.clue) return

    const w = clueWord.trim()
    if (!w) return
    const n = guardNumber(clueNumber)

    try {
      inFlightRef.current.clue = true
      setBusy('Setting clue…')
      await actions.sendClue(w, n)
      setClueWord('')
      setClueNumber(1)
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : 'failed to set clue')
    } finally {
      inFlightRef.current.clue = false
      setBusy(null)
    }
  }

  async function doReveal(card: GameCard) {
    if (!canRevealBase) return
    if (!revealCooldownOk) return
    if (inFlightRef.current.reveal) return
    if (card.revealed) return

    if (confirmReveal) {
      const ok = window.confirm(`Reveal "${card.word}"?`)
      if (!ok) return
    }

    try {
      inFlightRef.current.reveal = true
      lastRevealAtRef.current = Date.now()
      setBusy('Revealing…')
      await actions.reveal(card.pos)
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : 'failed to reveal')
    } finally {
      inFlightRef.current.reveal = false
      setBusy(null)
    }
  }

  async function doEndTurn() {
    if (!canEndTurnBase) return
    if (inFlightRef.current.end) return

    try {
      inFlightRef.current.end = true
      setBusy('Ending turn…')
      await actions.endTurn()
      addToast('Turn ended.', 'info')
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : 'failed to end turn')
    } finally {
      inFlightRef.current.end = false
      setBusy(null)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0b0b0f', color: '#fff', padding: 16, position: 'relative' }}>
      {/* Toast stack */}
      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          top: 12,
          right: 12,
          zIndex: 999999,
          display: 'grid',
          gap: 8,
          width: 360,
          maxWidth: 'calc(100vw - 24px)'
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.12)',
              background:
                t.tone === 'success'
                  ? 'rgba(40,190,120,0.16)'
                  : t.tone === 'warning'
                    ? 'rgba(240,190,70,0.16)'
                    : t.tone === 'danger'
                      ? 'rgba(255,80,80,0.16)'
                      : 'rgba(0,0,0,0.55)',
              color: '#fff',
              boxShadow: '0 12px 32px rgba(0,0,0,0.35)'
            }}
          >
            {t.text}
          </div>
        ))}
      </div>

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

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 8, opacity: 0.95 }}>
          <input type="checkbox" checked={confirmReveal} onChange={(e) => setConfirmReveal(e.target.checked)} />
          <span>Confirm reveal</span>
        </label>

        <div style={{ opacity: 0.8, fontSize: 12, marginLeft: 8 }}>{realtimeBadge}</div>

        <button onClick={() => actions.refresh()} style={{ marginLeft: 'auto' }}>
          Refresh
        </button>
      </div>

      <div style={{ padding: 12, border: '1px solid #2a2a35', borderRadius: 12, background: '#111118' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ opacity: 0.9 }}>
            You: <b>{myDisplayName}</b> • team <b>{teamLabel(myTeam)}</b> • role <b>{me?.isSpymaster ? 'spymaster' : 'operative'}</b>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 10px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.12)',
                background:
                  turnTeam === 'red' ? 'rgba(255,60,60,0.18)' : turnTeam === 'blue' ? 'rgba(80,140,255,0.18)' : 'rgba(255,255,255,0.06)'
              }}
            >
              <span style={{ opacity: 0.85 }}>Turn</span>
              <b>{teamLabel(turnTeam)}</b>
              <span style={{ opacity: 0.85 }}>{isMyTurn ? '(you)' : ''}</span>
            </span>

            <div style={{ opacity: 0.9 }}>
              guesses left: <b>{game?.guesses_remaining ?? '—'}</b>
            </div>
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

        {blockReason && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 10,
              border: '1px solid #2a2a35',
              background: '#0d0d14',
              opacity: 0.95
            }}
          >
            {blockReason}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr 280px', gap: 12, marginTop: 12 }}>
        <div style={{ padding: 12, border: '1px solid #2a2a35', borderRadius: 12, background: '#111118' }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Red Team</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {redTeam.map((m, idx) => {
              const pill = statusPill(m.last_seen_at)
              return (
                <div
                  key={m.user_id}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid #1f1f29',
                    background: '#0d0d14',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    alignItems: 'center'
                  }}
                >
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontWeight: 800 }}>{displayNameFor(m, idx)}</div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      {m.is_spymaster ? 'spymaster' : 'operative'}
                      {m.is_ready ? ' • ready' : ''}
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 12,
                      opacity: 0.9,
                      padding: '4px 8px',
                      borderRadius: 999,
                      border: '1px solid rgba(255,255,255,0.12)',
                      background: pill.bg
                    }}
                  >
                    {pill.text}
                  </div>
                </div>
              )
            })}
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
                <button onClick={doSendClue} disabled={busy !== null || clueWord.trim().length === 0 || inFlightRef.current.clue}>
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
              {!canRevealBase && isActive && <div style={{ opacity: 0.8 }}>Reveals are locked right now.</div>}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${boardSize}, minmax(0, 1fr))`, gap: 8 }}>
            {state.cards.map((c) => {
              const hint = state.showKey ? state.keyByPos.get(c.pos) : undefined
              const hintText = hint ? keyLetter(hint) : ''
              const revealEnabled = isActive && canReveal && !c.revealed && busy === null

              return (
                <button
                  key={c.pos}
                  onClick={() => doReveal(c)}
                  disabled={!revealEnabled}
                  title={!revealEnabled ? blockReason ?? '' : ''}
                  style={{
                    position: 'relative',
                    padding: 12,
                    borderRadius: 12,
                    border: '1px solid #1f1f29',
                    background: '#111118',
                    color: '#fff',
                    textAlign: 'left',
                    minHeight: 62,
                    opacity: c.revealed ? 0.65 : revealEnabled ? 1 : 0.55,
                    cursor: revealEnabled ? 'pointer' : 'not-allowed'
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
                        revealed • <b>{String(c.revealed_color ?? '—')}</b>
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
            {blueTeam.map((m, idx) => {
              const pill = statusPill(m.last_seen_at)
              return (
                <div
                  key={m.user_id}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid #1f1f29',
                    background: '#0d0d14',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    alignItems: 'center'
                  }}
                >
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontWeight: 800 }}>{displayNameFor(m, idx)}</div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      {m.is_spymaster ? 'spymaster' : 'operative'}
                      {m.is_ready ? ' • ready' : ''}
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 12,
                      opacity: 0.9,
                      padding: '4px 8px',
                      borderRadius: 999,
                      border: '1px solid rgba(255,255,255,0.12)',
                      background: pill.bg
                    }}
                  >
                    {pill.text}
                  </div>
                </div>
              )
            })}
            {blueTeam.length === 0 && <div style={{ opacity: 0.75 }}>no players</div>}
          </div>

          {spectators.length > 0 && (
            <>
              <div style={{ marginTop: 14, fontWeight: 900, opacity: 0.95 }}>Spectators</div>
              <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                {spectators.map((m, idx) => {
                  const pill = statusPill(m.last_seen_at)
                  return (
                    <div key={m.user_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <div style={{ opacity: 0.85, fontSize: 13 }}>{displayNameFor(m, idx)}</div>
                      <div
                        style={{
                          fontSize: 12,
                          opacity: 0.9,
                          padding: '4px 8px',
                          borderRadius: 999,
                          border: '1px solid rgba(255,255,255,0.12)',
                          background: pill.bg
                        }}
                      >
                        {pill.text}
                      </div>
                    </div>
                  )
                })}
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

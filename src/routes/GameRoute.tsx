import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import {
  loadGame,
  loadGameCards,
  revealCard,
  setClue,
  endTurn,
  loadSpymasterKey,
  type Game,
  type GameCard,
  type SpymasterKeyRow,
  type CardColor
} from '../lib/games'

type LoadState = 'loading' | 'ready' | 'error'

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

function keyColorText(c: CardColor): string {
  if (c === 'assassin') return 'A'
  if (c === 'neutral') return 'N'
  if (c === 'red') return 'R'
  return 'B'
}

export default function GameRoute() {
  const { id } = useParams()
  const navigate = useNavigate()

  const gameId = useMemo(() => (id ?? '').trim(), [id])

  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const [game, setGame] = useState<Game | null>(null)
  const [cards, setCards] = useState<GameCard[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const [myTeam, setMyTeam] = useState<'red' | 'blue' | null>(null)
  const [amSpymaster, setAmSpymaster] = useState(false)

  const [clueWord, setClueWord] = useState('')
  const [clueNumber, setClueNumber] = useState(1)

  const [showKey, setShowKey] = useState(false)
  const [keyRows, setKeyRows] = useState<SpymasterKeyRow[]>([])
  const keyMap = useMemo(() => {
    const m = new Map<number, CardColor>()
    for (const r of keyRows) m.set(r.pos, r.color)
    return m
  }, [keyRows])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)

        if (!gameId) throw new Error('Missing game id')

        const g = await loadGame(gameId)
        const c = await loadGameCards(gameId)

        const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr

        const uid = sessionData.session?.user?.id ?? null
        if (!uid) throw new Error('No session')

        const { data: lm, error: lmErr } = await supabase
          .from('lobby_members')
          .select('team,is_spymaster')
          .eq('lobby_id', g.lobby_id)
          .eq('user_id', uid)
          .single()

        if (lmErr) throw lmErr

        if (cancelled) return
        setGame(g)
        setCards(c)
        setMyTeam((lm?.team ?? null) as 'red' | 'blue' | null)
        setAmSpymaster(Boolean(lm?.is_spymaster))
        setClueWord(g.clue_word ?? '')
        setClueNumber(g.clue_number ?? 1)
        setState('ready')
      } catch (err) {
        console.error('[game] load failed:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : supaErr(err))
          setState('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [gameId])

  useEffect(() => {
    if (!gameId) return
    if (!game?.lobby_id) return

    const lobbyId = game.lobby_id

    const channel = supabase
      .channel(`lobby:${lobbyId}`, { config: { private: true } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, async () => {
        const g = await loadGame(gameId)
        setGame(g)
        setClueWord(g.clue_word ?? '')
        setClueNumber(g.clue_number ?? 1)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `game_id=eq.${gameId}` }, async () => {
        const c = await loadGameCards(gameId)
        setCards(c)
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [gameId, game?.lobby_id])

  useEffect(() => {
    let cancelled = false
    if (!amSpymaster || !showKey || !gameId) return

    ;(async () => {
      try {
        const rows = await loadSpymasterKey(gameId)
        if (!cancelled) setKeyRows(rows)
      } catch (err) {
        console.error('[game] key load failed:', err)
        if (!cancelled) alert(supaErr(err))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [amSpymaster, showKey, gameId])

  async function handleReveal(pos: number) {
    if (!gameId) return
    try {
      setBusy('Revealing…')
      await revealCard(gameId, pos)
    } catch (err) {
      console.error('[game] reveal failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleSetClue() {
    if (!gameId) return
    try {
      setBusy('Setting clue…')
      await setClue(gameId, clueWord, clueNumber)
    } catch (err) {
      console.error('[game] set clue failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleEndTurn() {
    if (!gameId) return
    try {
      setBusy('Ending turn…')
      await endTurn(gameId)
    } catch (err) {
      console.error('[game] end turn failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  const isMyTurn = game !== null && game.current_turn_team !== null && myTeam === game.current_turn_team
  const hasActiveClue = game !== null && game.guesses_remaining !== null && game.guesses_remaining !== undefined
  const canEndTurn = game !== null && !amSpymaster && isMyTurn && game.status === 'active' && hasActiveClue

  return (
    <div style={{ minHeight: '100vh', padding: 16, background: '#0b0b0f', color: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={() => navigate('/')}>Home</button>
        <button onClick={() => navigate(-1)}>Back</button>
      </div>

      <h2 style={{ marginBottom: 8 }}>Game</h2>

      {state === 'loading' && <p>Loading…</p>}
      {state === 'error' && (
        <div style={{ padding: 12, border: '1px solid #ff4d4f', borderRadius: 8 }}>
          <p style={{ margin: 0 }}>Error: {error}</p>
        </div>
      )}

      {state === 'ready' && game && (
        <>
          <div style={{ padding: 12, border: '1px solid #2a2a35', borderRadius: 8 }}>
            <p style={{ margin: 0, opacity: 0.9 }}>
              Turn: <b>{game.current_turn_team ?? '—'}</b> • You: <b>{myTeam ?? '—'}</b> ({amSpymaster ? 'spymaster' : 'operative'})
            </p>
            <p style={{ margin: '6px 0 0 0', opacity: 0.85 }}>
              Red left: <b>{game.red_remaining}</b> • Blue left: <b>{game.blue_remaining}</b> • guesses left:{' '}
              <b>{game.guesses_remaining ?? '—'}</b>
            </p>
            <p style={{ margin: '6px 0 0 0', opacity: 0.85 }}>
              Clue: <b>{game.clue_word ?? '—'}</b> {game.clue_number !== null ? `(${game.clue_number})` : ''}
            </p>

            {amSpymaster && (
              <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: '1px solid #1f1f29', background: '#111118' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={showKey} onChange={(e) => setShowKey(e.target.checked)} />
                  <span>Show key (spymaster)</span>
                </label>
              </div>
            )}

            {canEndTurn && (
              <div style={{ marginTop: 10 }}>
                <button onClick={handleEndTurn} disabled={busy !== null}>
                  End turn
                </button>
              </div>
            )}
          </div>

          {amSpymaster && isMyTurn && game.status === 'active' && (
            <div style={{ marginTop: 12, padding: 12, border: '1px solid #2a2a35', borderRadius: 8, maxWidth: 520 }}>
              <h3 style={{ marginTop: 0 }}>Give clue</h3>
              <div style={{ display: 'grid', gap: 10 }}>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span>Word</span>
                  <input
                    value={clueWord}
                    onChange={(e) => setClueWord(e.target.value)}
                    style={{ padding: 10, borderRadius: 8, border: '1px solid #2a2a35', background: '#111118', color: '#fff' }}
                  />
                </label>

                <label style={{ display: 'grid', gap: 6 }}>
                  <span>Number (0..9)</span>
                  <input
                    type="number"
                    value={clueNumber}
                    onChange={(e) => setClueNumber(Number(e.target.value))}
                    style={{ padding: 10, borderRadius: 8, border: '1px solid #2a2a35', background: '#111118', color: '#fff' }}
                  />
                </label>

                <button onClick={handleSetClue} disabled={busy !== null || clueWord.trim().length === 0}>
                  {busy ? 'Working…' : 'Set clue'}
                </button>
              </div>
            </div>
          )}

          <div
            style={{
              marginTop: 12,
              display: 'grid',
              gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
              gap: 8,
              maxWidth: 720
            }}
          >
            {cards.map((c) => {
              const hidden = showKey ? keyMap.get(c.pos) : undefined

              return (
                <button
                  key={c.pos}
                  onClick={() => handleReveal(c.pos)}
                  disabled={busy !== null || c.revealed || game.status !== 'active'}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid #1f1f29',
                    background: '#111118',
                    color: '#fff',
                    textAlign: 'left',
                    opacity: c.revealed ? 0.65 : 1,
                    cursor: c.revealed ? 'not-allowed' : 'pointer'
                  }}
                >
                  <div style={{ fontWeight: 700, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>{c.word}</span>
                    {hidden ? <span style={{ fontFamily: 'monospace', opacity: 0.9 }}>{keyColorText(hidden)}</span> : null}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                    revealed: <b>{c.revealed ? 'yes' : 'no'}</b>
                    {c.revealed && c.revealed_color ? (
                      <>
                        {' '}
                        • color: <b>{c.revealed_color}</b>
                      </>
                    ) : null}
                  </div>
                </button>
              )
            })}
          </div>
        </>
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
          <div style={{ padding: 16, borderRadius: 12, border: '1px solid #2a2a35', background: '#111118' }}>
            {busy}
          </div>
        </div>
      )}
    </div>
  )
}

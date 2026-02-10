import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { getLobbyByCode, joinLobby, type Lobby } from '../lib/lobbies'
import { startGame } from '../lib/games'

type MemberRow = {
  lobby_id: string
  user_id: string
  role: 'owner' | 'player' | 'spectator'
  team: 'red' | 'blue' | null
  is_spymaster: boolean
  is_ready: boolean
  joined_at: string
  last_seen_at: string
}

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

export default function LobbyRoute() {
  const { code } = useParams()
  const navigate = useNavigate()
  const lobbyCode = useMemo(() => (code ?? '').trim().toUpperCase(), [code])

  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function refreshMembers(lobbyId: string) {
    const { data, error } = await supabase
      .from('lobby_members')
      .select('*')
      .eq('lobby_id', lobbyId)
      .order('joined_at', { ascending: true })

    if (!error) setMembers((data ?? []) as MemberRow[])
  }

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)
        if (!lobbyCode) throw new Error('Missing lobby code')

        await joinLobby(lobbyCode)

        const l = await getLobbyByCode(lobbyCode)
        if (cancelled) return
        setLobby(l)

        const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr

        const uid = sessionData.session?.user?.id ?? null
        setMyUserId(uid)
        setIsOwner(uid !== null && uid === l.owner_id)

        await refreshMembers(l.id)
        setState('ready')
      } catch (err) {
        console.error('[lobby] load failed:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : supaErr(err))
          setState('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [lobbyCode])

  useEffect(() => {
    if (!lobby?.id) return

    const channel = supabase
      .channel(`lobby:${lobby.id}`, { config: { private: true } })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lobby_members', filter: `lobby_id=eq.${lobby.id}` },
        async () => {
          await refreshMembers(lobby.id)
        }
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lobbies', filter: `id=eq.${lobby.id}` }, async () => {
        const updated = await getLobbyByCode(lobbyCode)
        setLobby(updated)
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [lobby?.id, lobbyCode])

  const playable = members.filter((m) => m.role === 'owner' || m.role === 'player')
  const redSpy = playable.filter((m) => m.team === 'red' && m.is_spymaster).length
  const blueSpy = playable.filter((m) => m.team === 'blue' && m.is_spymaster).length
  const redOps = playable.filter((m) => m.team === 'red' && !m.is_spymaster).length
  const blueOps = playable.filter((m) => m.team === 'blue' && !m.is_spymaster).length

  const canStart =
    isOwner &&
    lobby?.status === 'open' &&
    redSpy === 1 &&
    blueSpy === 1 &&
    redOps >= 1 &&
    blueOps >= 1

  async function handleSetTeam(targetUserId: string, team: 'red' | 'blue') {
    if (!lobby) return
    try {
      setBusy(`Moving to ${team}…`)
      const { error } = await supabase.rpc('set_member_team', {
        p_lobby_id: lobby.id,
        p_user_id: targetUserId,
        p_team: team
      })
      if (error) throw error
      await refreshMembers(lobby.id)
    } catch (err) {
      console.error('[lobby] set_member_team failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleToggleSpymaster(targetUserId: string, makeSpymaster: boolean) {
    if (!lobby) return
    try {
      setBusy(makeSpymaster ? 'Making spymaster…' : 'Making operative…')

      const { error } = await supabase.rpc('set_member_spymaster', {
        p_lobby_id: lobby.id,
        p_user_id: targetUserId,
        p_is_spymaster: makeSpymaster
      })

      if (error) throw error
      await refreshMembers(lobby.id)
    } catch (err) {
      console.error('[lobby] set_member_spymaster failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleStartGame() {
    if (!lobby) return
    try {
      setBusy('Starting game…')
      const gameId = await startGame(lobby.id)
      navigate(`/game/${gameId}`)
    } catch (err) {
      console.error('[lobby] start game failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  const myRow = myUserId ? members.find((m) => m.user_id === myUserId) : null

  return (
    <div style={{ minHeight: '100vh', padding: 16, background: '#0b0b0f', color: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={() => navigate('/')}>Back</button>
        <button onClick={() => navigate(`/settings/${lobbyCode}`)}>Settings</button>
      </div>

      <h2 style={{ marginBottom: 8 }}>Lobby</h2>

      {state === 'loading' && <p>Joining and loading…</p>}

      {state === 'error' && (
        <div style={{ padding: 12, border: '1px solid #ff4d4f', borderRadius: 8 }}>
          <p style={{ margin: 0 }}>Error: {error}</p>
        </div>
      )}

      {state === 'ready' && lobby && (
        <>
          <div style={{ marginTop: 12, padding: 12, border: '1px solid #2a2a35', borderRadius: 8 }}>
            <p style={{ margin: 0, opacity: 0.9 }}>
              Code: <b>{lobby.code}</b>
            </p>
            <p style={{ margin: '6px 0 0 0', opacity: 0.8 }}>
              Status: <b>{lobby.status}</b> • Owner: <b>{isOwner ? 'you' : 'no'}</b>
            </p>

            {myRow && (
              <p style={{ margin: '10px 0 0 0', opacity: 0.9 }}>
                You: team <b>{myRow.team ?? '—'}</b> • role <b>{myRow.is_spymaster ? 'spymaster' : 'operative'}</b>
              </p>
            )}

            <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: '1px solid #1f1f29', background: '#111118' }}>
              <div style={{ opacity: 0.9, marginBottom: 6 }}>
                Setup needed to start:
              </div>
              <div style={{ opacity: 0.85 }}>
                Red: spymaster <b>{redSpy}</b>, operatives <b>{redOps}</b> • Blue: spymaster <b>{blueSpy}</b>, operatives <b>{blueOps}</b>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={handleStartGame} disabled={!canStart}>
                  Start Game
                </button>
                {!canStart && (
                  <span style={{ opacity: 0.8 }}>
                    Need 1 spymaster + 1 operative per team (usually 4 browser sessions).
                  </span>
                )}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, padding: 12, border: '1px solid #2a2a35', borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>Members</h3>

            <div style={{ display: 'grid', gap: 8 }}>
              {members.map((m) => (
                <div
                  key={m.user_id}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid #1f1f29',
                    background: '#111118',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12
                  }}
                >
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.85 }}>{m.user_id}</div>
                    <div style={{ marginTop: 4, opacity: 0.9 }}>
                      team: <b>{m.team ?? '—'}</b> • role: <b>{m.is_spymaster ? 'spymaster' : 'operative'}</b> • lobby role:{' '}
                      <b>{m.role}</b>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gap: 6, textAlign: 'right' }}>
                    <div style={{ opacity: 0.85 }}>
                      ready: <b>{m.is_ready ? 'yes' : 'no'}</b>
                    </div>

                    {isOwner && lobby.status === 'open' && m.role !== 'spectator' && (
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <button onClick={() => handleSetTeam(m.user_id, 'red')} disabled={busy !== null}>
                          To red
                        </button>
                        <button onClick={() => handleSetTeam(m.user_id, 'blue')} disabled={busy !== null}>
                          To blue
                        </button>
                        {m.team ? (
                          m.is_spymaster ? (
                            <button onClick={() => handleToggleSpymaster(m.user_id, false)} disabled={busy !== null}>
                              Make operative
                            </button>
                          ) : (
                            <button onClick={() => handleToggleSpymaster(m.user_id, true)} disabled={busy !== null}>
                              Make spymaster
                            </button>
                          )
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {lobby.status !== 'open' && <p style={{ marginTop: 10, opacity: 0.8 }}>Roles/teams are locked after start.</p>}
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

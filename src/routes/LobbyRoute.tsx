import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { getLobbyByCode, joinLobby, type Lobby } from '../lib/lobbies'
import { startGame } from '../lib/games'
import { getLobbyProfiles } from '../lib/publicProfiles'

type ProfileLite = {
  display_name: string | null
  avatar_url: string | null
}

type MemberRow = {
  lobby_id: string
  user_id: string
  role: 'owner' | 'player' | 'spectator'
  team: 'red' | 'blue' | null
  is_spymaster: boolean
  is_ready: boolean
  joined_at: string
  last_seen_at: string | null
  profiles?: ProfileLite | null
}

type LoadState = 'loading' | 'ready' | 'error'

const ONLINE_MS = 25_000
const HEARTBEAT_MS = 10_000

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

function displayNameFor(m: MemberRow, index: number): string {
  const n = (m.profiles?.display_name ?? '').trim()
  if (n) return n
  return `Player ${index + 1}`
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

function clearKey(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
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

  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  const [requireReady, setRequireReady] = useState<boolean>(() => readBool('oneclue_require_ready_start', false))
  useEffect(() => {
    writeBool('oneclue_require_ready_start', requireReady)
  }, [requireReady])

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])

  function showNotice(msg: string) {
    setNotice(msg)
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2200)
  }

  async function copyText(label: string, text: string) {
    const clean = String(text ?? '').trim()
    if (!clean) return

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(clean)
        showNotice(`${label} copied`)
        return
      }
      window.prompt(`Copy ${label}:`, clean)
      showNotice('Copied manually')
    } catch {
      window.prompt(`Copy ${label}:`, clean)
      showNotice('Copied manually')
    }
  }

  const lobbyLink = useMemo(() => {
    if (!lobbyCode) return ''
    try {
      return `${window.location.origin}/lobby/${lobbyCode}`
    } catch {
      return `/lobby/${lobbyCode}`
    }
  }, [lobbyCode])

  async function refreshMembers(lobbyId: string) {
    const { data, error } = await supabase
      .from('lobby_members')
      .select('lobby_id,user_id,role,team,is_spymaster,is_ready,joined_at,last_seen_at')
      .eq('lobby_id', lobbyId)
      .order('joined_at', { ascending: true })

    if (error) return

    const base = (data ?? []) as MemberRow[]

    let profileMap = new Map<string, ProfileLite>()
    try {
      const profs = await getLobbyProfiles(lobbyId)
      for (const p of profs) {
        profileMap.set(String(p.user_id), {
          display_name: (p.display_name ?? null) as string | null,
          avatar_url: (p.avatar_url ?? null) as string | null
        })
      }
    } catch (err) {
      console.warn('[lobby] get_lobby_profiles failed, using fallbacks:', err)
      profileMap = new Map()
    }

    const merged = base.map((m) => ({ ...m, profiles: profileMap.get(m.user_id) ?? null }))
    setMembers(merged)
  }

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)
        if (!lobbyCode) throw new Error('Missing lobby code')

        await joinLobby(lobbyCode)

        // ✅ store for auto-rejoin
        try {
          localStorage.setItem('oneclue_last_lobby_code', lobbyCode)
        } catch {
          // ignore
        }

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

  // Realtime
  useEffect(() => {
    if (!lobby?.id) return

    const channel = supabase
      .channel(`lobby_${lobby.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lobby_members', filter: `lobby_id=eq.${lobby.id}` }, async () => {
        await refreshMembers(lobby.id)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lobbies', filter: `id=eq.${lobby.id}` }, async () => {
        const updated = await getLobbyByCode(lobbyCode)
        setLobby(updated)
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [lobby?.id, lobbyCode])

  // Heartbeat
  useEffect(() => {
    if (!lobby?.id) return
    if (!myUserId) return

    const tick = async () => {
      if (document.hidden) return
      try {
        await supabase
          .from('lobby_members')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('lobby_id', lobby.id)
          .eq('user_id', myUserId)
      } catch {
        // ignore
      }
    }

    void tick()

    const t = window.setInterval(() => {
      void tick()
    }, HEARTBEAT_MS)

    return () => {
      window.clearInterval(t)
    }
  }, [lobby?.id, myUserId])

  const playable = members.filter((m) => m.role === 'owner' || m.role === 'player')
  const redSpy = playable.filter((m) => m.team === 'red' && m.is_spymaster).length
  const blueSpy = playable.filter((m) => m.team === 'blue' && m.is_spymaster).length
  const redOps = playable.filter((m) => m.team === 'red' && !m.is_spymaster).length
  const blueOps = playable.filter((m) => m.team === 'blue' && !m.is_spymaster).length

  const readyCount = playable.filter((m) => m.is_ready).length
  const playableCount = playable.length
  const readyOk = playableCount > 0 && readyCount === playableCount

  const baseCanStart = isOwner && lobby?.status === 'open' && redSpy === 1 && blueSpy === 1 && redOps >= 1 && blueOps >= 1
  const canStart = Boolean(baseCanStart && (!requireReady || readyOk))

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

  async function handleToggleReady() {
    if (!lobby) return
    if (!myUserId) return

    const mine = members.find((m) => m.user_id === myUserId)
    const next = !(mine?.is_ready ?? false)

    try {
      setBusy(next ? 'Setting ready…' : 'Setting not ready…')
      const { error } = await supabase
        .from('lobby_members')
        .update({ is_ready: next })
        .eq('lobby_id', lobby.id)
        .eq('user_id', myUserId)

      if (error) throw error
      await refreshMembers(lobby.id)
    } catch (err) {
      console.error('[lobby] toggle ready failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleLeaveLobby() {
    if (!lobby) return
    if (!myUserId) return

    const ok = window.confirm('Leave this lobby?')
    if (!ok) return

    try {
      setBusy('Leaving…')

      // remove membership
      const { error } = await supabase.from('lobby_members').delete().eq('lobby_id', lobby.id).eq('user_id', myUserId)
      if (error) throw error

      // clear auto rejoin
      clearKey('oneclue_last_lobby_code')

      navigate('/', { replace: true })
    } catch (err) {
      console.error('[lobby] leave failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  const myRow = myUserId ? members.find((m) => m.user_id === myUserId) : null

  return (
    <div style={{ minHeight: '100vh', padding: 16, background: '#0b0b0f', color: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={() => navigate('/')}>Back</button>
        <button onClick={() => navigate(`/settings/${lobbyCode}`)}>Settings</button>
        <button onClick={() => navigate('/profile')}>Profile</button>
        <button onClick={handleLeaveLobby} disabled={!myRow || busy !== null} style={{ marginLeft: 'auto' }}>
          Leave lobby
        </button>
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

            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button onClick={() => copyText('code', lobby.code)} disabled={!lobby.code}>
                Copy code
              </button>
              <button onClick={() => copyText('invite link', lobbyLink)} disabled={!lobbyLink}>
                Copy invite link
              </button>
              {notice && (
                <span
                  style={{
                    opacity: 0.85,
                    padding: '4px 10px',
                    borderRadius: 999,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: '#111118'
                  }}
                >
                  {notice}
                </span>
              )}
            </div>

            <p style={{ margin: '10px 0 0 0', opacity: 0.8 }}>
              Status: <b>{lobby.status}</b> • Owner: <b>{isOwner ? 'you' : 'no'}</b>
            </p>

            {myRow && (
              <p style={{ margin: '10px 0 0 0', opacity: 0.9 }}>
                You: <b>{displayNameFor(myRow, members.findIndex((x) => x.user_id === myRow.user_id))}</b> • team{' '}
                <b>{myRow.team ?? '—'}</b> • role <b>{myRow.is_spymaster ? 'spymaster' : 'operative'}</b> • ready{' '}
                <b>{myRow.is_ready ? 'yes' : 'no'}</b>
              </p>
            )}

            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button onClick={handleToggleReady} disabled={!myRow || busy !== null || lobby.status !== 'open'}>
                {myRow?.is_ready ? 'Set not ready' : 'Set ready'}
              </button>

              {isOwner && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: 0.95 }}>
                  <input
                    type="checkbox"
                    checked={requireReady}
                    onChange={(e) => setRequireReady(e.target.checked)}
                    disabled={lobby.status !== 'open'}
                  />
                  <span>Require ready to start</span>
                </label>
              )}

              <span style={{ opacity: 0.85 }}>
                Ready: <b>{readyCount}</b>/<b>{playableCount}</b>
              </span>
            </div>

            <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: '1px solid #1f1f29', background: '#111118' }}>
              <div style={{ opacity: 0.9, marginBottom: 6 }}>Setup needed to start:</div>
              <div style={{ opacity: 0.85 }}>
                Red: spymaster <b>{redSpy}</b>, operatives <b>{redOps}</b> • Blue: spymaster <b>{blueSpy}</b>, operatives <b>{blueOps}</b>
              </div>

              {requireReady && (
                <div style={{ marginTop: 6, opacity: 0.85 }}>
                  Ready required: <b>{readyOk ? 'ok' : 'not yet'}</b>
                </div>
              )}

              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={handleStartGame} disabled={!canStart}>
                  Start Game
                </button>
                {!canStart && (
                  <span style={{ opacity: 0.8 }}>
                    Need 1 spymaster + 1 operative per team{requireReady ? ' + everyone ready' : ''}.
                  </span>
                )}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, padding: 12, border: '1px solid #2a2a35', borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>Members</h3>

            <div style={{ display: 'grid', gap: 8 }}>
              {members.map((m, idx) => {
                const pill = statusPill(m.last_seen_at)
                return (
                  <div
                    key={m.user_id}
                    style={{
                      padding: 10,
                      borderRadius: 10,
                      border: '1px solid #1f1f29',
                      background: '#111118',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ overflow: 'hidden' }}>
                      <div style={{ fontWeight: 800 }}>{displayNameFor(m, idx)}</div>
                      <div style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.75 }}>{m.user_id}</div>
                      <div style={{ marginTop: 4, opacity: 0.9 }}>
                        team: <b>{m.team ?? '—'}</b> • role: <b>{m.is_spymaster ? 'spymaster' : 'operative'}</b> • lobby role:{' '}
                        <b>{m.role}</b>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gap: 6, textAlign: 'right' }}>
                      <div
                        style={{
                          justifySelf: 'end',
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
                )
              })}
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
          <div style={{ padding: 16, borderRadius: 12, border: '1px solid #2a2a35', background: '#111118' }}>{busy}</div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { getLobbyByCode, joinLobby, joinLobbyAsSpectator, type Lobby } from '../lib/lobbies'
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

async function loadLatestLobbyGameId(lobbyId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('games')
    .select('id,status,created_at')
    .eq('lobby_id', lobbyId)
    .in('status', ['setup', 'active'])
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  return row && typeof row.id === 'string' ? row.id : null
}

export default function LobbyRoute() {
  const { code } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const lobbyCode = useMemo(() => (code ?? '').trim().toUpperCase(), [code])

  const spectate = useMemo(() => {
    const sp = new URLSearchParams(location.search).get('spectate')
    return sp === '1' || sp === 'true' || sp === 'yes'
  }, [location.search])

  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const autoNavRef = useRef(false)

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

        if (spectate) {
          await joinLobbyAsSpectator(lobbyCode)
        } else {
          await joinLobby(lobbyCode)
        }

        // store for auto-rejoin + role
        try {
          localStorage.setItem('oneclue_last_lobby_code', lobbyCode)
          localStorage.setItem('oneclue_last_lobby_role', spectate ? 'spectator' : 'player')
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
  }, [lobbyCode, spectate])

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

        if (autoNavRef.current) return

        if (updated.status === 'closed') {
          autoNavRef.current = true
          navigate('/', { replace: true })
          return
        }

        if (updated.status === 'in_game') {
          try {
            const gid = await loadLatestLobbyGameId(updated.id)
            if (gid) {
              autoNavRef.current = true
              navigate(`/game/${gid}`, { replace: true })
            }
          } catch (err) {
            console.error('[lobby] latest game lookup failed:', err)
          }
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `lobby_id=eq.${lobby.id}` }, async () => {
        if (autoNavRef.current) return
        if (lobby.status !== 'in_game') return
        try {
          const gid = await loadLatestLobbyGameId(lobby.id)
          if (gid) {
            autoNavRef.current = true
            navigate(`/game/${gid}`, { replace: true })
          }
        } catch (err) {
          console.error('[lobby] games realtime lookup failed:', err)
        }
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [lobby?.id, lobby?.status, lobbyCode, navigate])

  useEffect(() => {
    autoNavRef.current = false
  }, [lobbyCode])

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

  useEffect(() => {
    if (!lobby?.id) return
    if (lobby.status !== 'in_game') return
    if (autoNavRef.current) return

    ;(async () => {
      try {
        const gid = await loadLatestLobbyGameId(lobby.id)
        if (!gid) return
        autoNavRef.current = true
        navigate(`/game/${gid}`, { replace: true })
      } catch (err) {
        console.error('[lobby] initial in_game navigation failed:', err)
      }
    })()
  }, [lobby?.id, lobby?.status, navigate])

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
      setBusy(`Moving to ${team}â€¦`)
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
      setBusy(makeSpymaster ? 'Making spymasterâ€¦' : 'Making operativeâ€¦')

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
      setBusy('Starting gameâ€¦')
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
    if (!mine) return
    if (mine.role === 'spectator') return

    const next = !(mine.is_ready ?? false)

    try {
      setBusy(next ? 'Setting readyâ€¦' : 'Setting not readyâ€¦')
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
      setBusy('Leavingâ€¦')

      const { error } = await supabase.from('lobby_members').delete().eq('lobby_id', lobby.id).eq('user_id', myUserId)
      if (error) throw error

      clearKey('oneclue_last_lobby_code')
      clearKey('oneclue_last_lobby_role')

      navigate('/', { replace: true })
    } catch (err) {
      console.error('[lobby] leave failed:', err)
      alert(supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  const myRow = myUserId ? members.find((m) => m.user_id === myUserId) : null
  const amSpectator = myRow?.role === 'spectator'

  const myGameRoleLabel = amSpectator ? 'spectator' : myRow?.is_spymaster ? 'spymaster' : 'operative'
  const myTeamLabel = amSpectator ? '-' : myRow?.team ?? '-'
  const redMembers = members.filter((m) => m.team === 'red' && (m.role === 'owner' || m.role === 'player'))
  const blueMembers = members.filter((m) => m.team === 'blue' && (m.role === 'owner' || m.role === 'player'))
  const spectators = members.filter((m) => m.role === 'spectator')

  const btnBase = {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.18)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.02)), rgba(0,0,0,0.30)',
    color: 'rgba(245,248,255,0.96)',
    fontWeight: 900,
    cursor: 'pointer'
  }

  function roleBadge(member: MemberRow) {
    if (member.role === 'owner') return 'owner'
    if (member.is_spymaster) return 'spymaster'
    return 'operative'
  }

  function shortUserId(id: string) {
    if (!id) return '-'
    return `${id.slice(0, 6)}...${id.slice(-4)}`
  }

  function renderMemberCard(member: MemberRow, index: number, tone: 'red' | 'blue' | 'neutral') {
    const pill = statusPill(member.last_seen_at)
    const toneBorder =
      tone === 'red'
        ? '1px solid rgba(255,95,95,0.34)'
        : tone === 'blue'
          ? '1px solid rgba(90,140,255,0.36)'
          : '1px solid rgba(255,255,255,0.12)'
    const toneBg =
      tone === 'red'
        ? 'linear-gradient(180deg, rgba(255,95,95,0.16), rgba(0,0,0,0.22))'
        : tone === 'blue'
          ? 'linear-gradient(180deg, rgba(90,140,255,0.18), rgba(0,0,0,0.24))'
          : 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,0.24))'

    return (
      <div
        key={member.user_id}
        style={{
          borderRadius: 14,
          border: toneBorder,
          background: toneBg,
          boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.42), 0 8px 24px rgba(0,0,0,0.35)',
          padding: 12,
          display: 'grid',
          gap: 10
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 900, fontSize: 15 }}>{displayNameFor(member, index)}</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.72 }}>{shortUserId(member.user_id)}</div>
          </div>

          <div
            style={{
              fontSize: 11,
              padding: '4px 8px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.16)',
              background: pill.bg,
              textTransform: 'uppercase',
              fontWeight: 800
            }}
          >
            {pill.text}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12, opacity: 0.92 }}>
          <span style={{ padding: '3px 8px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.14)' }}>{roleBadge(member)}</span>
          <span style={{ padding: '3px 8px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.14)' }}>
            ready: {member.is_ready ? 'yes' : 'no'}
          </span>
        </div>

        {isOwner && lobby?.status === 'open' && member.role !== 'spectator' && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => handleSetTeam(member.user_id, 'red')} disabled={busy !== null} style={{ ...btnBase, padding: '7px 9px', fontSize: 12 }}>
              Red
            </button>
            <button onClick={() => handleSetTeam(member.user_id, 'blue')} disabled={busy !== null} style={{ ...btnBase, padding: '7px 9px', fontSize: 12 }}>
              Blue
            </button>
            {member.team ? (
              member.is_spymaster ? (
                <button onClick={() => handleToggleSpymaster(member.user_id, false)} disabled={busy !== null} style={{ ...btnBase, padding: '7px 9px', fontSize: 12 }}>
                  Operative
                </button>
              ) : (
                <button onClick={() => handleToggleSpymaster(member.user_id, true)} disabled={busy !== null} style={{ ...btnBase, padding: '7px 9px', fontSize: 12 }}>
                  Spymaster
                </button>
              )
            ) : null}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(900px 520px at 50% 10%, rgba(255,255,255,0.08), rgba(0,0,0,0) 60%), #000', color: '#fff', padding: 16 }}>
      <style>{`
        .lobby-grid-main{
          display:grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        .lobby-teams{
          display:grid;
          grid-template-columns: 1fr 1fr 0.9fr;
          gap: 12px;
          margin-top: 12px;
        }
        @media (max-width: 980px){
          .lobby-grid-main{ grid-template-columns: 1fr; }
          .lobby-teams{ grid-template-columns: 1fr; }
        }
      `}</style>

      <div
        style={{
          width: 'min(1180px, 100%)',
          margin: '0 auto',
          borderRadius: 24,
          border: '1px solid rgba(255,255,255,0.10)',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015))',
          boxShadow: '0 24px 80px rgba(0,0,0,0.72)',
          padding: 14
        }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button onClick={() => navigate('/')} style={btnBase}>Home</button>
          <button onClick={() => navigate(`/settings/${lobbyCode}`)} style={btnBase}>Settings</button>
          <button onClick={() => navigate('/profile')} style={btnBase}>Profile</button>
          <button onClick={handleLeaveLobby} disabled={!myRow || busy !== null} style={{ ...btnBase, marginLeft: 'auto', borderColor: 'rgba(255,120,120,0.35)' }}>
            Leave Lobby
          </button>
        </div>

        {state === 'loading' && <div style={{ padding: 12, opacity: 0.9 }}>Joining and loading...</div>}

        {state === 'error' && (
          <div style={{ padding: 12, borderRadius: 12, border: '1px solid rgba(255,90,90,0.50)', background: 'rgba(255,60,60,0.08)' }}>
            Error: {error}
          </div>
        )}

        {state === 'ready' && lobby && (
          <>
            <div className="lobby-grid-main">
              <div style={{ borderRadius: 16, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.28)', padding: 14 }}>
                <div style={{ fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', opacity: 0.72, fontWeight: 900 }}>Lobby</div>
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 30, fontWeight: 1000, letterSpacing: '.08em' }}>{lobby.code}</div>
                  <span style={{ padding: '5px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.16)', background: lobby.status === 'open' ? 'rgba(90,180,120,0.16)' : lobby.status === 'in_game' ? 'rgba(90,140,255,0.18)' : 'rgba(255,120,120,0.16)', fontSize: 12, fontWeight: 900, textTransform: 'uppercase' }}>
                    {lobby.status}
                  </span>
                </div>

                <div style={{ marginTop: 8, opacity: 0.92 }}>
                  You: <b>{myRow ? displayNameFor(myRow, members.findIndex((x) => x.user_id === myRow.user_id)) : '-'}</b> . team <b>{myTeamLabel}</b> . role <b>{myGameRoleLabel}</b>
                </div>
                <div style={{ marginTop: 4, opacity: 0.84 }}>
                  Owner: <b>{isOwner ? 'you' : 'other player'}</b> . Ready: <b>{readyCount}</b>/<b>{playableCount}</b>
                </div>
                {amSpectator && <div style={{ marginTop: 8, opacity: 0.84 }}>You are spectating. Team actions are disabled.</div>}

                <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={() => copyText('code', lobby.code)} disabled={!lobby.code} style={btnBase}>Copy Code</button>
                  <button onClick={() => copyText('invite link', lobbyLink)} disabled={!lobbyLink} style={btnBase}>Copy Invite Link</button>
                  {notice && <span style={{ padding: '7px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.08)', fontSize: 12 }}>{notice}</span>}
                </div>
              </div>

              <div style={{ borderRadius: 16, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.28)', padding: 14 }}>
                <div style={{ fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', opacity: 0.72, fontWeight: 900 }}>Game Setup</div>
                <div style={{ marginTop: 8, display: 'grid', gap: 6, opacity: 0.92 }}>
                  <div>Red Team: spymaster <b>{redSpy}</b>, operatives <b>{redOps}</b></div>
                  <div>Blue Team: spymaster <b>{blueSpy}</b>, operatives <b>{blueOps}</b></div>
                  {requireReady && <div>Ready required: <b>{readyOk ? 'ok' : 'not yet'}</b></div>}
                </div>

                <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    onClick={handleToggleReady}
                    disabled={!myRow || busy !== null || lobby.status !== 'open' || amSpectator}
                    style={{ ...btnBase, borderColor: 'rgba(150,240,190,0.35)' }}
                  >
                    {myRow?.is_ready ? 'Set Not Ready' : 'Set Ready'}
                  </button>
                  <button
                    onClick={handleStartGame}
                    disabled={!canStart}
                    style={{ ...btnBase, borderColor: canStart ? 'rgba(255,220,120,0.55)' : 'rgba(255,255,255,0.16)', opacity: canStart ? 1 : 0.6 }}
                  >
                    Start Game
                  </button>
                </div>

                {isOwner && (
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, opacity: 0.95 }}>
                    <input type="checkbox" checked={requireReady} onChange={(e) => setRequireReady(e.target.checked)} disabled={lobby.status !== 'open'} />
                    <span>Require everyone ready before start</span>
                  </label>
                )}

                {!canStart && (
                  <div style={{ marginTop: 10, opacity: 0.78, fontSize: 13 }}>
                    Need 1 spymaster + 1 operative per team{requireReady ? ' + everyone ready' : ''}.
                  </div>
                )}
              </div>
            </div>

            <div className="lobby-teams">
              <div style={{ borderRadius: 16, border: '1px solid rgba(255,95,95,0.35)', background: 'rgba(80,20,20,0.28)', padding: 12 }}>
                <div style={{ fontWeight: 1000, marginBottom: 10, color: 'rgba(255,210,210,0.98)' }}>Red Team ({redMembers.length})</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {redMembers.length === 0 ? <div style={{ opacity: 0.7 }}>No players assigned.</div> : redMembers.map((m, idx) => renderMemberCard(m, idx, 'red'))}
                </div>
              </div>

              <div style={{ borderRadius: 16, border: '1px solid rgba(90,140,255,0.38)', background: 'rgba(18,32,80,0.30)', padding: 12 }}>
                <div style={{ fontWeight: 1000, marginBottom: 10, color: 'rgba(214,228,255,0.98)' }}>Blue Team ({blueMembers.length})</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {blueMembers.length === 0 ? <div style={{ opacity: 0.7 }}>No players assigned.</div> : blueMembers.map((m, idx) => renderMemberCard(m, idx, 'blue'))}
                </div>
              </div>

              <div style={{ borderRadius: 16, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(0,0,0,0.26)', padding: 12 }}>
                <div style={{ fontWeight: 1000, marginBottom: 10 }}>Spectators ({spectators.length})</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {spectators.length === 0 ? <div style={{ opacity: 0.7 }}>No spectators.</div> : spectators.map((m, idx) => renderMemberCard(m, idx, 'neutral'))}
                </div>
              </div>
            </div>

            {lobby.status !== 'open' && (
              <div style={{ marginTop: 12, padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.05)', opacity: 0.9 }}>
                Teams and roles are locked while lobby is not open.
              </div>
            )}
          </>
        )}
      </div>

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

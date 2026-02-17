import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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

const ONLINE_MS = 75_000
const HEARTBEAT_MS = 30_000

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

function displayNameFor(m: MemberRow, index: number, fallbackLabel = 'Player'): string {
  const n = (m.profiles?.display_name ?? '').trim()
  if (n) return n
  return `${fallbackLabel} ${index + 1}`
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

function statusPill(lastSeen: string | null | undefined): { textKey: string; bg: string } {
  if (isOnline(lastSeen)) return { textKey: 'lobby.presence.online', bg: 'rgba(40,190,120,0.16)' }
  return { textKey: 'lobby.presence.away', bg: 'rgba(255,255,255,0.06)' }
}

const AVATAR_POOL = {
  red: ['/assets/avatars/red-avatar/red-avatar.png', '/assets/avatars/red-avatar/red-avatar2.png', '/assets/avatars/red-avatar/red-avatar3.jpg'],
  blue: ['/assets/avatars/blue-avatar/blue-avatar.png', '/assets/avatars/blue-avatar/blue-avatar2.png', '/assets/avatars/blue-avatar/blue-avatar3.png'],
  neutral: ['/assets/gameavatar.png']
} as const

function hashSeed(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function fallbackAvatarFor(team: 'red' | 'blue' | null, seed: string): string {
  const bucket = team === 'red' ? AVATAR_POOL.red : team === 'blue' ? AVATAR_POOL.blue : AVATAR_POOL.neutral
  const idx = hashSeed(seed) % bucket.length
  return bucket[idx]
}

function avatarForMember(member: MemberRow): string {
  const raw = String(member.profiles?.avatar_url ?? '').trim()
  if (raw) return raw
  return fallbackAvatarFor(member.team, member.user_id)
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
  const { t, i18n } = useTranslation()
  const lobbyCode = useMemo(() => (code ?? '').trim().toUpperCase(), [code])
  const currentLang: 'en' | 'ar' = useMemo(() => {
    const raw = String(i18n.resolvedLanguage ?? i18n.language ?? 'en').toLowerCase()
    return raw.startsWith('ar') ? 'ar' : 'en'
  }, [i18n.language, i18n.resolvedLanguage])

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
  type ToastTone = 'info' | 'success' | 'error'
  type ToastItem = { id: string; text: string; tone: ToastTone }

  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false)

  function addToast(text: string, tone: ToastTone = 'info', ms = 2600) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    setToasts((prev) => [...prev, { id, text, tone }].slice(-3))
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, ms)
  }

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
        showNotice(t('lobby.copy.copied', { label }))
        return
      }
      window.prompt(t('lobby.copy.prompt', { label }), clean)
      showNotice(t('lobby.copy.copiedManual'))
    } catch {
      window.prompt(t('lobby.copy.prompt', { label }), clean)
      showNotice(t('lobby.copy.copiedManual'))
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

  async function refreshMembers(lobbyId: string, loadProfiles: boolean) {
    const { data, error } = await supabase
      .from('lobby_members')
      .select('lobby_id,user_id,role,team,is_spymaster,is_ready,joined_at,last_seen_at')
      .eq('lobby_id', lobbyId)
      .order('joined_at', { ascending: true })

    if (error) return

    const base = (data ?? []) as MemberRow[]

        if (loadProfiles) {
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
      return
    }

    // keep whatever profiles we already had (no extra rpc call)
    setMembers((prev) => {
      const prevProfiles = new Map<string, ProfileLite | null>()
      for (const p of prev) prevProfiles.set(p.user_id, p.profiles ?? null)
      return base.map((m) => ({ ...m, profiles: prevProfiles.get(m.user_id) ?? null }))
    })

  }

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)
        if (!lobbyCode) throw new Error('Missing lobby code')

              const guardKey = `oneclue_join_guard:${spectate ? 'spectator' : 'player'}:${lobbyCode.trim().toUpperCase()}`
        const now = Date.now()
        const last = Number(sessionStorage.getItem(guardKey) ?? '0')
        if (now - last < 2500) {
          console.debug('[lobby] join guard: skipping duplicate join')
        } else {
          sessionStorage.setItem(guardKey, String(now))
          if (spectate) {
            await joinLobbyAsSpectator(lobbyCode)
          } else {
            await joinLobby(lobbyCode)
          }
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

        await refreshMembers(l.id, true)
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
   // Realtime
  useEffect(() => {
    if (!lobby?.id) return

    let cancelled = false

    const channel = supabase
      .channel(`lobby_${lobby.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lobby_members', filter: `lobby_id=eq.${lobby.id}` },
        async (payload) => {
          if (cancelled) return

          // ignore heartbeat-only updates (last_seen_at)
          if (payload.eventType === 'UPDATE') {
            const n = payload.new as any
            const o = payload.old as any
            if (
              n &&
              o &&
              n.user_id === o.user_id &&
              n.team === o.team &&
              n.role === o.role &&
              n.is_spymaster === o.is_spymaster &&
              n.is_ready === o.is_ready &&
              n.joined_at === o.joined_at &&
              n.last_seen_at !== o.last_seen_at
            ) {
              setMembers((prev) =>
                prev.map((m) => (m.user_id === n.user_id ? { ...m, last_seen_at: n.last_seen_at } : m))
              )
              return
            }
          }

          // only reload profiles when someone joins/leaves
          const needsProfiles = payload.eventType === 'INSERT' || payload.eventType === 'DELETE'
          await refreshMembers(lobby.id, needsProfiles)
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [lobby?.id])


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
      setBusy(t('lobby.busy.movingToTeam', { team: t(`lobby.team.${team}`) }))
      const isSelf = Boolean(myUserId && targetUserId === myUserId)

      const { error } = isSelf
        ? await supabase
            .from('lobby_members')
            .update({
              team,
              // Moving teams as self always drops leader role to avoid invalid setup states.
              is_spymaster: false
            })
            .eq('lobby_id', lobby.id)
            .eq('user_id', targetUserId)
        : await supabase.rpc('set_member_team', {
            p_lobby_id: lobby.id,
            p_user_id: targetUserId,
            p_team: team
          })
      if (error) throw error
      await refreshMembers(lobby.id, false)
    } catch (err) {
      console.error('[lobby] set_member_team failed:', err)
      addToast(supaErr(err), 'error')

    } finally {
      setBusy(null)
    }
  }

  async function handleToggleSpymaster(targetUserId: string, makeSpymaster: boolean) {
    if (!lobby) return
    try {
      setBusy(makeSpymaster ? t('lobby.busy.makingSpymaster') : t('lobby.busy.makingOperative'))

      const isSelf = Boolean(myUserId && targetUserId === myUserId)

const { error } =
  isSelf
    ? await supabase
        .from('lobby_members')
        .update({ is_spymaster: makeSpymaster })
        .eq('lobby_id', lobby.id)
        .eq('user_id', targetUserId)
    : await supabase.rpc('set_member_spymaster', {
        p_lobby_id: lobby.id,
        p_user_id: targetUserId,
        p_is_spymaster: makeSpymaster,
      })

      if (error) throw error
      await refreshMembers(lobby.id, false)
    } catch (err) {
      console.error('[lobby] set_member_spymaster failed:', err)
      addToast(supaErr(err), 'error')

    } finally {
      setBusy(null)
    }
  }

  async function handleStartGame() {
    if (!lobby) return
    try {
      setBusy(t('lobby.busy.startingGame'))
      const gameId = await startGame(lobby.id)
      navigate(`/game/${gameId}`)
    } catch (err) {
      console.error('[lobby] start game failed:', err)
      addToast(supaErr(err), 'error')

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
      setBusy(next ? t('lobby.busy.settingReady') : t('lobby.busy.settingNotReady'))
      const { error } = await supabase
        .from('lobby_members')
        .update({ is_ready: next })
        .eq('lobby_id', lobby.id)
        .eq('user_id', myUserId)

      if (error) throw error
      await refreshMembers(lobby.id, false)
    } catch (err) {
      console.error('[lobby] toggle ready failed:', err)
      addToast(supaErr(err), 'error')

    } finally {
      setBusy(null)
    }
  }

  async function handleLeaveLobby() {
    if (!lobby) return
    if (!myUserId) return

    setLeaveConfirmOpen(true)
    return
  }

  async function doLeaveLobbyConfirmed() {
    if (!lobby) return
    if (!myUserId) return

    try {
      setBusy(t('lobby.busy.leaving'))

      const { error } = await supabase.from('lobby_members').delete().eq('lobby_id', lobby.id).eq('user_id', myUserId)
      if (error) throw error

      clearKey('oneclue_last_lobby_code')
      clearKey('oneclue_last_lobby_role')

      navigate('/', { replace: true })
    } catch (err) {
      console.error('[lobby] leave failed:', err)
      addToast(supaErr(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const myRow = myUserId ? members.find((m) => m.user_id === myUserId) : null
  const amSpectator = myRow?.role === 'spectator'

  const myGameRoleLabel = amSpectator
    ? t('lobby.role.spectator')
    : myRow?.is_spymaster
      ? t('lobby.role.spymaster')
      : t('lobby.role.operative')
  const myTeamLabel = amSpectator ? '-' : myRow?.team ? t(`lobby.team.${myRow.team}`) : '-'
  const redMembers = members.filter((m) => m.team === 'red' && (m.role === 'owner' || m.role === 'player'))
  const blueMembers = members.filter((m) => m.team === 'blue' && (m.role === 'owner' || m.role === 'player'))
  const redLeaders = redMembers.filter((m) => m.is_spymaster)
  const redOperatives = redMembers.filter((m) => !m.is_spymaster)
  const blueLeaders = blueMembers.filter((m) => m.is_spymaster)
  const blueOperatives = blueMembers.filter((m) => !m.is_spymaster)
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
    if (member.role === 'owner') return t('lobby.role.owner')
    if (member.is_spymaster) return t('lobby.role.spymaster')
    return t('lobby.role.operative')
  }

  function renderMemberCard(member: MemberRow, tone: 'red' | 'blue' | 'neutral') {
    const fallbackIndex = members.findIndex((m) => m.user_id === member.user_id)
    const nameIndex = fallbackIndex >= 0 ? fallbackIndex : 0
    const pill = statusPill(member.last_seen_at)
    const avatar = avatarForMember(member)
    const fallbackAvatar = fallbackAvatarFor(member.team, `${member.user_id}:fallback`)
    const toneGlow = tone === 'red' ? '0 0 0 1px rgba(255,95,95,0.34), 0 10px 22px rgba(20,0,0,0.32)' : tone === 'blue' ? '0 0 0 1px rgba(90,140,255,0.36), 0 10px 22px rgba(0,10,26,0.34)' : '0 0 0 1px rgba(255,255,255,0.16), 0 10px 22px rgba(0,0,0,0.3)'
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
          boxShadow: `inset 0 0 0 1px rgba(0,0,0,0.42), ${toneGlow}`,
          padding: 9,
          display: 'grid',
          gap: 8,
          position: 'relative',
          overflow: 'hidden'
        }}
        className="lobbyMemberCard"
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'start' }}>
          <div style={{ minWidth: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="lobbyMemberAvatarWrap">
              <img
                className="lobbyMemberAvatar"
                src={avatar}
                alt={`${displayNameFor(member, nameIndex, t('lobby.labels.player'))} avatar`}
                onError={(e) => {
                  const img = e.currentTarget
                  if (img.src.endsWith(fallbackAvatar)) return
                  img.src = fallbackAvatar
                }}
              />
            </div>
            <div style={{ minWidth: 0, display: 'grid', gap: 2 }}>
              <div style={{ fontWeight: 900, fontSize: 14 }}>{displayNameFor(member, nameIndex, t('lobby.labels.player'))}</div>
            </div>
          </div>

          <div
            style={{
              fontSize: 10,
              padding: '3px 7px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.16)',
              background: pill.bg,
              textTransform: 'uppercase',
              fontWeight: 800
            }}
          >
            {t(pill.textKey)}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11, opacity: 0.92 }}>
          <span style={{ padding: '2px 7px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.14)' }}>{roleBadge(member)}</span>
          <span style={{ padding: '2px 7px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.14)' }}>
            {t('lobby.labels.ready')}: {member.is_ready ? t('lobby.labels.yes') : t('lobby.labels.no')}
          </span>
        </div>

        {(lobby?.status === 'open') && member.role !== 'spectator' && (isOwner || member.user_id === myUserId) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              onClick={() => handleSetTeam(member.user_id, 'red')}
              disabled={busy !== null}
              style={{
                ...btnBase,
                padding: '6px 9px',
                fontSize: 11,
                borderColor: 'rgba(255,110,110,0.7)',
                background: 'linear-gradient(180deg, rgba(255,96,96,0.34), rgba(120,20,20,0.38))',
                color: 'rgba(255,236,236,0.98)'
              }}
            >
              {t('lobby.team.red')}
            </button>
            <button
              onClick={() => handleSetTeam(member.user_id, 'blue')}
              disabled={busy !== null}
              style={{
                ...btnBase,
                padding: '6px 9px',
                fontSize: 11,
                borderColor: 'rgba(120,170,255,0.75)',
                background: 'linear-gradient(180deg, rgba(90,140,255,0.34), rgba(18,40,120,0.42))',
                color: 'rgba(232,242,255,0.98)'
              }}
            >
              {t('lobby.team.blue')}
            </button>
            {member.team ? (
              member.is_spymaster ? (
                <button
                  onClick={() => handleToggleSpymaster(member.user_id, false)}
                  disabled={busy !== null}
                  style={{
                    ...btnBase,
                    padding: '6px 9px',
                    fontSize: 11,
                    borderColor: 'rgba(150,245,205,0.62)',
                    background: 'linear-gradient(180deg, rgba(60,200,140,0.26), rgba(10,90,64,0.38))',
                    color: 'rgba(228,255,243,0.98)'
                  }}
                >
                  {t('lobby.role.operative')}
                </button>
              ) : (
                <button
                  onClick={() => handleToggleSpymaster(member.user_id, true)}
                  disabled={busy !== null}
                  style={{
                    ...btnBase,
                    padding: '6px 9px',
                    fontSize: 11,
                    borderColor: 'rgba(255,220,140,0.72)',
                    background: 'linear-gradient(180deg, rgba(255,196,92,0.34), rgba(122,84,16,0.42))',
                    color: 'rgba(255,246,223,0.98)'
                  }}
                >
                  {t('lobby.role.spymaster')}
                </button>
              )
            ) : null}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="lobbyScene">
      <style>{`
        .lobbyScene{
          min-height:100vh;
          color:#fff;
          padding:16px;
          background:
            radial-gradient(1200px 500px at 50% -10%, rgba(255,255,255,0.14), transparent 62%),
            radial-gradient(900px 420px at 14% 10%, rgba(82,142,255,0.18), transparent 58%),
            radial-gradient(900px 420px at 88% 12%, rgba(255,98,98,0.12), transparent 58%),
            linear-gradient(180deg, #06080f, #030407 72%);
        }
        .lobbyShell{
          width:min(1180px, 100%);
          margin:0 auto;
          border-radius:24px;
          border:1px solid rgba(255,255,255,.11);
          background:
            linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.01)),
            rgba(4,6,10,.68);
          box-shadow: 0 28px 90px rgba(0,0,0,.76);
          padding:14px;
          backdrop-filter: blur(2px);
        }
        .lobbyTopbar{
          display:flex;
          gap:8px;
          flex-wrap:wrap;
          margin-bottom:12px;
          padding:6px;
          border-radius:14px;
          border:1px solid rgba(255,255,255,.09);
          background: rgba(255,255,255,.03);
        }
        .lobbyPanel{
          border-radius:16px;
          border:1px solid rgba(255,255,255,0.12);
          background:
            linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.02)),
            rgba(0,0,0,.31);
          box-shadow: inset 0 0 0 1px rgba(0,0,0,.44), 0 12px 34px rgba(0,0,0,.34);
          padding:14px;
        }
        .lobbyMetaTitle{
          font-size:12px;
          letter-spacing:.14em;
          text-transform:uppercase;
          opacity:.72;
          font-weight:900;
        }
        .lobbyCodeRow{
          margin-top:8px;
          display:flex;
          align-items:center;
          gap:10px;
          flex-wrap:wrap;
        }
        .lobbyCode{
          font-size:34px;
          font-weight:1000;
          letter-spacing:.1em;
        }
        .lobbyMetaLine{
          margin-top:7px;
          opacity:.9;
        }
        .lobbyActionsRow{
          margin-top:12px;
          display:flex;
          gap:8px;
          flex-wrap:wrap;
        }
        .lobbyStatusPill{
          padding:5px 10px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.18);
          font-size:12px;
          font-weight:900;
          text-transform:uppercase;
        }
        .lobbyStatusPill.open{ background: rgba(90,180,120,.16); }
        .lobbyStatusPill.in_game{ background: rgba(90,140,255,.18); }
        .lobbyStatusPill.closed{ background: rgba(255,120,120,.16); }
        .lobbyNotice{
          padding:7px 10px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,0.16);
          background:rgba(255,255,255,.08);
          font-size:12px;
        }
        .lobbySetupStats{
          margin-top:10px;
          display:grid;
          gap:7px;
          opacity:.93;
        }
        .lobbyHint{
          margin-top:10px;
          opacity:.78;
          font-size:13px;
        }
        .lobbyInfoStrip{
          margin-top:12px;
          padding:11px;
          border-radius:12px;
          border:1px solid rgba(255,255,255,0.14);
          background:rgba(255,255,255,0.05);
          opacity:0.9;
        }
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
        .lobbyCol{
          border-radius:16px;
          padding:12px;
          box-shadow: inset 0 0 0 1px rgba(0,0,0,.42), 0 12px 32px rgba(0,0,0,.34);
        }
        .lobbyColTitle{
          font-weight:1000;
          margin-bottom:10px;
          letter-spacing:.02em;
        }
        .lobbyCol.red{
          border:1px solid rgba(255,95,95,0.35);
          background:linear-gradient(180deg, rgba(255,95,95,.14), rgba(0,0,0,.30));
        }
        .lobbyCol.blue{
          border:1px solid rgba(90,140,255,0.38);
          background:linear-gradient(180deg, rgba(90,140,255,.16), rgba(0,0,0,.31));
        }
        .lobbyCol.neutral{
          border:1px solid rgba(255,255,255,0.16);
          background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(0,0,0,.28));
        }
        .lobbyRows{
          display:grid;
          gap:8px;
        }
        .lobbyRoleSection{
          border:1px solid rgba(255,255,255,0.12);
          border-radius:12px;
          padding:8px;
          background:rgba(0,0,0,0.20);
          display:grid;
          gap:8px;
        }
        .lobbyRoleSectionTitle{
          font-size:11px;
          letter-spacing:.08em;
          text-transform:uppercase;
          font-weight:900;
          opacity:.85;
        }
        .lobbyMemberCard::after{
          content:'';
          position:absolute;
          inset:0;
          pointer-events:none;
          background: linear-gradient(120deg, rgba(255,255,255,0.12), transparent 26%, transparent 70%, rgba(255,255,255,0.08));
          opacity:.34;
        }
        .lobbyMemberAvatarWrap{
          width:44px;
          height:44px;
          border-radius:12px;
          padding:2px;
          background: linear-gradient(135deg, rgba(120,255,255,0.8), rgba(120,120,255,0.28));
          box-shadow: 0 0 0 1px rgba(255,255,255,0.2), 0 8px 18px rgba(0,0,0,0.45);
          flex: 0 0 auto;
        }
        .lobbyMemberAvatar{
          width:100%;
          height:100%;
          display:block;
          object-fit:cover;
          border-radius:10px;
          border:1px solid rgba(255,255,255,0.18);
          background: rgba(0,0,0,0.35);
        }
        .lobbyMuted{
          opacity:.7;
        }
        .lobbyLoading{
          padding:12px;
          opacity:.9;
        }
        .lobbyError{
          padding:12px;
          border-radius:12px;
          border:1px solid rgba(255,90,90,0.50);
          background:rgba(255,60,60,0.08);
        }
        @media (max-width: 980px){
          .lobbyScene{ padding:10px; }
          .lobby-grid-main{ grid-template-columns: 1fr; }
          .lobby-teams{ grid-template-columns: 1fr; }
          .lobbyCode{ font-size:30px; }
        }
        @media (max-width: 560px){
          .lobbyShell{ padding:10px; border-radius:18px; }
          .lobbyTopbar{ padding:4px; }
          .lobbyCode{ font-size:26px; }
        }
      `}</style>
      {/* Toasts */}
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
              border: '1px solid rgba(255,255,255,0.14)',
              background:
                t.tone === 'error'
                  ? 'rgba(255,90,90,0.14)'
                  : t.tone === 'success'
                    ? 'rgba(40,190,120,0.14)'
                    : 'rgba(255,255,255,0.08)',
              color: 'rgba(245,248,255,0.96)',
              boxShadow: '0 12px 30px rgba(0,0,0,0.45)',
              fontWeight: 800,
              fontSize: 13
            }}
          >
            {t.text}
          </div>
        ))}
      </div>
      {leaveConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 999998,
            background: 'rgba(0,0,0,0.65)',
            display: 'grid',
            placeItems: 'center',
            padding: 16
          }}
        >
          <div
            style={{
              width: 'min(420px, 100%)',
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(0,0,0,0.55)',
              boxShadow: '0 24px 80px rgba(0,0,0,0.72)',
              padding: 14
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>{t('lobby.leave.title')}</div>
            <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12 }}>{t('lobby.leave.body')}</div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setLeaveConfirmOpen(false)}
                disabled={busy !== null}
                style={btnBase}
              >
                {t('lobby.leave.cancel')}
              </button>
              <button
                type="button"
                onClick={async () => {
                  setLeaveConfirmOpen(false)
                  await doLeaveLobbyConfirmed()
                }}
                disabled={busy !== null}
                style={{ ...btnBase, borderColor: 'rgba(255,120,120,0.35)' }}
              >
                {t('lobby.leave.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="lobbyShell">
        <div className="lobbyTopbar">
          <button onClick={() => navigate('/')} style={btnBase}>{t('lobby.nav.home')}</button>
          <button onClick={() => navigate(`/settings/${lobbyCode}`, { state: { from: `${location.pathname}${location.search}` } })} style={btnBase}>{t('lobby.nav.settings')}</button>
          <button onClick={() => navigate('/profile', { state: { from: `${location.pathname}${location.search}` } })} style={btnBase}>{t('lobby.nav.profile')}</button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => void i18n.changeLanguage('en')}
              disabled={currentLang === 'en'}
              style={{ ...btnBase, opacity: currentLang === 'en' ? 1 : 0.75 }}
            >
              {t('lobby.nav.english')}
            </button>
            <button
              onClick={() => void i18n.changeLanguage('ar')}
              disabled={currentLang === 'ar'}
              style={{ ...btnBase, opacity: currentLang === 'ar' ? 1 : 0.75 }}
            >
              {t('lobby.nav.arabic')}
            </button>
            <button onClick={handleLeaveLobby} disabled={!myRow || busy !== null} style={{ ...btnBase, borderColor: 'rgba(255,120,120,0.35)' }}>
              {t('lobby.nav.leaveLobby')}
            </button>
          </div>
        </div>

        {state === 'loading' && <div className="lobbyLoading">{t('lobby.loading')}</div>}

        {state === 'error' && (
          <div className="lobbyError">
            {t('lobby.error')}: {error}
          </div>
        )}

        {state === 'ready' && lobby && (
          <>
            <div className="lobby-grid-main">
              <div className="lobbyPanel">
                <div className="lobbyMetaTitle">{t('lobby.panels.lobby')}</div>
                <div className="lobbyCodeRow">
                  <div className="lobbyCode">{lobby.code}</div>
                  <span className={`lobbyStatusPill ${lobby.status}`}>
                    {t(`lobby.status.${lobby.status}`)}
                  </span>
                </div>

                <div className="lobbyMetaLine">
                  {t('lobby.meta.you')}: <b>{myRow ? displayNameFor(myRow, members.findIndex((x) => x.user_id === myRow.user_id), t('lobby.labels.player')) : '-'}</b> . {t('lobby.meta.team')} <b>{myTeamLabel}</b> . {t('lobby.meta.role')} <b>{myGameRoleLabel}</b>
                </div>
                <div className="lobbyMetaLine">
                  {t('lobby.meta.owner')}: <b>{isOwner ? t('lobby.meta.youOwner') : t('lobby.meta.otherOwner')}</b> . {t('lobby.meta.ready')}: <b>{readyCount}</b>/<b>{playableCount}</b>
                </div>
                {amSpectator && <div className="lobbyMetaLine">{t('lobby.meta.spectating')}</div>}

                <div className="lobbyActionsRow">
                  <button onClick={() => copyText(t('lobby.copy.codeLabel'), lobby.code)} disabled={!lobby.code} style={btnBase}>{t('lobby.copy.code')}</button>
                  <button onClick={() => copyText(t('lobby.copy.inviteLabel'), lobbyLink)} disabled={!lobbyLink} style={btnBase}>{t('lobby.copy.invite')}</button>
                  {notice && <span className="lobbyNotice">{notice}</span>}
                </div>
              </div>

              <div className="lobbyPanel">
                <div className="lobbyMetaTitle">{t('lobby.panels.setup')}</div>
                <div className="lobbySetupStats">
                  <div>{t('lobby.setup.red')}: {t('lobby.role.spymaster')} <b>{redSpy}</b>, {t('lobby.setup.operatives')} <b>{redOps}</b></div>
                  <div>{t('lobby.setup.blue')}: {t('lobby.role.spymaster')} <b>{blueSpy}</b>, {t('lobby.setup.operatives')} <b>{blueOps}</b></div>
                  {requireReady && <div>{t('lobby.setup.readyRequired')}: <b>{readyOk ? t('lobby.setup.ok') : t('lobby.setup.notYet')}</b></div>}
                </div>

                <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    onClick={handleToggleReady}
                    disabled={!myRow || busy !== null || lobby.status !== 'open' || amSpectator}
                    style={{ ...btnBase, borderColor: 'rgba(150,240,190,0.35)' }}
                  >
                    {myRow?.is_ready ? t('lobby.actions.setNotReady') : t('lobby.actions.setReady')}
                  </button>
                  <button
                    onClick={handleStartGame}
                    disabled={!canStart}
                    style={{ ...btnBase, borderColor: canStart ? 'rgba(255,220,120,0.55)' : 'rgba(255,255,255,0.16)', opacity: canStart ? 1 : 0.6 }}
                  >
                    {t('lobby.actions.startGame')}
                  </button>
                </div>

                {isOwner && (
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, opacity: 0.95 }}>
                    <input type="checkbox" checked={requireReady} onChange={(e) => setRequireReady(e.target.checked)} disabled={lobby.status !== 'open'} />
                    <span>{t('lobby.actions.requireReady')}</span>
                  </label>
                )}

                {!canStart && (
                  <div className="lobbyHint">
                    {t('lobby.hints.needSetup', { extra: requireReady ? ` ${t('lobby.hints.plusReady')}` : '' })}
                  </div>
                )}
              </div>
            </div>

            <div className="lobby-teams">
              <div className="lobbyCol red">
                <div className="lobbyColTitle">{t('lobby.columns.red', { count: redMembers.length })}</div>
                <div className="lobbyRows">
                  {redMembers.length === 0 ? <div className="lobbyMuted">{t('lobby.empty.noPlayers')}</div> : (
                    <>
                      <div className="lobbyRoleSection">
                        <div className="lobbyRoleSectionTitle">{t('lobby.role.spymaster')} ({redLeaders.length})</div>
                        <div className="lobbyRows">
                          {redLeaders.length === 0 ? <div className="lobbyMuted">-</div> : redLeaders.map((m) => renderMemberCard(m, 'red'))}
                        </div>
                      </div>
                      <div className="lobbyRoleSection">
                        <div className="lobbyRoleSectionTitle">{t('lobby.setup.operatives')} ({redOperatives.length})</div>
                        <div className="lobbyRows">
                          {redOperatives.length === 0 ? <div className="lobbyMuted">-</div> : redOperatives.map((m) => renderMemberCard(m, 'red'))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="lobbyCol blue">
                <div className="lobbyColTitle">{t('lobby.columns.blue', { count: blueMembers.length })}</div>
                <div className="lobbyRows">
                  {blueMembers.length === 0 ? <div className="lobbyMuted">{t('lobby.empty.noPlayers')}</div> : (
                    <>
                      <div className="lobbyRoleSection">
                        <div className="lobbyRoleSectionTitle">{t('lobby.role.spymaster')} ({blueLeaders.length})</div>
                        <div className="lobbyRows">
                          {blueLeaders.length === 0 ? <div className="lobbyMuted">-</div> : blueLeaders.map((m) => renderMemberCard(m, 'blue'))}
                        </div>
                      </div>
                      <div className="lobbyRoleSection">
                        <div className="lobbyRoleSectionTitle">{t('lobby.setup.operatives')} ({blueOperatives.length})</div>
                        <div className="lobbyRows">
                          {blueOperatives.length === 0 ? <div className="lobbyMuted">-</div> : blueOperatives.map((m) => renderMemberCard(m, 'blue'))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="lobbyCol neutral">
                <div className="lobbyColTitle">{t('lobby.columns.spectators', { count: spectators.length })}</div>
                <div className="lobbyRows">
                  {spectators.length === 0 ? <div className="lobbyMuted">{t('lobby.empty.noSpectators')}</div> : spectators.map((m) => renderMemberCard(m, 'neutral'))}
                </div>
              </div>
            </div>

            {lobby.status !== 'open' && (
              <div className="lobbyInfoStrip">
                {t('lobby.info.locked')}
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

import { useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from './lib/supabaseClient'
import { ensureSession } from './lib/auth'
import { joinLobby, joinLobbyAsSpectator } from './lib/lobbies'

import HomeRoute from './routes/HomeRoute'
import LobbyRoute from './routes/LobbyRoute'
import GameRoute from './routes/GameRoute'
import GameUiRoute from './routes/GameUiRoute'
import ProfileRoute from './routes/ProfileRoute'
import SettingsRoute from './routes/SettingsRoute'

type BootState = 'booting' | 'ready' | 'error'

type ActiveLobbyCtx = {
  lobbyId: string
  lobbyCode: string
  lobbyStatus: 'open' | 'in_game' | 'closed'
  latestGameId: string | null
}

type MemberRole = 'owner' | 'player' | 'spectator'

type OpenLobbyTarget = {
  id: string
  code: string
}

function RouteSyncGuard() {
  const navigate = useNavigate()
  const location = useLocation()
  const [ctx, setCtx] = useState<ActiveLobbyCtx | null>(null)
  const uidRef = useRef<string | null>(null)
  const navSigRef = useRef<string>('')
  const memberChannelRef = useRef<any>(null)
  const lobbyChannelRef = useRef<any>(null)
  const pollRef = useRef<number | null>(null)
  const subscribedLobbyIdRef = useRef<string | null>(null)

  async function findLatestOpenLobbyByOwner(ownerId: string, excludeLobbyId: string): Promise<OpenLobbyTarget | null> {
    const { data, error } = await supabase
      .from('lobbies')
      .select('id,code,created_at')
      .eq('owner_id', ownerId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(5)
    if (error) throw error

    const rows = (data ?? []) as Array<{ id: string; code: string; created_at: string }>
    const next = rows.find((r) => r.id !== excludeLobbyId) ?? null
    if (!next) return null
    return { id: next.id, code: String(next.code ?? '').trim().toUpperCase() }
  }

  async function tryMoveToOwnerNewLobby(oldLobbyId: string, ownerId: string, myRole: MemberRole): Promise<boolean> {
    const next = await findLatestOpenLobbyByOwner(ownerId, oldLobbyId)
    if (!next?.code) return false

    if (myRole === 'spectator') await joinLobbyAsSpectator(next.code)
    else await joinLobby(next.code)
    return true
  }

  async function loadLatestGameId(lobbyId: string): Promise<string | null> {
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

  async function refreshCtx() {
    const uid = uidRef.current
    if (!uid) return

    const { data: lmRows, error: lmErr } = await supabase
      .from('lobby_members')
      .select('lobby_id,joined_at,role')
      .eq('user_id', uid)
      .order('joined_at', { ascending: false })
      .limit(1)

    if (lmErr) throw lmErr
    const lm = Array.isArray(lmRows) ? lmRows[0] : null
    if (!lm || typeof lm.lobby_id !== 'string') {
      setCtx(null)
      return
    }
    const myRole = (String((lm as any).role ?? 'player') as MemberRole)

    const { data: lobbyRow, error: lobbyErr } = await supabase
      .from('lobbies')
      .select('id,code,status,owner_id')
      .eq('id', lm.lobby_id)
      .single()
    if (lobbyErr) throw lobbyErr

    const lobbyId = String((lobbyRow as any).id ?? '')
    const lobbyCode = String((lobbyRow as any).code ?? '').trim().toUpperCase()
    const lobbyStatus = String((lobbyRow as any).status ?? '') as ActiveLobbyCtx['lobbyStatus']
    const lobbyOwnerId = String((lobbyRow as any).owner_id ?? '')
    if (!lobbyId || !lobbyCode || (lobbyStatus !== 'open' && lobbyStatus !== 'in_game' && lobbyStatus !== 'closed')) {
      setCtx(null)
      return
    }

    if (lobbyStatus === 'closed' && lobbyOwnerId) {
      try {
        const moved = await tryMoveToOwnerNewLobby(lobbyId, lobbyOwnerId, myRole)
        if (moved) {
          // membership has changed; reload active context from new lobby
          await refreshCtx()
          return
        }
      } catch (err) {
        console.warn('[sync] auto-move to restarted lobby failed:', err)
      }
    }

    let latestGameId: string | null = null
    if (lobbyStatus === 'in_game') latestGameId = await loadLatestGameId(lobbyId)

    setCtx({ lobbyId, lobbyCode, lobbyStatus, latestGameId })
  }

    useEffect(() => {
    let cancelled = false

    async function start() {
      try {
        const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr
        const uid = sessionData.session?.user?.id ?? null
        uidRef.current = uid
        if (!uid) return

        await refreshCtx()
        if (cancelled) return

        memberChannelRef.current = supabase
          .channel(`sync:member:${uid}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'lobby_members', filter: `user_id=eq.${uid}` }, async () => {
            await refreshCtx()
          })
          .subscribe()

        if (cancelled) return

        // poll is just a fallback; keep it slower
        pollRef.current = window.setInterval(async () => {
          await refreshCtx()
        }, 8000)
      } catch (err) {
        if (!cancelled) console.error('[sync] init failed:', err)
      }
    }

    void start()

    return () => {
      cancelled = true

      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
      if (memberChannelRef.current) {
        void supabase.removeChannel(memberChannelRef.current)
        memberChannelRef.current = null
      }
      if (lobbyChannelRef.current) {
        void supabase.removeChannel(lobbyChannelRef.current)
        lobbyChannelRef.current = null
      }
      subscribedLobbyIdRef.current = null
    }
  }, [])


  useEffect(() => {
    const lobbyId = ctx?.lobbyId ?? null
    if (subscribedLobbyIdRef.current === lobbyId) return

    if (lobbyChannelRef.current) {
      void supabase.removeChannel(lobbyChannelRef.current)
      lobbyChannelRef.current = null
    }
    subscribedLobbyIdRef.current = lobbyId
    if (!lobbyId) return

    lobbyChannelRef.current = supabase
      .channel(`sync:lobby:${lobbyId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lobbies', filter: `id=eq.${lobbyId}` }, async () => {
        await refreshCtx()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `lobby_id=eq.${lobbyId}` }, async () => {
        await refreshCtx()
      })
      .subscribe()
  }, [ctx?.lobbyId])

    useEffect(() => {
    if (!ctx) return

    // If the user navigates to a game route while the lobby is still marked open
    // (common right after the owner starts the game), don't force-redirect back to the lobby.
    if ((location.pathname.startsWith('/game/') || location.pathname.startsWith('/game-ui/')) && ctx.lobbyStatus === 'open') return

    let target = ''
    if (ctx.lobbyStatus === 'closed') target = '/'
    else if (ctx.lobbyStatus === 'open') target = `/lobby/${ctx.lobbyCode}`
    else if (ctx.lobbyStatus === 'in_game' && ctx.latestGameId) target = `/game/${ctx.latestGameId}`
    if (!target) return


    // don't force-redirect while user is in profile/settings screens
    if (location.pathname.startsWith('/profile') || location.pathname.startsWith('/settings')) return
    // allow manual navigation to Home without being pulled back into lobby/game
    if (location.pathname === '/') return
    if (location.pathname === target) return
    const sig = `${ctx.lobbyStatus}|${ctx.lobbyCode}|${ctx.latestGameId ?? ''}|${target}`
    if (navSigRef.current === sig) return
    navSigRef.current = sig
    navigate(target, { replace: true })
  }, [ctx, location.pathname, navigate])

  return null
}

export default function App() {
  const { t } = useTranslation()

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
        <h3>{t('app.connectingTitle')}</h3>
        <p>{t('app.connectingBody')}</p>
      </div>
    )
  }

  if (bootState === 'error') {
    return (
      <div style={{ padding: 16 }}>
        <h3>{t('app.connectionErrorTitle')}</h3>
        <p>{bootError}</p>
      </div>
    )
  }

  return (
    <>
      <RouteSyncGuard />
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/lobby/:code" element={<LobbyRoute />} />
        <Route path="/game/:id" element={<GameRoute />} />
        <Route path="/game-ui/:id" element={<GameUiRoute />} />
        <Route path="/profile" element={<ProfileRoute />} />
        <Route path="/settings/:code" element={<SettingsRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}

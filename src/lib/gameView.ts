import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabaseClient'
import { getLobbyProfiles, type PublicProfile } from './publicProfiles'
import {
  endTurn,
  loadGame,
  loadGameCards,
  loadSpymasterKey,
  revealCard,
  setClue,
  type RevealResult,
  type CardColor,
  type Game,
  type GameCard,
  type SpymasterKeyRow
} from './games'

export type Team = 'red' | 'blue'

export type Me = {
  userId: string
  team: Team | null
  isSpymaster: boolean
  role: 'owner' | 'player' | 'spectator' | null
}

export type ProfileLite = {
  display_name: string | null
  avatar_url: string | null
}

export type LobbyMemberView = {
  user_id: string
  team: Team | null
  is_spymaster: boolean
  role: 'owner' | 'player' | 'spectator' | null
  is_ready: boolean | null
  joined_at: string | null
  last_seen_at: string | null
  profiles?: ProfileLite | null
}

export type RealtimeStatus = 'INIT' | 'SUBSCRIBED' | 'CLOSED' | 'CHANNEL_ERROR' | 'TIMED_OUT'

export type GameViewState = {
  loading: boolean
  error: string | null
  realtimeStatus: RealtimeStatus
  gameId: string
  lobbyId: string | null
  lobbyCode: string | null
  game: Game | null
  cards: GameCard[]
  members: LobbyMemberView[]
  me: Me | null
  showKey: boolean
  keyByPos: Map<number, CardColor>
}

export type GameViewActions = {
  setShowKey: (next: boolean) => void
  refresh: () => Promise<void>
  sendClue: (word: string, number: number) => Promise<void>
  reveal: (pos: number) => Promise<RevealResult>
  endTurn: () => Promise<void>
}

const ENABLE_POLL_FALLBACK = true
const POLL_MS = 1200
const MEMBERS_POLL_MS = 6000
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

async function loadLobbyCode(lobbyId: string): Promise<string | null> {
  const { data, error } = await supabase.from('lobbies').select('code').eq('id', lobbyId).single()
  if (error) throw error
  return (data?.code ?? null) as string | null
}

async function loadMembers(lobbyId: string): Promise<LobbyMemberView[]> {
  const { data: lm, error: lmErr } = await supabase
    .from('lobby_members')
    .select('user_id,team,is_spymaster,role,is_ready,joined_at,last_seen_at')
    .eq('lobby_id', lobbyId)
    .order('joined_at', { ascending: true })

  if (lmErr) throw lmErr

  const rows = (lm ?? []) as Omit<LobbyMemberView, 'profiles'>[]
  if (rows.length === 0) return []

  let profs: PublicProfile[] = []
  try {
    profs = await getLobbyProfiles(lobbyId)
  } catch (err) {
    console.warn('[useGameView] get_lobby_profiles failed, using fallbacks:', err)
    profs = []
  }

  const map = new Map<string, ProfileLite>()
  for (const p of profs) {
    map.set(String(p.user_id), {
      display_name: p.display_name ?? null,
      avatar_url: p.avatar_url ?? null
    })
  }

  return rows.map((r) => ({ ...r, profiles: map.get(r.user_id) ?? null })) as LobbyMemberView[]
}

async function loadMe(lobbyId: string): Promise<Me> {
  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
  if (sessionErr) throw sessionErr

  const uid = sessionData.session?.user?.id ?? null
  if (!uid) throw new Error('No session')

  const { data, error } = await supabase
    .from('lobby_members')
    .select('team,is_spymaster,role')
    .eq('lobby_id', lobbyId)
    .eq('user_id', uid)
    .single()

  if (error) throw error

  return {
    userId: uid,
    team: (data?.team ?? null) as Team | null,
    isSpymaster: Boolean(data?.is_spymaster),
    role: (data?.role ?? null) as Me['role']
  }
}

function keyRowsToMap(rows: SpymasterKeyRow[]): Map<number, CardColor> {
  const m = new Map<number, CardColor>()
  for (const r of rows) m.set(r.pos, r.color)
  return m
}

export function useGameView(gameIdRaw: string | null | undefined): { state: GameViewState; actions: GameViewActions } {
  const gameId = useMemo(() => (gameIdRaw ?? '').trim(), [gameIdRaw])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('INIT')

  const [game, setGame] = useState<Game | null>(null)
  const [cards, setCards] = useState<GameCard[]>([])
  const [members, setMembers] = useState<LobbyMemberView[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [lobbyCode, setLobbyCode] = useState<string | null>(null)

  const [showKey, setShowKey] = useState(false)
  const [keyByPos, setKeyByPos] = useState<Map<number, CardColor>>(() => new Map())

  const lobbyId = game?.lobby_id ?? null

  const pollInFlight = useRef(false)
  const membersPollInFlight = useRef(false)

  const refresh = async () => {
    if (!gameId) throw new Error('Missing game id')

    const g = await loadGame(gameId)
    const c = await loadGameCards(gameId)

    const [code, mem, mine] = await Promise.all([loadLobbyCode(g.lobby_id), loadMembers(g.lobby_id), loadMe(g.lobby_id)])

    setGame(g)
    setCards(c)
    setLobbyCode(code)
    setMembers(mem)
    setMe(mine)

    if (showKey && mine.isSpymaster) {
      const rows = await loadSpymasterKey(gameId)
      setKeyByPos(keyRowsToMap(rows))
    } else {
      setKeyByPos(new Map())
    }
  }

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setLoading(true)
        setError(null)
        await refresh()
        if (!cancelled) setLoading(false)
      } catch (err) {
        console.error('[useGameView] refresh failed:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : supaErr(err))
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      if (!gameId) return
      if (!me?.isSpymaster) {
        setKeyByPos(new Map())
        return
      }

      if (!showKey) {
        setKeyByPos(new Map())
        return
      }

      try {
        const rows = await loadSpymasterKey(gameId)
        if (!cancelled) setKeyByPos(keyRowsToMap(rows))
      } catch (err) {
        console.error('[useGameView] key load failed:', err)
        if (!cancelled) setKeyByPos(new Map())
      }
    })()

    return () => {
      cancelled = true
    }
  }, [gameId, showKey, me?.isSpymaster])

  // ✅ REALTIME (no private channels)
  useEffect(() => {
    if (!gameId) return
    if (!lobbyId) return

    setRealtimeStatus('INIT')

    const channel = supabase
      .channel(`live_${lobbyId}_${gameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, async () => {
        try {
          const g = await loadGame(gameId)
          setGame(g)
        } catch (err) {
          console.error('[useGameView] games realtime refresh failed:', err)
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `game_id=eq.${gameId}` }, async () => {
        try {
          const c = await loadGameCards(gameId)
          setCards(c)
        } catch (err) {
          console.error('[useGameView] cards realtime refresh failed:', err)
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lobby_members', filter: `lobby_id=eq.${lobbyId}` }, async () => {
        try {
          const [mem, mine] = await Promise.all([loadMembers(lobbyId), loadMe(lobbyId)])
          setMembers(mem)
          setMe(mine)
        } catch (err) {
          console.error('[useGameView] members realtime refresh failed:', err)
        }
      })
      .subscribe((status) => {
        const s = String(status) as RealtimeStatus
        if (s === 'SUBSCRIBED' || s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
          setRealtimeStatus(s)
        } else {
          setRealtimeStatus('INIT')
        }
      })

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [gameId, lobbyId])

  // ✅ HEARTBEAT (updates last_seen_at for "online" indicator)
  useEffect(() => {
    if (!lobbyId) return
    if (!me?.userId) return

    const tick = async () => {
      if (document.hidden) return
      try {
        await supabase
          .from('lobby_members')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('lobby_id', lobbyId)
          .eq('user_id', me.userId)
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
  }, [lobbyId, me?.userId])

  // Poll fallback (keeps UI live even when realtime fails)
  useEffect(() => {
    if (!ENABLE_POLL_FALLBACK) return
    if (!gameId) return

    const t = window.setInterval(async () => {
      if (document.hidden) return
      if (pollInFlight.current) return
      pollInFlight.current = true

      try {
        const [g, c] = await Promise.all([loadGame(gameId), loadGameCards(gameId)])
        setGame(g)
        setCards(c)
      } catch {
        // silent
      } finally {
        pollInFlight.current = false
      }
    }, POLL_MS)

    return () => {
      window.clearInterval(t)
    }
  }, [gameId])

  useEffect(() => {
    if (!ENABLE_POLL_FALLBACK) return
    if (!lobbyId) return

    const t = window.setInterval(async () => {
      if (document.hidden) return
      if (membersPollInFlight.current) return
      membersPollInFlight.current = true

      try {
        const [mem, mine] = await Promise.all([loadMembers(lobbyId), loadMe(lobbyId)])
        setMembers(mem)
        setMe(mine)
      } catch {
        // silent
      } finally {
        membersPollInFlight.current = false
      }
    }, MEMBERS_POLL_MS)

    return () => {
      window.clearInterval(t)
    }
  }, [lobbyId])

  const sendClue = async (word: string, number: number) => {
    if (!gameId) throw new Error('Missing game id')
    await setClue(gameId, word, number)
  }

  const reveal = async (pos: number): Promise<RevealResult> => {
    if (!gameId) throw new Error('Missing game id')
    return await revealCard(gameId, pos)
  }

  const doEndTurn = async () => {
    if (!gameId) throw new Error('Missing game id')
    await endTurn(gameId)
  }

  const state: GameViewState = {
    loading,
    error,
    realtimeStatus,
    gameId,
    lobbyId,
    lobbyCode,
    game,
    cards,
    members,
    me,
    showKey,
    keyByPos
  }

  const actions: GameViewActions = {
    setShowKey,
    refresh,
    sendClue,
    reveal,
    endTurn: doEndTurn
  }

  return { state, actions }
}

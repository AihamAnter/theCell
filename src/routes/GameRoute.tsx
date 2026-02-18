import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
import { restartLobby, stopPlaying } from '../lib/lobbyActions'
import { useDiceOption, useHelperAction, type DiceOption, type HelperAction } from '../lib/powers'
import { getLobbyById, joinLobby, joinLobbyAsSpectator } from '../lib/lobbies'
import { getLobbyProfiles } from '../lib/publicProfiles'
import { recordFinishedGameStats } from '../lib/playerStats'
import { settingsFromLobby } from '../lib/gameSettings'
import { playManagedSfx, playSfx, stopSfx } from '../lib/sfx'

type LoadState = 'loading' | 'ready' | 'error'

type LobbyMemberLite = {
  user_id: string
  team: 'red' | 'blue' | null
  is_spymaster: boolean
  role: 'owner' | 'player' | 'spectator'
  is_ready: boolean
  last_seen_at: string
}

type CenterNoticeTone = 'info' | 'turn' | 'win'
type HintGuess = { word: string; correct: boolean }
type HintTrack = { id: string; clue: string; number: number; words: HintGuess[] }
type ProfileView = { displayName: string; avatarUrl: string }
type RevealMark = { pos: number; byUserId: string | null; at: number }
type DicePickerState = {
  option: 'sabotage_reassign' | 'steal_reassign' | 'swap'
  posA: number | null
  posB: number | null
}
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

function keyColorText(c: CardColor): string {
  if (c === 'assassin') return 'A'
  if (c === 'neutral') return 'N'
  if (c === 'red') return 'R'
  return 'B'
}

function clampInt(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min
  return Math.max(min, Math.min(max, n))
}

function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

function displayNameOrFallback(name: string | undefined, fallback: string): string {
  const clean = String(name ?? '').trim()
  return clean || fallback
}

function clearLastLobbyMemory() {
  try {
    localStorage.removeItem('oneclue_last_lobby_code')
    localStorage.removeItem('oneclue_last_lobby_role')
  } catch {
    // ignore
  }
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

type PeekRow = { pos: number; color: string; at?: string }
function isDiceOption(value: unknown): value is DiceOption {
  return (
    value === 'double_hint' ||
    value === 'sabotage_reassign' ||
    value === 'steal_reassign' ||
    value === 'shield' ||
    value === 'cancel' ||
    value === 'swap'
  )
}

function getPeeks(state: any, team: 'red' | 'blue' | null): PeekRow[] {
  if (!team) return []
  const arr = state?.helpers?.peeks?.[team]
  if (!Array.isArray(arr)) return []
  return arr
    .map((x: any) => ({
      pos: typeof x?.pos === 'number' ? x.pos : Number(x?.pos),
      color: String(x?.color ?? ''),
      at: typeof x?.at === 'string' ? x.at : undefined
    }))
    .filter((x: PeekRow) => Number.isFinite(x.pos) && x.color.length > 0)
}

function getStreak(state: any, team: 'red' | 'blue' | null): number {
  if (!team) return 0
  const v = state?.streak?.[team]
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

function diceUsedThisTurn(state: any): boolean {
  const tn = Number(state?.turn_no ?? 0)
  const used = Number(state?.dice?.used_turn_no ?? -1)
  return Number.isFinite(tn) && Number.isFinite(used) && tn === used
}

function timeCutHalfAppliesNow(state: any, currentTurnTeam: 'red' | 'blue' | null): boolean {
  if (!currentTurnTeam) return false
  const mode = state?.helpers?.time_cut_mode?.[currentTurnTeam]
  return mode === 'half'
}

function buildTurnSig(g: Game | null): string {
  if (!g) return 'x'
  const st = (g.state as any) ?? {}
  const started = String((g as any).turn_started_at ?? st.turn_started_at ?? '')
  const team = String(g.current_turn_team ?? 'x')
  const tn = String(st.turn_no ?? '')
  const clue = String(g.clue_word ?? '')
  const num = String(g.clue_number ?? '')
  return `${team}|${tn}|${started}|${clue}|${num}`
}

export default function GameRoute() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const gameId = useMemo(() => (id ?? '').trim(), [id])

  function teamLabelText(team: 'red' | 'blue' | null): string {
    if (team === 'red') return t('game.team.red')
    if (team === 'blue') return t('game.team.blue')
    return t('game.team.none')
  }

  function roleLabel(isSpy: boolean): string {
    return isSpy ? t('game.role.spymaster') : t('game.role.operative')
  }

  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [realtimeStatus, setRealtimeStatus] = useState<
    'CONNECTING' | 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR'
  >('CONNECTING')

  const [game, setGame] = useState<Game | null>(null)
  const [cards, setCards] = useState<GameCard[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const [myTeam, setMyTeam] = useState<'red' | 'blue' | null>(null)
  const [amSpymaster, setAmSpymaster] = useState(false)
  const [myUserId, setMyUserId] = useState<string | null>(null)

  const [clueWord, setClueWord] = useState('')
  const [clueNumber, setClueNumber] = useState(1)
  const [isEditingClue, setIsEditingClue] = useState(false)
  const isEditingClueRef = useRef(false)
  const clueWordInputRef = useRef<HTMLInputElement | null>(null)
  const clueNumberInputRef = useRef<HTMLInputElement | null>(null)

  const [keyRows, setKeyRows] = useState<SpymasterKeyRow[]>([])
  const keyMap = useMemo(() => {
    const m = new Map<number, CardColor>()
    for (const r of keyRows) m.set(r.pos, r.color)
    return m
  }, [keyRows])

  const [members, setMembers] = useState<LobbyMemberLite[]>([])
  const membersRef = useRef<LobbyMemberLite[]>([])


  useEffect(() => {
    membersRef.current = members
  }, [members])

  const myUserIdRef = useRef<string | null>(null)
  useEffect(() => {
    myUserIdRef.current = myUserId
  }, [myUserId])

  const [profileByUserId, setProfileByUserId] = useState<Record<string, ProfileView>>({})
  const [profileNameByUserId, setProfileNameByUserId] = useState<Record<string, string>>({})

  const [revealFxByPos, setRevealFxByPos] = useState<Record<number, 'correct' | 'incorrect' | 'assassin'>>({})
  const [pendingRevealPos, setPendingRevealPos] = useState<number | null>(null)
  const [centerNotice, setCenterNotice] = useState<{ id: number; text: string; tone: CenterNoticeTone } | null>(null)
  const [teamHintLog, setTeamHintLog] = useState<{ red: HintTrack[]; blue: HintTrack[] }>({ red: [], blue: [] })
const hintHydratedRef = useRef(false)

// hint trail persistence (so refresh keeps history)
useEffect(() => {
  if (!gameId) return
  if (hintHydratedRef.current) return
  hintHydratedRef.current = true
  try {
    const raw = localStorage.getItem(`oneclue_hint_log:${gameId}`)
    if (!raw) return
    const parsed = JSON.parse(raw) as any
    if (parsed && typeof parsed === 'object' && parsed.red && parsed.blue) {
      setTeamHintLog({
        red: Array.isArray(parsed.red) ? (parsed.red as HintTrack[]) : [],
        blue: Array.isArray(parsed.blue) ? (parsed.blue as HintTrack[]) : []
      })
    }
  } catch {
    // ignore
  }
}, [gameId])

useEffect(() => {
  if (!gameId) return
  try {
    localStorage.setItem(`oneclue_hint_log:${gameId}`, JSON.stringify(teamHintLog))
  } catch {
    // ignore
  }
}, [gameId, teamHintLog])

  const [roundCorrectStreak, setRoundCorrectStreak] = useState(0)
  const [rolledDiceOption, setRolledDiceOption] = useState<DiceOption | null>(null)
  const [peekFlash, setPeekFlash] = useState<{ pos: number; color: string } | null>(null)
  const [showWinTrail, setShowWinTrail] = useState(false)
  const [lobbyCode, setLobbyCode] = useState<string>('')
  const [showRules, setShowRules] = useState(false)
  const [dicePicker, setDicePicker] = useState<DicePickerState | null>(null)
  const [revealMarks, setRevealMarks] = useState<Record<number, RevealMark>>({})
  const channelRef = useRef<any>(null)
  const prevRevealedRef = useRef<Map<number, boolean>>(new Map())
  const fxTimeoutsRef = useRef<number[]>([])
  const suspenseTimeoutRef = useRef<number | null>(null)
  const noticeTimeoutRef = useRef<number | null>(null)
  const peekFlashTimeoutRef = useRef<number | null>(null)
  const prevGameRef = useRef<Game | null>(null)
  const statsRecordedGameIdsRef = useRef<Set<string>>(new Set())
  const prevForcedWinnerRef = useRef<'red' | 'blue' | null>(null)
  const lastOutcomeSfxRef = useRef<string>('')
  const countdownSfxTurnSigRef = useRef<string>('')
  const autoEndTurnRef = useRef<{ sig: string; inFlight: boolean }>({ sig: '', inFlight: false })
  const guessesTransitionRef = useRef<{ turnSig: string; prev: number | null }>({ turnSig: '', prev: null })

  // timer (persisted if `games.turn_started_at` exists)
const DEFAULT_TURN_SECONDS = 60
const [timerSettings, setTimerSettings] = useState<{ useTurnTimer: boolean; turnSeconds: number; streakToUnlockDice: number }>({
  useTurnTimer: true,
  turnSeconds: DEFAULT_TURN_SECONDS,
  streakToUnlockDice: 4
})

async function refreshTimerSettings(lobbyId: string): Promise<void> {
  try {
    const lobby = await getLobbyById(lobbyId)
    const gs = settingsFromLobby(lobby)
    setTimerSettings({
      useTurnTimer: gs.useTurnTimer,
      turnSeconds: Math.max(15, Math.min(300, Math.floor(gs.turnSeconds))),
      streakToUnlockDice: Math.max(2, Math.min(8, Math.floor(gs.streakToUnlockDice)))
    })
  } catch (err) {
    console.warn('[game] refresh timer settings failed:', err)
  }
}

function getTurnTotalSeconds(g: Game | null): number {
  if (!g) return timerSettings.turnSeconds
  const st: any = g.state
  const base = timerSettings.turnSeconds
  // If time_cut_mode is "half" for the current team, make the whole turn half duration (refresh-safe).
  if (timeCutHalfAppliesNow(st, g.current_turn_team)) return Math.max(10, Math.floor(base / 2))
  return base
}

function getTurnStartedAt(g: Game | null): string | null {
  if (!g) return null
  const anyG: any = g as any
  const direct = typeof anyG.turn_started_at === 'string' ? anyG.turn_started_at : null
  const inState = typeof (g.state as any)?.turn_started_at === 'string' ? ((g.state as any).turn_started_at as string) : null
  return direct ?? inState ?? null
}

function computeTurnLeftFromGame(g: Game | null): number {
  const total = getTurnTotalSeconds(g)
  if (!g) return total

  const sig = buildTurnSig(g)
  const started = getTurnStartedAt(g)
  const parsedMs = started ? Date.parse(started) : NaN

  let startMs: number | null = Number.isFinite(parsedMs) ? parsedMs : null
  if (startMs === null) {
    const cached = localTurnStartMsBySigRef.current[sig]
    if (Number.isFinite(cached)) {
      startMs = cached
    } else {
      startMs = Date.now()
      localTurnStartMsBySigRef.current[sig] = startMs
    }
  } else {
    // Prefer backend timestamp when available, but cache it for stable ticking.
    localTurnStartMsBySigRef.current[sig] = startMs
  }

  const elapsed = Math.floor((Date.now() - startMs) / 1000)
  return clampInt(total - elapsed, 0, total)
}

const [turnLeft, setTurnLeft] = useState<number>(DEFAULT_TURN_SECONDS)
const lastTurnSigRef = useRef<string>('')
const localTurnStartMsBySigRef = useRef<Record<string, number>>({})

useEffect(() => {
  isEditingClueRef.current = isEditingClue
}, [isEditingClue])

function syncClueInputsFromGame(g: Game, force = false) {
  if (!force && isEditingClueRef.current) return
  setClueWord(g.clue_word ?? '')
  setClueNumber(g.clue_number ?? 1)
}

function handleClueInputBlur() {
  // Keep edit-lock on when focus moves between clue inputs.
  window.setTimeout(() => {
    const active = document.activeElement
    const stillInClueInputs = active === clueWordInputRef.current || active === clueNumberInputRef.current
    setIsEditingClue(stillInClueInputs)
  }, 0)
}


    async function refreshMembers(lobbyId: string, loadProfiles: boolean) {
  const { data, error } = await supabase
    .from('lobby_members')
    .select('user_id,team,is_spymaster,role,is_ready,joined_at,last_seen_at')
    .eq('lobby_id', lobbyId)
    .order('joined_at', { ascending: true })

  if (error) {
    console.warn('[game] refreshMembers failed:', error)
    return
  }

  const base = ((data ?? []) as any[]) as LobbyMemberLite[]
  setMembers(base)

  if (!loadProfiles) return

  try {
    const profs = await getLobbyProfiles(lobbyId)
    const map: Record<string, ProfileView> = {}
    const nameMap: Record<string, string> = {}
      for (const p of profs ?? []) {
        const uid = String((p as any).user_id ?? '').trim()
        const n = String((p as any).display_name ?? '').trim()
        const avatarUrl = String((p as any).avatar_url ?? '').trim()
        if (uid) {
          map[uid] = { displayName: n, avatarUrl }
          if (n) nameMap[uid] = n
        }
      }
      setProfileByUserId(map)
      setProfileNameByUserId(nameMap)
  } catch (err) {
    console.warn('[game] get_lobby_profiles failed; keeping cached names:', err)
    // keep old cache
  }
}

  const amOwner = useMemo(() => {
    if (!myUserId) return false
    return members.some((m) => m.user_id === myUserId && m.role === 'owner')
  }, [members, myUserId])
  const amPlayableMember = useMemo(() => {
    if (!myUserId) return false
    return members.some((m) => m.user_id === myUserId && (m.role === 'owner' || m.role === 'player'))
  }, [members, myUserId])
  const canAutoAdvanceTurn = amPlayableMember

  const myPeeks = useMemo(() => getPeeks(game?.state as any, myTeam), [game?.state, myTeam])
  const myStreak = useMemo(() => getStreak(game?.state as any, myTeam), [game?.state, myTeam])
  const diceFillPercent = useMemo(() => {
    const s = Math.max(0, Math.floor(myStreak))
    if (s <= 0) return 0
    if (s === 1) return 20
    if (s === 2) return 50
    if (s === 3) return 80
    return 100
  }, [myStreak])
  const memberTeamById = useMemo(() => {
    const out = new Map<string, 'red' | 'blue' | null>()
    for (const m of members) out.set(m.user_id, m.team)
    return out
  }, [members])
  const revealedCounts = useMemo(() => {
    let red = 0
    let blue = 0
    for (const c of cards) {
      if (!c.revealed || !c.revealed_color) continue
      if (c.revealed_color === 'red') red += 1
      if (c.revealed_color === 'blue') blue += 1
    }
    return { red, blue }
  }, [cards])

  const diceUnlockStreak = 4
  const diceUnlocked = myStreak >= diceUnlockStreak
  const diceUsed = useMemo(() => diceUsedThisTurn(game?.state as any), [game?.state])

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
        setMyUserId(uid)

        const { data: lm, error: lmErr } = await supabase
          .from('lobby_members')
          .select('team,is_spymaster')
          .eq('lobby_id', g.lobby_id)
          .eq('user_id', uid)
          .single()

        if (lmErr) throw lmErr

        await refreshMembers(g.lobby_id, true)
        await refreshTimerSettings(g.lobby_id)


        if (cancelled) return
        setGame(g)
        setCards(c)
        setMyTeam((lm?.team ?? null) as 'red' | 'blue' | null)
        setAmSpymaster(Boolean(lm?.is_spymaster))
        syncClueInputsFromGame(g, true)
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
    return () => {
      fxTimeoutsRef.current.forEach((t) => window.clearTimeout(t))
      fxTimeoutsRef.current = []
      if (suspenseTimeoutRef.current !== null) {
        window.clearTimeout(suspenseTimeoutRef.current)
        suspenseTimeoutRef.current = null
      }
      if (noticeTimeoutRef.current !== null) {
        window.clearTimeout(noticeTimeoutRef.current)
        noticeTimeoutRef.current = null
      }
      if (peekFlashTimeoutRef.current !== null) {
        window.clearTimeout(peekFlashTimeoutRef.current)
        peekFlashTimeoutRef.current = null
      }
    }
  }, [])

  // Keep lobby member presence fresh during game so auto-turn driver election does not pick offline members.
  useEffect(() => {
    if (!game?.lobby_id) return
    if (!myUserId) return

    let cancelled = false
    const lobbyId = game.lobby_id

    const ping = async () => {
      try {
        await supabase
          .from('lobby_members')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('lobby_id', lobbyId)
          .eq('user_id', myUserId)
      } catch {
        // ignore heartbeat failures
      }
    }

    void ping()
    const id = window.setInterval(() => {
      if (cancelled) return
      void ping()
    }, HEARTBEAT_MS)

    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [game?.lobby_id, myUserId])
    useEffect(() => {
    if (!gameId) return
    if (!game?.lobby_id) return
    if (realtimeStatus === 'SUBSCRIBED') return

    let cancelled = false
    const lobbyId = game.lobby_id

    const tick = async () => {
      try {
        const [g, c] = await Promise.all([loadGame(gameId), loadGameCards(gameId)])
        if (cancelled) return
        setGame(g)
        setCards(c)
        syncClueInputsFromGame(g)
      } catch (err) {
        // keep quiet: polling is just a fallback
        console.warn('[game] poll fallback failed:', err)
      }
    }

    void tick()
    const t = window.setInterval(tick, 2000)

    // members fallback (lighter, no profiles)
    const m = window.setInterval(() => {
      void refreshMembers(lobbyId, false)
    }, 10_000)

    return () => {
      cancelled = true
      window.clearInterval(t)
      window.clearInterval(m)
    }
  }, [gameId, game?.lobby_id, realtimeStatus])

  useEffect(() => {
    if (!gameId) return
    if (!game?.lobby_id) return

    const lobbyId = game.lobby_id
    setRealtimeStatus('CONNECTING')
    const channel = supabase
      .channel(`lobby:${lobbyId}`, { config: { broadcast: { self: true, ack: true } } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, async () => {
        const g = await loadGame(gameId)
        setGame(g)
        syncClueInputsFromGame(g)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `game_id=eq.${gameId}` }, async () => {
        const [c, g] = await Promise.all([loadGameCards(gameId), loadGame(gameId)])
        setCards(c)
        setGame(g)
        syncClueInputsFromGame(g)
      })
            .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lobby_members', filter: `lobby_id=eq.${lobbyId}` },
        async (payload) => {
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

          // full refresh for real membership changes
          await refreshMembers(lobbyId, payload.eventType === 'INSERT' || payload.eventType === 'DELETE')
        }
      )
      .on('broadcast', { event: 'reveal_mark' }, (payload) => {
        const data = (payload as any)?.payload as any
        if (!data || String(data.gameId ?? '') !== gameId) return
        const action = String(data.action ?? 'set')
        const pos = Number(data.pos)
        if (!Number.isFinite(pos) || pos < 0) return
        if (action === 'clear') {
          setRevealMarks((prev) => {
            const out = { ...prev }
            delete out[pos]
            return out
          })
          return
        }
        const byUserId = typeof data.byUserId === 'string' ? data.byUserId : null
        const at = Number(data.at)
        setRevealMarks((prev) => ({ ...prev, [pos]: { pos, byUserId, at: Number.isFinite(at) ? at : Date.now() } }))
      })
      .on('broadcast', { event: 'dice_roll' }, (payload) => {
        const data = (payload as any)?.payload as any
        if (!data || String(data.gameId ?? '') !== gameId) return
        const option = data.option
        if (!isDiceOption(option)) return
        setRolledDiceOption(option)
      })


            .subscribe((status) => {
        setRealtimeStatus(status as any)
      })
    channelRef.current = channel
    return () => {
      channelRef.current = null
      void supabase.removeChannel(channel)
    }
  }, [gameId, game?.lobby_id, navigate])

  useEffect(() => {
    if (!cards.length) return

    const next = new Map<number, boolean>()
    const updates: Array<{ pos: number; tone: 'correct' | 'incorrect' | 'assassin' }> = []
    const newlyRevealed: GameCard[] = []

    for (const c of cards) {
      const wasRevealed = prevRevealedRef.current.get(c.pos) ?? c.revealed
      next.set(c.pos, c.revealed)
      if (!wasRevealed && c.revealed) {
        newlyRevealed.push(c)
        const expectedTeam = game?.current_turn_team ?? myTeam
        const tone: 'correct' | 'incorrect' | 'assassin' =
          c.revealed_color === 'assassin'
            ? 'assassin'
            : expectedTeam !== null && c.revealed_color === expectedTeam
              ? 'correct'
              : 'incorrect'
        updates.push({ pos: c.pos, tone })
      }
    }

    prevRevealedRef.current = next

    if (updates.length > 0) {
      setRevealFxByPos((prev) => {
        const out = { ...prev }
        for (const u of updates) out[u.pos] = u.tone
        return out
      })

      for (const u of updates) {
        const timer = window.setTimeout(() => {
          setRevealFxByPos((prev) => {
            const out = { ...prev }
            delete out[u.pos]
            return out
          })
          fxTimeoutsRef.current = fxTimeoutsRef.current.filter((x) => x !== timer)
        }, 1250)
        fxTimeoutsRef.current.push(timer)
      }
    }

    if (newlyRevealed.length === 0) return

    for (const c of newlyRevealed) {
      const actorTeam = c.revealed_by ? memberTeamById.get(c.revealed_by) ?? null : null
      if (!actorTeam) continue
      const isCorrect = c.revealed_color === actorTeam
      setTeamHintLog((prev) => {
        const arr = [...prev[actorTeam]]
        if (arr.length === 0) {
          const fallback: HintTrack = {
            id: `${actorTeam}-fallback-${Date.now()}`,
            clue: String(game?.clue_word ?? t('game.symbol.none')),
            number: Number(game?.clue_number ?? 0),
            words: [{ word: c.word, correct: isCorrect }]
          }
          return { ...prev, [actorTeam]: [fallback] }
        }
        const last = arr[arr.length - 1]
        if (!last.words.some((w) => w.word === c.word)) last.words = [...last.words, { word: c.word, correct: isCorrect }]
        arr[arr.length - 1] = last
        return { ...prev, [actorTeam]: arr.slice(-6) }
      })

    }
  }, [cards, myTeam, game?.current_turn_team, game?.clue_word, game?.clue_number, memberTeamById])

  async function broadcastRevealMark(action: 'set' | 'clear', pos: number) {
    const ch = channelRef.current
    if (!ch) return
    try {
      await ch.send({
        type: 'broadcast',
        event: 'reveal_mark',
        payload: {
          gameId,
          action,
          pos,
          byUserId: myUserId ?? null,
          at: Date.now()
        }
      })
    } catch {
      // ignore realtime broadcast errors; local marker still works
    }
  }
  async function broadcastDiceRoll(option: DiceOption) {
    const ch = channelRef.current
    if (!ch) return
    try {
      await ch.send({
        type: 'broadcast',
        event: 'dice_roll',
        payload: {
          gameId,
          option,
          byUserId: myUserId ?? null,
          at: Date.now()
        }
      })
    } catch {
      // ignore realtime broadcast errors; local UI still updates
    }
  }

  function clearRevealMark(pos: number) {
    setRevealMarks((prev) => {
      if (!prev[pos]) return prev
      const out = { ...prev }
      delete out[pos]
      return out
    })
    void broadcastRevealMark('clear', pos)
  }

  useEffect(() => {
    const revealedSet = new Set(cards.filter((c) => c.revealed).map((c) => c.pos))
    setRevealMarks((prev) => {
      let changed = false
      const out: Record<number, RevealMark> = {}
      for (const [k, mark] of Object.entries(prev)) {
        const pos = Number(k)
        if (revealedSet.has(pos)) {
          changed = true
          continue
        }
        out[pos] = mark
      }
      return changed ? out : prev
    })
  }, [cards])

  

  function showCenterNotice(text: string, tone: CenterNoticeTone = 'info', ms = 1700) {
    if (noticeTimeoutRef.current !== null) {
      window.clearTimeout(noticeTimeoutRef.current)
      noticeTimeoutRef.current = null
    }
    setCenterNotice({ id: Date.now(), text, tone })
    noticeTimeoutRef.current = window.setTimeout(() => {
      setCenterNotice((prev) => (prev?.text === text ? null : prev))
      noticeTimeoutRef.current = null
    }, ms)
  }

  function playOutcomeSfx(winner: 'red' | 'blue' | null | undefined) {
    if (!winner) return
    const outcome = myTeam ? (winner === myTeam ? 'win' : 'lose') : 'win'
    const sig = `${gameId}|${winner}|${outcome}`
    if (lastOutcomeSfxRef.current === sig) return
    lastOutcomeSfxRef.current = sig
    playSfx(outcome, 0.92)
  }

  useEffect(() => {
    if (!game) return
    const prev = prevGameRef.current
    prevGameRef.current = game
    if (!prev) return

    if (prev.current_turn_team !== game.current_turn_team && game.current_turn_team) {
      showCenterNotice(t('game.notice.teamTurn', { team: teamLabelText(game.current_turn_team) }), 'turn', 1700)
      playSfx('turn', 0.7)
    }

    const prevClue = (prev.clue_word ?? '').trim()
    const nextClue = (game.clue_word ?? '').trim()
    if ((prevClue !== nextClue || prev.clue_number !== game.clue_number) && nextClue && game.current_turn_team) {
      const tn = Number((game.state as any)?.turn_no ?? 0)
      const hintId = `${game.current_turn_team}-${tn}-${nextClue}-${String(game.clue_number ?? 0)}`
      setTeamHintLog((logs) => {
        const team = game.current_turn_team as 'red' | 'blue'
        if (!team) return logs
        const arr = [...logs[team]]
        if (arr.some((x) => x.id === hintId)) return logs
        arr.push({ id: hintId, clue: nextClue, number: Number(game.clue_number ?? 0), words: [] })
        return { ...logs, [team]: arr.slice(-6) }
      })
      showCenterNotice(t('game.notice.clueSet', { clue: nextClue, number: String(game.clue_number ?? t('game.symbol.none')) }), 'info', 2200)
      playSfx('clue', 0.8)
    }

    if (prev.status !== game.status) {
      if (game.status === 'finished') {
        if (game.winning_team) {
          showCenterNotice(t('game.notice.teamWins', { team: teamLabelText(game.winning_team) }), 'win', 2600)
          playOutcomeSfx(game.winning_team)
        } else {
          showCenterNotice(t('game.notice.gameFinished'), 'win', 2200)
        }
      } else if (game.status === 'abandoned') {
        showCenterNotice(t('game.notice.gameAbandoned'), 'info', 2200)
      }
    }

    if (prev.winning_team !== game.winning_team && game.winning_team) {
      showCenterNotice(t('game.notice.teamWins', { team: teamLabelText(game.winning_team) }), 'win', 2600)
      playOutcomeSfx(game.winning_team)
    }
  }, [game, gameId, myTeam, t])

  useEffect(() => {
    const g = game
    if (!g) return

    // Some backends may not immediately mark the game as finished.
    // We treat "0 remaining" as a win signal as a fallback so stats still record.
    const blueNow = clampInt(g.blue_remaining ?? 0, 0, 99)
    const redNow = clampInt(g.red_remaining ?? 0, 0, 99)
    const winnerFromRemaining: 'red' | 'blue' | null = blueNow === 0 ? 'blue' : redNow === 0 ? 'red' : null

    const winner: 'red' | 'blue' | null = (g.winning_team as any) ?? winnerFromRemaining
    if (!winner) return

    if (!myUserId || !myTeam) return
    if (!gameId) return
    if (statsRecordedGameIdsRef.current.has(gameId)) return
    statsRecordedGameIdsRef.current.add(gameId)

    ;(async () => {
      try {
        await recordFinishedGameStats({
          gameId,
          winnerTeam: winner,
          myUserId,
          myTeam,
          members,
          profileNameByUserId
        })
      } catch (err) {
        // keep gameplay flow intact even if stats persist fails
        console.warn('[game] stats update failed:', err)
      }
    })()
  }, [game, gameId, myUserId, myTeam, members, profileNameByUserId])

  useEffect(() => {
    if (!game?.clue_word || !game.current_turn_team) return
    const clue = game.clue_word.trim()
    if (!clue) return
    const tn = Number((game.state as any)?.turn_no ?? 0)
    const hintId = `${game.current_turn_team}-${tn}-${clue}-${String(game.clue_number ?? 0)}`
    setTeamHintLog((logs) => {
      const team = game.current_turn_team as 'red' | 'blue'
      const arr = [...logs[team]]
      if (arr.some((x) => x.id === hintId)) return logs
      arr.push({ id: hintId, clue, number: Number(game.clue_number ?? 0), words: [] })
      return { ...logs, [team]: arr.slice(-6) }
    })
  }, [game?.clue_word, game?.clue_number, game?.current_turn_team, game?.state])

  useEffect(() => {
    if (!game) return
    const blueNow = clampInt(game.blue_remaining ?? 0, 0, 99)
    const redNow = clampInt(game.red_remaining ?? 0, 0, 99)
    const winner: 'red' | 'blue' | null = blueNow === 0 ? 'blue' : redNow === 0 ? 'red' : null

    if (!winner) {
      prevForcedWinnerRef.current = null
      return
    }
    if (prevForcedWinnerRef.current === winner) return
    prevForcedWinnerRef.current = winner
    showCenterNotice(t('game.notice.teamWins', { team: teamLabelText(winner) }), 'win', 2600)
    playOutcomeSfx(winner)
  }, [game, gameId, myTeam, t])

  useEffect(() => {
    let cancelled = false
    if (!amSpymaster || !gameId) return

    ;(async () => {
      try {
        const rows = await loadSpymasterKey(gameId)
        if (!cancelled) setKeyRows(rows)
      } catch (err) {
        console.error('[game] key load failed:', err)
        if (!cancelled) showCenterNotice(supaErr(err), 'info', 2600)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [amSpymaster, gameId])

  // reset timer on new turn signature
  useEffect(() => {
    if (!game) return
    const sig = buildTurnSig(game)
    if (sig !== lastTurnSigRef.current) {
      lastTurnSigRef.current = sig
      setTurnLeft(computeTurnLeftFromGame(game))
      setRoundCorrectStreak(0)
      setRolledDiceOption(null)
    }
  }, [game?.current_turn_team, game?.clue_word, game?.clue_number, game?.state])

  // ticking timer (recomputes from persisted turn start time when available)
useEffect(() => {
  if (state !== 'ready') return
  if (!game) return

  const blueNow = clampInt(game.blue_remaining ?? 0, 0, 99)
  const redNow = clampInt(game.red_remaining ?? 0, 0, 99)
  const winner: 'red' | 'blue' | null = game.winning_team ?? (blueNow === 0 ? 'blue' : redNow === 0 ? 'red' : null)
  const localStatus = game.status === 'active' && winner ? 'finished' : game.status
  if (localStatus !== 'active') return

  if (!timerSettings.useTurnTimer) {
    setTurnLeft(getTurnTotalSeconds(game))
    return
  }

  // snap immediately, then tick
  setTurnLeft(computeTurnLeftFromGame(game))
  const id = window.setInterval(() => setTurnLeft(computeTurnLeftFromGame(game)), 1000)
  return () => window.clearInterval(id)
}, [state, game, timerSettings.useTurnTimer, timerSettings.turnSeconds])

  // Play "time running" once when the timer enters the last 10 seconds of a turn.
  useEffect(() => {
    if (!game) {
      stopSfx('time_running')
      return
    }
    if (!timerSettings.useTurnTimer) {
      stopSfx('time_running')
      return
    }

    const blueNow = clampInt(game.blue_remaining ?? 0, 0, 99)
    const redNow = clampInt(game.red_remaining ?? 0, 0, 99)
    const winner: 'red' | 'blue' | null = game.winning_team ?? (blueNow === 0 ? 'blue' : redNow === 0 ? 'red' : null)
    const localStatus = game.status === 'active' && winner ? 'finished' : game.status
    if (localStatus !== 'active') {
      stopSfx('time_running')
      return
    }

    if (turnLeft > 0 && turnLeft <= 10) {
      const sig = buildTurnSig(game)
      if (countdownSfxTurnSigRef.current !== sig) {
        countdownSfxTurnSigRef.current = sig
        playManagedSfx('time_running', 0.9)
      }
      return
    }
    stopSfx('time_running')
  }, [game, turnLeft, timerSettings.useTurnTimer])

// auto-change turn when timer reaches 0
  useEffect(() => {
    if (!gameId || !game) return
    if (!timerSettings.useTurnTimer) return
    if (!canAutoAdvanceTurn) return
    if (turnLeft > 0) return
    if (game.status !== 'active') return
    const blueNow = clampInt(game.blue_remaining ?? 0, 0, 99)
    const redNow = clampInt(game.red_remaining ?? 0, 0, 99)
    const winner: 'red' | 'blue' | null = game.winning_team ?? (blueNow === 0 ? 'blue' : redNow === 0 ? 'red' : null)
    if (winner) return

    const turnSig = buildTurnSig(game)
    if (autoEndTurnRef.current.sig === turnSig) return
    if (autoEndTurnRef.current.inFlight) return

    autoEndTurnRef.current.inFlight = true
    autoEndTurnRef.current.sig = turnSig

    ;(async () => {
      try {
        const fresh = await loadGame(gameId)
        if (fresh.status !== 'active') return
        if (buildTurnSig(fresh) !== turnSig) return
        await endTurn(gameId)
        const after = await loadGame(gameId)
        if (buildTurnSig(after) === turnSig && after.status === 'active' && !after.winning_team) {
          // end_turn returned but turn did not advance; allow immediate retry.
          if (autoEndTurnRef.current.sig === turnSig) autoEndTurnRef.current.sig = ''
        }
        // Pull fresh game state so turn/team/timer updates immediately without relying on realtime timing.
        setGame(after)
        syncClueInputsFromGame(after)
      } catch (err) {
        // Allow retry for the same turn if this attempt fails.
        if (autoEndTurnRef.current.sig === turnSig) autoEndTurnRef.current.sig = ''
        console.warn('[game] timer auto end_turn skipped:', err)
      } finally {
        autoEndTurnRef.current.inFlight = false
      }
    })()
  }, [gameId, game, turnLeft, canAutoAdvanceTurn, timerSettings.useTurnTimer])

  // auto-change turn when guesses are exhausted
  useEffect(() => {
    if (!gameId || !game) return
    if (!canAutoAdvanceTurn) return
    if (game.status !== 'active') return
    const gr = Number(game.guesses_remaining ?? -1)

    const turnSig = buildTurnSig(game)
    if (guessesTransitionRef.current.turnSig !== turnSig) {
      guessesTransitionRef.current = { turnSig, prev: Number.isFinite(gr) ? gr : null }
      return
    }

    const prev = guessesTransitionRef.current.prev
    guessesTransitionRef.current.prev = Number.isFinite(gr) ? gr : null

    // Only auto-end on a real transition (e.g. 1 -> 0), not on stable 0 states.
    if (!Number.isFinite(gr) || gr > 0) return
    if (prev === null || prev <= 0) return
    if (autoEndTurnRef.current.sig === turnSig) return
    if (autoEndTurnRef.current.inFlight) return

    autoEndTurnRef.current.inFlight = true
    autoEndTurnRef.current.sig = turnSig

    ;(async () => {
      try {
        const fresh = await loadGame(gameId)
        if (fresh.status !== 'active') return
        if (buildTurnSig(fresh) !== turnSig) return
        const freshGuesses = Number(fresh.guesses_remaining ?? -1)
        if (!Number.isFinite(freshGuesses) || freshGuesses > 0) return
        await endTurn(gameId)
        const after = await loadGame(gameId)
        if (buildTurnSig(after) === turnSig && after.status === 'active' && !after.winning_team) {
          // end_turn returned but turn did not advance; allow immediate retry.
          if (autoEndTurnRef.current.sig === turnSig) autoEndTurnRef.current.sig = ''
        }

        // pull fresh game state so UI flips immediately even if realtime misses it
        setGame(after)
        syncClueInputsFromGame(after)
      } catch (err) {
        // Allow retry for the same turn if this attempt fails.
        if (autoEndTurnRef.current.sig === turnSig) autoEndTurnRef.current.sig = ''
        console.warn('[game] guesses auto end_turn failed:', err)
        showCenterNotice(supaErr(err), 'info', 2600)
      } finally {
        autoEndTurnRef.current.inFlight = false
      }
    })()
  }, [gameId, game, canAutoAdvanceTurn])



async function handleReveal(pos: number) {
    if (!gameId) return
    if (!isGameActive) return
    if (pillCount <= 0) return
    if (pendingRevealPos !== null || busy !== null) return

    const mark = revealMarks[pos]
    const markedByMe = Boolean(mark && mark.byUserId && myUserId && mark.byUserId === myUserId)
    if (!markedByMe) {
      setRevealMarks((prev) => ({ ...prev, [pos]: { pos, byUserId: myUserId ?? null, at: Date.now() } }))
      void broadcastRevealMark('set', pos)
      showCenterNotice('Card tagged. Click it again to reveal.', 'info', 1300)
      return
    }

    try {
      clearRevealMark(pos)
      setPendingRevealPos(pos)

      // tiny delay keeps the UI feel responsive (also prevents accidental double taps)
      await new Promise<void>((resolve) => {
        suspenseTimeoutRef.current = window.setTimeout(() => {
          suspenseTimeoutRef.current = null
          resolve()
        }, 500)
      })

      const res = await revealCard(gameId, pos)
      if (res.revealed_color === 'assassin') {
        playSfx('reveal_assassin', 0.95)
      } else if (game?.current_turn_team && res.revealed_color === game.current_turn_team) {
        playSfx('reveal_correct', 0.85)
      } else {
        playSfx('reveal_incorrect', 0.85)
      }
      const nextGuesses =
        res.guesses_remaining === null || res.guesses_remaining === undefined
          ? null
          : Number(res.guesses_remaining)

      // streak is local UX only
      if (myTeam && game?.current_turn_team === myTeam) {
        const isCorrect = res.revealed_color === myTeam
        setRoundCorrectStreak((prev) => (isCorrect ? prev + 1 : 0))
      }

      // Always trust DB for counters + turn changes (fixes "cards left" inaccuracies).
      const g1 = await loadGame(gameId)
      setGame(g1)
      syncClueInputsFromGame(g1)

      // Auto end turn when guesses hit 0 (reliable even if realtime misses updates).
      const wasMyTurn = Boolean(myTeam && game?.current_turn_team === myTeam)
      const gr = typeof nextGuesses === 'number' && Number.isFinite(nextGuesses)
        ? nextGuesses
        : Number(g1.guesses_remaining ?? -1)
      const beforeTurnSig = buildTurnSig(game)
      const afterTurnSig = buildTurnSig(g1)
      if (wasMyTurn && canAutoAdvanceTurn && beforeTurnSig === afterTurnSig && g1.status === 'active' && !g1.winning_team && Number.isFinite(gr) && gr === 0) {
        const turnSig = buildTurnSig(g1)
        if (!autoEndTurnRef.current.inFlight && autoEndTurnRef.current.sig !== turnSig) {
          autoEndTurnRef.current.inFlight = true
          autoEndTurnRef.current.sig = turnSig
          try {
            await endTurn(gameId)
            const after = await loadGame(gameId)
            if (buildTurnSig(after) === turnSig && after.status === 'active' && !after.winning_team) {
              // end_turn returned but turn did not advance; allow immediate retry.
              if (autoEndTurnRef.current.sig === turnSig) autoEndTurnRef.current.sig = ''
            }
          } catch (err) {
            // Allow retry for the same turn if this attempt fails.
            if (autoEndTurnRef.current.sig === turnSig) autoEndTurnRef.current.sig = ''
            console.warn('[game] reveal -> auto end_turn failed:', err)
            showCenterNotice(supaErr(err), 'info', 2600)
          } finally {
            autoEndTurnRef.current.inFlight = false
          }

          // pull fresh game state after end_turn so UI flips immediately
          try {
            const g2 = await loadGame(gameId)
            setGame(g2)
            syncClueInputsFromGame(g2)
          } catch (err) {
            console.warn('[game] post end_turn reload failed:', err)
          }
        }
      }
    } catch (err) {
      console.error('[game] reveal failed:', err)
      showCenterNotice(supaErr(err), 'info', 2600)
    } finally {
      setPendingRevealPos(null)
    }
  }


  async function handleSetClue() {
    if (!gameId) return
    try {
      setIsEditingClue(false)
      setBusy(t('game.busy.settingClue'))
      await setClue(gameId, clueWord, clueNumber)
    } catch (err) {
      console.error('[game] set clue failed:', err)
      showCenterNotice(supaErr(err), 'info', 2600)
    } finally {
      setBusy(null)
    }
  }

  async function handleEndTurn() {
    if (!gameId) return
    try {
      setBusy(t('game.busy.endingTurn'))
      await endTurn(gameId)
    } catch (err) {
      console.error('[game] end turn failed:', err)
      showCenterNotice(supaErr(err), 'info', 2600)
    } finally {
      setBusy(null)
    }
  }

  async function handleStopPlaying() {
    if (!game?.lobby_id) return
    try {
      setBusy(t('game.busy.leaving'))
      await stopPlaying(game.lobby_id)
      clearLastLobbyMemory()
      navigate('/', { replace: true })
    } catch (err) {
      console.error('[game] stop playing failed:', err)
      showCenterNotice(supaErr(err), 'info', 2600)
    } finally {
      setBusy(null)
    }
  }


  async function getLobbyCodeSafe(): Promise<string | null> {
    if (!game?.lobby_id) return null
    if (lobbyCode) return lobbyCode
    try {
      const l = await getLobbyById(game.lobby_id)
      const code = String(l.code ?? '').trim().toUpperCase()
      if (!code) return null
      setLobbyCode(code)
      return code
    } catch (err) {
      console.warn('[game] get lobby code failed:', err)
      showCenterNotice(t('game.notice.loadLobbyCodeFailed'), 'info', 2200)
      return null
    }
  }

  async function handleHome() {
    await handleStopPlaying()
  }

  function handleProfile() {
    navigate('/profile', { state: { from: `/game/${gameId}` } })
  }

  async function handleCopyLobbyCode() {
    const code = await getLobbyCodeSafe()
    if (!code) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code)
      } else {
        const ta = document.createElement('textarea')
        ta.value = code
        ta.setAttribute('readonly', 'true')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      showCenterNotice(t('game.notice.lobbyCodeCopied', { code }), 'info', 1800)
    } catch (err) {
      console.warn('[game] copy lobby code failed:', err)
      showCenterNotice(t('game.notice.copyFailed'), 'info', 2000)
    }
  }

  async function handleBackToLobby() {
    const code = await getLobbyCodeSafe()
    if (!code) return
    try {
      sessionStorage.setItem('oneclue_allow_lobby_view_until', String(Date.now() + 10 * 60 * 1000))
    } catch {
      // ignore
    }
    navigate(`/lobby/${code}`)
  }

  async function handleExitGame() {
    const ok = window.confirm(t('game.confirm.exitGame'))
    if (!ok) return
    await handleStopPlaying()
  }

// If the host stops playing, the RPC should mark the game as abandoned.
// Everyone should leave the game screen when that happens.
useEffect(() => {
  let cancelled = false
  if (!game) return
  if (game.status !== 'abandoned') return

  const lobbyId = game.lobby_id
  ;(async () => {
    try {
      const l = await getLobbyById(lobbyId)
      if (cancelled) return
      navigate(`/lobby/${l.code}`, { replace: true })
    } catch (err) {
      console.warn('[game] abandoned -> redirect failed:', err)
      if (!cancelled) navigate('/', { replace: true })
    }
  })()

  return () => {
    cancelled = true
  }
}, [game?.status, game?.lobby_id, navigate])


  async function handleRestart() {
    if (!game?.lobby_id) return
    try {
      setBusy(t('game.busy.restarting'))
      const code = await restartLobby(game.lobby_id)
      navigate(`/settings/${code}`, { state: { from: `/game/${gameId}` } })
    } catch (err) {
      console.error('[game] restart failed:', err)
      showCenterNotice(supaErr(err), 'info', 2600)
    } finally {
      setBusy(null)
    }
  }

  async function runDice(option: DiceOption) {
    if (!gameId) return
    if (!isGameActive) return
    if (dicePicker) return
    if (option === 'sabotage_reassign' || option === 'steal_reassign' || option === 'swap') {
      setDicePicker({ option, posA: null, posB: null })
      return
    }
    try {
      setBusy(t('game.busy.usingDice'))
      // simple options
      const res = await useDiceOption(gameId, option, {})
      console.log('[dice result]', res)
      showCenterNotice(t('game.notice.diceUsed'), 'info', 1600)
    } catch (err) {
      console.error('[dice] failed:', err)
      showCenterNotice(supaErr(err), 'info', 2600)
    } finally {
      setBusy(null)
    }
  }

  async function submitDicePicker() {
    if (!gameId || !dicePicker) return
    const { option, posA, posB } = dicePicker
    if ((option === 'sabotage_reassign' || option === 'steal_reassign') && !Number.isFinite(Number(posA))) {
      showCenterNotice(t('game.notice.invalidPosition'), 'info', 2000)
      return
    }
    if (option === 'swap' && (!Number.isFinite(Number(posA)) || !Number.isFinite(Number(posB)) || posA === posB)) {
      showCenterNotice(t('game.notice.invalidPositions'), 'info', 2000)
      return
    }
    try {
      setBusy(t('game.busy.usingDice'))
      const params =
        option === 'swap'
          ? { pos_a: Number(posA), pos_b: Number(posB) }
          : { pos: Number(posA) }
      const res = await useDiceOption(gameId, option, params)
      console.log('[dice result]', res)
      showCenterNotice(t('game.notice.diceUsed'), 'info', 1600)
      setDicePicker(null)
    } catch (err) {
      console.error('[dice] failed:', err)
      showCenterNotice(supaErr(err), 'info', 2600)
    } finally {
      setBusy(null)
    }
  }
  function diceOptionLabel(option: DiceOption): string {
    if (option === 'double_hint') return t('game.dice.doubleHint')
    if (option === 'sabotage_reassign') return t('game.dice.sabotageReassign')
    if (option === 'steal_reassign') return t('game.dice.stealReassign')
    if (option === 'shield') return t('game.dice.shield')
    if (option === 'cancel') return t('game.dice.cancel')
    return t('game.dice.swap')
  }
  function diceOptionImage(option: DiceOption): string {
    return diceFacesByOption[option]
  }
  function diceOptionEffectText(option: DiceOption): string {
    if (option === 'double_hint') return t('game.dice.doubleHintHelp')
    if (option === 'sabotage_reassign') return t('game.dice.sabotageReassignHelp')
    if (option === 'steal_reassign') return t('game.dice.stealReassignHelp')
    if (option === 'shield') return t('game.dice.shieldHelp')
    if (option === 'cancel') return t('game.dice.cancelHelp')
    return t('game.dice.swapHelp')
  }
  function diceOptionNextStepText(option: DiceOption): string {
    if (option === 'swap') return t('game.dice.swapStep1')
    if (option === 'sabotage_reassign' || option === 'steal_reassign') return t('game.dice.singleTargetHelp')
    return t('game.dice.instantApplyHelp')
  }

  async function handleRollDice() {
    if (!isGameActive || !diceUnlocked || diceUsed || busy !== null || dicePicker !== null) return
    const options: DiceOption[] = ['double_hint', 'sabotage_reassign', 'steal_reassign', 'shield', 'cancel', 'swap']
    const option = options[Math.floor(Math.random() * options.length)]
    setRolledDiceOption(option)
    void broadcastDiceRoll(option)
    showCenterNotice(t('game.notice.diceRoll', { option: diceOptionLabel(option) }), 'info', 1500)
    await runDice(option)
  }

  async function runHelper(action: HelperAction) {
    if (!gameId) return
    if (!isGameActive) return
    try {
      setBusy(t('game.busy.usingHelper'))
      const res = await useHelperAction(gameId, action, {})
      if (action === 'random_peek') {
        const pos = Number(res.pos)
        const color = String(res.color ?? '').toUpperCase()
        if (Number.isFinite(pos)) {
          setPeekFlash({ pos, color })
          if (peekFlashTimeoutRef.current !== null) window.clearTimeout(peekFlashTimeoutRef.current)
          peekFlashTimeoutRef.current = window.setTimeout(() => {
            setPeekFlash(null)
            peekFlashTimeoutRef.current = null
          }, 1000)
        }
        showCenterNotice(t('game.notice.peek', { color }), 'info', 1300)
      } else if (action === 'time_cut') {
showCenterNotice(t('game.notice.timeCutApplied', { team: String(res.team).toUpperCase() }), 'info', 2200)
      } else {
        showCenterNotice(t('game.notice.shuffleDone'), 'info', 2200)
      }
    } catch (err) {
      console.error('[helper] failed:', err)
      showCenterNotice(supaErr(err), 'info', 2600)
    } finally {
      setBusy(null)
    }
  }

  const pillCount = clampInt(game?.guesses_remaining ?? 0, 0, 99)
  const blueLeft = clampInt(game?.blue_remaining ?? 0, 0, 99)
  const redLeft = clampInt(game?.red_remaining ?? 0, 0, 99)
  const forcedWinner: 'red' | 'blue' | null = blueLeft === 0 ? 'blue' : redLeft === 0 ? 'red' : null
  const effectiveWinner: 'red' | 'blue' | null = game?.winning_team ?? forcedWinner
  const effectiveStatus = game?.status === 'active' && forcedWinner ? 'finished' : game?.status
  const isGameActive = effectiveStatus === 'active'

  const isMyTurn = game?.current_turn_team !== null && myTeam === game?.current_turn_team
  const hasClue = game?.guesses_remaining !== null && game?.guesses_remaining !== undefined
  const canOperate = !amSpymaster && isMyTurn && isGameActive && hasClue && pillCount > 0
  const canEndTurnOperate = !amSpymaster && isMyTurn && isGameActive && hasClue
  const canSpymaster = amSpymaster && isMyTurn && isGameActive
  const shouldShakeCards = isGameActive && turnLeft > 0 && turnLeft <= 10
  const currentTurnTeam = isGameActive ? game?.current_turn_team ?? null : null
  const turnIndicatorClass = !isGameActive ? 'done' : currentTurnTeam === 'red' ? 'red' : currentTurnTeam === 'blue' ? 'blue' : 'idle'
  const turnIndicatorLabel = !isGameActive
    ? t('game.turn.gameFinished')
    : currentTurnTeam === 'red'
      ? t('game.turn.redTeamTurn')
      : currentTurnTeam === 'blue'
        ? t('game.turn.blueTeamTurn')
        : t('game.turn.waiting')
  const turnClueWord = String(game?.clue_word ?? '').trim()
  const turnClueClass = !isGameActive ? 'done' : currentTurnTeam === 'red' ? 'red' : currentTurnTeam === 'blue' ? 'blue' : 'idle'
  const turnTaskClass = turnClueClass
  const activeTurnIsWritingClue = !hasClue
  const turnActorName = useMemo(() => {
    if (!currentTurnTeam) return null
    const teamMembers = members.filter((m) => (m.role === 'owner' || m.role === 'player') && m.team === currentTurnTeam)
    const actorIndex = teamMembers.findIndex((m) => Boolean(m.is_spymaster) === activeTurnIsWritingClue)
    if (actorIndex < 0) return null
    const actor = teamMembers[actorIndex]
    return memberDisplayName(actor.user_id, actorIndex)
  }, [members, currentTurnTeam, activeTurnIsWritingClue, profileByUserId, t])
  const turnTaskText = !isGameActive || !currentTurnTeam
    ? t('game.turn.waiting')
    : activeTurnIsWritingClue
      ? t('game.turn.actorWritingClue', { name: turnActorName ?? teamLabelText(currentTurnTeam) })
      : t('game.turn.actorSolvingClue', { name: turnActorName ?? teamLabelText(currentTurnTeam) })

  useEffect(() => {
    if (isGameActive) setShowWinTrail(false)
  }, [isGameActive])

  const playable = members.filter((m) => m.role === 'owner' || m.role === 'player')
  const redTeam = playable.filter((m) => m.team === 'red')
  const blueTeam = playable.filter((m) => m.team === 'blue')
  const unrevealedCards = useMemo(
    () =>
      cards
        .filter((c) => !c.revealed)
        .map((c) => ({ pos: c.pos, word: String(c.word ?? '').trim() }))
        .sort((a, b) => a.pos - b.pos),
    [cards]
  )

  function diceCardName(pos: number | null): string {
    if (pos === null || !Number.isFinite(pos)) return '-'
    const c = unrevealedCards.find((x) => x.pos === pos)
    const w = String(c?.word ?? '').trim()
    return w || `#${pos}`
  }

  function memberDisplayName(userId: string, index: number): string {
    return displayNameOrFallback(profileByUserId[userId]?.displayName, `${t('game.member.player')} ${index + 1}`)
  }

  function memberAvatar(userId: string, team: 'red' | 'blue' | null): string {
    const custom = String(profileByUserId[userId]?.avatarUrl ?? '').trim()
    if (custom) return custom
    return fallbackAvatarFor(team, userId)
  }

  function renderHintTrail(team: 'red' | 'blue', limit: number, keyPrefix: string): JSX.Element {
    const items = (teamHintLog[team] ?? []).slice(-limit).reverse()
    const teamClass = team === 'red' ? 'red' : 'blue'

    if (items.length === 0) {
      return (
        <div className="oc-hint-empty-pill">
          {t('game.symbol.none')}
        </div>
      )
    }

    return (
      <div className="oc-hint-stack">
        {items.map((h) => (
          <div key={`${keyPrefix}${h.id}`} className={`oc-hint-entry ${teamClass}`}>
            <div className="oc-hint-head">
              <span className="oc-hint-clue">{h.clue}</span>
              <span className="oc-hint-num">{h.number}</span>
            </div>

            {h.words.length > 0 ? (
              <div className="oc-hint-word-row">
                {h.words.map((w, idx) => (
                  <span key={`${h.id}-${w.word}-${idx}`} className={`oc-hint-word ${w.correct ? 'ok' : 'bad'}`}>
                    {w.word}
                    <b>{w.correct ? 'OK' : 'X'}</b>
                  </span>
                ))}
              </div>
            ) : (
              <div className="oc-hint-word-row">
                <span className="oc-hint-word empty">{t('game.hints.noRevealsYet')}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    )
  }

  const bg =
    'radial-gradient(1200px 680px at 50% -6%, rgba(160,190,255,0.14), rgba(0,0,0,0) 58%), radial-gradient(900px 520px at 84% 14%, rgba(255,105,105,0.12), rgba(0,0,0,0) 56%), radial-gradient(900px 520px at 12% 20%, rgba(100,145,255,0.16), rgba(0,0,0,0) 58%), linear-gradient(180deg, rgba(4,8,18,0.82), rgba(2,3,7,0.9) 72%), url("/assets/bg-room2.jpg") center / cover no-repeat'
  const panel = 'rgba(0,0,0,0.35)'
  const border = '1px solid rgba(255,255,255,0.10)'
  const navIcons = {
    home: '/assets/icons/nav/home.svg',
    profile: '/assets/icons/nav/profile.svg',
    copy: '/assets/icons/nav/copy.svg',
    backToLobby: '/assets/icons/nav/backToLobby.svg',
    rules: '/assets/icons/nav/rules.svg',
    exit: '/assets/icons/nav/exit.svg'
  } as const
  const helperIcons = {
    timeCut: '/assets/icons/helperAction/time.svg',
    randomPeek: '/assets/icons/helperAction/peek.svg',
    shuffle: '/assets/icons/helperAction/shuffle.svg'
  } as const
  const diceFacesByOption: Record<DiceOption, string> = {
    double_hint: '/assets/dice/dice-1.svg',
    sabotage_reassign: '/assets/dice/dice-2.svg',
    steal_reassign: '/assets/dice/dice-3.svg',
    shield: '/assets/dice/dice-4.svg',
    cancel: '/assets/dice/dice-5.svg',
    swap: '/assets/dice/dice-6.svg'
  }

  function cardBg(c: GameCard, hidden?: CardColor): string {
    if (c.revealed && c.revealed_color) {
      if (c.revealed_color === 'blue') return 'linear-gradient(180deg, rgba(40,100,215,0.92), rgba(18,46,114,0.98))'
      if (c.revealed_color === 'red') return 'linear-gradient(180deg, rgba(196,52,70,0.94), rgba(104,20,30,0.98))'
      if (c.revealed_color === 'assassin') return 'linear-gradient(180deg, rgba(26,28,34,0.98), rgba(8,9,12,1))'
      return 'linear-gradient(180deg, rgba(205,212,224,0.98), rgba(148,158,176,0.98))'
    }
    if (hidden) {
      if (hidden === 'blue') return 'linear-gradient(180deg, rgba(56,112,226,0.54), rgba(22,42,96,0.92))'
      if (hidden === 'red') return 'linear-gradient(180deg, rgba(214,62,82,0.5), rgba(98,24,34,0.92))'
      if (hidden === 'assassin') return 'linear-gradient(180deg, rgba(56,58,66,0.66), rgba(14,16,20,0.96))'
      return 'linear-gradient(180deg, rgba(182,168,142,0.6), rgba(116,106,90,0.94))'
    }
    return 'linear-gradient(180deg, rgba(196,178,144,0.56), rgba(122,108,86,0.94))'
  }

  function fxClassFor(pos: number): string {
    const tone = revealFxByPos[pos]
    if (!tone) return ''
    if (tone === 'assassin') return 'oc-card-fx-assassin'
    if (tone === 'correct') return 'oc-card-fx-correct'
    return 'oc-card-fx-incorrect'
  }

  return (
    <div className="oc-root" style={{ minHeight: '100vh', background: bg, color: '#fff', display: 'grid', placeItems: 'center', padding: 18 }}>
      <style>{`
        .oc-root{
          font-family: "Manrope", "Tajawal", "Avenir Next", "Segoe UI", "Noto Sans Arabic", sans-serif;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          text-rendering: optimizeLegibility;
          --oc-metal-1: rgba(255,255,255,0.09);
          --oc-metal-2: rgba(255,255,255,0.03);
          --oc-stroke: rgba(255,255,255,0.16);
          --oc-gold: rgba(255,212,118,0.9);
        }
        .oc-stage{
          isolation:isolate;
          background: transparent !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          box-shadow: none !important;
        }
        .oc-stage::before{
          display: none;
        }
        .oc-turn-indicator{
          height: 42px;
          min-width: 186px;
          border-radius: 999px;
          padding: 0 14px;
          display: flex;
          align-items: center;
          gap: 10px;
          border: 1px solid rgba(255,255,255,0.22);
          color: rgba(255,255,255,0.97);
          font-weight: 950;
          text-transform: uppercase;
          letter-spacing: .04em;
          box-shadow: 0 14px 28px rgba(0,0,0,0.44), inset 0 0 0 1px rgba(255,255,255,0.10);
          animation: oc-turn-pulse 1.6s ease-in-out infinite;
        }
        .oc-turn-dot{
          width: 10px;
          height: 10px;
          border-radius: 999px;
          background: currentColor;
          box-shadow: 0 0 12px currentColor;
        }
        .oc-turn-sub{
          font-size: 11px;
          font-weight: 850;
          opacity: 0.88;
        }
        .oc-turn-indicator.red{
          background: linear-gradient(180deg, rgba(255,105,105,0.36), rgba(70,20,20,0.82));
          border-color: rgba(255,145,145,0.52);
          color: rgba(255,226,226,0.98);
        }
        .oc-turn-indicator.blue{
          background: linear-gradient(180deg, rgba(105,130,255,0.38), rgba(20,30,85,0.84));
          border-color: rgba(165,190,255,0.52);
          color: rgba(225,235,255,0.98);
        }
        .oc-turn-indicator.idle{
          background: linear-gradient(180deg, rgba(225,225,225,0.20), rgba(40,40,46,0.82));
          border-color: rgba(255,255,255,0.36);
          color: rgba(242,244,255,0.95);
        }
        .oc-turn-indicator.done{
          background: linear-gradient(180deg, rgba(255,220,125,0.30), rgba(58,44,12,0.82));
          border-color: rgba(255,230,165,0.56);
          color: rgba(255,242,198,0.98);
          animation: none;
        }
        .oc-hud-row{
          position: relative;
          z-index: 2;
          display: grid;
          grid-template-columns: auto auto auto auto auto;
          justify-content: center;
          align-items: center;
          gap: 12px;
          padding: 6px 0 14px;
        }
        .oc-hud-dice-btn{
          width: 68px;
          height: 68px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.24);
          background: linear-gradient(180deg, rgba(180,130,255,0.22), rgba(28,18,52,0.72));
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.42), 0 14px 28px rgba(0,0,0,0.46);
          display:grid;
          place-items:center;
          cursor:pointer;
          transition: background .25s ease, box-shadow .25s ease, border-color .25s ease, opacity .2s ease;
        }
        .oc-hud-dice-btn:disabled{
          opacity:.52;
          cursor:default;
        }
        .oc-hud-dice-btn img{
          width: 38px;
          height: 38px;
          object-fit: contain;
        }
        .oc-hud-helpers{
          display:flex;
          gap:8px;
          align-items:center;
          justify-content:flex-start;
        }
        .oc-hud-helper-btn{
          width: 56px;
          height: 56px;
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,0.24);
          background: linear-gradient(180deg, rgba(255,255,255,0.14), rgba(0,0,0,0.36));
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.42), 0 12px 26px rgba(0,0,0,0.42);
          display:grid;
          place-items:center;
          cursor:pointer;
        }
        .oc-hud-helper-btn:disabled{
          opacity:.5;
          cursor:default;
        }
        .oc-hud-helper-btn img{
          width:30px;
          height:30px;
          object-fit:contain;
        }
        .oc-hud-turn-row{
          position: relative;
          z-index: 2;
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 10px;
          padding-bottom: 12px;
        }
        .oc-hud-turn-clue{
          min-height: 42px;
          min-width: 160px;
          border-radius: 999px;
          padding: 0 14px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border: 1px solid rgba(255,255,255,0.22);
          box-shadow: 0 14px 28px rgba(0,0,0,0.44), inset 0 0 0 1px rgba(255,255,255,0.10);
          text-transform: uppercase;
          letter-spacing: .03em;
          font-weight: 950;
        }
        .oc-hud-turn-clue-label{
          font-size: 10px;
          opacity: .84;
          font-weight: 900;
        }
        .oc-hud-turn-clue-word{
          font-size: 13px;
          font-weight: 1000;
        }
        .oc-hud-turn-clue.red{
          background: linear-gradient(180deg, rgba(255,105,105,0.36), rgba(70,20,20,0.82));
          border-color: rgba(255,145,145,0.52);
          color: rgba(255,226,226,0.98);
        }
        .oc-hud-turn-clue.blue{
          background: linear-gradient(180deg, rgba(105,130,255,0.38), rgba(20,30,85,0.84));
          border-color: rgba(165,190,255,0.52);
          color: rgba(225,235,255,0.98);
        }
        .oc-hud-turn-clue.idle{
          background: linear-gradient(180deg, rgba(225,225,225,0.20), rgba(40,40,46,0.82));
          border-color: rgba(255,255,255,0.36);
          color: rgba(242,244,255,0.95);
        }
        .oc-hud-turn-clue.done{
          background: linear-gradient(180deg, rgba(255,220,125,0.30), rgba(58,44,12,0.82));
          border-color: rgba(255,230,165,0.56);
          color: rgba(255,242,198,0.98);
        }
        .oc-hud-turn-task{
          min-height: 42px;
          min-width: 220px;
          border-radius: 999px;
          padding: 0 14px;
          display: inline-flex;
          align-items: center;
          border: 1px solid rgba(255,255,255,0.22);
          box-shadow: 0 14px 28px rgba(0,0,0,0.44), inset 0 0 0 1px rgba(255,255,255,0.10);
          text-transform: uppercase;
          letter-spacing: .03em;
          font-weight: 900;
          font-size: 12px;
          line-height: 1;
          white-space: nowrap;
        }
        .oc-hud-turn-task.red{
          background: linear-gradient(180deg, rgba(255,105,105,0.36), rgba(70,20,20,0.82));
          border-color: rgba(255,145,145,0.52);
          color: rgba(255,226,226,0.98);
        }
        .oc-hud-turn-task.blue{
          background: linear-gradient(180deg, rgba(105,130,255,0.38), rgba(20,30,85,0.84));
          border-color: rgba(165,190,255,0.52);
          color: rgba(225,235,255,0.98);
        }
        .oc-hud-turn-task.idle{
          background: linear-gradient(180deg, rgba(225,225,225,0.20), rgba(40,40,46,0.82));
          border-color: rgba(255,255,255,0.36);
          color: rgba(242,244,255,0.95);
        }
        .oc-hud-turn-task.done{
          background: linear-gradient(180deg, rgba(255,220,125,0.30), rgba(58,44,12,0.82));
          border-color: rgba(255,230,165,0.56);
          color: rgba(255,242,198,0.98);
        }
        .oc-score-node{
          min-width: 64px;
          height: 52px;
          border-radius: 12px;
          display: grid;
          place-items: center;
          font-size: 34px;
          font-weight: 1000;
          border: 1px solid var(--oc-stroke);
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4), 0 12px 26px rgba(0,0,0,0.45);
          position: relative;
          overflow: hidden;
        }
        .oc-score-node::after{
          content:'';
          position:absolute;
          inset:0;
          background: linear-gradient(120deg, rgba(255,255,255,0.14), transparent 34%, transparent 66%, rgba(255,255,255,0.08));
          pointer-events:none;
        }
        .oc-score-node.blue{
          color: rgba(198,224,255,0.98);
          border-color: rgba(120,170,255,0.54);
          background: linear-gradient(180deg, rgba(74,116,255,0.45), rgba(14,28,80,0.9));
        }
        .oc-score-node.red{
          color: rgba(255,218,218,0.98);
          border-color: rgba(255,140,140,0.56);
          background: linear-gradient(180deg, rgba(255,86,86,0.46), rgba(80,14,14,0.9));
        }
        .oc-mid-hud{
          min-width: 180px;
          border-radius: 14px;
          border: 1px solid rgba(255,235,180,0.44);
          background: linear-gradient(180deg, rgba(255,219,140,0.16), rgba(0,0,0,0.45));
          padding: 7px 12px;
          display: grid;
          gap: 4px;
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.42), 0 14px 30px rgba(0,0,0,0.45);
        }
        .oc-mid-hud-title{
          font-size: 11px;
          font-weight: 900;
          text-transform: uppercase;
          opacity: 0.86;
          letter-spacing: 0.06em;
          text-align: center;
        }
        .oc-mid-hud-bottom{
          display:flex;
          align-items:center;
          justify-content:center;
          gap:8px;
        }
        .oc-mid-pill{
          min-width: 34px;
          height: 24px;
          border-radius: 999px;
          display:grid;
          place-items:center;
          border: 1px solid rgba(255,255,255,0.2);
          background: rgba(255,255,255,0.12);
          font-size: 12px;
          font-weight: 1000;
        }
        .oc-mid-time{
          padding: 2px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255,225,160,0.5);
          background: rgba(20,12,2,0.55);
          color: rgba(255,232,178,0.98);
          font-weight: 1000;
          font-size: 22px;
          line-height: 1.1;
          letter-spacing: 0.04em;
        }
        .oc-nav-btn{
          display:inline-flex;
          align-items:center;
          gap:8px;
        }
        .oc-top-actions{
          display:flex;
          gap:6px;
          align-items:center;
          flex-wrap:wrap;
          margin-bottom:10px;
          padding:4px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,0.08);
          background:rgba(255,255,255,0.02);
        }
        .oc-top-actions .oc-nav-btn{
          padding: 7px 10px !important;
          border-radius: 999px !important;
          border: 1px solid rgba(255,255,255,0.12) !important;
          background: rgba(255,255,255,0.045) !important;
          color: rgba(255,255,255,0.86) !important;
          font-weight: 760 !important;
          font-size: 13px !important;
          line-height: 1 !important;
          cursor: pointer;
          transition: background .18s ease, border-color .18s ease, color .18s ease, opacity .18s ease;
        }
        .oc-top-actions .oc-nav-btn:hover{
          background: rgba(255,255,255,0.08) !important;
          border-color: rgba(255,255,255,0.18) !important;
          color: rgba(255,255,255,0.96) !important;
        }
        .oc-top-actions .oc-nav-btn:disabled{
          opacity: .58 !important;
          cursor: default;
        }
        .oc-top-actions .oc-nav-btn.is-accent{
          background: rgba(180,235,255,0.07) !important;
          border-color: rgba(170,255,255,0.22) !important;
        }
        .oc-top-actions .oc-nav-btn.is-danger{
          background: rgba(255,90,90,0.07) !important;
          border-color: rgba(255,120,120,0.24) !important;
          color: rgba(255,240,240,0.9) !important;
        }
        .oc-top-actions .oc-nav-btn.is-danger:hover{
          background: rgba(255,90,90,0.11) !important;
          border-color: rgba(255,120,120,0.34) !important;
        }
        .oc-top-actions .oc-nav-icon{
          width:13px;
          height:13px;
          opacity:.84;
        }
        .oc-nav-icon{
          width:14px;
          height:14px;
          object-fit:contain;
          opacity:.96;
          filter: brightness(0) invert(1);
        }
        .oc-nav-icon-original{
          filter: none;
        }
        .oc-hint-stack{
          display:grid;
          gap:8px;
        }
        .oc-hint-entry{
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.18);
          background: rgba(8,10,18,0.55);
          padding: 8px;
          display:grid;
          gap: 7px;
        }
        .oc-hint-entry.red{
          border-color: rgba(255,120,120,0.36);
          background: linear-gradient(180deg, rgba(255,95,95,0.14), rgba(8,10,18,0.52));
        }
        .oc-hint-entry.blue{
          border-color: rgba(120,165,255,0.38);
          background: linear-gradient(180deg, rgba(95,145,255,0.16), rgba(8,10,18,0.52));
        }
        .oc-hint-head{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:8px;
        }
        .oc-hint-clue{
          display:inline-flex;
          align-items:center;
          max-width:100%;
          min-width:0;
          padding: 5px 9px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.2);
          background: rgba(255,255,255,0.08);
          font-weight: 900;
          font-size: 12px;
          letter-spacing: .02em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .oc-hint-num{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-width: 26px;
          height: 26px;
          padding: 0 8px;
          border-radius: 999px;
          border: 1px solid rgba(255,225,150,0.45);
          background: rgba(255,205,110,0.18);
          color: rgba(255,240,200,0.98);
          font-size: 12px;
          font-weight: 1000;
        }
        .oc-hint-word-row{
          display:flex;
          flex-wrap:wrap;
          gap:6px;
        }
        .oc-hint-word{
          display:inline-flex;
          align-items:center;
          gap:6px;
          padding: 4px 8px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.18);
          background: rgba(255,255,255,0.08);
          font-size: 11px;
          font-weight: 850;
          line-height: 1;
        }
        .oc-hint-word.ok{
          border-color: rgba(120,255,175,0.38);
          background: rgba(95,230,155,0.2);
          color: rgba(225,255,236,0.98);
        }
        .oc-hint-word.bad{
          border-color: rgba(255,145,145,0.38);
          background: rgba(255,95,95,0.2);
          color: rgba(255,230,230,0.98);
        }
        .oc-hint-word.empty{
          border-color: rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.05);
          color: rgba(230,236,255,0.76);
          font-weight: 760;
        }
        .oc-hint-empty-pill{
          display:inline-flex;
          align-items:center;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.05);
          font-size: 12px;
          color: rgba(235,240,255,0.72);
          width: fit-content;
        }

        .oc-card{
          transform-origin: 50% 62%;
          position: relative;
          overflow: hidden;
        }
        .oc-card::before{
          content:'';
          position:absolute;
          inset:0;
          pointer-events:none;
          background: linear-gradient(140deg, rgba(255,255,255,0.18), transparent 34%, transparent 72%, rgba(255,255,255,0.08));
          opacity: 0.42;
        }
        .oc-card::after{
          content:'';
          position:absolute;
          inset:2px;
          border-radius: 13px;
          pointer-events:none;
          border: 1px solid rgba(255,255,255,0.2);
          opacity: 0.45;
        }
        .oc-card-shell{
          position: relative;
        }
        .oc-card-shell.oc-last10{
          animation: oc-last10-shake 0.24s ease-in-out infinite;
        }
        .oc-card.oc-card-interactive:hover{
          animation: oc-suspense-hover 0.55s ease forwards;
        }
        .oc-card.oc-card-pending{
          animation: oc-suspense-breathe 0.5s cubic-bezier(.2,.75,.2,1) forwards;
        }
        .oc-card.oc-card-peek{
          box-shadow: 0 0 30px rgba(255,225,120,0.42), 0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 2px rgba(255,225,120,0.65);
          filter: saturate(1.2) brightness(1.12);
        }
        .oc-card.oc-card-marked{
          box-shadow: 0 0 0 2px rgba(255,210,120,0.42), 0 0 28px rgba(255,210,120,0.24), 0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.50);
          animation: oc-mark-pulse 1s ease-in-out infinite;
        }
        .oc-card.oc-card-spymaster-crossed{
          opacity: 0.78;
        }
        .oc-card.oc-card-spymaster-crossed::before,
        .oc-card.oc-card-spymaster-crossed::after{
          content: '';
          position: absolute;
          left: 10%;
          right: 10%;
          top: 50%;
          height: 2px;
          border-radius: 999px;
          background: rgba(255,245,210,0.78);
          box-shadow: 0 0 10px rgba(0,0,0,0.45);
          pointer-events: none;
          z-index: 3;
        }
        .oc-card.oc-card-spymaster-crossed::before{
          transform: rotate(20deg);
        }
        .oc-card.oc-card-spymaster-crossed::after{
          transform: rotate(-20deg);
        }

        .oc-card-fx-correct{
          animation: oc-impact-team 1.2s cubic-bezier(.2,.78,.2,1);
        }
        .oc-card-fx-incorrect{
          animation: oc-impact-enemy 1s cubic-bezier(.36,.07,.19,.97);
        }
        .oc-card-fx-assassin{
          animation: oc-impact-assassin 1.25s cubic-bezier(.2,.78,.2,1);
        }

        .oc-card .oc-word{
          transition: letter-spacing .28s ease, transform .28s ease;
          text-shadow: 0 1px 0 rgba(0,0,0,0.5), 0 0 8px rgba(0,0,0,0.22);
        }
        .oc-card.oc-card-interactive:hover .oc-word{
          letter-spacing: 1.2px;
          transform: scale(1.03);
        }

        @keyframes oc-ambient-swirl{
          0%{ transform: translate3d(-2%, -1%, 0) scale(1); opacity:.62; }
          100%{ transform: translate3d(2.5%, 2%, 0) scale(1.08); opacity:.94; }
        }
        @keyframes oc-last10-shake{
          0%{ transform: translate(0, 0) rotate(0deg); }
          25%{ transform: translate(-1px, 1px) rotate(-0.45deg); }
          50%{ transform: translate(1px, -1px) rotate(0.45deg); }
          75%{ transform: translate(-1px, -1px) rotate(-0.35deg); }
          100%{ transform: translate(0, 0) rotate(0deg); }
        }
        @keyframes oc-turn-pulse{
          0%{ transform: translateY(0); filter: brightness(1); }
          50%{ transform: translateY(-1px); filter: brightness(1.12); }
          100%{ transform: translateY(0); filter: brightness(1); }
        }
        @keyframes oc-suspense-breathe{
          0%{ transform: translateY(0) scale(1); filter: brightness(1); }
          34%{ transform: translateY(-2px) scale(1.018); filter: brightness(1.08); }
          70%{ transform: translateY(1px) scale(1.01); filter: brightness(1.03); }
          100%{ transform: translateY(0) scale(1); filter: brightness(1); }
        }
        @keyframes oc-suspense-hover{
          0%{ transform: translateY(0) scale(1); filter: brightness(1); }
          45%{ transform: translateY(-3px) scale(1.03); filter: brightness(1.18); }
          100%{ transform: translateY(-1px) scale(1.02); filter: brightness(1.1); }
        }
        @keyframes oc-impact-team{
          0%{ transform: scale(1); filter: brightness(1); }
          28%{ transform: scale(1.09); filter: brightness(1.28); }
          58%{ transform: scale(.97); filter: brightness(.96); }
          100%{ transform: scale(1); filter: brightness(1); }
        }
        @keyframes oc-impact-enemy{
          0%{ transform: translateX(0); filter: brightness(1); }
          20%{ transform: translateX(-8px); filter: brightness(1.16); }
          40%{ transform: translateX(8px); }
          60%{ transform: translateX(-6px); }
          80%{ transform: translateX(5px); }
          100%{ transform: translateX(0); filter: brightness(1); }
        }
        @keyframes oc-impact-assassin{
          0%{ transform: scale(1); filter: brightness(1); box-shadow: 0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.50); }
          22%{ transform: scale(1.11); filter: brightness(1.45); box-shadow: 0 0 46px rgba(255,196,96,0.35), 0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.50); }
          52%{ transform: scale(.95); filter: brightness(.86); }
          78%{ transform: scale(1.04); filter: brightness(1.18); }
          100%{ transform: scale(1); filter: brightness(1); box-shadow: 0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.50); }
        }
        @keyframes oc-mark-pulse{
          0%{ filter: brightness(1); }
          50%{ filter: brightness(1.12); }
          100%{ filter: brightness(1); }
        }

        .oc-center-notice{
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          z-index: 9;
          pointer-events: none;
          padding: 18px 24px;
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.20);
          background: linear-gradient(180deg, rgba(0,0,0,0.84), rgba(0,0,0,0.68));
          color: rgba(255,255,255,0.96);
          font-weight: 1000;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          box-shadow: 0 26px 60px rgba(0,0,0,0.64);
          animation: oc-notice-in .42s cubic-bezier(.2,.78,.2,1), oc-notice-pulse .9s ease-in-out;
          white-space: nowrap;
        }
        .oc-center-notice.turn{
          border-color: rgba(170,255,255,0.44);
          box-shadow: 0 0 30px rgba(90,170,255,0.28), 0 26px 60px rgba(0,0,0,0.64);
        }
        .oc-center-notice.win{
          border-color: rgba(255,216,120,0.55);
          box-shadow: 0 0 38px rgba(255,216,120,0.35), 0 26px 60px rgba(0,0,0,0.64);
        }
        @keyframes oc-notice-in{
          0%{ opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
          100%{ opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes oc-notice-pulse{
          0%{ filter: brightness(1); }
          50%{ filter: brightness(1.2); }
          100%{ filter: brightness(1); }
        }
        .oc-win-overlay{
          position:absolute;
          inset:0;
          z-index:8;
          display:grid;
          place-items:center;
          background: rgba(0,0,0,0.36);
          pointer-events:auto;
        }
        .oc-win-card{
          min-width: min(560px, 92vw);
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.18);
          background: linear-gradient(180deg, rgba(0,0,0,0.86), rgba(0,0,0,0.72));
          box-shadow: 0 30px 70px rgba(0,0,0,0.68);
          padding: 18px;
          display:grid;
          gap: 12px;
        }
        .oc-win-title{
          text-align:center;
          font-size: clamp(24px, 4vw, 42px);
          font-weight: 1000;
          letter-spacing: .06em;
          text-transform: uppercase;
          animation: oc-win-float 2.2s ease-in-out infinite;
        }
        @keyframes oc-win-float{
          0%{ transform: translateY(0px); filter: brightness(1); }
          50%{ transform: translateY(-8px); filter: brightness(1.18); }
          100%{ transform: translateY(0px); filter: brightness(1); }
        }
        .oc-game-layout{
          display:grid;
          grid-template-columns: 240px minmax(0, 1fr) 240px;
          gap: 14px;
          align-items: start;
        }
        .oc-center-stack{
          display:grid;
          gap:12px;
        }
        .oc-utility-row{
          display:grid;
          grid-template-columns: 1fr;
          gap: 10px;
          position: static;
          width: auto;
          z-index: auto;
          order: 4;
          margin-top: 10px;
        }
        .oc-utility-row > div{
          padding: 8px !important;
          border-radius: 12px !important;
        }
        .oc-utility-row button{
          padding: 6px 8px !important;
          border-radius: 10px !important;
          font-size: 11px !important;
        }
        .oc-utility-row .oc-nav-icon{
          width: 12px;
          height: 12px;
        }
        .oc-cards-grid{
          display:grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 10px;
          order: 3;
          padding: 10px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.14);
          background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(0,0,0,0.36));
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.42);
        }
        .oc-team-panel{
          border-radius: 18px;
          padding: 12px;
          border: 1px solid rgba(255,255,255,0.2);
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.5), 0 16px 36px rgba(0,0,0,0.52);
        }
        .oc-team-panel.red{
          border-color: rgba(255,118,118,0.42);
          background: linear-gradient(180deg, rgba(255,95,95,0.2), rgba(12,2,2,0.36));
        }
        .oc-team-panel.blue{
          border-color: rgba(112,162,255,0.46);
          background: linear-gradient(180deg, rgba(90,140,255,0.22), rgba(3,6,15,0.38));
        }
        .oc-team-panel.turn-active{
          border-color: rgba(255,214,110,0.95) !important;
          box-shadow:
            inset 0 0 0 1px rgba(0,0,0,0.42),
            0 0 0 1px rgba(255,214,110,0.45),
            0 14px 34px rgba(0,0,0,0.45),
            0 0 28px rgba(255,208,90,0.26);
        }
        .oc-team-panel.turn-dim{
          filter: saturate(0.78) brightness(0.82);
          opacity: 0.88;
        }
        .oc-side-tools{
          display:grid;
          gap:10px;
          align-content:start;
          position: sticky;
          top: 10px;
        }
        .oc-tool-card{
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(0,0,0,0.34);
          padding: 8px;
          display:grid;
          gap:8px;
        }
        .oc-tool-title{
          font-size: 11px;
          font-weight: 900;
          opacity: 0.9;
          letter-spacing: .02em;
          text-transform: uppercase;
        }
        .oc-tool-meta{
          font-size: 10px;
          font-weight: 800;
          opacity: 0.76;
        }
        .oc-tool-btn{
          padding: 7px 8px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.16);
          background: rgba(255,255,255,0.06);
          color: #fff;
          font-size: 11px;
          font-weight: 900;
          cursor: pointer;
          display:inline-flex;
          align-items:center;
          gap:6px;
          justify-content:flex-start;
        }
        .oc-tool-btn .oc-nav-icon{
          width: 12px;
          height: 12px;
        }
        .oc-member{
          border-radius: 12px;
          padding: 10px;
          border: 1px solid rgba(255,255,255,0.18);
          background:
            linear-gradient(140deg, rgba(140,240,255,0.10), transparent 44%),
            linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,0.34));
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.48), 0 12px 24px rgba(0,0,0,0.34);
          display: grid;
          gap: 8px;
          position: relative;
          overflow: hidden;
        }
        .oc-member::after{
          content:'';
          position:absolute;
          inset:0;
          pointer-events:none;
          background: linear-gradient(120deg, rgba(255,255,255,0.12), transparent 26%, transparent 74%, rgba(255,255,255,0.08));
          opacity:.32;
        }
        .oc-member-main{
          display:flex;
          align-items:center;
          gap:10px;
          min-width:0;
        }
        .oc-member-avatar-wrap{
          width:46px;
          height:46px;
          border-radius:12px;
          padding:2px;
          background: linear-gradient(135deg, rgba(120,255,255,0.82), rgba(120,120,255,0.30));
          box-shadow: 0 0 0 1px rgba(255,255,255,0.22), 0 8px 18px rgba(0,0,0,0.40);
          flex: 0 0 auto;
        }
        .oc-member-avatar{
          width:100%;
          height:100%;
          object-fit:cover;
          border-radius:10px;
          display:block;
          border:1px solid rgba(255,255,255,0.2);
          background: rgba(0,0,0,0.38);
        }
        .oc-member-meta{
          min-width:0;
          display:grid;
          gap:3px;
        }
        .oc-member-name{
          font-weight:900;
          white-space:nowrap;
          overflow:hidden;
          text-overflow:ellipsis;
        }
        .oc-member-role{
          font-size:12px;
          opacity:0.86;
        }
        @media (max-width: 1120px){
          .oc-utility-row{
            position: static;
            width: auto;
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 1080px){
          .oc-hud-row{ gap: 8px; grid-template-columns: auto auto auto; }
          .oc-hud-helpers{
            grid-column: 1 / -1;
            justify-content: center;
          }
          .oc-hud-dice-btn{
            width: 58px;
            height: 58px;
          }
          .oc-hud-dice-btn img{
            width: 32px;
            height: 32px;
          }
          .oc-score-node{ min-width: 56px; height: 46px; font-size: 30px; }
          .oc-mid-hud{ min-width: 150px; }
          .oc-mid-time{ font-size: 18px; }
          .oc-game-layout{
            grid-template-columns: 1fr;
          }
          .oc-side-tools{
            position: static;
          }
        }
      `}</style>
      <div
        className="oc-stage"
        style={{
          width: 'min(1380px, 100%)',
          borderRadius: 26,
          border,
          background: 'transparent',
          boxShadow: 'none',
          padding: 16,
          position: 'relative',
          overflow: 'hidden'
        }}
      >
        <div style={{ position: 'absolute', inset: 10, borderRadius: 18, border: '1px solid rgba(255,255,255,0.06)', pointerEvents: 'none' }} />

        {/* top counters */}
        <div className="oc-hud-row">
          <button
            className="oc-hud-dice-btn"
            aria-label={t('game.dice.roll')}
            title={
              diceUnlocked
                ? diceUsed
                  ? t('game.dice.usedTurn')
                  : t('game.dice.roll')
                : t('game.dice.streakProgress', { streak: myStreak, target: diceUnlockStreak })
            }
            disabled={!isGameActive || !diceUnlocked || diceUsed || busy !== null || dicePicker !== null}
            onClick={handleRollDice}
            style={{
              background: `linear-gradient(0deg, rgba(255,208,104,0.98) 0%, rgba(255,208,104,0.98) ${diceFillPercent}%, rgba(28,18,52,0.78) ${diceFillPercent}%, rgba(28,18,52,0.78) 100%)`,
              borderColor: diceUnlocked ? 'rgba(255,230,145,0.94)' : 'rgba(255,255,255,0.24)',
              boxShadow: diceUnlocked
                ? 'inset 0 0 0 1px rgba(72,38,0,0.38), 0 0 0 1px rgba(255,221,120,0.45), 0 14px 30px rgba(0,0,0,0.48)'
                : 'inset 0 0 0 1px rgba(0,0,0,0.42), 0 14px 28px rgba(0,0,0,0.46)'
            }}
          >
            <img src="/assets/icons/dice.svg" alt="" aria-hidden="true" />
          </button>
          <div className="oc-score-node red" title={t('game.counters.redRemaining')}>
            {redLeft}
          </div>

          <div className="oc-mid-hud" title={t('game.counters.guessesTimer')}>
            <div className="oc-mid-hud-title">{t('game.counters.guessesTimer')}</div>
            <div className="oc-mid-hud-bottom">
              <div className="oc-mid-pill">{pillCount}</div>
              <div className="oc-mid-time">{timerSettings.useTurnTimer ? formatMMSS(turnLeft) : 'OFF'}</div>
            </div>
          </div>
          <div className="oc-score-node blue" title={t('game.counters.blueRemaining')}>
            {blueLeft}
          </div>
          <div className="oc-hud-helpers">
            <button
              className="oc-hud-helper-btn"
              disabled={!isGameActive || busy !== null}
              onClick={() => runHelper('time_cut')}
              title={t('game.helper.timeCut')}
              aria-label={t('game.helper.timeCut')}
            >
              <img className="oc-nav-icon-original" src={helperIcons.timeCut} alt="" aria-hidden="true" />
            </button>
            <button
              className="oc-hud-helper-btn"
              disabled={!isGameActive || busy !== null}
              onClick={() => runHelper('random_peek')}
              title={t('game.helper.randomPeek')}
              aria-label={t('game.helper.randomPeek')}
            >
              <img className="oc-nav-icon-original" src={helperIcons.randomPeek} alt="" aria-hidden="true" />
            </button>
            <button
              className="oc-hud-helper-btn"
              disabled={!isGameActive || busy !== null}
              onClick={() => runHelper('shuffle_unrevealed')}
              title={t('game.helper.cardShuffle')}
              aria-label={t('game.helper.cardShuffle')}
            >
              <img className="oc-nav-icon-original" src={helperIcons.shuffle} alt="" aria-hidden="true" />
            </button>
          </div>
        </div>
        {rolledDiceOption && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '8px 10px',
              margin: '4px 0 8px',
              width: 'min(680px, 100%)',
              borderRadius: 12,
              border: '1px solid rgba(255,220,120,0.38)',
              background: 'rgba(26,18,8,0.78)',
              boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
              position: 'relative',
              zIndex: 3
            }}
            aria-live="polite"
          >
            <img
              src={diceOptionImage(rolledDiceOption)}
              alt={diceOptionLabel(rolledDiceOption)}
              style={{
                width: 42,
                height: 42,
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.18)',
                background: 'rgba(0,0,0,0.35)',
                objectFit: 'contain'
              }}
            />
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ fontWeight: 900, fontSize: 13, color: 'rgba(255,242,210,0.98)' }}>
                {t('game.dice.lastRoll', { option: diceOptionLabel(rolledDiceOption) })}
              </div>
              <div style={{ fontSize: 12, color: 'rgba(255,242,210,0.88)', lineHeight: 1.35 }}>
                {diceOptionEffectText(rolledDiceOption)}
              </div>
              <div style={{ fontSize: 12, color: 'rgba(255,232,170,0.95)', lineHeight: 1.35, fontWeight: 800 }}>
                {diceOptionNextStepText(rolledDiceOption)}
              </div>
            </div>
          </div>
        )}
        <div className="oc-hud-turn-row">
          {turnClueWord ? (
            <div className={`oc-hud-turn-clue ${turnClueClass}`} title={t('game.header.clue')}>
              <span className="oc-hud-turn-clue-label">{t('game.header.clue')}</span>
              <span className="oc-hud-turn-clue-word">{turnClueWord}</span>
            </div>
          ) : null}
          <div className={`oc-turn-indicator ${turnIndicatorClass}`} title="Current turn">
            <span className="oc-turn-dot" />
            <span>{turnIndicatorLabel}</span>
            {isGameActive && isMyTurn ? <span className="oc-turn-sub">{t('game.turn.yourTurn')}</span> : null}
          </div>
          <div className={`oc-hud-turn-task ${turnTaskClass}`} title={turnTaskText}>
            <span>{turnTaskText}</span>
          </div>
        </div>

        <div style={{ position: 'relative', zIndex: 2, padding: '0 10px 10px' }}>
          {state === 'loading' && <div style={{ padding: 12 }}>{t('game.loading')}</div>}
          {state === 'error' && (
            <div style={{ padding: 12, borderRadius: 14, border: '1px solid rgba(255,90,90,0.45)', background: panel }}>
              {t('game.error')}: {error}
            </div>
          )}

          {state === 'ready' && game && (
            <>
              <div className="oc-top-actions">
                <button className="oc-nav-btn" onClick={handleHome} disabled={busy !== null}>
                  <img className="oc-nav-icon" src={navIcons.home} alt="" aria-hidden="true" />
                  {t('game.nav.home')}
                </button>
                <button className="oc-nav-btn" onClick={handleProfile} disabled={busy !== null}>
                  <img className="oc-nav-icon" src={navIcons.profile} alt="" aria-hidden="true" />
                  {t('game.nav.profile')}
                </button>
                <button className="oc-nav-btn" onClick={handleCopyLobbyCode} disabled={busy !== null}>
                  <img className="oc-nav-icon" src={navIcons.copy} alt="" aria-hidden="true" />
                  {t('game.nav.copyLobbyCode')}
                </button>
                <button className="oc-nav-btn" onClick={handleBackToLobby} disabled={busy !== null}>
                  <img className="oc-nav-icon" src={navIcons.backToLobby} alt="" aria-hidden="true" />
                  {t('game.nav.backToLobby')}
                </button>
                <button className="oc-nav-btn is-accent" onClick={() => setShowRules((v) => !v)} disabled={busy !== null}>
                  <img className="oc-nav-icon" src={navIcons.rules} alt="" aria-hidden="true" />
                  {t('game.nav.helpRules')}
                </button>
                <button className="oc-nav-btn is-danger" onClick={handleExitGame} disabled={busy !== null}>
                  <img className="oc-nav-icon" src={navIcons.exit} alt="" aria-hidden="true" />
                  {t('game.nav.exitGame')}
                </button>
              </div>

              {/* header */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div />

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  {amSpymaster && (
                    <div style={{ padding: '8px 10px', borderRadius: 999, border, background: panel, fontWeight: 900, opacity: 0.9 }}>
                      {t('game.header.keyAutoVisible')}
                    </div>
                  )}

                  {canEndTurnOperate && (
                    <button onClick={handleEndTurn} disabled={busy !== null} style={{ padding: '10px 14px', borderRadius: 999, border, background: 'rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.95)', fontWeight: 900, cursor: 'pointer' }}>
                      {t('game.actions.endTurn')}
                    </button>
                  )}

                  {amOwner && (
                    <button onClick={handleRestart} disabled={busy !== null} style={{ padding: '10px 14px', borderRadius: 999, border: '1px solid rgba(170,255,255,0.35)', background: 'rgba(200,255,255,0.10)', color: 'rgba(255,255,255,0.95)', fontWeight: 900, cursor: 'pointer' }}>
                      {t('game.actions.restart')}
                    </button>
                  )}
                </div>
              </div>

              {/* layout */}
              <div className="oc-game-layout">
                <div className={`oc-team-panel red ${currentTurnTeam === 'red' ? 'turn-active' : currentTurnTeam === 'blue' ? 'turn-dim' : ''}`}>
                  <div style={{ fontWeight: 1000, marginBottom: 10, color: 'rgba(255,220,220,0.98)' }}>{t('game.team.redTeam')}</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {redTeam.length === 0 ? (
                      <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>{t('game.team.noPlayers')}</div>
                    ) : (
                      redTeam.map((m, idx) => {
                        const you = m.user_id === myUserId
                        const name = memberDisplayName(m.user_id, idx)
                        const avatarSrc = memberAvatar(m.user_id, m.team)
                        const fallbackAvatar = fallbackAvatarFor(m.team, `${m.user_id}:fallback`)
                        return (
                          <div key={`red-${m.user_id}`} className="oc-member">
                            <div className="oc-member-main">
                              <div className="oc-member-avatar-wrap">
                                <img
                                  className="oc-member-avatar"
                                  src={avatarSrc}
                                  alt={`${name} avatar`}
                                  onError={(e) => {
                                    const img = e.currentTarget
                                    if (img.src.endsWith(fallbackAvatar)) return
                                    img.src = fallbackAvatar
                                  }}
                                />
                              </div>
                              <div className="oc-member-meta">
                                <div className="oc-member-name">{you ? t('game.member.youName', { name }) : name}</div>
                                <div className="oc-member-role">{roleLabel(m.is_spymaster)}</div>
                              </div>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
                    <div style={{ fontSize: 12, opacity: 0.78, fontWeight: 900, marginBottom: 6 }}>{t('game.hints.trail')}</div>
                    {renderHintTrail('red', 3, 'panel-red-')}
                  </div>
                </div>

                <div className="oc-center-stack">
                  {canSpymaster && (
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: 12, borderRadius: 18, border, background: panel }}>
                      <input
                        ref={clueWordInputRef}
                        value={clueWord}
                        onChange={(e) => setClueWord(e.target.value)}
                        onFocus={() => setIsEditingClue(true)}
                        onBlur={handleClueInputBlur}
                        placeholder={t('game.inputs.clueWord')}
                        style={{ flex: '1 1 220px', padding: '12px 12px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(0,0,0,0.35)', color: 'rgba(255,255,255,0.92)', fontWeight: 900, outline: 'none' }}
                      />
                      <input
                        ref={clueNumberInputRef}
                        type="number"
                        value={clueNumber}
                        onChange={(e) => setClueNumber(Number(e.target.value))}
                        onFocus={() => setIsEditingClue(true)}
                        onBlur={handleClueInputBlur}
                        min={0}
                        max={9}
                        style={{ width: 110, padding: '12px 12px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(0,0,0,0.35)', color: 'rgba(255,255,255,0.92)', fontWeight: 900, outline: 'none' }}
                      />
                      <button onClick={handleSetClue} disabled={busy !== null || clueWord.trim().length === 0} style={{ padding: '12px 16px', borderRadius: 14, border: '1px solid rgba(170,255,255,0.35)', background: 'rgba(200,255,255,0.10)', color: 'rgba(255,255,255,0.95)', fontWeight: 900, cursor: 'pointer' }}>
                        {t('game.actions.setClue')}
                      </button>
                    </div>
                  )}

                  <div className="oc-cards-grid">
                    {cards.map((c, idx) => {
                      const hidden = amSpymaster ? keyMap.get(c.pos) : undefined
                      const corner = hidden ? keyColorText(hidden) : null
                      const fxClass = fxClassFor(c.pos)
                      const pendingClass = pendingRevealPos === c.pos ? 'oc-card-pending' : ''
                      const peekClass = peekFlash?.pos === c.pos ? 'oc-card-peek' : ''
                      const interactiveClass = !c.revealed ? 'oc-card-interactive' : ''
                      const revealedClass = c.revealed ? 'oc-card-is-revealed' : ''
                      const spymasterCrossedClass = amSpymaster && c.revealed ? 'oc-card-spymaster-crossed' : ''
                      const mark = revealMarks[c.pos]
                      const markedClass = mark ? 'oc-card-marked' : ''
                      const markedByMe = Boolean(mark && mark.byUserId && myUserId && mark.byUserId === myUserId)
                      return (
                        <div key={c.pos} className={`oc-card-shell ${shouldShakeCards ? 'oc-last10' : ''}`} style={{ animationDelay: `${idx * 12}ms` }}>
                          <button
                            className={`oc-card ${interactiveClass} ${pendingClass} ${peekClass} ${revealedClass} ${spymasterCrossedClass} ${markedClass} ${fxClass}`.trim()}
                            onClick={(e) => {
                              const target = e.target as HTMLElement | null
                              if (target?.closest('[data-mark-remove="1"]')) return
                              void handleReveal(c.pos)
                            }}
                            disabled={busy !== null || pendingRevealPos !== null || c.revealed || !isGameActive}
                            style={{
                              position: 'relative',
                              width: '100%',
                              height: 116,
                              borderRadius: 16,
                              border: '1px solid rgba(255,255,255,0.10)',
                              background: cardBg(c, hidden),
                              boxShadow: '0 10px 26px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.50)',
                              color: c.revealed && c.revealed_color === 'neutral' ? 'rgba(8,10,14,0.95)' : 'rgba(240,244,255,0.92)',
                              cursor: c.revealed || pendingRevealPos !== null || !isGameActive ? 'not-allowed' : 'pointer',
                              overflow: 'hidden',
                              animationDelay: `${idx * 55}ms`
                            }}
                            title={c.word}
                          >
                            {mark && !c.revealed && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: 8,
                                  top: 8,
                                  padding: '3px 8px',
                                  borderRadius: 999,
                                  border: '1px solid rgba(255,210,110,0.72)',
                                  background: 'rgba(35,28,12,0.9)',
                                  color: 'rgba(255,222,125,0.98)',
                                  fontSize: 11,
                                  fontWeight: 900
                                }}
                              >
                                {markedByMe ? 'Click again' : 'Marked'}
                              </div>
                            )}
                            {mark && markedByMe && !c.revealed && (
                              <div
                                data-mark-remove="1"
                                role="button"
                                aria-label="Remove tag"
                                title="Remove tag"
                                onPointerDown={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                }}
                                onMouseDown={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                }}
                                onTouchStart={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                }}
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  clearRevealMark(c.pos)
                                }}
                                style={{
                                  position: 'absolute',
                                  left: 8,
                                  top: 34,
                                  width: 30,
                                  height: 30,
                                  borderRadius: 999,
                                  border: '1px solid rgba(255,170,170,0.72)',
                                  background: 'rgba(50,10,10,0.92)',
                                  color: 'rgba(255,225,225,0.99)',
                                  display: 'grid',
                                  placeItems: 'center',
                                  fontSize: 19,
                                  fontWeight: 1000,
                                  lineHeight: 1,
                                  cursor: 'pointer',
                                  padding: 0,
                                  zIndex: 3,
                                  userSelect: 'none'
                                }}
                              >
                                X
                              </div>
                            )}
                            {corner && (
                              <div style={{ position: 'absolute', right: 10, top: 10, width: 22, height: 22, borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 900, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(0,0,0,0.25)', opacity: 0.9 }}>
                                {corner}
                              </div>
                            )}
                            {peekFlash?.pos === c.pos && (
                              <div style={{ position: 'absolute', left: 8, top: 8, padding: '2px 6px', borderRadius: 8, border: '1px solid rgba(255,225,120,0.78)', background: 'rgba(255,225,120,0.24)', color: 'rgba(255,245,185,0.98)', fontSize: 11, fontWeight: 900 }}>
                                {peekFlash.color || t('game.peek')}
                              </div>
                            )}
                            <div className="oc-word" style={{ height: '100%', display: 'grid', placeItems: 'center', padding: '0 10px', textAlign: 'center', fontWeight: 900, letterSpacing: 0.3, textTransform: 'uppercase', opacity: c.revealed ? 0.85 : 0.95 }}>
                              {c.word}
                            </div>
                          </button>
                        </div>
                      )
                    })}
                  </div>

                </div>

                <div className={`oc-team-panel blue ${currentTurnTeam === 'blue' ? 'turn-active' : currentTurnTeam === 'red' ? 'turn-dim' : ''}`}>
                  <div style={{ fontWeight: 1000, marginBottom: 10, color: 'rgba(220,230,255,0.98)' }}>{t('game.team.blueTeam')}</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {blueTeam.length === 0 ? (
                      <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>{t('game.team.noPlayers')}</div>
                    ) : (
                      blueTeam.map((m, idx) => {
                        const you = m.user_id === myUserId
                        const name = memberDisplayName(m.user_id, idx)
                        const avatarSrc = memberAvatar(m.user_id, m.team)
                        const fallbackAvatar = fallbackAvatarFor(m.team, `${m.user_id}:fallback`)
                        return (
                          <div key={`blue-${m.user_id}`} className="oc-member">
                            <div className="oc-member-main">
                              <div className="oc-member-avatar-wrap">
                                <img
                                  className="oc-member-avatar"
                                  src={avatarSrc}
                                  alt={`${name} avatar`}
                                  onError={(e) => {
                                    const img = e.currentTarget
                                    if (img.src.endsWith(fallbackAvatar)) return
                                    img.src = fallbackAvatar
                                  }}
                                />
                              </div>
                              <div className="oc-member-meta">
                                <div className="oc-member-name">{you ? t('game.member.youName', { name }) : name}</div>
                                <div className="oc-member-role">{roleLabel(m.is_spymaster)}</div>
                              </div>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
                    <div style={{ fontSize: 12, opacity: 0.78, fontWeight: 900, marginBottom: 6 }}>{t('game.hints.trail')}</div>
                    {renderHintTrail('blue', 3, 'panel-blue-')}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {!isGameActive && effectiveWinner && (
          <div className="oc-win-overlay">
            <div className="oc-win-card">
              <div className="oc-win-title">{t('game.notice.teamWins', { team: teamLabelText(effectiveWinner) })}</div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                {amOwner ? (
                  <button
                    onClick={handleRestart}
                    disabled={busy !== null}
                    style={{ padding: '10px 14px', borderRadius: 12, border: '1px solid rgba(170,255,255,0.42)', background: 'rgba(200,255,255,0.12)', color: '#fff', fontWeight: 900, cursor: 'pointer' }}
                  >
                    {t('game.win.startNewLobby')}
                  </button>
                ) : (
                  <div style={{ opacity: 0.82, fontWeight: 800, paddingTop: 8 }}>{t('game.win.waitingOwner')}</div>
                )}
                <button
                  onClick={() => setShowWinTrail((v) => !v)}
                  style={{ padding: '10px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.24)', background: 'rgba(255,255,255,0.10)', color: '#fff', fontWeight: 900, cursor: 'pointer' }}
                >
                  {showWinTrail ? t('game.win.hideHintTrail') : t('game.win.readHintTrail')}
                </button>
              </div>

              {showWinTrail && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,95,95,0.34)', background: 'rgba(255,95,95,0.10)' }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>{t('game.win.redTrail')}</div>
                    {renderHintTrail('red', 6, 'win-r-')}
                  </div>
                  <div style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(90,140,255,0.36)', background: 'rgba(90,140,255,0.10)' }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>{t('game.win.blueTrail')}</div>
                    {renderHintTrail('blue', 6, 'win-b-')}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {centerNotice && (
          <div className={`oc-center-notice ${centerNotice.tone}`} key={centerNotice.id}>
            {centerNotice.text}
          </div>
        )}

        {showRules && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 11, background: 'rgba(0,0,0,0.66)', display: 'grid', placeItems: 'center', padding: 14 }}>
            <div style={{ width: 'min(680px, 95vw)', borderRadius: 16, border, background: 'rgba(0,0,0,0.86)', boxShadow: '0 24px 70px rgba(0,0,0,0.72)', padding: 16, display: 'grid', gap: 12 }}>
              <div style={{ fontWeight: 1000, fontSize: 20 }}>{t('game.rules.title')}</div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, opacity: 0.92 }}>
                <li>{t('game.rules.items.1')}</li>
                <li>{t('game.rules.items.2')}</li>
                <li>{t('game.rules.items.3')}</li>
                <li>{t('game.rules.items.4')}</li>
                <li>{t('game.rules.items.5')}</li>
                <li>{t('game.rules.items.6')}</li>
              </ul>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => setShowRules(false)} style={{ padding: '9px 12px', borderRadius: 10, border, background: 'rgba(255,255,255,0.12)', color: '#fff', fontWeight: 900, cursor: 'pointer' }}>
                  {t('game.actions.close')}
                </button>
              </div>
            </div>
          </div>
        )}

        {dicePicker && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 12, background: 'rgba(0,0,0,0.66)', display: 'grid', placeItems: 'center', padding: 14 }}>
            <div style={{ width: 'min(760px, 95vw)', borderRadius: 16, border, background: 'rgba(0,0,0,0.86)', boxShadow: '0 24px 70px rgba(0,0,0,0.72)', padding: 16, display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <img
                  src={diceOptionImage(dicePicker.option)}
                  alt={diceOptionLabel(dicePicker.option)}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    border: '1px solid rgba(255,255,255,0.18)',
                    background: 'rgba(0,0,0,0.35)',
                    objectFit: 'contain'
                  }}
                />
                <div style={{ fontWeight: 1000, fontSize: 18 }}>{diceOptionLabel(dicePicker.option)}</div>
              </div>
              <div style={{ opacity: 0.94, fontSize: 13, lineHeight: 1.5, border: '1px solid rgba(255,220,120,0.22)', borderRadius: 10, padding: '8px 10px', background: 'rgba(255,220,120,0.08)', color: 'rgba(255,240,196,0.98)' }}>
                {diceOptionEffectText(dicePicker.option)}
              </div>
              <div style={{ opacity: 0.9, fontSize: 13, lineHeight: 1.5, border: '1px solid rgba(255,255,255,0.14)', borderRadius: 10, padding: '8px 10px', background: 'rgba(255,255,255,0.05)' }}>
                {dicePicker.option === 'swap'
                  ? dicePicker.posA === null
                    ? t('game.dice.swapStep1')
                    : dicePicker.posB === null
                      ? t('game.dice.swapStep2', { pos: diceCardName(dicePicker.posA) })
                      : t('game.dice.swapSelected', { posA: diceCardName(dicePicker.posA), posB: diceCardName(dicePicker.posB) })
                  : t('game.dice.singleTargetHelp')}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {unrevealedCards.map((c) => {
                  const selected = c.pos === dicePicker.posA || c.pos === dicePicker.posB
                  return (
                    <button
                      key={`dice-pos-${c.pos}`}
                      type="button"
                      onClick={() => {
                        if (dicePicker.option === 'swap') {
                          if (dicePicker.posA === null) {
                            setDicePicker({ ...dicePicker, posA: c.pos })
                            return
                          }
                          if (dicePicker.posB === null) {
                            setDicePicker({ ...dicePicker, posB: c.pos })
                            return
                          }
                          setDicePicker({ ...dicePicker, posA: c.pos, posB: null })
                          return
                        }
                        setDicePicker({ ...dicePicker, posA: c.pos })
                      }}
                      style={{
                        minWidth: 88,
                        padding: '8px 10px',
                        borderRadius: 10,
                        border: selected ? '1px solid rgba(255,220,120,0.72)' : '1px solid rgba(255,255,255,0.22)',
                        background: selected ? 'rgba(255,220,120,0.22)' : 'rgba(255,255,255,0.08)',
                        color: '#fff',
                        fontWeight: 900,
                        cursor: 'pointer'
                      }}
                      title={`${c.word} (#${c.pos})`}
                    >
                      {c.word || `#${c.pos}`}
                    </button>
                  )
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => setDicePicker(null)} style={{ padding: '9px 12px', borderRadius: 10, border, background: 'rgba(255,255,255,0.10)', color: '#fff', fontWeight: 900, cursor: 'pointer' }}>
                  {t('game.actions.close')}
                </button>
                <button
                  onClick={submitDicePicker}
                  disabled={busy !== null || (dicePicker.option === 'swap' ? dicePicker.posA === null || dicePicker.posB === null || dicePicker.posA === dicePicker.posB : dicePicker.posA === null)}
                  style={{ padding: '9px 12px', borderRadius: 10, border: '1px solid rgba(170,255,255,0.42)', background: 'rgba(200,255,255,0.12)', color: '#fff', fontWeight: 900, cursor: 'pointer' }}
                >
                  {t('game.dice.apply')}
                </button>
              </div>
            </div>
          </div>
        )}

        {busy && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.60)', zIndex: 10 }}>
            <div style={{ padding: 16, borderRadius: 14, border, background: 'rgba(0,0,0,0.35)', fontWeight: 900 }}>{busy}</div>
          </div>
        )}
      </div>
    </div>
  )
}


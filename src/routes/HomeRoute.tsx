import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import HomePage from '../components/HomePage'
import { supabase } from '../lib/supabaseClient'
import { createLobby, joinLobby, joinLobbyAsSpectator, quickMatch } from '../lib/lobbies'

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

function readStr(key: string): string {
  try {
    return (localStorage.getItem(key) ?? '').trim()
  } catch {
    return ''
  }
}

function writeStr(key: string, val: string) {
  try {
    localStorage.setItem(key, (val ?? '').trim())
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

function lobbyUrl(code: string, role: string | null): string {
  const clean = (code ?? '').trim().toUpperCase()
  if (!clean) return '/'
  if ((role ?? '').toLowerCase() === 'spectator') return `/lobby/${clean}?spectate=1`
  return `/lobby/${clean}`
}

export default function HomeRoute() {
  const navigate = useNavigate()

  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const [busy, setBusy] = useState<string | null>(null)
  const [lastLobbyCode, setLastLobbyCode] = useState<string>(() => readStr('oneclue_last_lobby_code'))
  const [lastLobbyRole, setLastLobbyRole] = useState<string>(() => readStr('oneclue_last_lobby_role'))

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)

        const { data, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr
        if (!data.session?.user?.id) throw new Error('No session')

        if (cancelled) return
        setState('ready')

        const code = (lastLobbyCode ?? '').trim()
        if (code) {
          setTimeout(() => {
            if (!cancelled) navigate(lobbyUrl(code, lastLobbyRole || null))
          }, 10)
        }
      } catch (err) {
        console.error('[home] failed:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : supaErr(err))
          setState('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [navigate, lastLobbyCode, lastLobbyRole])

  const uiDisabled = busy !== null || state !== 'ready'

  async function handleCreate(mode: 'classic' | 'powers') {
    if (uiDisabled) return
    try {
      setBusy(mode === 'powers' ? 'Creating powers lobby…' : 'Creating lobby…')
      const { lobbyCode } = await createLobby({ settings: { mode } })

      writeStr('oneclue_last_lobby_code', lobbyCode)
      writeStr('oneclue_last_lobby_role', 'player')
      setLastLobbyCode(lobbyCode)
      setLastLobbyRole('player')

      navigate(`/lobby/${lobbyCode}`)
    } catch (err) {
      console.error('[home] create failed:', err)
      alert(err instanceof Error ? err.message : supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleJoin(code: string) {
    if (uiDisabled) return
    const clean = (code ?? '').trim().toUpperCase()
    if (!clean) return

    try {
      setBusy('Joining lobby…')
      await joinLobby(clean)

      writeStr('oneclue_last_lobby_code', clean)
      writeStr('oneclue_last_lobby_role', 'player')
      setLastLobbyCode(clean)
      setLastLobbyRole('player')

      navigate(`/lobby/${clean}`)
    } catch (err) {
      console.error('[home] join failed:', err)
      alert(err instanceof Error ? err.message : supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleSpectate(code: string) {
    if (uiDisabled) return
    const clean = (code ?? '').trim().toUpperCase()
    if (!clean) return

    try {
      setBusy('Joining as spectator…')
      await joinLobbyAsSpectator(clean)

      writeStr('oneclue_last_lobby_code', clean)
      writeStr('oneclue_last_lobby_role', 'spectator')
      setLastLobbyCode(clean)
      setLastLobbyRole('spectator')

      navigate(`/lobby/${clean}?spectate=1`)
    } catch (err) {
      console.error('[home] spectate failed:', err)
      alert(err instanceof Error ? err.message : supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleQuickMatch() {
    if (uiDisabled) return
    try {
      setBusy('Finding a match…')
      const res = await quickMatch({ mode: 'classic' })

      writeStr('oneclue_last_lobby_code', res.lobbyCode)
      writeStr('oneclue_last_lobby_role', 'player')
      setLastLobbyCode(res.lobbyCode)
      setLastLobbyRole('player')

      navigate(`/lobby/${res.lobbyCode}`)
    } catch (err) {
      console.error('[home] quick match failed:', err)
      alert(err instanceof Error ? err.message : supaErr(err))
    } finally {
      setBusy(null)
    }
  }

  function handleForgetLast() {
    clearKey('oneclue_last_lobby_code')
    clearKey('oneclue_last_lobby_role')
    setLastLobbyCode('')
    setLastLobbyRole('')
    alert('Forgot last lobby.')
  }

  function openSettings() {
    const code = (lastLobbyCode ?? '').trim()
    if (!code) {
      alert('No recent lobby found. Join a lobby first.')
      return
    }
    navigate(`/settings/${code}`)
  }

  if (state === 'loading') {
    return (
      <div className="homeScene">
        <div className="homeFrame">
          <div className="homeHeader">
            <div className="homeEyebrow">Classic 5x5</div>
            <h1 className="homeTitle">OneClue</h1>
            <p className="homeSubtitle">Loading…</p>
          </div>
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="homeScene">
        <div className="homeFrame">
          <div className="homeHeader">
            <div className="homeEyebrow">Classic 5x5</div>
            <h1 className="homeTitle">OneClue</h1>
            <p className="homeSubtitle">Could not start the app.</p>
          </div>

          <section className="homeCard" aria-label="Error">
            <h2>Error</h2>
            <p style={{ minHeight: 0 }}>{error ?? 'Unknown error'}</p>
            <div className="homeBtnStack">
              <button className="homeBtnPrimary" type="button" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </section>
        </div>
      </div>
    )
  }

  return (
    <>
      <HomePage
        onJoinLobby={handleJoin}
        onSpectateLobby={handleSpectate}
        onCreateLobby={handleCreate}
        onQuickMatch={handleQuickMatch}
        onOpenProfile={() => navigate('/profile')}
        onOpenSettings={openSettings}
        lastLobbyCode={lastLobbyCode || null}
        onRejoinLast={() => navigate(lobbyUrl(lastLobbyCode, lastLobbyRole || null))}
        onForgetLast={handleForgetLast}
      />

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
          <div
            style={{
              padding: 16,
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,.12)',
              background: 'rgba(0,0,0,.55)'
            }}
          >
            {busy}
          </div>
        </div>
      )}
    </>
  )
}

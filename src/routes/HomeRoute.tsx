import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import HomePage from '../components/HomePage'
import { supabase } from '../lib/supabaseClient'
import { createLobby, joinLobby, joinLobbyAsSpectator, quickMatch } from '../lib/lobbies'
import {
  ensureSession,
  getCurrentUser,
  signInWithEmailPassword,
  signOut,
  upgradeAnonymousWithEmailPassword
} from '../lib/auth'

type LoadState = 'loading' | 'ready' | 'error'
type ToastTone = 'info' | 'success' | 'error'
type ToastItem = { id: string; text: string; tone: ToastTone }

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
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [authEmail, setAuthEmail] = useState<string | null>(null)
  const [isAnonymousUser, setIsAnonymousUser] = useState<boolean>(true)


  function addToast(text: string, tone: ToastTone = 'info', ms = 2600) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    setToasts((prev) => [...prev, { id, text, tone }].slice(-3))
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, ms)
  }

  const [lastLobbyRole, setLastLobbyRole] = useState<string>(() => readStr('oneclue_last_lobby_role'))

  async function refreshAuthSummary() {
    const user = await getCurrentUser()
    const isAnon = Boolean((user as any)?.is_anonymous)
    setIsAnonymousUser(isAnon)
    setAuthEmail(user?.email ?? null)
  }

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)

        const { data, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr
        if (!data.session?.user?.id) throw new Error('No session')
        await refreshAuthSummary()

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

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      void refreshAuthSummary()
    })
    return () => {
      sub.subscription.unsubscribe()
    }
  }, [])

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
      addToast(err instanceof Error ? err.message : supaErr(err), 'error')

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
      addToast(err instanceof Error ? err.message : supaErr(err), 'error')

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
      addToast(err instanceof Error ? err.message : supaErr(err), 'error')

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
      addToast(err instanceof Error ? err.message : supaErr(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  function handleForgetLast() {
    clearKey('oneclue_last_lobby_code')
    clearKey('oneclue_last_lobby_role')
    setLastLobbyCode('')
    setLastLobbyRole('')
    addToast('Forgot last lobby.', 'success')

  }

  function openSettings() {
    const code = (lastLobbyCode ?? '').trim()
    if (!code) {
      addToast('No recent lobby found. Join a lobby first.', 'info')

      return
    }
    navigate(`/settings/${code}`)
  }

  async function handleSignIn(email: string, password: string) {
    if (uiDisabled) return
    try {
      setBusy('Signing in...')
      await signInWithEmailPassword(email, password)
      await refreshAuthSummary()
      addToast('Signed in.', 'success')
    } catch (err) {
      console.error('[home] sign in failed:', err)
      addToast(err instanceof Error ? err.message : supaErr(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function handleCreateAccount(email: string, password: string) {
    if (uiDisabled) return
    try {
      setBusy('Creating account...')
      const res = await upgradeAnonymousWithEmailPassword(email, password)
      await refreshAuthSummary()
      if (res.mode === 'upgrade') addToast('Guest account upgraded.', 'success')
      else addToast('Account created. Check email if confirmation is enabled.', 'success')
    } catch (err) {
      console.error('[home] create account failed:', err)
      addToast(err instanceof Error ? err.message : supaErr(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function handleLogout() {
    if (uiDisabled) return
    try {
      setBusy('Logging out...')
      await signOut()
      await ensureSession()
      await refreshAuthSummary()
      addToast('Now playing as guest.', 'info')
    } catch (err) {
      console.error('[home] logout failed:', err)
      addToast(err instanceof Error ? err.message : supaErr(err), 'error')
    } finally {
      setBusy(null)
    }
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
        authEmail={authEmail}
        isAnonymousUser={isAnonymousUser}
        authBusy={Boolean(busy)}
        onSignIn={handleSignIn}
        onCreateAccount={handleCreateAccount}
        onContinueAsGuest={() => addToast('Continuing as guest.', 'info')}
        onLogout={handleLogout}
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

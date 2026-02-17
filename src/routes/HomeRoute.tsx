import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import HomePage from '../components/HomePage'
import { supabase } from '../lib/supabaseClient'
import { createLobby, joinLobby, joinLobbyAsSpectator } from '../lib/lobbies'
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
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useTranslation()
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
      setBusy(t('home.busy.creatingPowersLobby'))
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
      setBusy(t('home.busy.joiningLobby'))
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
      setBusy(t('home.busy.joiningSpectator'))
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

  function handleForgetLast() {
    clearKey('oneclue_last_lobby_code')
    clearKey('oneclue_last_lobby_role')
    setLastLobbyCode('')
    setLastLobbyRole('')
    addToast(t('home.toasts.forgotLast'), 'success')

  }

  async function handleSignIn(email: string, password: string) {
    if (uiDisabled) return
    try {
      setBusy(t('home.busy.signingIn'))
      await signInWithEmailPassword(email, password)
      await refreshAuthSummary()
      addToast(t('home.toasts.signedIn'), 'success')
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
      setBusy(t('home.busy.creatingLobby'))
      const res = await upgradeAnonymousWithEmailPassword(email, password)
      await refreshAuthSummary()
      if (res.mode === 'upgrade') addToast(t('home.toasts.guestUpgraded'), 'success')
      else addToast(t('home.toasts.accountCreated'), 'success')
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
      setBusy(t('home.busy.loggingOut'))
      await signOut()
      await ensureSession()
      await refreshAuthSummary()
      addToast(t('home.toasts.nowGuest'), 'info')
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
            <div className="homeEyebrow">{t('home.screens.loadingKicker')}</div>
            <h1 className="homeTitle">{t('home.screens.loadingTitle')}</h1>
            <p className="homeSubtitle">{t('home.screens.loading')}</p>
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
            <div className="homeEyebrow">{t('home.screens.loadingKicker')}</div>
            <h1 className="homeTitle">{t('home.screens.loadingTitle')}</h1>
            <p className="homeSubtitle">{t('home.screens.couldNotStart')}.</p>
          </div>

          <section className="homeCard" aria-label="Error">
            <h2>{t('home.screens.errorTitle')}</h2>
            <p style={{ minHeight: 0 }}>{error ?? 'Unknown error'}</p>
            <div className="homeBtnStack">
              <button className="homeBtnPrimary" type="button" onClick={() => window.location.reload()}>
                {t('home.screens.reload')}
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
        onOpenProfile={() => navigate('/profile', { state: { from: `${location.pathname}${location.search}` } })}
        lastLobbyCode={lastLobbyCode || null}
        onRejoinLast={() => navigate(lobbyUrl(lastLobbyCode, lastLobbyRole || null))}
        onForgetLast={handleForgetLast}
        authEmail={authEmail}
        isAnonymousUser={isAnonymousUser}
        authBusy={Boolean(busy)}
        onSignIn={handleSignIn}
        onCreateAccount={handleCreateAccount}
        onContinueAsGuest={() => addToast(t('home.toasts.continueGuest'), 'info')}
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

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabaseClient'
import { getMyProfile, updateMyProfile, type Profile } from '../lib/profile'
import { getMostTeammate, getWinLossRatio, readPlayerStatsFromPreferences, type PlayerStats } from '../lib/playerStats'

type Props = {
  onClose: () => void
  onBackToHome: () => void
  onBackToGame: () => void
}

type LoadState = 'loading' | 'ready' | 'saving' | 'error'

type ProfilePrefs = {
  username?: string
  language?: string
  region?: string
  teamColor?: 'Blue' | 'Red' | 'Auto' | string
  showOnline?: boolean
  allowInvites?: boolean
  publicProfile?: boolean
  emailUpdates?: boolean
  gameAlerts?: boolean
  darkPanels?: boolean
}

type UiLang = 'ar' | 'en'

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function parseLang(v: unknown): UiLang {
  const raw = String(v ?? '').trim().toLowerCase()
  if (raw === 'ar' || raw === 'arabic' || raw.includes('عرب')) return 'ar'
  return 'en'
}

function downloadJson(filename: string, obj: unknown) {
  const text = JSON.stringify(obj, null, 2)
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()

  URL.revokeObjectURL(url)
}

export default function ProfilePage({ onClose, onBackToHome, onBackToGame }: Props) {
  const { t, i18n } = useTranslation()

  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [profile, setProfile] = useState<Profile | null>(null)
  const [stats, setStats] = useState<PlayerStats | null>(null)
  const [email, setEmail] = useState<string>('')

  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [bio, setBio] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')

  const [language, setLanguage] = useState<UiLang>('en')
  useEffect(() => {
    const target = language
    const current = String(i18n.resolvedLanguage ?? i18n.language ?? '').toLowerCase()
    const alreadyUsingTarget = target === 'ar' ? current.startsWith('ar') : current.startsWith('en')
    if (alreadyUsingTarget) return
    void i18n.changeLanguage(target)
  }, [language, i18n])

  const [region, setRegion] = useState<'Middle East' | 'Europe' | 'North America'>('Middle East')
  const [teamColor, setTeamColor] = useState<'Blue' | 'Red' | 'Auto'>('Auto')
  const [darkPanels, setDarkPanels] = useState(true)

  const [publicProfile, setPublicProfile] = useState(false)
  const [showOnline, setShowOnline] = useState(true)
  const [allowInvites, setAllowInvites] = useState(true)

  const [emailUpdates, setEmailUpdates] = useState(true)
  const [gameAlerts, setGameAlerts] = useState(true)

  const canSave = useMemo(() => {
    if (state !== 'ready') return false
    return displayName.trim().length > 0
  }, [state, displayName])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)
        setNotice(null)

        const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr

        const sessionEmail = sessionData.session?.user?.email ?? ''
        if (!cancelled) setEmail(sessionEmail)

        const p = await getMyProfile()
        if (cancelled) return

        const prefs = (p.preferences ?? {}) as ProfilePrefs

        setProfile(p)
        setStats(readPlayerStatsFromPreferences(p.preferences))
        setDisplayName(p.display_name ?? '')
        setBio(p.bio ?? '')
        setAvatarUrl(p.avatar_url ?? '')

        setUsername(asStr(prefs.username, ''))
        setLanguage(parseLang(prefs.language))

        setRegion((asStr(prefs.region, 'Middle East') as any) || 'Middle East')
        setTeamColor((asStr(prefs.teamColor, 'Auto') as any) || 'Auto')

        setDarkPanels(asBool(prefs.darkPanels, true))

        setPublicProfile(asBool(prefs.publicProfile, false))
        setShowOnline(asBool(prefs.showOnline, true))
        setAllowInvites(asBool(prefs.allowInvites, true))

        setEmailUpdates(asBool(prefs.emailUpdates, true))
        setGameAlerts(asBool(prefs.gameAlerts, true))

        setState('ready')
      } catch (err) {
        console.error('[profile] load failed:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : i18n.t('profile.errors.load'))
          setState('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  async function handleSave() {
    if (!profile) return
    if (!canSave) return

    try {
      setState('saving')
      setError(null)
      setNotice(null)

      const nextPrefs: ProfilePrefs = {
        ...(profile.preferences ?? {}),
        username: username.trim() || undefined,
        language,
        region,
        teamColor,
        darkPanels,
        publicProfile,
        showOnline,
        allowInvites,
        emailUpdates,
        gameAlerts
      }

      await updateMyProfile({
        display_name: displayName,
        bio,
        avatar_url: avatarUrl,
        preferences: nextPrefs as Record<string, unknown>
      })

      const updated = await getMyProfile()
      setProfile(updated)
      setStats(readPlayerStatsFromPreferences(updated.preferences))
      setNotice(t('profile.notice.saved'))
      setState('ready')
    } catch (err) {
      console.error('[profile] save failed:', err)
      setError(err instanceof Error ? err.message : t('profile.errors.save'))
      setState('error')
    }
  }

  async function handleChangePassword() {
    const p1 = window.prompt(t('profile.password.newPrompt'))
    if (!p1) return
    const p2 = window.prompt(t('profile.password.repeatPrompt'))
    if (!p2) return
    if (p1 !== p2) {
      setNotice(t('profile.password.mismatch'))
      return
    }
    if (p1.length < 8) {
      setNotice(t('profile.password.tooShort'))
      return
    }

    try {
      setNotice(null)
      const { error } = await supabase.auth.updateUser({ password: p1 })
      if (error) throw error
      setNotice(t('profile.password.updated'))
    } catch (err) {
      console.error('[profile] change password failed:', err)
      setNotice(err instanceof Error ? err.message : t('profile.errors.changePassword'))
    }
  }

  async function handleActiveSession() {
    try {
      const { data, error } = await supabase.auth.getSession()
      if (error) throw error
      const s = data.session
      if (!s) {
        setNotice(t('profile.session.none'))
        return
      }
      const exp = s.expires_at ? new Date(s.expires_at * 1000).toISOString() : t('profile.session.unknown')
      setNotice(t('profile.session.active', { email: s.user?.email ?? t('profile.session.unknown'), exp }))
    } catch (err) {
      console.error('[profile] session read failed:', err)
      setNotice(err instanceof Error ? err.message : t('profile.errors.readSession'))
    }
  }

  function handleExport() {
    const payload = {
      exported_at: new Date().toISOString(),
      email,
      profile: profile ?? null
    }
    downloadJson('oneclue-profile-export.json', payload)
  }

  const mostTeammate = useMemo(() => (stats ? getMostTeammate(stats) : null), [stats])
  const winLossRatio = useMemo(() => (stats ? getWinLossRatio(stats) : '0.00'), [stats])

  return (
    <div className="profileScene">
      <div className="profileFrame">
        <header className="profileHeader">
          <div>
            <div className="profileEyebrow">{t('profile.header.eyebrow')}</div>
            <h1 className="profileTitle">{t('profile.header.title')}</h1>
            <p className="profileSubtitle">{t('profile.header.subtitle')}</p>
            {profile && (
              <p className="profileSubtitle" style={{ marginTop: 8, opacity: 0.85 }}>
                {t('profile.header.userId')}: <span style={{ fontFamily: 'monospace' }}>{profile.user_id}</span>
              </p>
            )}
            {notice && (
              <p className="profileSubtitle" style={{ marginTop: 8, opacity: 0.95 }}>
                {notice}
              </p>
            )}
          </div>

          <div className="profileHeaderActions">
            <button className="homeBtnGhost" type="button" onClick={onClose}>
              {t('profile.actions.closeProfile')}
            </button>
            <button className="homeBtnGhost" type="button" onClick={onBackToHome}>
              {t('profile.actions.backToLobby')}
            </button>
            <button className="homeBtnPrimary" type="button" onClick={onBackToGame}>
              {t('profile.actions.returnToGame')}
            </button>
          </div>
        </header>

        {state === 'loading' && <p className="profileSubtitle">{t('profile.loading')}</p>}

        {state === 'error' && error && (
          <div style={{ padding: 12, borderRadius: 12, border: '1px solid rgba(226,59,59,.35)', background: 'rgba(0,0,0,.25)' }}>
            <p style={{ margin: 0, fontWeight: 900 }}>{t('profile.errorTitle')}</p>
            <p style={{ margin: '6px 0 0 0', opacity: 0.9 }}>{error}</p>
          </div>
        )}

        {profile && (
          <div className="profileGrid">
            <section className="profileCard">
              <h2>{t('profile.sections.basicInfo')}</h2>
              <div className="profileFields">
                <label>
                  {t('profile.fields.displayName')}
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t('profile.placeholders.yourName')} />
                </label>

                <label>
                  {t('profile.fields.username')}
                  <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t('profile.placeholders.nickname')} />
                </label>

                <label>
                  {t('profile.fields.email')}
                  <input value={email} disabled placeholder={t('profile.fields.email')} />
                </label>

                <label>
                  {t('profile.fields.avatarUrl')}
                  <input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder={t('profile.placeholders.avatarUrl')} />
                </label>

                <label className="isWide">
                  {t('profile.fields.bio')}
                  <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder={t('profile.placeholders.bio')} />
                </label>
              </div>
            </section>

            <section className="profileCard">
              <h2>{t('profile.sections.preferences')}</h2>
              <div className="profileFields">
                <label>
                  {t('profile.fields.language')}
                  <select value={language} onChange={(e) => setLanguage(e.target.value as UiLang)}>
                    <option value="ar">{t('profile.options.language.arabic')}</option>
                    <option value="en">{t('profile.options.language.english')}</option>
                  </select>
                </label>

                <label>
                  {t('profile.fields.region')}
                  <select value={region} onChange={(e) => setRegion(e.target.value as any)}>
                    <option value="Middle East">{t('profile.options.region.middleEast')}</option>
                    <option value="Europe">{t('profile.options.region.europe')}</option>
                    <option value="North America">{t('profile.options.region.northAmerica')}</option>
                  </select>
                </label>

                <label>
                  {t('profile.fields.preferredTeam')}
                  <select value={teamColor} onChange={(e) => setTeamColor(e.target.value as any)}>
                    <option value="Blue">{t('profile.options.team.blue')}</option>
                    <option value="Red">{t('profile.options.team.red')}</option>
                    <option value="Auto">{t('profile.options.team.auto')}</option>
                  </select>
                </label>

                <label className="toggleRow">
                  <span>{t('profile.fields.useDarkPanels')}</span>
                  <input type="checkbox" checked={darkPanels} onChange={(e) => setDarkPanels(e.target.checked)} />
                </label>
              </div>
            </section>

            <section className="profileCard">
              <h2>{t('profile.sections.privacy')}</h2>
              <div className="profileToggles">
                <label className="toggleRow">
                  <span>{t('profile.fields.publicProfile')}</span>
                  <input type="checkbox" checked={publicProfile} onChange={(e) => setPublicProfile(e.target.checked)} />
                </label>
                <label className="toggleRow">
                  <span>{t('profile.fields.showOnlineStatus')}</span>
                  <input type="checkbox" checked={showOnline} onChange={(e) => setShowOnline(e.target.checked)} />
                </label>
                <label className="toggleRow">
                  <span>{t('profile.fields.allowLobbyInvites')}</span>
                  <input type="checkbox" checked={allowInvites} onChange={(e) => setAllowInvites(e.target.checked)} />
                </label>
              </div>
            </section>

            <section className="profileCard">
              <h2>{t('profile.sections.notifications')}</h2>
              <div className="profileToggles">
                <label className="toggleRow">
                  <span>{t('profile.fields.emailUpdates')}</span>
                  <input type="checkbox" checked={emailUpdates} onChange={(e) => setEmailUpdates(e.target.checked)} />
                </label>
                <label className="toggleRow">
                  <span>{t('profile.fields.gameAlerts')}</span>
                  <input type="checkbox" checked={gameAlerts} onChange={(e) => setGameAlerts(e.target.checked)} />
                </label>
              </div>
            </section>

            <section className="profileCard">
              <h2>{t('profile.sections.statistics')}</h2>
              <div className="profileFields">
                <label>
                  {t('profile.stats.gamesPlayed')}
                  <input value={String(stats?.games_played ?? 0)} disabled />
                </label>
                <label>
                  {t('profile.stats.timesWon')}
                  <input value={String(stats?.times_won ?? 0)} disabled />
                </label>
                <label>
                  {t('profile.stats.timesLost')}
                  <input value={String(stats?.times_lost ?? 0)} disabled />
                </label>
                <label>
                  {t('profile.stats.winLossRatio')}
                  <input value={winLossRatio} disabled />
                </label>
                <label className="isWide">
                  {t('profile.stats.mostTeammate')}
                  <input
                    value={
                      mostTeammate
                        ? `${mostTeammate.name} (${mostTeammate.games} ${t('profile.stats.games')})`
                        : t('profile.stats.noTeammate')
                    }
                    disabled
                  />
                </label>
              </div>
            </section>

            <section className="profileCard">
              <h2>{t('profile.sections.security')}</h2>
              <div className="profileBtnStack">
                <button className="homeBtnGhost" type="button" onClick={handleChangePassword}>
                  {t('profile.actions.changePassword')}
                </button>
                <button className="homeBtnGhost" type="button" onClick={() => setNotice(t('profile.notice.twoFaPending'))}>
                  {t('profile.actions.manage2fa')}
                </button>
                <button className="homeBtnGhost" type="button" onClick={handleActiveSession}>
                  {t('profile.actions.activeSession')}
                </button>
              </div>
            </section>

            <section className="profileCard">
              <h2>{t('profile.sections.accountActions')}</h2>
              <div className="profileBtnStack">
                <button className="homeBtnPrimary" type="button" onClick={handleSave} disabled={!canSave || state === 'saving'}>
                  {state === 'saving' ? t('profile.actions.saving') : t('profile.actions.saveChanges')}
                </button>
                <button className="homeBtnGhost" type="button" onClick={handleExport}>
                  {t('profile.actions.exportData')}
                </button>
                <button className="profileDanger" type="button" onClick={() => setNotice(t('profile.notice.deletePending'))}>
                  {t('profile.actions.deleteAccount')}
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

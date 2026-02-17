import { useState } from 'react'
import { useTranslation } from 'react-i18next'

type HomePageProps = {
  onJoinLobby: (code: string) => void
  onSpectateLobby: (code: string) => void
  onCreateLobby: (mode: 'classic' | 'powers') => void
  onOpenProfile: () => void
  lastLobbyCode?: string | null
  onRejoinLast?: () => void
  onForgetLast?: () => void
  authEmail?: string | null
  isAnonymousUser?: boolean
  authBusy?: boolean
  onSignIn?: (email: string, password: string) => void
  onCreateAccount?: (email: string, password: string) => void
  onContinueAsGuest?: () => void
  onLogout?: () => void
}

export default function HomePage({
  onJoinLobby,
  onSpectateLobby,
  onCreateLobby,
  onOpenProfile,
  lastLobbyCode,
  onRejoinLast,
  onForgetLast,
  authEmail,
  isAnonymousUser = true,
  authBusy = false,
  onSignIn,
  onCreateAccount,
  onContinueAsGuest,
  onLogout
}: HomePageProps) {
  const { t } = useTranslation()

  const [lobbyCode, setLobbyCode] = useState<string>('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  return (
    <div className="homeScene">
      <div className="homeFrame">
        <div className="homeHeader">
          <div className="homeEyebrow">{t('home.subtitle')}</div>
          <h1 className="homeTitle">{t('home.title')}</h1>
          <p className="homeSubtitle">{t('home.desc')}</p>
          <div className="homeHeroChips">
            <span className="homeHeroChip">{t('home.badges.grid')}</span>
            <span className="homeHeroChip">{t('home.badges.strategy')}</span>
            <span className="homeHeroChip">{t('home.badges.sync')}</span>
          </div>
        </div>

        <div className="homeTopCards">
          <section className="homeCard homeCardFeature" aria-label="Account">
            <h2>{t('home.account.title')}</h2>
            {!isAnonymousUser ? (
              <>
                <p>
                  {t('home.account.signedInAs', { email: authEmail || 'account user' })}
                </p>
                <div className="homeBtnStack">
                  <button className="homeBtnPrimary" type="button" onClick={onOpenProfile}>
                    {t('home.other.profile')}
                  </button>
                  <button className="homeBtnGhost" type="button" onClick={onLogout} disabled={authBusy}>
                    {t('home.account.logout')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>{t('home.account.guestOrSignIn')}.</p>
                <div className="homeJoinRow">
                  <input
                    className="homeInput"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('home.account.emailPh')}
                    aria-label="Email"
                  />
                </div>
                <div className="homeJoinRow" style={{ marginTop: 8 }}>
                  <input
                    className="homeInput"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('home.account.passwordPh')}
                    aria-label="Password"
                  />
                </div>
                <div className="homeBtnStack" style={{ marginTop: 10 }}>
                  <button className="homeBtnPrimary" type="button" onClick={onOpenProfile}>
                    {t('home.other.profile')}
                  </button>
                  <button
                    className="homeBtnPrimary"
                    type="button"
                    onClick={() => onSignIn?.(email, password)}
                    disabled={authBusy || !email.trim() || !password.trim()}
                  >
                     {t('home.account.login')}
                  </button>
                  <button
                    className="homeBtnGhost"
                    type="button"
                    onClick={() => onCreateAccount?.(email, password)}
                    disabled={authBusy || !email.trim() || !password.trim()}
                  >
                    {t('home.account.createAccount')}
                  </button>
                  <button className="homeBtnGhost" type="button" onClick={onContinueAsGuest} disabled={authBusy}>
                    {t('home.account.continueGuest')}
                  </button>
                </div>
              </>
            )}
          </section>

          {lastLobbyCode && onRejoinLast && onForgetLast && (
            <section className="homeCard homeCardFeature" aria-label="Last lobby">
              <h2>{t('home.lastLobby.title')}</h2>
              <p>
                {t('home.lastLobby.code', { code: lastLobbyCode })}
              </p>
              <div className="homeBtnStack">
                <button className="homeBtnPrimary" type="button" onClick={onRejoinLast}>
                  {t('home.lastLobby.rejoin')}
                </button>
                <button className="homeBtnGhost" type="button" onClick={onForgetLast}>
                  {t('home.lastLobby.forget')}
                </button>
              </div>
            </section>
          )}
        </div>

        <div className="homeGrid">
          <section className="homeCard homeCardJoin" aria-label="Join lobby">
            <h2>{t('home.join.title')}</h2>
            <p>{t('home.join.desc')}.</p>
            <div className="homeJoinRow">
              <input
                className="homeInput"
                type="text"
                value={lobbyCode}
                onChange={(e) => setLobbyCode(e.target.value.toUpperCase())}
                placeholder={t('home.join.roomCodePh')}
                aria-label="Lobby code"
              />
              <button
                className="homeBtnPrimary"
                type="button"
                onClick={() => onJoinLobby(lobbyCode.trim())}
                disabled={!lobbyCode.trim()}
              >
                {t('home.join.joinBtn')}
              </button>
            </div>

            <div style={{ marginTop: 10 }}>
              <button
                className="homeBtnGhost"
                type="button"
                onClick={() => onSpectateLobby(lobbyCode.trim())}
                disabled={!lobbyCode.trim()}
              >
                {t('home.join.spectateBtn')}
              </button>
            </div>
          </section>

          <section className="homeCard homeCardCreate" aria-label="Create lobby">
            <h2>{t('home.create.title')}</h2>
            <p>{t('home.create.desc')}.</p>
            <div className="homeBtnStack">
              <button className="homeBtnPrimary" type="button" onClick={() => onCreateLobby('classic')}>
               {t('home.create.classic')}
              </button>
              <button className="homeBtnGhost" type="button" onClick={() => onCreateLobby('powers')}>
               {t('home.create.powers')}
              </button>
            </div>
          </section>

        </div>
      </div>
    </div>
  )
}

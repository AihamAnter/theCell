import { useEffect, useMemo, useState } from 'react'
import type { Lobby } from '../lib/lobbies'
import { supabase } from '../lib/supabaseClient'
import {
  DEFAULT_SETTINGS_FORM,
  defaultCardCounts,
  formFromLobby,
  loadLobbyForSettings,
  saveLobbySettings,
  validateLobbySettingsForm,
  type LobbySettingsForm
} from '../lib/lobbySettings'

type Props = {
  lobbyCode: string
  onClose: () => void
  onBackToHome: () => void
  onBackToGame: () => void
}

type LoadState = 'loading' | 'ready' | 'saving' | 'error'

function supaErr(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as any
    const msg = typeof e.message === 'string' ? e.message : 'Unknown error'
    const details = typeof e.details === 'string' ? e.details : ''
    const hint = typeof e.hint === 'string' ? e.hint : ''
    const code = typeof e.code === 'string' ? e.code : ''
    const extra = [code && `code=${code}`, details && `details=${details}`, hint && `hint=${hint}`].filter(Boolean).join(' | ')
    return extra ? `${msg} (${extra})` : msg
  }
  return 'Unknown error'
}

function boardPresetFromSize(boardSize: number): '4x4' | '5x5' | '6x6' | 'custom' {
  if (boardSize === 16) return '4x4'
  if (boardSize === 25) return '5x5'
  if (boardSize === 36) return '6x6'
  return 'custom'
}

function toInt(v: string, fallback: number) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

export default function SettingsPage({ lobbyCode, onClose, onBackToHome, onBackToGame }: Props) {
  const code = lobbyCode.trim().toUpperCase()

  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [isOwner, setIsOwner] = useState(false)

  const [baseSettings, setBaseSettings] = useState<Record<string, unknown>>({})
  const [form, setForm] = useState<LobbySettingsForm>(DEFAULT_SETTINGS_FORM)

  const preset = useMemo(() => boardPresetFromSize(form.boardSize), [form.boardSize])
  const validationErrors = useMemo(() => validateLobbySettingsForm(form), [form])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        setState('loading')
        setError(null)

        if (!code) throw new Error('Missing lobby code')

        const l = await loadLobbyForSettings(code)
        if (cancelled) return

        setLobby(l)
        setBaseSettings((l.settings ?? {}) as Record<string, unknown>)

        const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
        if (sessionErr) throw sessionErr

        const uid = sessionData.session?.user?.id ?? null
        setIsOwner(uid !== null && uid === l.owner_id)

        setForm(formFromLobby(l))
        setState('ready')
      } catch (err) {
        console.error('[settings] load failed:', err)
        if (!cancelled) {
          setError(err instanceof Error ? err.message : supaErr(err))
          setState('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code])

  function setField<K extends keyof LobbySettingsForm>(key: K, value: LobbySettingsForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function applyBoardSize(nextSize: number) {
    const safe = Math.max(9, Math.min(100, Math.floor(nextSize || 25)))
    const nextCounts = defaultCardCounts(safe)
    setForm((prev) => ({
      ...prev,
      boardSize: safe,
      ...nextCounts
    }))
  }

  function resetDefaults() {
    // keep current lobby name as a nicer reset, but still reset everything else
    setForm((prev) => ({
      ...DEFAULT_SETTINGS_FORM,
      name: prev.name?.trim() ? prev.name : DEFAULT_SETTINGS_FORM.name
    }))
  }

  async function handleSave() {
    if (!lobby) return
    try {
      setState('saving')
      setError(null)

      await saveLobbySettings(lobby.id, form, baseSettings)

      const refreshed = await loadLobbyForSettings(code)
      setLobby(refreshed)
      setBaseSettings((refreshed.settings ?? {}) as Record<string, unknown>)
      setForm(formFromLobby(refreshed))

      setState('ready')
    } catch (err) {
      console.error('[settings] save failed:', err)
      setError(err instanceof Error ? err.message : supaErr(err))
      setState('error')
    }
  }

  const canEdit = isOwner && state !== 'saving'
  const canSave = canEdit && validationErrors.length === 0

  const cardsSum = form.firstTeamCards + form.secondTeamCards + form.neutralCards + form.assassinCards

  return (
    <div className="settingsScene">
      <div className="settingsFrame">
        <header className="settingsHeader">
          <div>
            <div className="settingsEyebrow">Room Configuration</div>
            <h1 className="settingsTitle">Settings</h1>
            <p className="settingsSubtitle">Configure lobby rules, clue rules, powers, and permissions.</p>

            {lobby && (
              <p style={{ margin: '10px 0 0', color: 'rgba(233,239,255,.70)', fontWeight: 800 }}>
                Lobby: <b>{lobby.code}</b> • Owner: <b>{isOwner ? 'you' : 'no'}</b>
              </p>
            )}
          </div>

          <div className="settingsHeaderActions">
            <button className="homeBtnGhost" type="button" onClick={onClose}>
              Close Settings
            </button>
            <button className="homeBtnGhost" type="button" onClick={onBackToGame}>
              Back To Lobby
            </button>
            <button className="homeBtnGhost" type="button" onClick={onBackToHome}>
              Back Home
            </button>
          </div>
        </header>

        {state === 'loading' && <p style={{ marginTop: 0, color: 'rgba(233,239,255,.70)', fontWeight: 800 }}>Loading…</p>}

        {error && (
          <div style={{ marginTop: 12, padding: 12, border: '1px solid #ff4d4f', borderRadius: 12 }}>
            <p style={{ margin: 0, fontWeight: 900 }}>Error: {error}</p>
          </div>
        )}

        {!isOwner && lobby && (
          <div style={{ marginTop: 12, padding: 12, border: '1px solid rgba(255,255,255,.12)', borderRadius: 12, background: 'rgba(0,0,0,.18)', fontWeight: 900 }}>
            Only the lobby owner can edit settings.
          </div>
        )}

        {validationErrors.length > 0 && lobby && (
          <div style={{ marginTop: 12, padding: 12, border: '1px solid rgba(245,197,66,.35)', borderRadius: 12, background: 'rgba(0,0,0,.18)' }}>
            <p style={{ margin: 0, fontWeight: 900, color: 'rgba(233,239,255,.92)' }}>{validationErrors[0]}</p>
          </div>
        )}

        {lobby && (
          <>
            <div className="settingsGrid" style={{ marginTop: 14 }}>
              <section className="settingsCard">
                <h2>Lobby Basics</h2>
                <div className="settingsFields">
                  <label className="isWide">
                    Room Name
                    <input value={form.name} onChange={(e) => setField('name', e.target.value)} disabled={!canEdit} />
                  </label>

                  <label>
                    Mode
                    <select value={form.mode} onChange={(e) => setField('mode', e.target.value as any)} disabled={!canEdit}>
                      <option value="classic">classic</option>
                      <option value="powers">powers</option>
                    </select>
                  </label>

                  <label>
                    Board Preset
                    <select
                      value={preset}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === '4x4') applyBoardSize(16)
                        else if (v === '5x5') applyBoardSize(25)
                        else if (v === '6x6') applyBoardSize(36)
                      }}
                      disabled={!canEdit}
                    >
                      <option value="4x4">4x4</option>
                      <option value="5x5">5x5</option>
                      <option value="6x6">6x6</option>
                      <option value="custom">custom</option>
                    </select>
                  </label>

                  <label>
                    Board Size (cards)
                    <input
                      type="number"
                      min={9}
                      max={100}
                      value={form.boardSize}
                      onChange={(e) => applyBoardSize(toInt(e.target.value, form.boardSize))}
                      disabled={!canEdit}
                    />
                  </label>

                  <label>
                    Max Players (2..32)
                    <input
                      type="number"
                      min={2}
                      max={32}
                      value={form.maxPlayers}
                      onChange={(e) => setField('maxPlayers', toInt(e.target.value, form.maxPlayers))}
                      disabled={!canEdit}
                    />
                  </label>

                  <label>
                    Language
                    <select value={form.language} onChange={(e) => setField('language', e.target.value as any)} disabled={!canEdit}>
                      <option value="english">English</option>
                      <option value="arabic">Arabic</option>
                    </select>
                  </label>

                  <label>
                    Privacy
                    <select value={form.privacy} onChange={(e) => setField('privacy', e.target.value as any)} disabled={!canEdit}>
                      <option value="private">Private</option>
                      <option value="public">Public</option>
                      <option value="friends">Friends Only</option>
                    </select>
                  </label>
                </div>
              </section>

              <section className="settingsCard">
                <h2>Permissions</h2>
                <div className="settingsToggles">
                  <label className="toggleRow">
                    <span>Password Required (not enforced yet)</span>
                    <input type="checkbox" checked={form.passwordRequired} onChange={(e) => setField('passwordRequired', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Allow Spectators</span>
                    <input type="checkbox" checked={form.allowSpectators} onChange={(e) => setField('allowSpectators', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Spectators Can Chat (later)</span>
                    <input type="checkbox" checked={form.spectatorsCanChat} onChange={(e) => setField('spectatorsCanChat', e.target.checked)} disabled={!canEdit} />
                  </label>
                </div>
              </section>

              <section className="settingsCard">
                <h2>Teams And Roles</h2>
                <div className="settingsFields">
                  <label>
                    Players Per Team
                    <select
                      value={String(form.playersPerTeam)}
                      onChange={(e) => setField('playersPerTeam', toInt(e.target.value, form.playersPerTeam))}
                      disabled={!canEdit}
                    >
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                    </select>
                  </label>

                  <label>
                    Team A Cards
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={form.firstTeamCards}
                      onChange={(e) => setField('firstTeamCards', toInt(e.target.value, form.firstTeamCards))}
                      disabled={!canEdit}
                    />
                  </label>

                  <label>
                    Team B Cards
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={form.secondTeamCards}
                      onChange={(e) => setField('secondTeamCards', toInt(e.target.value, form.secondTeamCards))}
                      disabled={!canEdit}
                    />
                  </label>

                  <label>
                    Neutral Cards
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={form.neutralCards}
                      onChange={(e) => setField('neutralCards', toInt(e.target.value, form.neutralCards))}
                      disabled={!canEdit}
                    />
                  </label>

                  <label>
                    Assassin Cards
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={form.assassinCards}
                      onChange={(e) => setField('assassinCards', toInt(e.target.value, form.assassinCards))}
                      disabled={!canEdit}
                    />
                  </label>

                  <label className="isWide">
                    Card Total
                    <input value={`${cardsSum} / ${form.boardSize}`} readOnly disabled style={{ opacity: 0.9 }} />
                  </label>
                </div>

                <div className="settingsToggles">
                  <label className="toggleRow">
                    <span>Require Spymaster Role</span>
                    <input type="checkbox" checked={form.requireSpymaster} onChange={(e) => setField('requireSpymaster', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Show Key Card To Spymaster Only</span>
                    <input
                      type="checkbox"
                      checked={form.showKeyCardToSpymasterOnly}
                      onChange={(e) => setField('showKeyCardToSpymasterOnly', e.target.checked)}
                      disabled={!canEdit}
                    />
                  </label>

                  <label className="toggleRow">
                    <span>Auto Balance Teams</span>
                    <input type="checkbox" checked={form.autoBalanceTeams} onChange={(e) => setField('autoBalanceTeams', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <button className="homeBtnGhost" type="button" onClick={() => applyBoardSize(form.boardSize)} disabled={!canEdit}>
                    Recalculate Card Counts
                  </button>
                </div>
              </section>

              <section className="settingsCard">
                <h2>Turn And Guess Rules</h2>
                <div className="settingsFields">
                  <label>
                    Turn Seconds
                    <input
                      type="number"
                      min={15}
                      max={300}
                      step={5}
                      value={form.turnSeconds}
                      onChange={(e) => setField('turnSeconds', toInt(e.target.value, form.turnSeconds))}
                      disabled={!canEdit || !form.useTurnTimer}
                    />
                  </label>

                  <label>
                    Overtime Seconds
                    <input
                      type="number"
                      min={0}
                      max={120}
                      step={5}
                      value={form.overtimeSeconds}
                      onChange={(e) => setField('overtimeSeconds', toInt(e.target.value, form.overtimeSeconds))}
                      disabled={!canEdit || !form.useTurnTimer}
                    />
                  </label>
                </div>

                <div className="settingsToggles">
                  <label className="toggleRow">
                    <span>Use Turn Timer</span>
                    <input type="checkbox" checked={form.useTurnTimer} onChange={(e) => setField('useTurnTimer', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Allow Unlimited Guesses</span>
                    <input
                      type="checkbox"
                      checked={form.allowUnlimitedGuesses}
                      onChange={(e) => setField('allowUnlimitedGuesses', e.target.checked)}
                      disabled={!canEdit}
                    />
                  </label>

                  <label className="toggleRow">
                    <span>Allow +1 Bonus Guess</span>
                    <input type="checkbox" checked={form.allowBonusGuess} onChange={(e) => setField('allowBonusGuess', e.target.checked)} disabled={!canEdit} />
                  </label>
                </div>
              </section>

              <section className="settingsCard">
                <h2>Clue Restrictions (Official Style)</h2>
                <div className="settingsToggles">
                  <label className="toggleRow">
                    <span>Enforce One-Word Clue</span>
                    <input type="checkbox" checked={form.enforceOneWordClue} onChange={(e) => setField('enforceOneWordClue', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Strict No Board-Word Clues</span>
                    <input
                      type="checkbox"
                      checked={form.strictNoBoardWordClues}
                      onChange={(e) => setField('strictNoBoardWordClues', e.target.checked)}
                      disabled={!canEdit}
                    />
                  </label>

                  <label className="toggleRow">
                    <span>Allow Hyphenated Clues</span>
                    <input type="checkbox" checked={form.allowHyphenatedWords} onChange={(e) => setField('allowHyphenatedWords', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Allow Abbreviations</span>
                    <input type="checkbox" checked={form.allowAbbreviations} onChange={(e) => setField('allowAbbreviations', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Allow Proper Nouns</span>
                    <input type="checkbox" checked={form.allowProperNouns} onChange={(e) => setField('allowProperNouns', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Allow Homophones</span>
                    <input type="checkbox" checked={form.allowHomophones} onChange={(e) => setField('allowHomophones', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Allow Translations</span>
                    <input type="checkbox" checked={form.allowTranslations} onChange={(e) => setField('allowTranslations', e.target.checked)} disabled={!canEdit} />
                  </label>
                </div>
              </section>

              <section className="settingsCard">
                <h2>Powers Variant</h2>
                <div className="settingsFields">
                  <label className="isWide">
                    Streak Needed For Dice
                    <input
                      type="number"
                      min={2}
                      max={8}
                      value={form.streakToUnlockDice}
                      onChange={(e) => setField('streakToUnlockDice', toInt(e.target.value, form.streakToUnlockDice))}
                      disabled={!canEdit}
                    />
                  </label>
                </div>

                <div className="settingsToggles">
                  <label className="toggleRow">
                    <span>Allow Time Cut</span>
                    <input type="checkbox" checked={form.allowTimeCut} onChange={(e) => setField('allowTimeCut', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Allow Random Peek</span>
                    <input type="checkbox" checked={form.allowRandomPeek} onChange={(e) => setField('allowRandomPeek', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Allow Shuffle Unrevealed</span>
                    <input type="checkbox" checked={form.allowShuffle} onChange={(e) => setField('allowShuffle', e.target.checked)} disabled={!canEdit} />
                  </label>
                </div>
              </section>

              <section className="settingsCard">
                <h2>Moderation And Accessibility</h2>
                <div className="settingsToggles">
                  <label className="toggleRow">
                    <span>Profanity Filter</span>
                    <input type="checkbox" checked={form.profanityFilter} onChange={(e) => setField('profanityFilter', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Kick On Repeated Violations</span>
                    <input
                      type="checkbox"
                      checked={form.kickOnRepeatedViolations}
                      onChange={(e) => setField('kickOnRepeatedViolations', e.target.checked)}
                      disabled={!canEdit}
                    />
                  </label>

                  <label className="toggleRow">
                    <span>Colorblind Patterns</span>
                    <input type="checkbox" checked={form.colorblindPatterns} onChange={(e) => setField('colorblindPatterns', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Reduce Motion</span>
                    <input type="checkbox" checked={form.reduceMotion} onChange={(e) => setField('reduceMotion', e.target.checked)} disabled={!canEdit} />
                  </label>

                  <label className="toggleRow">
                    <span>Larger Text</span>
                    <input type="checkbox" checked={form.largerText} onChange={(e) => setField('largerText', e.target.checked)} disabled={!canEdit} />
                  </label>
                </div>
              </section>
            </div>

            <footer className="settingsFooter">
              <button className="homeBtnGhost" type="button" onClick={resetDefaults} disabled={!canEdit}>
                Reset To Defaults
              </button>

              <button className="homeBtnPrimary" type="button" onClick={handleSave} disabled={!canSave}>
                {state === 'saving' ? 'Saving…' : 'Save Room Settings'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}

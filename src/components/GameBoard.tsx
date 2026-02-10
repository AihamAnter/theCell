import { useEffect, useMemo, useRef, useState } from 'react'
import { cards } from '../data/cards'

type Team = 'blue' | 'red'

type RevealResult = 'assassin' | 'correct' | 'wrong'

type ToastTone = 'info' | 'success' | 'warning' | 'danger'

type Toast = {
  id: string
  text: string
  tone: ToastTone
}

type GameBoardProps = {
  onBackToHome: () => void
  onOpenProfile: () => void
  onOpenSettings: () => void
}

const TOAST_MS = 2400

export default function GameBoard({ onBackToHome, onOpenProfile, onOpenSettings }: GameBoardProps) {
  const initialCounts = useMemo(() => {
    return cards.reduce(
      (acc, card) => {
        if (card.cls === 'isBlue') acc.blue += 1
        if (card.cls === 'isRed') acc.red += 1
        return acc
      },
      { blue: 0, red: 0 }
    )
  }, [])

  const [revealed, setRevealed] = useState<Set<number>>(() => new Set<number>())
  const [currentTeam, setCurrentTeam] = useState<Team>('blue')
  const [blueRemaining, setBlueRemaining] = useState(initialCounts.blue)
  const [redRemaining, setRedRemaining] = useState(initialCounts.red)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [isTurnPulseOn, setIsTurnPulseOn] = useState(false)
  const [winner, setWinner] = useState<Team | ''>('')
  const toastTimeoutsRef = useRef<number[]>([])
  const revealTimeoutsRef = useRef<number[]>([])
  const revealFxTimeoutsRef = useRef<number[]>([])
  const [pendingReveals, setPendingReveals] = useState<Set<number>>(() => new Set<number>())
  const [revealFxByCard, setRevealFxByCard] = useState<Record<number, RevealResult>>({})
  const [revealResultByCard, setRevealResultByCard] = useState<Record<number, RevealResult>>({})

  const gameOver = Boolean(winner)
  const hasPendingReveal = pendingReveals.size > 0

  useEffect(() => {
    setIsTurnPulseOn(true)
    const timeoutId = window.setTimeout(() => setIsTurnPulseOn(false), 720)
    return () => window.clearTimeout(timeoutId)
  }, [currentTeam])

  useEffect(() => {
    return () => {
      toastTimeoutsRef.current.forEach((id) => window.clearTimeout(id))
      revealTimeoutsRef.current.forEach((id) => window.clearTimeout(id))
      revealFxTimeoutsRef.current.forEach((id) => window.clearTimeout(id))
    }
  }, [])

  const addToast = (text: string, tone: ToastTone = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    setToasts((prev) => [...prev, { id, text, tone }])

    const timeoutId = window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id))
      toastTimeoutsRef.current = toastTimeoutsRef.current.filter((activeId) => activeId !== timeoutId)
    }, TOAST_MS)

    toastTimeoutsRef.current.push(timeoutId)
  }

  const switchTurn = () => {
    setCurrentTeam((prev) => (prev === 'blue' ? 'red' : 'blue'))
  }

  const endTurn = () => {
    if (gameOver) return
    switchTurn()
    addToast('Turn ended. Other team is up.', 'info')
  }

  const handleReveal = (idx: number) => {
    if (gameOver || hasPendingReveal || revealed.has(idx) || pendingReveals.has(idx)) return

    const card = cards[idx]
    const teamAtPick = currentTeam
    const teamClass = teamAtPick === 'blue' ? 'isBlue' : 'isRed'
    const enemyClass = teamAtPick === 'blue' ? 'isRed' : 'isBlue'

    const setRevealFx = (cardIndex: number, tone: RevealResult) => {
      setRevealFxByCard((prev) => ({ ...prev, [cardIndex]: tone }))
      const fxTimeout = window.setTimeout(() => {
        setRevealFxByCard((prev) => {
          const next = { ...prev }
          delete next[cardIndex]
          return next
        })
        revealFxTimeoutsRef.current = revealFxTimeoutsRef.current.filter((id) => id !== fxTimeout)
      }, 900)
      revealFxTimeoutsRef.current.push(fxTimeout)
    }

    setPendingReveals((prev) => {
      const next = new Set(prev)
      next.add(idx)
      return next
    })

    const timeoutId = window.setTimeout(() => {
      revealTimeoutsRef.current = revealTimeoutsRef.current.filter((activeId) => activeId !== timeoutId)

      setPendingReveals((prev) => {
        const next = new Set(prev)
        next.delete(idx)
        return next
      })

      setRevealed((prev) => {
        const next = new Set(prev)
        next.add(idx)
        return next
      })

      if (card.cls === 'isBlue') {
        setBlueRemaining((prev) => Math.max(0, prev - 1))
      }

      if (card.cls === 'isRed') {
        setRedRemaining((prev) => Math.max(0, prev - 1))
      }

      if (card.assassin) {
        setRevealResultByCard((prev) => ({ ...prev, [idx]: 'assassin' }))
        setRevealFx(idx, 'assassin')
        const nextWinner = teamAtPick === 'blue' ? 'red' : 'blue'
        setWinner(nextWinner)
        addToast(`Assassin picked. ${nextWinner.toUpperCase()} wins.`, 'danger')
        return
      }

      if (card.cls === teamClass) {
        setRevealResultByCard((prev) => ({ ...prev, [idx]: 'correct' }))
        setRevealFx(idx, 'correct')
        addToast(`${teamAtPick.toUpperCase()} found their agent.`, 'success')
        return
      }

      if (card.cls === enemyClass) {
        setRevealResultByCard((prev) => ({ ...prev, [idx]: 'wrong' }))
        setRevealFx(idx, 'wrong')
        addToast(`${teamAtPick.toUpperCase()} hit enemy agent. Turn passes.`, 'warning')
        switchTurn()
        return
      }

      setRevealResultByCard((prev) => ({ ...prev, [idx]: 'wrong' }))
      setRevealFx(idx, 'wrong')
      addToast('Neutral card revealed. Turn passes.', 'info')
      switchTurn()
    }, 1000)

    revealTimeoutsRef.current.push(timeoutId)
  }

  useEffect(() => {
    if (blueRemaining === 0) {
      setWinner('blue')
      addToast('BLUE cleared all agents and wins.', 'success')
    }
  }, [blueRemaining])

  useEffect(() => {
    if (redRemaining === 0) {
      setWinner('red')
      addToast('RED cleared all agents and wins.', 'success')
    }
  }, [redRemaining])

  const activeTurnLabel = currentTeam.toUpperCase()
  return (
    <div className="scene">
      <div className="frame">
        <div className="toastStack" aria-live="polite" aria-label="Game events">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.tone}`}>
              {toast.text}
            </div>
          ))}
        </div>

        <div className="layout">
          <div className="hud">
            <div className="hudbar">
              <button className="hudIconBtn" type="button" onClick={onBackToHome} aria-label="Go to lobby" title="Lobby">
                <span className="hudIcon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" role="img" focusable="false">
                    <path d="M3 10.5L12 3l9 7.5" />
                    <path d="M5 9.75V21h14V9.75" />
                    <path d="M10 21v-6h4v6" />
                  </svg>
                </span>
              </button>

              <button className="hudIconBtn" type="button" onClick={onOpenProfile} aria-label="Open profile" title="Profile">
                <span className="hudIcon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" role="img" focusable="false">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21c0-3.9 3.6-7 8-7s8 3.1 8 7" />
                  </svg>
                </span>
              </button>

              <button className="hudIconBtn" type="button" onClick={onOpenSettings} aria-label="Open settings" title="Settings">
                <span className="hudIcon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" role="img" focusable="false">
                    <circle cx="12" cy="12" r="3.25" />
                    <path d="M19.4 15a1.75 1.75 0 0 0 .35 1.93l.07.08a2 2 0 1 1-2.82 2.82l-.08-.07a1.75 1.75 0 0 0-1.93-.35 1.75 1.75 0 0 0-1.06 1.6V21a2 2 0 1 1-4 0v-.12a1.75 1.75 0 0 0-1.06-1.6 1.75 1.75 0 0 0-1.93.35l-.08.07a2 2 0 1 1-2.82-2.82l.07-.08A1.75 1.75 0 0 0 4.6 15a1.75 1.75 0 0 0-1.6-1.06H3a2 2 0 1 1 0-4h.12a1.75 1.75 0 0 0 1.6-1.06 1.75 1.75 0 0 0-.35-1.93l-.07-.08a2 2 0 1 1 2.82-2.82l.08.07a1.75 1.75 0 0 0 1.93.35h.01A1.75 1.75 0 0 0 10.2 3H10a2 2 0 1 1 4 0h-.12a1.75 1.75 0 0 0 1.6 1.06h.01a1.75 1.75 0 0 0 1.93-.35l.08-.07a2 2 0 1 1 2.82 2.82l-.07.08a1.75 1.75 0 0 0-.35 1.93v.01A1.75 1.75 0 0 0 21 10.2h.12a2 2 0 1 1 0 4H21a1.75 1.75 0 0 0-1.6 1.06V15z" />
                  </svg>
                </span>
              </button>

              <div className={`plate blue ${currentTeam === 'blue' && isTurnPulseOn ? 'turnPulse' : ''}`} aria-label="Blue remaining">
                {blueRemaining}
              </div>

              <div className="centerHud">
                <div className="modeTitle">Classic 5x5</div>

                <div className="powerMiniRow" aria-label="Powers status">
                  <div className="miniChip">
                    <span className="chipLabel">Streak</span>
                    <span className="chipValue">0/4</span>
                  </div>

                  <div className="miniChip">
                    <span className="chipLabel">Dice</span>
                    <span className="chipValue locked">Locked</span>
                  </div>

                  <div className="miniChip">
                    <span className="chipLabel">Helpers</span>
                    <span className="chipValue">3</span>
                  </div>
                </div>
              </div>

              <div className={`plate red ${currentTeam === 'red' && isTurnPulseOn ? 'turnPulse' : ''}`} aria-label="Red remaining">
                {redRemaining}
              </div>
            </div>
          </div>

          <aside className={`side blue ${currentTeam === 'blue' ? 'isActiveTurn' : ''}`}>
            <div className="roleCard">
              <div className="roleHead blueStrip">
                <div className="roleTitle">Team Blue</div>
                <div className="teamPill blue">{blueRemaining} left</div>
              </div>

              <div className="userRow">
                <div className="namer">
                  <div className="avatar">
                    <img src="/assets/avatars/blue-operative.png" alt="Blue Player" />
                  </div>
                  <div className="userMeta">
                    <div className="userName">Moutaz</div>
                    <div className="userSub">Guessers</div>
                  </div>
                </div>
              </div>

              <div className="miniInfo">
                <div className="miniLine">
                  <span className="miniLabel">Turn</span>
                  <span className="turnPill blue">{currentTeam === 'blue' ? 'BLUE' : 'WAIT'}</span>
                </div>

                <div className="miniLine">
                  <span className="miniLabel">Guesses left</span>
                  <span className="miniValue">2</span>
                </div>
              </div>
            </div>

            <div className="roleCard">
              <div className="roleHead">
                <div className="roleTitle">Spymaster</div>
                <div className="teamPill">Hint</div>
              </div>

              <div className="userRow">
                <div className="namer">
                  <div className="avatar">
                    <img src="/assets/avatars/blue-spymaster.png" alt="Blue Spymaster" />
                  </div>
                  <div className="userMeta">
                    <div className="userName">Enkido</div>
                    <div className="userSub">Gives clue</div>
                  </div>
                </div>
              </div>

              <div className="hintReadout">
                <div className="hintLabel">Current clue</div>
                <div className="hintValue">???? • 2</div>
              </div>
            </div>

            <div className="roleCard">
              <div className="roleHead blueStrip">
                <div className="roleTitle">Powers</div>
                <div className="teamPill blue">Once/Unlock</div>
              </div>

              <div className="powerBlock">
                <div className="powerHeader">
                  <div className="powerName">Streak</div>
                  <div className="powerNote">Unlock dice at 4 correct links</div>
                </div>

                <div className="streakRow" aria-label="Streak meter">
                  <div className="streakLabel">0 / 4</div>
                  <div className="streakDots">
                    <span className="dot"></span>
                    <span className="dot"></span>
                    <span className="dot"></span>
                    <span className="dot"></span>
                  </div>
                </div>
              </div>

              <div className="powerBlock">
                <div className="powerHeader">
                  <div className="powerName">Dice</div>
                  <div className="powerNote">
                    <span className="lockedText">Locked until streak</span>
                  </div>
                </div>

                <div className="diceRow">
                  <button className="powerBtn powerBtnPurple" type="button" disabled>
                    <span className="btnIco">
                      <img src="/assets/icons/dice.svg" alt="" />
                    </span>
                    Roll Dice
                  </button>
                  <div className="diceHint">Roll gives 1 effect (see list below)</div>
                </div>
              </div>

              <div className="powerBlock">
                <div className="powerHeader">
                  <div className="powerName">Helper Actions</div>
                  <div className="powerNote">Each once per game</div>
                </div>

                <div className="helperGrid">
                  <button className="helperBtn" type="button">
                    <span className="btnIco">
                      <img src="/assets/icons/time.svg" alt="" />
                    </span>
                    Time Cut
                  </button>

                  <button className="helperBtn" type="button">
                    <span className="btnIco">
                      <img src="/assets/icons/peek.svg" alt="" />
                    </span>
                    Random Peek
                  </button>

                  <button className="helperBtn" type="button">
                    <span className="btnIco">
                      <img src="/assets/icons/shuffle.svg" alt="" />
                    </span>
                    Shuffle
                  </button>
                </div>
              </div>
            </div>
          </aside>

          <main className="center">
            <div className="boardTop">
              <div className="hintBar">
                <div className="hintLabel">Current clue</div>
                <div className="hintValue">???? • 2</div>
              </div>

              <div className={`turnChip ${currentTeam === 'blue' ? 'blueTurn' : 'redTurn'} ${isTurnPulseOn ? 'turnPulse' : ''}`}>
                Turn <span className={`turnBadge ${currentTeam === 'red' ? 'red' : ''}`}>{activeTurnLabel}</span>
              </div>
            </div>

            <section className="grid" aria-label="5x5 grid">
              {cards.map((c, idx) => {
                const isRevealed = revealed.has(idx)
                return (
                  <button
                    key={`${c.img}-${idx}`}
                    type="button"
                    className={`card ${pendingReveals.has(idx) ? 'isPendingReveal' : ''} ${isRevealed ? 'isRevealed' : 'isHiddenCard'} ${revealFxByCard[idx] ? `fx-${revealFxByCard[idx]}` : ''} ${revealResultByCard[idx] ? `revealed-${revealResultByCard[idx]}` : ''}`.trim()}
                    onClick={() => handleReveal(idx)}
                    disabled={gameOver || hasPendingReveal}
                    aria-label={`Reveal card ${idx + 1}`}
                  >
                    <div className="cardInner">
                      <div className="cardFace cardFront">
                        <div className="cardImg" style={{ backgroundImage: `url('/assets/cards/${c.img}.jpg')` }}></div>
                        <div className="cardTxt">{c.txt}</div>
                      </div>

                      <div className={`cardFace cardBack ${c.cls}`}>
                        <div className="cardImg" style={{ backgroundImage: `url('/assets/cards/${c.img}.jpg')` }}></div>
                        <div className="cardTxt">{c.txt}</div>
                        {c.assassin ? (
                          <div className="assassinMark" aria-hidden="true">
                            ?
                          </div>
                        ) : null}
                        {isRevealed && revealResultByCard[idx] === 'wrong' ? (
                          <div className="wrongMark" aria-hidden="true">
                            Wrong
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </button>
                )
              })}
            </section>

            <div className="bottomBar">
              <button className="bigBtn endTurn" type="button" onClick={endTurn} disabled={gameOver || hasPendingReveal}>
                {gameOver ? `${winner.toUpperCase()} Wins` : 'End Turn'}
              </button>

              <div className="clueDock bottomClueDock" aria-label="Clue input">
                <div className="clueTag">CLUE</div>
                <input className="clueInput" defaultValue="????" aria-label="Clue word" />
                <div className="clueTag">#</div>
                <input className="numInput" defaultValue="2" aria-label="Clue number" />
                <button className="sendBtn" type="button">
                  Send
                </button>
              </div>
            </div>
          </main>

          <aside className={`side red ${currentTeam === 'red' ? 'isActiveTurn' : ''}`}>
            <div className="roleCard">
              <div className="roleHead redStrip">
                <div className="roleTitle">Team Red</div>
                <div className="teamPill red">{redRemaining} left</div>
              </div>

              <div className="userRow">
                <div className="namer">
                  <div className="avatar">
                    <img src="/assets/avatars/red-operative.png" alt="Red Player" />
                  </div>
                  <div className="userMeta">
                    <div className="userName">Acrab</div>
                    <div className="userSub">Guessers</div>
                  </div>
                </div>
                <div className="namer">
                  <div className="avatar">
                    <img src="/assets/avatars/red-spymaster.jpg" alt="Red Spymaster" />
                  </div>
                  <div className="userMeta">
                    <div className="userName">Wadhah</div>
                    <div className="userSub">Gives clue</div>
                  </div>
                </div>
              </div>

              <div className="miniInfo">
                <div className="miniLine">
                  <span className="miniLabel">Turn</span>
                  <span className={`turnPill ${currentTeam === 'red' ? 'red' : ''}`}>{currentTeam === 'red' ? 'RED' : 'WAIT'}</span>
                </div>

                <div className="miniLine">
                  <span className="miniLabel">Guesses left</span>
                  <span className="miniValue">—</span>
                </div>
              </div>
            </div>

            <div className="roleCard">
              <div className="roleHead">
                <div className="roleTitle">Spymaster</div>
                <div className="teamPill">Hint</div>
              </div>

              <div className="userRow">
                <div className="namer">
                  <div className="avatar">
                    <img src="/assets/avatars/red-spymaster.jpg" alt="Red Spymaster" />
                  </div>
                  <div className="userMeta">
                    <div className="userName">Wadhah</div>
                    <div className="userSub">Gives clue</div>
                  </div>
                </div>
              </div>

              <div className="hintReadout">
                <div className="hintLabel">Current clue</div>
                <div className="hintValue">—</div>
              </div>
            </div>

            <div className="roleCard">
              <div className="roleHead redStrip">
                <div className="roleTitle">Powers</div>
                <div className="teamPill red">Once/Unlock</div>
              </div>

              <div className="powerBlock">
                <div className="powerHeader">
                  <div className="powerName">Streak</div>
                  <div className="powerNote">Unlock dice at 4 correct links</div>
                </div>

                <div className="streakRow" aria-label="Streak meter">
                  <div className="streakLabel">0 / 4</div>
                  <div className="streakDots">
                    <span className="dot"></span>
                    <span className="dot"></span>
                    <span className="dot"></span>
                    <span className="dot"></span>
                  </div>
                </div>
              </div>

              <div className="powerBlock">
                <div className="powerHeader">
                  <div className="powerName">Dice</div>
                  <div className="powerNote">
                    <span className="lockedText">Locked until streak</span>
                  </div>
                </div>

                <div className="diceRow">
                  <button className="powerBtn powerBtnPurple" type="button" disabled>
                    <span className="btnIco">
                      <img src="/assets/icons/dice.svg" alt="" />
                    </span>
                    Roll Dice
                  </button>
                  <div className="diceHint">Unlocked only after streak</div>
                </div>
              </div>

              <div className="powerBlock">
                <div className="powerHeader">
                  <div className="powerName">Helper Actions</div>
                  <div className="powerNote">Each once per game</div>
                </div>

                <div className="helperGrid">
                  <button className="helperBtn helperBtnDim" type="button" disabled>
                    <span className="btnIco">
                      <img src="/assets/icons/time.svg" alt="" />
                    </span>
                    Time Cut
                    <span className="helperSub">Half enemy timer</span>
                  </button>

                  <button className="helperBtn helperBtnDim" type="button" disabled>
                    <span className="btnIco">
                      <img src="/assets/icons/peek.svg" alt="" />
                    </span>
                    Random Peek
                    <span className="helperSub">Private reveal</span>
                  </button>

                  <button className="helperBtn helperBtnDim" type="button" disabled>
                    <span className="btnIco">
                      <img src="/assets/icons/shuffle.svg" alt="" />
                    </span>
                    Shuffle
                    <span className="helperSub">Shuffle unrevealed</span>
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

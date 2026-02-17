import { useLocation, useNavigate, useParams } from 'react-router-dom'
import SettingsPage from '../components/SettingsPage'

export default function SettingsRoute() {
  const location = useLocation()
  const navigate = useNavigate()
  const { code } = useParams()
  const lobbyCode = (code ?? '').trim().toUpperCase()
  const from = typeof (location.state as any)?.from === 'string' ? String((location.state as any).from) : ''

  function handleClose() {
    if (from && from !== location.pathname) {
      navigate(from)
      return
    }
    if (window.history.length > 1) {
      navigate(-1)
      return
    }
    navigate(lobbyCode ? `/lobby/${lobbyCode}` : '/')
  }

  return (
    <SettingsPage
      lobbyCode={lobbyCode}
      onClose={handleClose}
      onBackToHome={() => navigate('/')}
      onBackToGame={() => navigate(lobbyCode ? `/lobby/${lobbyCode}` : '/')}
    />
  )
}

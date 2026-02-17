import { useLocation, useNavigate } from 'react-router-dom'
import ProfilePage from '../components/ProfilePage'

export default function ProfileRoute() {
  const location = useLocation()
  const navigate = useNavigate()
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
    navigate('/')
  }

  return <ProfilePage onClose={handleClose} onBackToHome={() => navigate('/')} onBackToGame={() => navigate('/')} />
}

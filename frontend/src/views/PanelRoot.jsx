/* Painel de administração — SEPARADO do aplicativo: rota própria (/painel),
   autenticação dedicada por usuário e senha (cookie ogadmin, distinto do gymsid
   dos usuários). Acessado pelo botão "Administração" no rodapé da landing.     */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import AdminLogin from './AdminLogin.jsx'
import AdminPanel from './AdminPanel.jsx'
import '../styles/admin.css'

// Raiz da rota /painel: decide entre login dedicado e o painel, mantendo a sessão
// do painel em estado local (o cookie HttpOnly é a verdade de fato).
export default function PanelRoot() {
  const navigate = useNavigate()
  const [state, setState] = useState('checking')   // checking | out | in
  useEffect(() => {
    api('/api/panel/me').then(() => setState('in')).catch(() => setState('out'))
  }, [])
  if (state === 'checking') return (
    <div className="pa-page"><div className="pa-boot"><Icon name="dumbbell" /></div></div>
  )
  return state === 'in'
    ? <AdminPanel onOut={() => setState('out')} />
    : <AdminLogin onOk={() => setState('in')} onHome={() => navigate('/')} />
}

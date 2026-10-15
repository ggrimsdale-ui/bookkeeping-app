import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { DialogHost } from './components/Dialogs'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DialogHost>
      <App />
    </DialogHost>
  </StrictMode>
)

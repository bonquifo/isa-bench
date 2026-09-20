import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import MultiLaneApp from './lanes/MultiLaneApp.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MultiLaneApp />
  </StrictMode>,
)

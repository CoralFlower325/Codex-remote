import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';
import './reference-layout.css';
import './side-chat.css';
import './mobile-layout.css';
import { prioritizeInteraction } from './background-work';
import { pageUpdateSource } from './app-update';

window.addEventListener('pointerdown', prioritizeInteraction, { passive: true });
window.addEventListener('keydown', prioritizeInteraction);
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    window.setTimeout(() => {
      void navigator.serviceWorker.register(pageUpdateSource().script, { scope: '/', updateViaCache: 'none' }).then(registration => {
        console.debug('[app-update] registered', { active: registration.active?.state,
          waiting: registration.waiting?.state, installing: registration.installing?.state });
      }).catch(error => console.warn('[app-update] registration failed', error));
    }, 2000);
  }, { once: true });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

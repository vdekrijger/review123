import { mount } from 'svelte'
import './app.css'

// IBM Plex Sans — UI font
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'

// IBM Plex Mono — code and diff
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

// Newsreader — prose (summaries, descriptions, comment bodies)
import '@fontsource/newsreader/400.css'
import '@fontsource/newsreader/400-italic.css'
import '@fontsource/newsreader/500.css'

import App from './App.svelte'
import { initAnalytics } from './lib/analytics/analytics'
import { applyAppearance } from './lib/settings/appearance.svelte'

initAnalytics()
applyAppearance()
mount(App, { target: document.getElementById('app')! })

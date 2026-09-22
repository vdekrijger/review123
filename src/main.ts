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
import { initBridge } from './lib/bridge/bridge.svelte'
import { applyAppearance } from './lib/settings/appearance.svelte'

initAnalytics()
applyAppearance()

// Re-probe the local bridge at app start, now that inference can be routed
// through it: a review may begin long before the Settings page is ever opened,
// and the connection has to be known by then.
//
// THE SILENT-PROBE GUARANTEE IS INTACT. initBridge() reads the stored pairing
// first and returns without touching the network when there is none, so a
// visitor who has never paired still sends not one extra byte. A failure means
// "the bridge is not running", which is not news: it resolves to
// `disconnected`, with no toast and no analytics event.
void initBridge()

mount(App, { target: document.getElementById('app')! })

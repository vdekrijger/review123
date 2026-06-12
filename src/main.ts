import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { initAnalytics } from './lib/analytics/analytics'
import { applyAppearance } from './lib/settings/appearance.svelte'

initAnalytics()
applyAppearance()
mount(App, { target: document.getElementById('app')! })

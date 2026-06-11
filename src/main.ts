import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { initAnalytics } from './lib/analytics/analytics'

initAnalytics()
mount(App, { target: document.getElementById('app')! })

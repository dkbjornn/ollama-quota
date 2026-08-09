/**
 * Ollama Cloud Quota — desktop statusbar chip.
 *
 * Shows current Ollama Cloud usage (session + weekly) as a compact chip
 * in the bottom status bar. Polls https://ollama.com/api/usage every 60s.
 *
 * No fork, no build step — drop this file in:
 *   ~/.hermes/desktop-plugins/ollama-quota/plugin.js
 * Then run "Reload desktop plugins" from ⌘K.
 */

import { cn, haptic, host, Tip, StatusDot, useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'ollama-quota'
const API_URL = 'https://ollama.com/api/usage'
const POLL_MS = 60_000

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Fetch the OLLAMA_API_KEY from the gateway's environment via shell.exec.
 * The desktop renderer can't read .env directly, so we ask the gateway
 * to extract it for us.
 */
async function fetchApiKey() {
  const cmd =
    'grep -v "^#" "${HERMES_HOME:-$HOME/.hermes}/.env" 2>/dev/null | grep OLLAMA_API_KEY | head -1 | cut -d= -f2- | tr -d \'"\''
  try {
    const res = await host.request('shell.exec', { command: cmd })
    const key = (res?.stdout ?? res?.result?.stdout ?? '').trim()
    if (key && key.length > 10) return key
  } catch {
    // fall through
  }
  return null
}

/** Fetch usage from Ollama Cloud. Returns parsed JSON or null. */
async function fetchUsage(apiKey) {
  if (!apiKey) return null
  const res = await fetch(API_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null
  return res.json()
}

/** Format a usage fraction (0–1) as a percentage string. */
function pct(fraction) {
  if (fraction == null || Number.isNaN(fraction)) return '?'
  return `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`
}

/** Pick a StatusDot tone based on usage level. */
function dotTone(fraction) {
  if (fraction == null || Number.isNaN(fraction)) return 'muted'
  if (fraction >= 0.9) return 'bad'
  if (fraction >= 0.7) return 'warn'
  return 'good'
}

/** Tooltip content with model-level breakdown. */
function buildTooltip(data) {
  if (!data) return jsx('div', { children: 'Ollama Cloud — loading…' })
  
  const elements = [
    jsx('div', { 
      key: 'title', 
      className: 'font-bold mb-1', 
      children: 'Ollama Cloud Usage' 
    })
  ]

  if (data.limits?.session) {
    const s = data.limits.session
    elements.push(jsx('div', { key: 's-title', className: 'mt-1', children: `Session: ${pct(s.usage)} used` }))
    for (const m of s.models ?? []) {
      elements.push(jsx('div', { key: `s-${m.name}`, className: 'text-left', children: `• ${m.name}: ${m.request_count} reqs` }))
    }
  }

  if (data.limits?.weekly) {
    const w = data.limits.weekly
    elements.push(jsx('div', { key: 'w-title', className: 'mt-1', children: `Weekly: ${pct(w.usage)} used` }))
    for (const m of w.models ?? []) {
      elements.push(jsx('div', { key: `w-${m.name}`, className: 'text-left', children: `• ${m.name}: ${m.request_count} reqs` }))
    }
  }

  return jsxs('div', {
    className: 'flex flex-col text-left leading-tight bg-white text-black p-2 rounded shadow-sm',
    children: elements,
  })
}

// ── Component ──────────────────────────────────────────────────────────

function OllamaQuotaChip() {
  const queryClient = useQueryClient()

  // 1. Fetch the API key once (cached for the plugin's lifetime).
  const { data: apiKey } = useQuery({
    queryKey: [ID, 'apikey'],
    queryFn: fetchApiKey,
    staleTime: Infinity,
    retry: 1,
  })

  // 2. Poll usage every 60s once we have the key.
  const { data, isLoading } = useQuery({
    queryKey: [ID, 'usage'],
    queryFn: () => fetchUsage(apiKey),
    enabled: !!apiKey,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
    retry: 2,
  })

  const sessionFrac = data?.limits?.session?.usage ?? null
  const weeklyFrac = data?.limits?.weekly?.usage ?? null
  const displayFrac = Math.max(sessionFrac ?? 0, weeklyFrac ?? 0)
  const tip = buildTooltip(data)

  return jsx(Tip, {
    label: tip,
    children: jsxs('button', {
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem]',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
        'transition-colors tabular-nums'
      ),
      type: 'button',
      onClick: () => {
        haptic('tap')
        queryClient.invalidateQueries({ queryKey: [ID, 'usage'] })
      },
      children: [
        (() => {
          const tone = dotTone(displayFrac)
          // SDK's StatusDot renders 'good' as bg-primary (the app's brand color,
          // #0053fd blue) — which is visually subtle and reads as "not green"
          // against a white status bar. Use a clear emerald dot for the safe
          // state; fall back to StatusDot for warn/bad/muted where amber/red
          // already match the design system.
          if (tone === 'good') {
            return jsx('span', {
              'aria-hidden': 'true',
              className: 'inline-block size-1.5 rounded-full bg-emerald-500',
            })
          }
          return jsx(StatusDot, { tone })
        })(),
        jsx('span', {
          className: 'font-medium',
          children: isLoading && !data
            ? 'Ollama …'
            : apiKey
              ? `Ollama ${pct(sessionFrac)}/${pct(weeklyFrac)}`
              : 'Ollama ⚠',
        }),
      ],
    }),
  })
}

// ── Plugin Registration ────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Ollama Cloud Quota',
  defaultEnabled: true,

  register(ctx) {
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 140,
      render: () => jsx(OllamaQuotaChip, {}),
    })
  },
}
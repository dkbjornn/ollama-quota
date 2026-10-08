/**
 * Ollama Cloud Quota — desktop statusbar chip.
 *
 * Shows current Ollama Cloud quota (session + weekly % used) as a compact
 * chip in the bottom status bar.
 *
 * Data sources (docs.ollama.com/api/balance, /api/cloud-usage):
 *   GET https://ollama.com/api/balance        → remaining_percent (legacy
 *     plans) or balance_usd/allowance_usd (dollar plans), resets_at
 *   GET https://ollama.com/api/usage?range=24h → time-series activity
 *
 * The pre-2026-10 /api/usage shape (limits.session.usage) is gone — the
 * remaining-quota percentages the chip displays moved to /api/balance.
 * Both endpoints are polled at ~1 req/min, under the shared 10/min cap.
 *
 * No fork, no build step — drop this file in:
 *   ~/.hermes/desktop-plugins/ollama-quota/plugin.js
 * Then bounce the plugin folder (⌘K "Reload desktop plugins" does NOT
 * re-read an already-tracked file).
 */

import { useState } from 'react'
import { cn, haptic, host, Popover, PopoverContent, PopoverTrigger, StatusDot, useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'ollama-quota'
const BALANCE_URL = 'https://ollama.com/api/balance'
const USAGE_URL = 'https://ollama.com/api/usage?range=24h'
const POLL_MS = 60_000

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Fetch the OLLAMA_API_KEY via shell.exec (the renderer can't read .env).
 *
 * IMPORTANT: strip quotes in JS, NOT with `tr -d "\x27"` — macOS BSD tr
 * has no \x escape support and deletes the literal characters \ x 2 7,
 * corrupting any key containing a 2, 7 or x (silently → 401 downstream).
 *
 * Walker order: active profile .env → every profile .env → ~/.hermes/.env.
 * Only anchored `^OLLAMA_API_KEY=` lines match, so commented doc lines and
 * OLLAMA_BASE_URL etc. are ignored. Value validation happens in JS.
 */
async function fetchApiKey() {
  // `| cut -d= -f2-` on EVERY grep: the gateway masks `NAME=value` output to
  // `NAME=***` but passes bare values through — cut alone is safe. Do NOT
  // pipe through tr (BSD tr has no \x escapes and mangles keys) or sed.
  const cmd = [
    'if [ -n "$HERMES_PROFILE" ] && [ -f "$HOME/.hermes/profiles/$HERMES_PROFILE/.env" ]; then grep -h "^OLLAMA_API_KEY=" "$HOME/.hermes/profiles/$HERMES_PROFILE/.env" | cut -d= -f2-; fi',
    'for f in "$HOME"/.hermes/profiles/*/.env; do [ -f "$f" ] && grep -h "^OLLAMA_API_KEY=" "$f" | cut -d= -f2-; done',
    'grep -h "^OLLAMA_API_KEY=" "${HERMES_HOME:-$HOME/.hermes}/.env" 2>/dev/null | cut -d= -f2-',
  ].join('\n')
  try {
    const res = await host.request('shell.exec', { command: cmd })
    const stdout = (res?.stdout ?? res?.result?.stdout ?? '')
    for (const line of stdout.split('\n')) {
      const raw = line.trim()
      if (!raw || raw.startsWith('#')) continue
      // Lines arrive bare (cut strips "KEY="); tolerate a KEY= prefix too.
      const key = (raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw)
        .replace(/^["']+/, '')
        .replace(/["']+$/, '')
        .trim()
      // Plausible key: 40–200 printable chars, no spaces, has a dot, and
      // not a docs placeholder like "your_ollama_key_here."
      if (
        key.length >= 40 &&
        key.length <= 200 &&
        !/\s/.test(key) &&
        key.includes('.') &&
        /^[\x21-\x7E]+$/.test(key) &&
        !/^your/i.test(key)
      ) {
        return key
      }
    }
  } catch {
    // fall through
  }
  return null
}

/** One gateway-curl JSON GET. Returns parsed body, or {error}. */
async function curlJson(apiKey, url) {
  const escaped = apiKey.replace(/'/g, "'\\''")
  const cmd = "curl -sS -m 10 -H 'Authorization: Bearer " + escaped + "' '" + url + "'"
  try {
    const res = await host.request('shell.exec', { command: cmd })
    const stdout = (res?.stdout ?? res?.result?.stdout ?? '').trim()
    if (!stdout) return { error: 'empty response' }
    let body
    try {
      body = JSON.parse(stdout)
    } catch {
      return { error: 'unparseable response' }
    }
    if (body && body.error) {
      return { error: typeof body.error === 'string' ? body.error : JSON.stringify(body.error) }
    }
    return body
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) }
  }
}

/**
 * Poll quota + activity. Balance carries the quota percentages the chip
 * displays; usage?range=24h carries recent request/cost activity.
 */
async function fetchQuota(apiKey) {
  if (!apiKey) return null
  const [bal, use] = await Promise.all([
    curlJson(apiKey, BALANCE_URL),
    curlJson(apiKey, USAGE_URL),
  ])
  if (bal?.error) return { error: bal.error }
  const inc = bal?.included ?? {}
  const out = {
    purchasedUsd: bal?.purchased?.balance_usd ?? null,
    requests24h: use?.totals?.request_count ?? null,
    usageUsd24h: use?.totals?.usage_usd ?? null,
    legacy: false,
  }
  if (inc && typeof inc.session?.remaining_percent === 'number') {
    // Legacy plan: session/weekly percent windows.
    out.legacy = true
    out.sessionUsed = 100 - inc.session.remaining_percent
    out.sessionResets = inc.session.resets_at ?? null
    out.weeklyUsed = inc.weekly && typeof inc.weekly.remaining_percent === 'number'
      ? 100 - inc.weekly.remaining_percent
      : null
    out.weeklyResets = inc.weekly?.resets_at ?? null
  } else if (inc && typeof inc.balance_usd === 'number') {
    // Dollar-balance plan.
    const allow = typeof inc.allowance_usd === 'number' ? inc.allowance_usd : null
    out.planUsed = allow ? 100 * (1 - inc.balance_usd / allow) : null
    out.includedUsd = inc.balance_usd
    out.allowanceUsd = allow
    out.periodEnds = inc.period?.until ?? null
  }
  return out
}

/** Format a used-fraction (0–1) as a percentage string. */
function pct(fraction) {
  if (fraction == null || Number.isNaN(fraction)) return '?'
  return `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`
}

/** Pick a StatusDot tone from the worst (highest) used fraction. */
function dotTone(fraction) {
  if (fraction == null || Number.isNaN(fraction)) return 'muted'
  if (fraction >= 0.9) return 'bad'
  if (fraction >= 0.7) return 'warn'
  return 'good'
}

/** "2026-10-08T04:00:00Z" → "04:00Z" (same day) or "Oct 12" (further out). */
function fmtResets(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const now = new Date()
  const sameDay = d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate()
  if (sameDay) {
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    return `${hh}:${mm}Z`
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Tooltip rows for the balance/usage payload. */
function buildTooltip(data) {
  const rows = []
  if (!data) {
    rows.push(jsx('div', { key: 'load', children: 'Ollama Cloud — loading…' }))
  } else if (data.error) {
    rows.push(jsx('div', { key: 'err', children: `⚠ API error: ${data.error}` }))
  } else {
    if (data.legacy) {
      if (data.sessionUsed != null) {
        const r = fmtResets(data.sessionResets)
        rows.push(jsx('div', { key: 's', children: `Session: ${pct(data.sessionUsed / 100)} used${r ? ` · resets ${r}` : ''}` }))
      }
      if (data.weeklyUsed != null) {
        const r = fmtResets(data.weeklyResets)
        rows.push(jsx('div', { key: 'w', children: `Weekly: ${pct(data.weeklyUsed / 100)} used${r ? ` · resets ${r}` : ''}` }))
      }
    } else if (data.planUsed != null) {
      const r = fmtResets(data.periodEnds)
      rows.push(jsx('div', { key: 'p', children: `Plan: ${pct(data.planUsed / 100)} used${r ? ` · resets ${r}` : ''}` }))
      if (data.includedUsd != null) {
        rows.push(jsx('div', { key: 'bal', children: `Included balance: $${Number(data.includedUsd).toFixed(2)}` }))
      }
    } else {
      rows.push(jsx('div', { key: 'unk', children: 'Balance format not recognized' }))
    }
    if (data.purchasedUsd > 0) {
      rows.push(jsx('div', { key: 'pur', children: `Purchased credits: $${Number(data.purchasedUsd).toFixed(2)}` }))
    }
    if (data.requests24h != null) {
      const usd = data.usageUsd24h != null ? ` · $${Number(data.usageUsd24h).toFixed(4)}` : ''
      rows.push(jsx('div', { key: 'act', children: `Last 24h: ${data.requests24h} requests${usd}` }))
    }
  }
  rows.unshift(jsx('div', { key: 'title', className: 'font-bold mb-1', children: 'Ollama Cloud Usage' }))
  return jsxs('div', {
    className: 'flex flex-col items-start text-left leading-tight gap-0.5',
    children: rows,
  })
}

// ── Component ──────────────────────────────────────────────────────────

function OllamaQuotaChip() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  // 1. Fetch the API key — SELF-HEALING: keep probing while null, stop once
  //    a key lands. queryKey carries a version because the react-query cache
  //    SURVIVES plugin reloads; a null pinned by an older revision would
  //    poison every reload. Bump v4 ← v3: quote-strip moved out of the shell
  //    (BSD tr mangled keys containing 2/7/x) + placeholder rejection.
  const { data: apiKey } = useQuery({
    queryKey: [ID, 'apikey', 'v4'],
    queryFn: fetchApiKey,
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
    refetchInterval: (query) => (query?.state?.data ? false : 15_000),
    retry: 2,
  })

  // 2. Poll balance + activity every 60s once we have the key. v4: legacy
  //    limits-based /api/usage parsing replaced with /api/balance + 24h activity.
  const { data, isLoading } = useQuery({
    queryKey: [ID, 'quota', 'v4'],
    queryFn: () => fetchQuota(apiKey),
    enabled: !!apiKey,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
    retry: 2,
  })

  const worstFrac = data?.legacy
    ? Math.max(data.sessionUsed ?? 0, data.weeklyUsed ?? 0)
    : data?.planUsed ?? null
  const sessionLabel = data?.legacy
    ? pct((data.sessionUsed ?? 0) / 100)
    : data?.planUsed != null
      ? pct(data.planUsed / 100)
      : '?'
  const weeklyLabel = data?.legacy ? pct((data.weeklyUsed ?? 0) / 100) : null
  const tip = buildTooltip(data)

  // Use Popover (hover-managed): Tip's box-decoration-clone + [&>*]:!inline
  // rendering collapses block content into an unstyled inline strip.
  return jsx(Popover, {
    open: open,
    onOpenChange: setOpen,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        children: jsxs('button', {
          className: cn(
            'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem]',
            'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
            'transition-colors tabular-nums'
          ),
          type: 'button',
          onClick: () => {
            haptic('tap')
            queryClient.invalidateQueries({ queryKey: [ID, 'quota'] })
          },
          children: [
            (() => {
              const tone = dotTone(worstFrac / 100)
              // SDK's StatusDot 'good' is brand-blue (#0053fd) which reads as
              // "invisible" on the status bar — use a clear emerald dot for
              // the safe state; StatusDot for warn/bad/muted.
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
                  ? data?.error
                    ? 'Ollama ⚠ (API error)'
                    : weeklyLabel != null
                      ? `Ollama ${sessionLabel}/${weeklyLabel}`
                      : `Ollama ${sessionLabel}`
                  : 'Ollama ⚠ (no key)',
            }),
          ],
        }),
      }),
      jsx(PopoverContent, {
        side: 'top',
        align: 'end',
        className: 'w-auto max-w-xs text-[11px]',
        children: tip,
      }),
    ],
  })
}

// ── Plugin Registration ─────────────────────────────────────────────---

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
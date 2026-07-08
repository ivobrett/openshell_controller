"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { apiFetch, ApiError } from "@/app/lib/apiFetch"

// §12.3 — the xterm + socket machinery extracted from operator-terminal/page.tsx
// so it is testable and reusable by the future mobile app. Server side is a
// do-not-touch boundary: sessions survive socket drops (200 kB replay buffer,
// keyed by sessionId), and the terminal server silently ignores unknown WS
// message types, so a client `{type:"ping"}` keepalive is safe with zero
// server change.

// Backoff schedule for auto-reconnect (5 attempts), §12.3(a).
const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 15000]
const KEEPALIVE_INTERVAL_MS = 25000

export type TerminalConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "failed"
  | "error"

interface LiveSessionResponse {
  ok: boolean
  sessionId: string
  sandboxId: string
  dashboardSessionId?: string
  replay?: string
  transport?: string
  websocketUrl: string
  sshHostAlias?: string
  error?: string
}

interface LiveSession {
  websocketUrl: string
  replay?: string
  transport?: string
  sandboxId: string
  generation: number
}

export interface UseTerminalConnectionArgs {
  sandboxId: string | null
  dashboardSessionId: string
  fontSize: number
}

export interface UseTerminalConnectionResult {
  containerRef: React.RefObject<HTMLDivElement>
  state: TerminalConnectionState
  statusText: string
  reconnectAttempt: number
  exitCode: number | null
  sessionId: string | null
  ctrlLatched: boolean
  /** Start a brand new shell (fresh sessionId). Used from the ended banner. */
  startNewSession: () => void
  /** Manual reconnect after the backoff schedule is exhausted (failed state). */
  reconnect: () => void
  /** Send a raw byte sequence (used by the mobile key bar). */
  sendInput: (seq: string) => void
  /** Toggle the Ctrl latch: the next printable key becomes a control code. */
  toggleCtrl: () => void
  /** Re-fit the terminal to its container (e.g. after a layout change). */
  fit: () => void
}

export function useTerminalConnection({
  sandboxId,
  dashboardSessionId,
  fontSize,
}: UseTerminalConnectionArgs): UseTerminalConnectionResult {
  const [state, setState] = useState<TerminalConnectionState>("connecting")
  const [statusText, setStatusText] = useState("Initializing live terminal session…")
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [ctrlLatched, setCtrlLatched] = useState(false)
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null)
  const [terminalReady, setTerminalReady] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<InstanceType<typeof import("xterm")["Terminal"]> | null>(null)
  const fitAddonRef = useRef<InstanceType<typeof import("xterm-addon-fit")["FitAddon"]> | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const liveSessionIdRef = useRef<string>("")
  const liveRequestRef = useRef<Promise<void> | null>(null)
  const generationRef = useRef(0)
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const manualCloseRef = useRef(false)
  const endedRef = useRef(false)
  const stateRef = useRef<TerminalConnectionState>("connecting")
  const ctrlLatchRef = useRef(false)

  const setConnectionState = useCallback((next: TerminalConnectionState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }

  // Allocate (or re-attach to) the server-side session. On a reconnect the same
  // sessionId is re-sent (liveSessionIdRef is NOT cleared) so the server
  // replays the scrollback buffer — this is what preserves state across drops.
  const ensureLiveSession = useCallback(
    async ({ reset = false }: { reset?: boolean } = {}) => {
      if (liveRequestRef.current) return liveRequestRef.current
      if (reset) {
        // Fresh shell: drop the sessionId so the server allocates a new one.
        endedRef.current = false
        manualCloseRef.current = true
        liveSessionIdRef.current = ""
        socketRef.current?.close()
        reconnectAttemptRef.current = 0
        setReconnectAttempt(0)
        setExitCode(null)
      }
      setConnectionState(stateRef.current === "reconnecting" ? "reconnecting" : "connecting")

      const request = (async () => {
        try {
          const previousSessionId = liveSessionIdRef.current
          const result = await apiFetch<LiveSessionResponse>("/api/openshell/terminal/live", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sandboxId,
              sessionId: liveSessionIdRef.current,
              dashboardSessionId,
            }),
          })
          if (!result.ok) {
            setConnectionState("error")
            setStatusText(result.error || "Failed to initialize live terminal session.")
            return
          }
          liveSessionIdRef.current = result.sessionId
          setSessionId(result.sessionId)
          // §12.3(a): a NEW sessionId when we sent a non-empty one means the
          // server evicted our old session (max 24, oldest first).
          if (previousSessionId && result.sessionId !== previousSessionId && !reset) {
            toast.info("Previous session expired — started a new shell.")
          }
          generationRef.current += 1
          setLiveSession({
            websocketUrl: result.websocketUrl,
            replay: result.replay,
            transport: result.transport,
            sandboxId: result.sandboxId,
            generation: generationRef.current,
          })
        } catch (error) {
          // apiFetch redirects to /login on 401 itself; other errors surface here.
          if (error instanceof ApiError && error.status === 401) return
          setConnectionState("error")
          setStatusText(error instanceof Error ? error.message : "Failed to initialize live terminal session.")
        }
      })()

      liveRequestRef.current = request
      try {
        await request
      } finally {
        liveRequestRef.current = null
      }
    },
    [dashboardSessionId, sandboxId, setConnectionState],
  )

  const scheduleReconnect = useCallback(() => {
    clearReconnectTimer()
    const attempt = reconnectAttemptRef.current
    if (attempt >= RECONNECT_BACKOFF.length) {
      setConnectionState("failed")
      setStatusText("Terminal disconnected. Reconnect to try again.")
      return
    }
    const delay = RECONNECT_BACKOFF[attempt]
    reconnectAttemptRef.current = attempt + 1
    setReconnectAttempt(attempt + 1)
    setConnectionState("reconnecting")
    setStatusText(`Reconnecting… attempt ${attempt + 1}/${RECONNECT_BACKOFF.length}`)
    reconnectTimerRef.current = window.setTimeout(() => {
      // Same sessionId is reused (no reset) → server replays scrollback.
      ensureLiveSession()
    }, delay)
  }, [ensureLiveSession, setConnectionState])

  // Wake-from-sleep fix (§12.3a): reconnect immediately, attempt counter reset.
  const reconnectNow = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) return
    if (endedRef.current || stateRef.current === "ended") return
    clearReconnectTimer()
    reconnectAttemptRef.current = 0
    setReconnectAttempt(0)
    ensureLiveSession()
  }, [ensureLiveSession])

  const startNewSession = useCallback(() => {
    endedRef.current = false
    setExitCode(null)
    ensureLiveSession({ reset: true })
  }, [ensureLiveSession])

  const reconnect = useCallback(() => {
    reconnectAttemptRef.current = 0
    setReconnectAttempt(0)
    ensureLiveSession()
  }, [ensureLiveSession])

  const sendInput = useCallback((seq: string) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "input", data: seq }))
    }
  }, [])

  const toggleCtrl = useCallback(() => {
    ctrlLatchRef.current = !ctrlLatchRef.current
    setCtrlLatched(ctrlLatchRef.current)
  }, [])

  const fit = useCallback(() => {
    try {
      fitAddonRef.current?.fit()
    } catch {
      // xterm fit throws when the container has no layout yet.
    }
    if (socketRef.current?.readyState === WebSocket.OPEN && termRef.current) {
      socketRef.current.send(
        JSON.stringify({ type: "resize", cols: termRef.current.cols, rows: termRef.current.rows }),
      )
    }
  }, [])

  // Kick off the first allocation.
  useEffect(() => {
    ensureLiveSession()
  }, [ensureLiveSession])

  // Create the xterm instance once the container is mounted.
  useEffect(() => {
    if (!containerRef.current || termRef.current) return
    let disposed = false
    let cleanupListeners: (() => void) | null = null

    ;(async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("xterm"),
        import("xterm-addon-fit"),
      ])
      if (disposed || !containerRef.current) return
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize,
        theme: { background: "#000000", foreground: "#f5f5f5", cursor: "#76b900" },
        scrollback: 5000,
        allowTransparency: false,
        // Treat bare LF as CRLF. The terminal server can fall back to a stream
        // transport (no PTY line discipline), so shell output that uses '\n'
        // without '\r' — e.g. the OpenClaw policy banner printed on login —
        // would otherwise staircase across the screen. Safe for PTY sessions
        // too (their output already carries '\r').
        convertEol: true,
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(containerRef.current)
      requestAnimationFrame(() => {
        try {
          fitAddon.fit()
        } catch {
          /* no layout yet */
        }
      })
      term.focus()
      termRef.current = term
      fitAddonRef.current = fitAddon
      setTerminalReady(true)

      // Ctrl-latch (§12.3d): when latched, the next printable char is sent as a
      // control code (charCode & 0x1f), then the latch clears.
      term.onData((data) => {
        if (ctrlLatchRef.current && data.length === 1) {
          const code = data.charCodeAt(0)
          ctrlLatchRef.current = false
          setCtrlLatched(false)
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(
              JSON.stringify({ type: "input", data: String.fromCharCode(code & 0x1f) }),
            )
          }
          return
        }
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({ type: "input", data }))
        }
      })

      const focusTerminal = () => term.focus()
      containerRef.current.addEventListener("click", focusTerminal)

      const handleResize = () => fit()
      window.addEventListener("resize", handleResize)
      const resizeObserver = new ResizeObserver(handleResize)
      resizeObserver.observe(containerRef.current)
      // Soft-keyboard handling (§12.3d): the visual viewport shrinks when the
      // on-screen keyboard opens; re-fit so the prompt stays visible.
      const vv = window.visualViewport
      vv?.addEventListener("resize", handleResize)

      cleanupListeners = () => {
        window.removeEventListener("resize", handleResize)
        vv?.removeEventListener("resize", handleResize)
        resizeObserver.disconnect()
        containerRef.current?.removeEventListener("click", focusTerminal)
      }
    })().catch((error) => {
      setConnectionState("error")
      setStatusText(error instanceof Error ? error.message : "Failed to load terminal renderer.")
    })

    return () => {
      disposed = true
      cleanupListeners?.()
      manualCloseRef.current = true
      socketRef.current?.close()
      termRef.current?.dispose()
      termRef.current = null
      fitAddonRef.current = null
      setTerminalReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply font-size changes live.
  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.fontSize = fontSize
    fit()
  }, [fontSize, fit])

  // Connect (and reconnect) the socket whenever a live session is (re)allocated.
  useEffect(() => {
    if (!terminalReady || !liveSession?.websocketUrl || !termRef.current) return
    const term = termRef.current
    const previousSocket = socketRef.current
    if (previousSocket && previousSocket.readyState !== WebSocket.CLOSED) {
      previousSocket.close()
    }
    term.reset()
    if (liveSession.replay) term.write(liveSession.replay)

    const socket = new WebSocket(liveSession.websocketUrl)
    socketRef.current = socket
    manualCloseRef.current = false

    let keepalive: number | null = null

    socket.addEventListener("open", () => {
      if (socketRef.current !== socket) return
      const wasReconnecting = stateRef.current === "reconnecting"
      reconnectAttemptRef.current = 0
      setReconnectAttempt(0)
      setConnectionState("connected")
      const transportLabel = liveSession.transport ? ` via ${liveSession.transport}` : ""
      setStatusText(`Live terminal connected for ${liveSession.sandboxId}${transportLabel}.`)
      if (wasReconnecting) toast.success("Terminal reconnected")
      fit()
      term.focus()
      // §12.3(b) keepalive: keep intermediary proxies from idle-closing the WS.
      // The server ignores unknown message types, so this is inert server-side.
      keepalive = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN && !document.hidden) {
          socket.send(JSON.stringify({ type: "ping" }))
        }
      }, KEEPALIVE_INTERVAL_MS)
    })

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === "ready" && message.replay) {
          term.reset()
          term.write(message.replay)
        } else if (message.type === "data" && typeof message.data === "string") {
          term.write(message.data)
        } else if (message.type === "exit") {
          endedRef.current = true
          setExitCode(typeof message.exitCode === "number" ? message.exitCode : null)
          setConnectionState("ended")
          setStatusText(`Session ended (exit code ${message.exitCode ?? "unknown"}).`)
        }
      } catch {
        // ignore malformed frames
      }
    })

    socket.addEventListener("close", () => {
      if (keepalive !== null) window.clearInterval(keepalive)
      if (socketRef.current !== socket) return
      // Superseded / user-initiated / clean exit → do not reconnect.
      if (manualCloseRef.current || endedRef.current || stateRef.current === "ended") return
      scheduleReconnect()
    })

    socket.addEventListener("error", () => {
      // Let the close handler drive the reconnect state machine.
    })

    return () => {
      if (keepalive !== null) window.clearInterval(keepalive)
      manualCloseRef.current = true
      socket.close()
      if (socketRef.current === socket) socketRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSession, terminalReady])

  // Wake-from-sleep + network-restored listeners (§12.3a).
  useEffect(() => {
    const onOnline = () => reconnectNow()
    const onVisibility = () => {
      if (!document.hidden) reconnectNow()
    }
    window.addEventListener("online", onOnline)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("online", onOnline)
      document.removeEventListener("visibilitychange", onVisibility)
      clearReconnectTimer()
    }
  }, [reconnectNow])

  return {
    containerRef,
    state,
    statusText,
    reconnectAttempt,
    exitCode,
    sessionId,
    ctrlLatched,
    startNewSession,
    reconnect,
    sendInput,
    toggleCtrl,
    fit,
  }
}

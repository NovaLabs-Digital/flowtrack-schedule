"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatState, DemoRole } from "@/lib/demoSession/client";
import { CHAT_MAX_CHARS } from "@/lib/demoSession/chat";
import { MARGIN, placeCard, type Point, type Rect } from "@/app/components/demo-session/chatPlacement";

// Guided Demo Session chat card (migration 046): a floating, draggable,
// minimizable two-way chat between the host and the guest, usable for the
// whole live session -- including while the guest is watch-only.
//
// - Local only: its position (and nothing else) is remembered in this
//   browser's local storage; messages and drafts are never stored. It is not
//   part of the shared screen, shared fields, or cursor tracking (it renders
//   outside the cursor anchor area, and its keys never reach the dashboard).
// - It keeps clear of the session controls and any open dialog box
//   ([data-session-controls], [data-keep-clear]): if its place would cover
//   one, it moves to a free corner, and minimizes if no corner is free --
//   so Save, Close, and the session controls always stay clickable.
// - Messages arrive on the once-a-second check-in: about 1-2 seconds.

export const SESSION_CHAT_ATTR = "data-session-chat";
const KEEP_CLEAR = "[data-session-controls], [data-keep-clear]";
const OPEN = { w: 320, h: 380 };
// Used beside a large dialog on a smaller window, before minimizing.
const COMPACT = { w: 260, h: 300 };
const PILL = { w: 132, h: 40 };
const positionKey = (role: DemoRole) => `sft-guided-chat-position:${role}`;

function keepClearRects(): Rect[] {
  if (typeof document === "undefined") return [];
  return Array.from(document.querySelectorAll<HTMLElement>(KEEP_CLEAR))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 }));
}

function clampToWindow(p: Point, size: { w: number; h: number }): Point {
  const maxX = Math.max(MARGIN, window.innerWidth - size.w - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - size.h - MARGIN);
  return { x: Math.min(Math.max(MARGIN, p.x), maxX), y: Math.min(Math.max(MARGIN, p.y), maxY) };
}

function readPosition(role: DemoRole): Point | null {
  try {
    const raw = window.localStorage.getItem(positionKey(role));
    const p = raw ? JSON.parse(raw) : null;
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
  } catch {
    return null;
  }
}
function savePosition(role: DemoRole, p: Point) {
  try {
    window.localStorage.setItem(positionKey(role), JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) }));
  } catch {
    // Storage unavailable (private mode, blocked): the card just starts in its default place next time.
  }
}

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

export default function SessionChat({
  role,
  chat,
  ended,
  onSend,
  onRetry,
  onDiscard,
}: {
  role: DemoRole;
  chat: ChatState;
  ended: boolean;
  onSend: (text: string) => boolean;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => string | null;
}) {
  // Opens automatically when the session page starts (host: session start;
  // guest: joining).
  const [minimized, setMinimized] = useState(false);
  const [wanted, setWanted] = useState<Point | null>(null);
  const [placed, setPlaced] = useState<{ pos: Point; forcedMin: boolean; compact?: boolean } | null>(null);
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [seenId, setSeenId] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number; pointer: number } | null>(null);

  const showOpen = !minimized && !placed?.forcedMin;
  const size = showOpen ? (placed?.compact ? COMPACT : OPEN) : PILL;

  // Initial place: remembered in this browser, else the bottom-right corner
  // (clear of the main navigation on the left).
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads this browser's saved place once, after mount
    setWanted(readPosition(role) ?? { x: window.innerWidth - OPEN.w - MARGIN, y: window.innerHeight - OPEN.h - MARGIN });
  }, [role]);

  const relayout = useCallback(() => {
    if (!wanted) return;
    const view = { w: window.innerWidth, h: window.innerHeight };
    const clear = keepClearRects();
    const wantOpen = !minimized;
    const openPos = wantOpen ? placeCard(wanted, OPEN, clear, view) : null;
    const compactPos = wantOpen && !openPos ? placeCard(wanted, COMPACT, clear, view) : null;
    let next: { pos: Point; forcedMin: boolean; compact?: boolean };
    if (wantOpen && openPos) next = { pos: openPos, forcedMin: false };
    else if (wantOpen && compactPos) next = { pos: compactPos, forcedMin: false, compact: true };
    else {
      const pill = placeCard({ x: MARGIN, y: view.h - PILL.h - MARGIN }, PILL, clear, view) ?? clampToWindow({ x: MARGIN, y: view.h - PILL.h - MARGIN }, PILL);
      next = { pos: wantOpen ? pill : placeCard(wanted, PILL, clear, view) ?? pill, forcedMin: wantOpen };
    }
    setPlaced((prev) =>
      prev && prev.forcedMin === next.forcedMin && !!prev.compact === !!next.compact && Math.abs(prev.pos.x - next.pos.x) < 1 && Math.abs(prev.pos.y - next.pos.y) < 1
        ? prev
        : next
    );
  }, [wanted, minimized]);

  // Re-place on resize, and whenever dialogs or the session bar appear,
  // disappear, or change size.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- places the card for the current window and dialogs
    relayout();
    let frame = 0;
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!drag.current) relayout();
      });
    };
    window.addEventListener("resize", soon);
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(soon);
    observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    const tick = setInterval(soon, 1000);
    return () => {
      window.removeEventListener("resize", soon);
      observer?.disconnect();
      clearInterval(tick);
      cancelAnimationFrame(frame);
    };
  }, [relayout]);

  // Unread: the other person's messages that arrived while minimized.
  const othersLatest = chat.messages.reduce((max, m) => (m.role !== role && m.id > max ? m.id : max), 0);
  const unread = showOpen ? 0 : chat.messages.filter((m) => m.role !== role && m.id > seenId).length;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks messages read while the card is open
    if (showOpen && othersLatest > seenId) setSeenId(othersLatest);
  }, [showOpen, othersLatest, seenId]);
  useEffect(() => {
    // A cleared conversation starts unread counting from scratch.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the read marker after a clear
    if (chat.messages.length === 0 && seenId !== 0) setSeenId(0);
  }, [chat.messages.length, seenId]);

  // Keep the newest message in view when already near the bottom.
  const count = chat.messages.length + chat.outgoing.length;
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [count, showOpen]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("button") || !placed) return;
    drag.current = { dx: e.clientX - placed.pos.x, dy: e.clientY - placed.pos.y, pointer: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointer !== e.pointerId) return;
    const p = clampToWindow({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }, size);
    setPlaced({ pos: p, forcedMin: placed?.forcedMin ?? false, compact: placed?.compact });
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointer !== e.pointerId) return;
    drag.current = null;
    if (placed) {
      setWanted(placed.pos);
      savePosition(role, placed.pos);
    }
  }

  function send() {
    if (!draft.trim()) return;
    if (onSend(draft)) {
      setDraft("");
      setHint(null);
    } else {
      setHint(ended ? "The session has ended." : `Messages must be 1 to ${CHAT_MAX_CHARS} characters.`);
    }
  }

  // Keys typed in the chat stay in the chat: never dashboard shortcuts.
  const keepKeys = (e: React.KeyboardEvent) => e.stopPropagation();

  if (!placed) return null;
  const style = { left: placed.pos.x, top: placed.pos.y };
  const attrs = { [SESSION_CHAT_ATTR]: "" };

  if (!showOpen) {
    return (
      <div {...attrs} className="fixed z-[85]" style={style} onKeyDown={keepKeys} onKeyUp={keepKeys}>
        <button
          type="button"
          onClick={() => setMinimized(false)}
          disabled={placed.forcedMin}
          title={placed.forcedMin ? "The chat reopens when there is room (close the dialog)." : undefined}
          className="flex h-10 items-center gap-2 rounded-full bg-[#0f172a] px-4 text-sm font-medium text-white shadow-lg hover:bg-slate-800 disabled:opacity-80"
          aria-label={unread > 0 ? `Open chat, ${unread} unread` : "Open chat"}
        >
          Chat
          {unread > 0 && <span data-chat-unread className="rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold leading-5">{unread}</span>}
        </button>
      </div>
    );
  }

  return (
    <section
      {...attrs}
      aria-label="Session chat"
      className="fixed z-[85] flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
      style={{ ...style, width: size.w, height: size.h }}
      onKeyDown={keepKeys}
      onKeyUp={keepKeys}
    >
      <div
        data-chat-handle
        className="flex shrink-0 cursor-move select-none items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2 touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="text-sm font-semibold text-slate-900">Chat</div>
        <button type="button" onClick={() => setMinimized(true)} className="rounded-lg px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-200" aria-label="Minimize chat">
          Minimize
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2" aria-live="polite">
        {chat.available === false && <p className="text-xs text-slate-500">Chat isn&apos;t available yet.</p>}
        {chat.available !== false && chat.messages.length === 0 && chat.outgoing.length === 0 && !ended && (
          <p className="text-xs text-slate-500">Messages appear here for both of you, usually within a second or two.</p>
        )}
        {chat.messages.map((m) => (
          <div key={m.id} data-chat-message className={m.role === role ? "text-right" : ""}>
            <div className="text-[11px] text-slate-500">
              {m.name} · {timeOf(m.at)}
            </div>
            <div className={`inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-1.5 text-left text-sm ${m.role === role ? "bg-[#0f172a] text-white" : "bg-slate-100 text-slate-900"}`}>
              {m.body}
            </div>
          </div>
        ))}
        {chat.outgoing.map((o) => (
          <div key={o.clientId} data-chat-outgoing={o.status} className="text-right">
            <div className="inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-slate-200 px-3 py-1.5 text-left text-sm text-slate-700">{o.text}</div>
            {o.status === "sending" ? (
              <div className="text-[11px] text-slate-500">Sending...</div>
            ) : (
              <div role="alert" className="mt-0.5 text-[11px] text-rose-700">
                {o.error}{" "}
                <button type="button" onClick={() => onRetry(o.clientId)} className="font-semibold underline">
                  Retry
                </button>{" "}
                <button
                  type="button"
                  onClick={() => {
                    const text = onDiscard(o.clientId);
                    if (text !== null) setDraft((d) => (d ? `${text}\n${d}` : text));
                  }}
                  className="underline"
                >
                  Edit
                </button>
              </div>
            )}
          </div>
        ))}
        {ended && <p className="text-xs text-slate-500">This session has ended. Chat is closed.</p>}
      </div>

      {!ended && chat.available !== false && (
        <form
          className="shrink-0 border-t border-slate-200 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            aria-label="Message"
            value={draft}
            maxLength={CHAT_MAX_CHARS}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Type a message"
            className="w-full resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className={`text-[11px] ${hint ? "text-rose-700" : "text-slate-400"}`}>{hint ?? `${draft.length}/${CHAT_MAX_CHARS}`}</span>
            <button type="submit" disabled={!draft.trim() || chat.available !== true} className="rounded-lg bg-[#0f172a] px-3 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              Send
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

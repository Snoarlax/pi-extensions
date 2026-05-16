/**
 * pr-comments.ts — Pi extension
 *
 * Adds a /pr-comments command that fetches open PRs for the current git repo,
 * lets the user pick one, then walks through review comment threads one at a
 * time. Selecting a thread injects it as a user message so Pi can address it.
 *
 * Install:
 *   Global  → ~/.pi/agent/extensions/pr-comments.ts
 *   Project → .pi/extensions/pr-comments.ts
 *
 * Requires: gh CLI (https://cli.github.com) authenticated with repo access.
 *
 * Usage inside Pi:
 *   /pr-comments
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

// ─── ANSI constants (module-level so helpers can use them) ────────────────────

const A_RESET  = "\x1b[0m";
const A_BOLD   = "\x1b[1m";
const A_DIM    = "\x1b[2m";
const A_INVERT = "\x1b[7m";
const A_RED    = "\x1b[31m";
const A_GREEN  = "\x1b[32m";
const A_CYAN   = "\x1b[36m";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PR {
  number: number;
  title: string;
  headRefName: string;
}

interface PRComment {
  id: number;
  in_reply_to_id?: number | null;
  body: string;
  body_html?: string;
  diff_hunk?: string;
  path: string;
  line?: number | null;
  original_line?: number | null;
  user: { login: string };
}

interface Thread {
  root: PRComment;
  replies: PRComment[];
}

// ─── Shell helpers ────────────────────────────────────────────────────────────

function shell(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function shellJSON<T>(cmd: string): T {
  return JSON.parse(shell(cmd));
}

// ─── HTML → plain text ────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/gi, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, "");
}

function htmlToText(html: string): string {
  let s = html;

  // Pre/code blocks — strip inner tags, indent 2 spaces, preserve whitespace
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const content = decodeEntities(inner.replace(/<[^>]+>/g, "")).trimEnd();
    return "\n" + content.split("\n").map((l) => "  " + l).join("\n") + "\n\n";
  });

  // Headings
  s = s.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, inner) =>
    inner.replace(/<[^>]+>/g, "").trim() + "\n"
  );

  // Paragraphs
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<p[^>]*>/gi, "");

  // Blockquotes — prefix each line with "> "
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    return (
      text
        .split("\n")
        .map((l) => "> " + l.trim())
        .join("\n") + "\n"
    );
  });

  // Lists
  s = s.replace(/<li[^>]*>/gi, "• ");
  s = s.replace(/<\/li>/gi, "\n");
  s = s.replace(/<\/(ul|ol)>/gi, "\n");

  // Line breaks
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // Links → "text (url)" or just "url" when text === url
  s = s.replace(
    /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => {
      const t = text.replace(/<[^>]+>/g, "").trim();
      return t && t !== href ? `${t} (${href})` : href;
    }
  );

  // Inline code → backticks
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, "");

  // Decode entities
  s = decodeEntities(s);

  // Collapse 3+ newlines → 2
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

// ─── Word wrap ────────────────────────────────────────────────────────────────

function wordWrap(text: string, width: number): string[] {
  const result: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      result.push("");
      continue;
    }
    // Indented lines (code blocks, blockquotes) — hard-clip, no re-wrap
    if (para.startsWith("  ") || para.startsWith("> ") || para.startsWith("• ")) {
      result.push(para.length <= width ? para : para.slice(0, width - 1) + "…");
      continue;
    }
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      if (!line) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += " " + word;
      } else {
        result.push(line);
        line = word;
      }
    }
    if (line) result.push(line);
  }
  return result;
}

// ─── Diff rendering ───────────────────────────────────────────────────────────

function colorDiffLine(raw: string, width: number): string {
  const clipped = raw.length > width ? raw.slice(0, width - 1) + "…" : raw;
  if (raw.startsWith("@@")) return A_CYAN + A_DIM + clipped + A_RESET;
  if (raw.startsWith("+"))  return A_GREEN + clipped + A_RESET;
  if (raw.startsWith("-"))  return A_RED   + clipped + A_RESET;
  return A_DIM + clipped + A_RESET;
}

// Show only the @@ header + the last MAX_CTX content lines of the hunk so the
// display stays tight around the specific line being commented on.
const HUNK_CTX = 5;

function renderDiffHunk(hunk: string, width: number): string[] {
  const [header, ...rest] = hunk.split("\n");
  const content = rest.filter((l) => l !== "");
  const visible = content.length > HUNK_CTX ? content.slice(-HUNK_CTX) : content;

  const out: string[] = [];
  if (header?.startsWith("@@")) out.push(colorDiffLine(header, width));
  for (const raw of visible) out.push(colorDiffLine(raw, width));
  return out;
}

// ─── Suggestion rendering ─────────────────────────────────────────────────────

// GitHub "suggested change" blocks look like:  ```suggestion\nnew code\n```
// We convert them to a mini-diff: last N lines of the diff_hunk become "-" rows
// (the original), and the suggestion lines become "+" rows.
const SUGGESTION_RE = /```suggestion\r?\n([\s\S]*?)```/g;

function renderSuggestion(
  suggContent: string,
  diffHunk: string | undefined,
  width: number
): string[] {
  const suggLines = suggContent.replace(/\n$/, "").split("\n");
  const N = suggLines.length;
  const out: string[] = [];

  out.push(A_DIM + A_BOLD + "── suggestion " + "─".repeat(Math.max(0, width - 14)) + A_RESET);

  // Original lines: last N content lines of the hunk, with their prefix stripped
  if (diffHunk) {
    const content = diffHunk.split("\n").filter((l) => l !== "" && !l.startsWith("@@"));
    for (const bl of content.slice(-N)) {
      const raw = "-" + bl.slice(1); // strip +/space prefix, replace with -
      const clipped = raw.length > width ? raw.slice(0, width - 1) + "…" : raw;
      out.push(A_RED + clipped + A_RESET);
    }
  }

  for (const sl of suggLines) {
    const raw = "+" + sl;
    const clipped = raw.length > width ? raw.slice(0, width - 1) + "…" : raw;
    out.push(A_GREEN + clipped + A_RESET);
  }

  return out;
}

// ─── Comment body rendering ───────────────────────────────────────────────────

// Render a single comment's body. Suggestion blocks are replaced with colored
// diffs; the remaining prose is rendered from body_html when available.
function renderCommentBody(comment: PRComment, width: number): string[] {
  const raw = comment.body;
  const hasSuggestion = SUGGESTION_RE.test(raw);
  SUGGESTION_RE.lastIndex = 0;

  if (!hasSuggestion) {
    const text = comment.body_html ? htmlToText(comment.body_html) : raw;
    return wordWrap(text, width);
  }

  const out: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SUGGESTION_RE.exec(raw)) !== null) {
    const prose = raw.slice(lastIndex, match.index).trim();
    if (prose) {
      out.push(...wordWrap(prose, width));
      out.push("");
    }
    out.push(...renderSuggestion(match[1], comment.diff_hunk, width));
    lastIndex = match.index + match[0].length;
  }

  const tail = raw.slice(lastIndex).trim();
  if (tail) {
    out.push("");
    out.push(...wordWrap(tail, width));
  }

  return out;
}

// ─── Thread rendering ─────────────────────────────────────────────────────────

function threadBodyLines(thread: Thread, width: number): string[] {
  const lines: string[] = [];

  // Diff hunk — trimmed to just the relevant lines around the commented position
  if (thread.root.diff_hunk) {
    lines.push(A_DIM + "── diff " + "─".repeat(Math.max(0, width - 8)) + A_RESET);
    lines.push(...renderDiffHunk(thread.root.diff_hunk, width));
    lines.push("");
  }

  lines.push(...renderCommentBody(thread.root, width));

  for (const reply of thread.replies) {
    lines.push("");
    lines.push(
      A_DIM +
      `── @${reply.user.login} ` +
      "─".repeat(Math.max(0, width - reply.user.login.length - 5)) +
      A_RESET
    );
    lines.push(...renderCommentBody(reply, width));
  }

  return lines;
}

// ─── Thread grouping ──────────────────────────────────────────────────────────

function groupThreads(comments: PRComment[]): Thread[] {
  const map = new Map<number, Thread>();

  for (const c of comments) {
    if (!c.in_reply_to_id) {
      map.set(c.id, { root: c, replies: [] });
    }
  }

  for (const c of comments) {
    if (c.in_reply_to_id) {
      const thread = map.get(c.in_reply_to_id);
      if (thread) thread.replies.push(c);
    }
  }

  const threads = Array.from(map.values());
  threads.sort((a, b) => {
    if (a.root.path < b.root.path) return -1;
    if (a.root.path > b.root.path) return 1;
    return (
      (a.root.line ?? a.root.original_line ?? 0) -
      (b.root.line ?? b.root.original_line ?? 0)
    );
  });

  return threads;
}

// ─── Agent message builder ────────────────────────────────────────────────────

function buildAgentMessage(thread: Thread, prNumber: number): string {
  const { root, replies } = thread;
  const line = root.line ?? root.original_line;
  const location = line ? `${root.path} (line ${line})` : root.path;

  const quotedRoot = root.body
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

  const quotedReplies = replies
    .map((r) => {
      const body = r.body
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      return `>\n> Reply from @${r.user.login}:\n${body}`;
    })
    .join("\n");

  return [
    `Address this PR #${prNumber} review comment:`,
    ``,
    `File: ${location}`,
    `Author: @${root.user.login}`,
    ``,
    quotedRoot,
    quotedReplies,
    ``,
    `Please make the necessary code changes to address this feedback.`,
  ]
    .join("\n")
    .trim();
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pr-comments", {
    description:
      "Browse GitHub PR review comment threads and pick one for Pi to address.\n" +
      "  /pr-comments",

    handler: async (_args, ctx) => {
      // Aliases for the module-level ANSI constants (shorter names inside handler)
      const RESET  = A_RESET;
      const BOLD   = A_BOLD;
      const DIM    = A_DIM;
      const INVERT = A_INVERT;

      function truncate(s: string, max: number): string {
        const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
        if (visible.length <= max) return s;
        return visible.slice(0, max - 1) + "…";
      }

      function pad(s: string, width: number): string {
        const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
        return s + " ".repeat(Math.max(0, width - visible.length));
      }

      // ── 1. Verify gh CLI ────────────────────────────────────────────────────
      try {
        shell("gh --version");
      } catch {
        ctx.ui.notify("gh CLI not found — install it from https://cli.github.com", "error");
        return;
      }

      // ── 2. Detect git repo ──────────────────────────────────────────────────
      let repoSlug: string;
      try {
        repoSlug = shellJSON<{ nameWithOwner: string }>(
          "gh repo view --json nameWithOwner"
        ).nameWithOwner;
      } catch {
        ctx.ui.notify("Not in a git repo (or gh can't detect one)", "error");
        return;
      }

      // ── 3. Fetch open PRs ───────────────────────────────────────────────────
      ctx.ui.setStatus("pr-comments", "Fetching open PRs…");
      let prs: PR[];
      try {
        prs = shellJSON<PR[]>("gh pr list --json number,title,headRefName");
      } catch (err: any) {
        ctx.ui.setStatus("pr-comments", "");
        ctx.ui.notify(`gh pr list failed: ${err.message}`, "error");
        return;
      }
      ctx.ui.setStatus("pr-comments", "");

      if (prs.length === 0) {
        ctx.ui.notify("No open PRs found", "info");
        return;
      }

      // ── 4. Screen 1 — PR Picker ─────────────────────────────────────────────
      const MAX_PR_VISIBLE = 12;

      const pickedPRIdx = await ctx.ui.custom<number | null>(
        (tui, _theme, _kb, done) => {
          let cursor = 0;
          let scroll = 0;

          function clamp() {
            if (cursor < 0) cursor = 0;
            if (cursor >= prs.length) cursor = prs.length - 1;
            if (cursor < scroll) scroll = cursor;
            if (cursor >= scroll + MAX_PR_VISIBLE) scroll = cursor - MAX_PR_VISIBLE + 1;
          }

          return {
            render(width: number): string[] {
              const lines: string[] = [];
              const innerW = width - 2;

              lines.push(BOLD + truncate(` Select PR — ${repoSlug}`, width) + RESET);
              lines.push(DIM + "─".repeat(width) + RESET);

              const end = Math.min(scroll + MAX_PR_VISIBLE, prs.length);
              for (let i = scroll; i < end; i++) {
                const pr = prs[i];
                const row = `#${pr.number}  ${pr.title}  (${pr.headRefName})`;
                const cell = truncate(row, innerW);
                if (i === cursor) {
                  lines.push(" " + INVERT + pad(cell, innerW) + RESET + " ");
                } else {
                  lines.push(" " + pad(cell, innerW) + " ");
                }
              }

              lines.push(DIM + "─".repeat(width) + RESET);
              const hint = " ↑↓ navigate · Enter select · Esc cancel ";
              const info = ` ${cursor + 1}/${prs.length} `;
              const gap = width - hint.length - info.length;
              lines.push(DIM + hint + " ".repeat(Math.max(0, gap)) + info + RESET);

              return lines;
            },

            handleInput(data: string) {
              if      (data === "\x1b[A" || data === "k") { cursor--; clamp(); }
              else if (data === "\x1b[B" || data === "j") { cursor++; clamp(); }
              else if (data === "\x1b[5~") { cursor -= MAX_PR_VISIBLE; clamp(); }
              else if (data === "\x1b[6~") { cursor += MAX_PR_VISIBLE; clamp(); }
              else if (data === "\x1b[H")  { cursor = 0; clamp(); }
              else if (data === "\x1b[F")  { cursor = prs.length - 1; clamp(); }
              else if (data === "\r" || data === "\n") { done(cursor); return; }
              else if (data === "\x1b")    { done(null); return; }
              tui.requestRender();
            },

            invalidate() {},
          };
        },
        { overlay: true, overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" } }
      );

      if (pickedPRIdx === null) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const pr = prs[pickedPRIdx];

      // ── 5. Fetch PR review comments (with HTML bodies) ──────────────────────
      ctx.ui.setStatus("pr-comments", `Fetching comments for PR #${pr.number}…`);
      let rawComments: PRComment[];
      try {
        rawComments = shellJSON<PRComment[]>(
          `gh api -H "Accept: application/vnd.github.full+json" ` +
          `"/repos/${repoSlug}/pulls/${pr.number}/comments?per_page=100"`
        );
      } catch (err: any) {
        ctx.ui.setStatus("pr-comments", "");
        ctx.ui.notify(`gh API error: ${err.message}`, "error");
        return;
      }
      ctx.ui.setStatus("pr-comments", "");

      if (rawComments.length === 0) {
        ctx.ui.notify(`PR #${pr.number} has no review comments`, "info");
        return;
      }

      // ── 6. Group into threads ───────────────────────────────────────────────
      const threads = groupThreads(rawComments);

      if (threads.length === 0) {
        ctx.ui.notify(`No comment threads found on PR #${pr.number}`, "info");
        return;
      }

      // ── 7. Screen 2 — Comment Navigator ────────────────────────────────────
      //   ← / → : cycle threads          (resets scroll)
      //   ↑ / ↓ : scroll body text
      //   Enter  : address selected thread
      //   Esc    : back to PR picker

      const BODY_VISIBLE = 22;

      const pickedThreadIdx = await ctx.ui.custom<number | null>(
        (tui, _theme, _kb, done) => {
          let threadIdx = 0;
          let scrollY   = 0;
          // Cache rendered body lines per thread index (width-dependent; reset on resize)
          let cachedWidth = -1;
          let cachedLines: string[] = [];

          function getBodyLines(width: number): string[] {
            if (width !== cachedWidth) {
              cachedWidth = width;
              cachedLines = threadBodyLines(threads[threadIdx], width - 2);
            }
            return cachedLines;
          }

          function goToThread(idx: number) {
            threadIdx = Math.max(0, Math.min(threads.length - 1, idx));
            scrollY   = 0;
            cachedWidth = -1; // invalidate cache
          }

          function clampScroll(bodyLen: number) {
            const maxScroll = Math.max(0, bodyLen - BODY_VISIBLE);
            if (scrollY < 0) scrollY = 0;
            if (scrollY > maxScroll) scrollY = maxScroll;
          }

          return {
            render(width: number): string[] {
              const lines: string[] = [];
              const innerW = width - 2;
              const t = threads[threadIdx];
              const tLine = t.root.line ?? t.root.original_line ?? "?";
              const replyBadge = t.replies.length
                ? `  [+${t.replies.length} repl${t.replies.length === 1 ? "y" : "ies"}]`
                : "";

              // ── Header ──
              const threadPos = `[${threadIdx + 1} / ${threads.length}]`;
              const titleLeft = ` PR #${pr.number} Review Comments`;
              const titleGap  = width - titleLeft.length - threadPos.length - 1;
              lines.push(
                BOLD + titleLeft + " ".repeat(Math.max(1, titleGap)) + threadPos + RESET
              );

              // ── Location + author ──
              lines.push(
                DIM +
                  truncate(` ${t.root.path}:${tLine}  @${t.root.user.login}${replyBadge}`, width) +
                  RESET
              );
              lines.push(DIM + "─".repeat(width) + RESET);

              // ── Body (scrollable) ──
              const bodyLines = getBodyLines(width);
              clampScroll(bodyLines.length);

              const visibleEnd = Math.min(scrollY + BODY_VISIBLE, bodyLines.length);
              for (let i = scrollY; i < visibleEnd; i++) {
                lines.push(" " + bodyLines[i]);
              }
              // Pad to BODY_VISIBLE rows so the footer doesn't jump
              for (let i = visibleEnd - scrollY; i < BODY_VISIBLE; i++) {
                lines.push("");
              }

              // ── Scroll indicator + footer ──
              lines.push(DIM + "─".repeat(width) + RESET);

              const hint = " ← → switch · ↑↓ scroll · Enter address · Esc back ";
              const scrollInfo = bodyLines.length > BODY_VISIBLE
                ? ` ${scrollY + 1}–${Math.min(scrollY + BODY_VISIBLE, bodyLines.length)}/${bodyLines.length} `
                : "";
              const fgap = width - hint.length - scrollInfo.length;
              lines.push(DIM + hint + " ".repeat(Math.max(0, fgap)) + scrollInfo + RESET);

              return lines;
            },

            handleInput(data: string) {
              const bodyLines = getBodyLines(cachedWidth > 0 ? cachedWidth : 80);

              if (data === "\x1b[D" || data === "h") {
                // Left — previous thread
                goToThread(threadIdx - 1);
              } else if (data === "\x1b[C" || data === "l") {
                // Right — next thread
                goToThread(threadIdx + 1);
              } else if (data === "\x1b[A" || data === "k") {
                // Up — scroll body up
                scrollY--;
                clampScroll(bodyLines.length);
              } else if (data === "\x1b[B" || data === "j") {
                // Down — scroll body down
                scrollY++;
                clampScroll(bodyLines.length);
              } else if (data === "\x1b[5~") {
                // PgUp
                scrollY -= BODY_VISIBLE;
                clampScroll(bodyLines.length);
              } else if (data === "\x1b[6~") {
                // PgDn
                scrollY += BODY_VISIBLE;
                clampScroll(bodyLines.length);
              } else if (data === "\x1b[H") {
                scrollY = 0;
              } else if (data === "\x1b[F") {
                scrollY = Math.max(0, bodyLines.length - BODY_VISIBLE);
              } else if (data === "\r" || data === "\n") {
                done(threadIdx);
                return;
              } else if (data === "\x1b") {
                done(null);
                return;
              }

              tui.requestRender();
            },

            invalidate() {
              cachedWidth = -1; // force re-wrap on terminal resize
            },
          };
        },
        { overlay: true, overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center" } }
      );

      if (pickedThreadIdx === null) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const thread = threads[pickedThreadIdx];
      if (!thread) return;

      // ── 8. Inject thread as agent user message ──────────────────────────────
      await ctx.waitForIdle();
      pi.sendUserMessage(buildAgentMessage(thread, pr.number));
    },
  });
}

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

// ─── Box drawing ─────────────────────────────────────────────────────────────

// Wraps an array of content lines (each already sized to outerWidth-2 visible
// chars) in a Unicode box. ANSI codes are stripped only for padding measurement.
function box(content: string[], outerWidth: number): string[] {
  const cw = outerWidth - 2; // inner width between the │ chars
  const out: string[] = [A_DIM + "┌" + "─".repeat(cw) + "┐" + A_RESET];
  for (const line of content) {
    const vis = line.replace(/\x1b\[[0-9;]*m/g, "").length;
    out.push(A_DIM + "│" + A_RESET + line + " ".repeat(Math.max(0, cw - vis)) + A_DIM + "│" + A_RESET);
  }
  out.push(A_DIM + "└" + "─".repeat(cw) + "┘" + A_RESET);
  return out;
}

// ─── Diff rendering ───────────────────────────────────────────────────────────

function colorDiffLine(raw: string, width: number): string {
  const clipped = raw.length > width ? raw.slice(0, width - 1) + "…" : raw;
  if (raw.startsWith("@@"))                    return A_CYAN + A_DIM + clipped + A_RESET;
  if (raw.startsWith("---") || raw.startsWith("+++")) return A_BOLD + A_DIM + clipped + A_RESET;
  if (raw.startsWith("+"))                     return A_GREEN + clipped + A_RESET;
  if (raw.startsWith("-"))                     return A_RED   + clipped + A_RESET;
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

// ─── Agent message builders ───────────────────────────────────────────────────

function buildAgentMessage(
  selectedThreads: Thread[],
  prNumber: number,
  feedback?: string
): string {
  const parts: string[] = [];

  if (selectedThreads.length === 1) {
    const { root, replies } = selectedThreads[0];
    const line = root.line ?? root.original_line;
    const location = line ? `${root.path} (line ${line})` : root.path;

    const quotedRoot = root.body.split("\n").map((l) => `> ${l}`).join("\n");
    const quotedReplies = replies
      .map((r) => {
        const body = r.body.split("\n").map((l) => `> ${l}`).join("\n");
        return `>\n> Reply from @${r.user.login}:\n${body}`;
      })
      .join("\n");

    parts.push(
      `Address this PR #${prNumber} review comment:`,
      ``,
      `File: ${location}`,
      `Author: @${root.user.login}`,
      ``,
      quotedRoot,
      quotedReplies,
      ``,
      `Please make the necessary code changes directly to the file(s) to address this feedback.`
    );
  } else {
    parts.push(
      `Address these ${selectedThreads.length} PR #${prNumber} review comments together:`,
      ``
    );
    for (let i = 0; i < selectedThreads.length; i++) {
      const { root, replies } = selectedThreads[i];
      const line = root.line ?? root.original_line;
      const location = line ? `${root.path} (line ${line})` : root.path;
      parts.push(
        `─── Comment ${i + 1} of ${selectedThreads.length} ───`,
        `File: ${location}`,
        `Author: @${root.user.login}`,
        ``,
        ...root.body.split("\n").map((l) => `> ${l}`)
      );
      for (const r of replies) {
        parts.push(`>`, `> Reply from @${r.user.login}:`);
        parts.push(...r.body.split("\n").map((l) => `> ${l}`));
      }
      parts.push(``);
    }
    parts.push(`Please make all the necessary code changes to address every comment above.`);
  }

  if (feedback) {
    parts.push(
      ``,
      `Previous attempt was rejected. Reviewer feedback:`,
      ``,
      `  ${feedback}`,
      ``,
      `Please revise your approach accordingly.`
    );
  }

  return parts.join("\n").trim();
}

function buildCommitMessage(selectedThreads: Thread[], prNumber: number): string {
  if (selectedThreads.length === 1) {
    const { root } = selectedThreads[0];
    const line = root.line ?? root.original_line;
    const loc  = line ? `${root.path}:${line}` : root.path;
    const summary = root.body.split("\n")[0].replace(/`/g, "'").slice(0, 72);
    return `Fix PR #${prNumber} review: ${summary}\n\nFile: ${loc}\nReviewer: @${root.user.login}`;
  }
  const files    = [...new Set(selectedThreads.map((t) => t.root.path))].join(", ");
  const authors  = [...new Set(selectedThreads.map((t) => `@${t.root.user.login}`))].join(", ");
  return `Fix ${selectedThreads.length} PR #${prNumber} review comments\n\nFiles: ${files}\nReviewers: ${authors}`;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pr", {
    description:
      "Browse GitHub PR review comment threads and pick one for Pi to address.\n" +
      "  /pr",

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
      ctx.ui.setStatus("pr", "Fetching open PRs…");
      let prs: PR[];
      try {
        prs = shellJSON<PR[]>("gh pr list --json number,title,headRefName");
      } catch (err: any) {
        ctx.ui.setStatus("pr", "");
        ctx.ui.notify(`gh pr list failed: ${err.message}`, "error");
        return;
      }
      ctx.ui.setStatus("pr", "");

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
              const cw = width - 2;
              const innerW = cw - 2;
              const content: string[] = [];

              content.push(BOLD + truncate(` Select PR — ${repoSlug}`, cw) + RESET);
              content.push(DIM + "─".repeat(cw) + RESET);

              const end = Math.min(scroll + MAX_PR_VISIBLE, prs.length);
              for (let i = scroll; i < end; i++) {
                const pr = prs[i];
                const row = `#${pr.number}  ${pr.title}  (${pr.headRefName})`;
                const cell = truncate(row, innerW);
                if (i === cursor) {
                  content.push(" " + INVERT + pad(cell, innerW) + RESET + " ");
                } else {
                  content.push(" " + pad(cell, innerW) + " ");
                }
              }

              content.push(DIM + "─".repeat(cw) + RESET);
              const hint = " ↑↓ navigate · Enter select · Esc cancel ";
              const info = ` ${cursor + 1}/${prs.length} `;
              const gap = cw - hint.length - info.length;
              content.push(DIM + hint + " ".repeat(Math.max(0, gap)) + info + RESET);

              return box(content, width);
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
      ctx.ui.setStatus("pr", `Fetching comments for PR #${pr.number}…`);
      let rawComments: PRComment[];
      try {
        rawComments = shellJSON<PRComment[]>(
          `gh api -H "Accept: application/vnd.github.full+json" ` +
          `"/repos/${repoSlug}/pulls/${pr.number}/comments?per_page=100"`
        );
      } catch (err: any) {
        ctx.ui.setStatus("pr", "");
        ctx.ui.notify(`gh API error: ${err.message}`, "error");
        return;
      }
      ctx.ui.setStatus("pr", "");

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

      // ── 7. Comment Navigator loop ───────────────────────────────────────────
      //   Re-opens the navigator after each fix so the user can pick the next
      //   comment to address. Esc in the navigator exits the loop entirely.

      const BODY_VISIBLE = 22;

      // Threads dismissed with x — persists across commentLoop iterations
      const dismissedIds = new Set<number>();

      commentLoop: while (true) {

      // Recompute visible list each time the navigator opens
      let visibleThreads: Thread[] = [];

      // null = Esc (exit), number[] = indices into visibleThreads to fix
      const pickedIndices = await ctx.ui.custom<number[] | null>(
        (tui, _theme, _kb, done) => {
          visibleThreads = threads.filter((t) => !dismissedIds.has(t.root.id));

          if (visibleThreads.length === 0) {
            done(null);
            return { render: () => [], handleInput: () => {}, invalidate: () => {} };
          }

          let threadIdx = 0;
          let scrollY   = 0;
          const markedIndices = new Set<number>();

          let cachedWidth = -1;
          let cachedLines: string[] = [];

          function getBodyLines(width: number): string[] {
            if (width !== cachedWidth) {
              cachedWidth = width;
              cachedLines = threadBodyLines(visibleThreads[threadIdx], width - 2);
            }
            return cachedLines;
          }

          function goToThread(idx: number) {
            threadIdx = Math.max(0, Math.min(visibleThreads.length - 1, idx));
            scrollY   = 0;
            cachedWidth = -1;
          }

          function clampScroll(bodyLen: number) {
            const maxScroll = Math.max(0, bodyLen - BODY_VISIBLE);
            if (scrollY < 0) scrollY = 0;
            if (scrollY > maxScroll) scrollY = maxScroll;
          }

          return {
            render(width: number): string[] {
              const cw = width - 2;
              const content: string[] = [];
              const t = visibleThreads[threadIdx];
              const tLine = t.root.line ?? t.root.original_line ?? "?";
              const isMarked = markedIndices.has(threadIdx);
              const replyBadge = t.replies.length
                ? `  [+${t.replies.length} repl${t.replies.length === 1 ? "y" : "ies"}]`
                : "";

              // ── Header ──
              const markedBadge = markedIndices.size > 0
                ? ` [${markedIndices.size} marked]` : "";
              const markFlag  = isMarked ? " ★" : "  ";
              const threadPos = `${markFlag} ${threadIdx + 1} / ${visibleThreads.length} `;
              const titleLeft = ` PR #${pr.number} Review Comments${markedBadge}`;
              const titleGap  = cw - titleLeft.length - threadPos.length;
              content.push(
                BOLD + titleLeft +
                " ".repeat(Math.max(0, titleGap)) +
                (isMarked ? A_GREEN : DIM) + threadPos + RESET
              );

              // ── Location + author ──
              content.push(
                DIM +
                  truncate(` ${t.root.path}:${tLine}  @${t.root.user.login}${replyBadge}`, cw) +
                  RESET
              );
              content.push(DIM + "─".repeat(cw) + RESET);

              // ── Body (scrollable) ──
              const bodyLines = getBodyLines(width);
              clampScroll(bodyLines.length);

              const visibleEnd = Math.min(scrollY + BODY_VISIBLE, bodyLines.length);
              for (let i = scrollY; i < visibleEnd; i++) {
                content.push(" " + bodyLines[i]);
              }
              for (let i = visibleEnd - scrollY; i < BODY_VISIBLE; i++) {
                content.push("");
              }

              // ── Footer ──
              content.push(DIM + "─".repeat(cw) + RESET);
              const hint = " ← → switch · ↑↓ scroll · m mark · x dismiss · Enter fix · Esc exit ";
              const scrollInfo = bodyLines.length > BODY_VISIBLE
                ? ` ${scrollY + 1}–${Math.min(scrollY + BODY_VISIBLE, bodyLines.length)}/${bodyLines.length} `
                : "";
              const fgap = cw - hint.length - scrollInfo.length;
              content.push(DIM + hint + " ".repeat(Math.max(0, fgap)) + scrollInfo + RESET);

              return box(content, width);
            },

            handleInput(data: string) {
              const bodyLines = getBodyLines(cachedWidth > 0 ? cachedWidth : 80);

              if (data === "\x1b[D" || data === "h") {
                goToThread(threadIdx - 1);
              } else if (data === "\x1b[C" || data === "l") {
                goToThread(threadIdx + 1);
              } else if (data === "\x1b[A" || data === "k") {
                scrollY--; clampScroll(bodyLines.length);
              } else if (data === "\x1b[B" || data === "j") {
                scrollY++; clampScroll(bodyLines.length);
              } else if (data === "\x1b[5~") {
                scrollY -= BODY_VISIBLE; clampScroll(bodyLines.length);
              } else if (data === "\x1b[6~") {
                scrollY += BODY_VISIBLE; clampScroll(bodyLines.length);
              } else if (data === "\x1b[H") {
                scrollY = 0;
              } else if (data === "\x1b[F") {
                scrollY = Math.max(0, bodyLines.length - BODY_VISIBLE);
              } else if (data === "m") {
                if (markedIndices.has(threadIdx)) {
                  markedIndices.delete(threadIdx);
                } else {
                  markedIndices.add(threadIdx);
                }
              } else if (data === "x") {
                // Dismiss current thread — remove from markedIndices, remap
                // indices above the dismissed slot down by one, then rebuild list
                dismissedIds.add(visibleThreads[threadIdx].root.id);
                const newMarked = new Set<number>();
                for (const idx of markedIndices) {
                  if (idx < threadIdx) newMarked.add(idx);
                  else if (idx > threadIdx) newMarked.add(idx - 1);
                }
                markedIndices.clear();
                for (const idx of newMarked) markedIndices.add(idx);
                visibleThreads = threads.filter((t) => !dismissedIds.has(t.root.id));
                if (visibleThreads.length === 0) { done(null); return; }
                threadIdx = Math.min(threadIdx, visibleThreads.length - 1);
                cachedWidth = -1;
              } else if (data === "\r" || data === "\n") {
                const toFix = markedIndices.size > 0
                  ? Array.from(markedIndices).sort((a, b) => a - b)
                  : [threadIdx];
                done(toFix);
                return;
              } else if (data === "\x1b") {
                done(null);
                return;
              }

              tui.requestRender();
            },

            invalidate() {
              cachedWidth = -1;
            },
          };
        },
        { overlay: true, overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center" } }
      );

      if (pickedIndices === null) {
        if (visibleThreads.length === 0) {
          ctx.ui.notify("All comment threads dismissed.", "info");
        }
        break commentLoop;
      }

      const selectedThreads = pickedIndices.map((i) => visibleThreads[i]).filter(Boolean);
      if (selectedThreads.length === 0) continue commentLoop;

      // ── 8. Iterative fix loop ────────────────────────────────────────────────
      //   Pi proposes changes → diff shown for review → user accepts or rejects.
      //   On rejection the user types feedback; Pi retries with that context.
      //   On acceptance the diff is committed. Esc at any point exits cleanly.
      //
      //   Synchronisation: a 2 s delay before waitForIdle() lets Pi transition
      //   to "busy" before we check; a 30 s safety poll after covers cases where
      //   waitForIdle() resolves marginally before Pi's last file write lands.

      const PATCH_VISIBLE = 30;
      let feedback: string | undefined;

      fixLoop: while (true) {
        // Snapshot HEAD so we can diff correctly even if Pi commits
        let baseSha = "";
        try { baseSha = shell("git rev-parse HEAD").trim(); } catch {}

        // ── 8a. Ask Pi to make changes ────────────────────────────────────────
        await ctx.waitForIdle();
        ctx.ui.setStatus("pr", feedback ? "Pi is revising the fix…" : "Pi is generating a fix…");

        // Promisified agent_end: bridge the event emitter into async/await so
        // we block here until Pi's turn completes with no polling or fixed delays.
        await new Promise<void>((resolve) => {
          let settled = false;
          pi.on("agent_end", () => { if (!settled) { settled = true; resolve(); } });
          pi.sendUserMessage(buildAgentMessage(selectedThreads, pr.number, feedback));
        });

        ctx.ui.setStatus("pr", "");

        // ── 8b. Capture proposed diff ─────────────────────────────────────────
        let currentSha = "";
        let rawDiff = "";
        try {
          currentSha = shell("git rev-parse HEAD").trim();
          const cmd = currentSha !== baseSha
            ? `git diff ${baseSha}..${currentSha} --unified=5`
            : "git diff HEAD --unified=5";
          rawDiff = shell(cmd);
        } catch { /* ignore */ }

        const piCommitted = !!baseSha && !!currentSha && currentSha !== baseSha;

        if (!rawDiff.trim()) {
          ctx.ui.notify("Pi made no changes.", "info");
          break fixLoop;
        }
        const patchLines = rawDiff.split("\n");

        // ── 8c. Screen 3 — Diff Review ───────────────────────────────────────
        //   y / Enter : commit (or keep if Pi already committed)
        //   n         : reject → prompt for feedback → retry
        //   Esc       : cancel → revert and exit

        const decision = await ctx.ui.custom<"commit" | "reject" | "cancel">(
          (tui, _theme, _kb, done) => {
            let scrollY = 0;

            function clampScroll() {
              const max = Math.max(0, patchLines.length - PATCH_VISIBLE);
              if (scrollY < 0) scrollY = 0;
              if (scrollY > max) scrollY = max;
            }

            return {
              render(width: number): string[] {
                const cw = width - 2;
                const innerW = cw - 1;
                const content: string[] = [];

                const pos = patchLines.length > PATCH_VISIBLE
                  ? ` [${scrollY + 1}–${Math.min(scrollY + PATCH_VISIBLE, patchLines.length)}/${patchLines.length}]`
                  : "";
                const titleLeft = ` Proposed Fix — PR #${pr.number}`;
                const titleGap  = cw - titleLeft.length - pos.length;
                content.push(BOLD + titleLeft + " ".repeat(Math.max(0, titleGap)) + pos + RESET);
                content.push(DIM + "─".repeat(cw) + RESET);

                const end = Math.min(scrollY + PATCH_VISIBLE, patchLines.length);
                for (let i = scrollY; i < end; i++) {
                  content.push(" " + colorDiffLine(patchLines[i], innerW));
                }
                for (let i = end - scrollY; i < PATCH_VISIBLE; i++) {
                  content.push("");
                }

                content.push(DIM + "─".repeat(cw) + RESET);
                const hint = " y commit · n reject & retry · Esc cancel ";
                const scrollInfo = patchLines.length > PATCH_VISIBLE ? " ↑↓ scroll " : "";
                const fgap = cw - hint.length - scrollInfo.length;
                content.push(DIM + hint + " ".repeat(Math.max(0, fgap)) + scrollInfo + RESET);

                return box(content, width);
              },

              handleInput(data: string) {
                if      (data === "\x1b[A" || data === "k") { scrollY--; clampScroll(); }
                else if (data === "\x1b[B" || data === "j") { scrollY++; clampScroll(); }
                else if (data === "\x1b[5~") { scrollY -= PATCH_VISIBLE; clampScroll(); }
                else if (data === "\x1b[6~") { scrollY += PATCH_VISIBLE; clampScroll(); }
                else if (data === "\x1b[H")  { scrollY = 0; }
                else if (data === "\x1b[F")  { scrollY = Math.max(0, patchLines.length - PATCH_VISIBLE); }
                else if (data === "y")         { done("commit"); return; }
                else if (data === "n")         { done("reject"); return; }
                else if (data === "\r" || data === "\n") { /* ignore Enter to prevent leaking from previous screen */ }
                else if (data === "\x1b")      { done("cancel"); return; }
                tui.requestRender();
              },

              invalidate() {},
            };
          },
          { overlay: true, overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center" } }
        );

        if (decision === "commit") {
          try {
            if (!piCommitted) {
              shell("git add -A");
              shell(`git commit -m ${JSON.stringify(buildCommitMessage(selectedThreads, pr.number))}`);
            }
            ctx.ui.notify(`Fix committed — PR #${pr.number}.`, "info");
          } catch (err: any) {
            ctx.ui.notify(`Commit failed: ${err.message}`, "error");
          }
          break fixLoop;
        }

        // Revert Pi's changes before retrying or exiting
        try {
          if (piCommitted) {
            shell(`git reset --hard ${JSON.stringify(baseSha)}`);
          } else {
            shell("git restore --staged --worktree .");
          }
        } catch {
          try { shell("git checkout -- ."); } catch { /* best-effort */ }
        }

        if (decision === "cancel") {
          ctx.ui.notify("Cancelled — changes reverted.", "info");
          break fixLoop;
        }

        // Rejected: collect feedback and loop
        const fb = await ctx.ui.input(
          "What was wrong with that fix?",
          "Describe the issue so Pi can try again…"
        );
        if (!fb) {
          ctx.ui.notify("No feedback provided — exiting.", "info");
          break fixLoop;
        }
        feedback = fb;
      }

      } // end commentLoop
    },
  });
}

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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

// ─── ZellijModal-style frame ──────────────────────────────────────────────────
// Rounded borders with title/footer embedded in the border lines, matching the
// visual style of pi-tool-display's ZellijModal component.

const ZB = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

function zellijFrame(
  content: string[],
  outerWidth: number,
  title?: { left?: string; right?: string },
  footer?: { left?: string; right?: string }
): string[] {
  const cw  = outerWidth - 2;

  const tl = title?.left   ?? "";
  const tr = title?.right  ?? "";
  const fl = footer?.left  ?? "";
  const fr = footer?.right ?? "";

  const topFill = Math.max(0, cw - visLen(tl) - visLen(tr));
  const botFill = Math.max(0, cw - visLen(fl) - visLen(fr));

  const out: string[] = [
    A_DIM + ZB.tl + A_RESET + tl + A_DIM + ZB.h.repeat(topFill) + A_RESET + tr + A_DIM + ZB.tr + A_RESET,
  ];
  for (const line of content) {
    const fill = Math.max(0, cw - visLen(line));
    out.push(A_DIM + ZB.v + A_RESET + line + " ".repeat(fill) + A_DIM + ZB.v + A_RESET);
  }
  out.push(
    A_DIM + ZB.bl + A_RESET + fl + A_DIM + ZB.h.repeat(botFill) + A_RESET + fr + A_DIM + ZB.br + A_RESET
  );
  return out;
}

// ─── String helpers ──────────────────────────────────────────────────────────

function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncate(s: string, max: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length <= max) return s;
  return visible.slice(0, max - 1) + "…";
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visLen(s)));
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
  feedback?: string,
  plan?: string
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

  if (plan) {
    parts.push(
      ``,
      `Approved implementation plan:`,
      ``,
      plan
    );
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

// ─── TODO file support ────────────────────────────────────────────────────────

let _todoIdCounter = 0x80000000;

function parseTodoFile(content: string, relPath: string): Thread[] {
  const threads: Thread[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    threads.push({
      root: { id: _todoIdCounter++, body: text, path: relPath, line: i + 1, user: { login: "TODO" } },
      replies: [],
    });
  }

  return threads;
}

function buildTodoAgentMessage(selectedThreads: Thread[], feedback?: string, plan?: string): string {
  const parts: string[] = [];

  if (selectedThreads.length === 1) {
    const { root } = selectedThreads[0];
    parts.push(
      `Complete this TODO item from \`${root.path}\` (line ${root.line ?? "?"}):`,
      ``,
      `> ${root.body}`,
      ``,
      `Please implement the necessary code changes to complete this task. Do not modify the TODO file.`
    );
  } else {
    parts.push(`Complete these ${selectedThreads.length} TODO items:`, ``);
    for (let i = 0; i < selectedThreads.length; i++) {
      const { root } = selectedThreads[i];
      parts.push(
        `─── Item ${i + 1} of ${selectedThreads.length} (${root.path}:${root.line ?? "?"}) ───`,
        ``,
        `> ${root.body}`,
        ``
      );
    }
    parts.push(`Please implement all the necessary code changes to complete every item above. Do not modify the TODO file.`);
  }

  if (plan) {
    parts.push(
      ``,
      `Approved implementation plan:`,
      ``,
      plan
    );
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

function buildTodoCommitMessage(selectedThreads: Thread[]): string {
  if (selectedThreads.length === 1) {
    const summary = selectedThreads[0].root.body.split("\n")[0].replace(/`/g, "'").slice(0, 72);
    return `Complete TODO: ${summary}`;
  }
  return `Complete ${selectedThreads.length} TODO items`;
}

// ─── Planning stage ───────────────────────────────────────────────────────────

/**
 * Send a message to Pi and capture the response text.
 *
 * agent_end fires with no payload in v0.73.1, so we ask Pi to write its
 * response to a temp file and read it back after the turn ends.
 * The tmpFile path is appended to the message automatically; the file is
 * deleted after reading. Falls back to the event payload for future versions
 * that may include it.
 */
async function sendAndCapture(pi: ExtensionAPI, message: string): Promise<string> {
  const tmpFile = `/tmp/pi-plan-${Date.now()}.txt`;
  const augmented = `${message}\n\nAlso write your numbered plan verbatim to \`${tmpFile}\` using your write tool.`;

  return new Promise<string>((resolve) => {
    let settled = false;
    pi.on("agent_end", (payload?: any) => {
      if (settled) return;
      settled = true;
      // Primary: read from temp file Pi wrote
      let text = "";
      try { text = readFileSync(tmpFile, "utf8").trim(); } catch {}
      try { shell(`rm -f ${JSON.stringify(tmpFile)}`); } catch {}
      // Fallback: event payload (future Pi versions)
      if (!text) {
        if (typeof payload === "string")               text = payload;
        else if (typeof payload?.message === "string") text = payload.message;
        else if (typeof payload?.content === "string") text = payload.content;
      }
      resolve(text);
    });
    pi.sendUserMessage(augmented);
  });
}

function buildPrPlanRequestMessage(selectedThreads: Thread[], prNumber: number): string {
  const base = buildAgentMessage(selectedThreads, prNumber);
  return (
    `Before making any code changes, produce a concise numbered implementation plan for the task below.\n` +
    `Output ONLY the numbered list — no prose, no code. Do not modify any files.\n\n` +
    base
  );
}

function buildTodoPlanRequestMessage(selectedThreads: Thread[]): string {
  const base = buildTodoAgentMessage(selectedThreads);
  return (
    `Before making any code changes, produce a concise numbered implementation plan for the task below.\n` +
    `Output ONLY the numbered list — no prose, no code. Do not modify any files.\n\n` +
    base
  );
}

function buildPlanRevisionMessage(currentPlan: string, userComment: string): string {
  const parts = [
    `Here is the current implementation plan:\n`,
    currentPlan,
    ``,
  ];
  if (userComment.trim()) {
    parts.push(`Reviewer comment: ${userComment.trim()}`, ``);
  }
  parts.push(
    `Please revise the plan accordingly. Output ONLY the updated numbered list — no prose, no code. Do not modify any files.`
  );
  return parts.join("\n");
}

/**
 * Runs the interactive plan review screen.
 * Returns { approved: true, planText } when the user accepts the plan,
 * or { approved: false, planText: "" } when they cancel.
 */
async function planStage(
  pi: ExtensionAPI,
  ctx: any,
  firstMessage: string,
  statusKey: string
): Promise<{ approved: boolean; planText: string }> {
  const PLAN_VISIBLE = 28;

  ctx.ui.setStatus(statusKey, "Pi is planning…");
  let planText = await sendAndCapture(pi, firstMessage);
  ctx.ui.setStatus(statusKey, "");

  // Strip fences/markdown that Pi might wrap the list in
  planText = planText
    .replace(/^```[^\n]*\n?/m, "")
    .replace(/```\s*$/m, "")
    .trim();

  planLoop: while (true) {
    const result = await ctx.ui.custom<"approve" | "revise" | "cancel">(
      (tui, _theme, _kb, done) => {
        let scrollY = 0;
        let renderedLines: string[] = [];

        function buildLines(width: number): string[] {
          const cw = width - 4; // frame + 1 pad each side
          return wordWrap(planText || "(no plan — press Enter to prompt Pi again)", cw);
        }

        function clampScroll(total: number) {
          const max = Math.max(0, total - PLAN_VISIBLE);
          if (scrollY < 0) scrollY = 0;
          if (scrollY > max) scrollY = max;
        }

        return {
          render(width: number): string[] {
            renderedLines = buildLines(width);
            clampScroll(renderedLines.length);

            const content: string[] = [];
            const end = Math.min(scrollY + PLAN_VISIBLE, renderedLines.length);
            for (let i = scrollY; i < end; i++) {
              content.push(" " + truncate(renderedLines[i], width - 4));
            }
            for (let i = end - scrollY; i < PLAN_VISIBLE; i++) content.push("");

            const pos = renderedLines.length > PLAN_VISIBLE
              ? ` ${scrollY + 1}–${Math.min(scrollY + PLAN_VISIBLE, renderedLines.length)}/${renderedLines.length} `
              : "";

            return zellijFrame(
              content, width,
              { left: A_BOLD + " Implementation Plan " + A_RESET },
              { left: A_DIM + " c deploy · Enter revise · Esc cancel " + A_RESET, right: A_DIM + pos + A_RESET }
            );
          },

          handleInput(data: string) {
            if (data === "c")                        { done("approve"); return; }
            if (data === "\x1b")                     { done("cancel");  return; }
            if (data === "\r" || data === "\n")      { done("revise");  return; }
            if (data === "\x1b[A" || data === "k")   { scrollY--; clampScroll(renderedLines.length); }
            else if (data === "\x1b[B" || data === "j") { scrollY++; clampScroll(renderedLines.length); }
            else if (data === "\x1b[5~") { scrollY -= PLAN_VISIBLE; clampScroll(renderedLines.length); }
            else if (data === "\x1b[6~") { scrollY += PLAN_VISIBLE; clampScroll(renderedLines.length); }
            else if (data === "\x1b[H")  { scrollY = 0; }
            else if (data === "\x1b[F")  { scrollY = Math.max(0, renderedLines.length - PLAN_VISIBLE); }
            tui.requestRender();
          },

          invalidate() {},
        };
      },
      { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } }
    );

    if (result === "cancel") return { approved: false, planText: "" };
    if (result === "approve") return { approved: true, planText };

    // Revise — ask for optional comment then send back to Pi
    const comment = await ctx.ui.input(
      "Revision notes (optional)",
      "Describe changes to the plan, or press Enter to let Pi refine it…"
    ) ?? "";

    ctx.ui.setStatus(statusKey, "Pi is revising the plan…");
    planText = await sendAndCapture(pi, buildPlanRevisionMessage(planText, comment));
    ctx.ui.setStatus(statusKey, "");
    planText = planText.replace(/^```[^\n]*\n?/m, "").replace(/```\s*$/m, "").trim();
  }
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
              const cw     = width - 2;
              const innerW = cw - 2; // 1-char margin each side
              const content: string[] = [];

              const end = Math.min(scroll + MAX_PR_VISIBLE, prs.length);
              for (let i = scroll; i < end; i++) {
                const pr  = prs[i];
                const row = `#${pr.number}  ${pr.title}  (${pr.headRefName})`;
                const cell = truncate(row, innerW);
                if (i === cursor) {
                  content.push(" " + INVERT + pad(cell, innerW) + RESET + " ");
                } else {
                  content.push(" " + pad(cell, innerW) + " ");
                }
              }

              const hint = ` ↑↓ navigate · Enter select · Esc cancel `;
              const info = ` ${cursor + 1}/${prs.length} `;

              return zellijFrame(
                content, width,
                { left: BOLD + ` Select PR — ${repoSlug} ` + RESET },
                { left: DIM + hint + RESET, right: DIM + info + RESET }
              );
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

              // ── Location + author (first content line) ──
              content.push(
                DIM + truncate(` ${t.root.path}:${tLine}  @${t.root.user.login}${replyBadge}`, cw) + RESET
              );
              content.push(DIM + ZB.h.repeat(cw) + RESET);

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

              // ── Frame title / footer ──
              const markedBadge = markedIndices.size > 0 ? ` [${markedIndices.size} marked]` : "";
              const markFlag  = isMarked ? " ★" : "";
              const threadPos = `${markFlag} ${threadIdx + 1}/${visibleThreads.length} `;
              const hint      = ` ← → · ↑↓ · m mark · x dismiss · Enter fix · Esc `;
              const scrollInfo = bodyLines.length > BODY_VISIBLE
                ? ` ${scrollY + 1}–${Math.min(scrollY + BODY_VISIBLE, bodyLines.length)}/${bodyLines.length} `
                : "";

              return zellijFrame(
                content, width,
                {
                  left:  BOLD + ` PR #${pr.number} Review Comments${markedBadge} ` + RESET,
                  right: (isMarked ? A_GREEN : DIM) + threadPos + RESET,
                },
                {
                  left:  DIM + hint + RESET,
                  right: DIM + scrollInfo + RESET,
                }
              );
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

      // ── 8. Plan stage ────────────────────────────────────────────────────────
      const { approved: planApproved, planText: approvedPlan } = await planStage(
        pi, ctx,
        buildPrPlanRequestMessage(selectedThreads, pr.number),
        "pr"
      );
      if (!planApproved) continue commentLoop;

      // ── 9. Fix loop: generate → review diff → commit or retry ────────────────
      const DIFF_VISIBLE = 30;
      let feedback: string | undefined;
      let continuing = false;

      // Capture HEAD once so the diff always shows cumulative changes for this task
      let sessionBaseSha = "";
      try { sessionBaseSha = shell("git rev-parse HEAD").trim(); } catch {}

      fixLoop: while (true) {
        // Per-turn SHA — used only to detect whether Pi auto-committed this turn
        let turnBaseSha = "";
        try { turnBaseSha = shell("git rev-parse HEAD").trim(); } catch {}

        const statusMsg = continuing ? "Pi is continuing…"
          : feedback     ? "Pi is revising the fix…"
          :                "Pi is implementing the fix…";
        ctx.ui.setStatus("pr", statusMsg);

        const msg = continuing
          ? "Please continue. Keep implementing until the task is fully complete."
          : buildAgentMessage(selectedThreads, pr.number, feedback, approvedPlan);
        await new Promise<void>((resolve) => {
          let settled = false;
          pi.on("agent_end", () => { if (!settled) { settled = true; resolve(); } });
          pi.sendUserMessage(msg);
        });
        ctx.ui.setStatus("pr", "");
        continuing = false;

        let currentSha = "";
        let rawDiff = "";
        try {
          currentSha = shell("git rev-parse HEAD").trim();
          // Always diff from the session start so the screen shows the full picture
          const base = sessionBaseSha || turnBaseSha;
          const cmd  = currentSha !== base
            ? `git diff ${base}..${currentSha} --unified=5`
            : "git diff HEAD --unified=5";
          rawDiff = shell(cmd);
        } catch {}

        if (!rawDiff.trim()) {
          ctx.ui.notify("Pi made no changes.", "info");
          break fixLoop;
        }

        const patchLines  = rawDiff.split("\n");
        const piCommitted = !!turnBaseSha && !!currentSha && currentSha !== turnBaseSha;

        // ── Screen 3 — Diff Review ─────────────────────────────────────────
        const decision = await ctx.ui.custom<"commit" | "continue" | "reject" | "cancel">(
          (tui, _theme, _kb, done) => {
            let scrollY = 0;
            function clampScroll() {
              const max = Math.max(0, patchLines.length - DIFF_VISIBLE);
              if (scrollY < 0) scrollY = 0;
              if (scrollY > max) scrollY = max;
            }
            return {
              render(width: number): string[] {
                const content: string[] = [];
                const end = Math.min(scrollY + DIFF_VISIBLE, patchLines.length);
                for (let i = scrollY; i < end; i++) {
                  content.push(" " + colorDiffLine(patchLines[i], width - 4));
                }
                for (let i = end - scrollY; i < DIFF_VISIBLE; i++) content.push("");

                const pos        = patchLines.length > DIFF_VISIBLE
                  ? ` ${scrollY + 1}–${Math.min(scrollY + DIFF_VISIBLE, patchLines.length)}/${patchLines.length} `
                  : "";
                const scrollInfo = patchLines.length > DIFF_VISIBLE ? ` ↑↓ ` : "";

                return zellijFrame(
                  content, width,
                  { left: A_BOLD + ` Proposed Fix — PR #${pr.number} ` + A_RESET, right: A_DIM + pos + A_RESET },
                  { left: A_DIM + ` y commit · c continue · n reject · Esc cancel ` + A_RESET, right: A_DIM + scrollInfo + A_RESET }
                );
              },
              handleInput(data: string) {
                if      (data === "\x1b[A" || data === "k") { scrollY--; clampScroll(); }
                else if (data === "\x1b[B" || data === "j") { scrollY++; clampScroll(); }
                else if (data === "\x1b[5~") { scrollY -= DIFF_VISIBLE; clampScroll(); }
                else if (data === "\x1b[6~") { scrollY += DIFF_VISIBLE; clampScroll(); }
                else if (data === "\x1b[H")  { scrollY = 0; }
                else if (data === "\x1b[F")  { scrollY = Math.max(0, patchLines.length - DIFF_VISIBLE); }
                else if (data === "y")                      { done("commit");   return; }
                else if (data === "c")                      { done("continue"); return; }
                else if (data === "n")                      { done("reject");   return; }
                else if (data === "\r" || data === "\n")    { /* block Enter leak */ }
                else if (data === "\x1b")                   { done("cancel");   return; }
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

        if (decision === "continue") {
          // Keep all changes in place; send Pi back to finish the task
          continuing = true;
          feedback = undefined;
          continue fixLoop;
        }

        // Revert before retrying or cancelling
        try {
          if (currentSha !== sessionBaseSha) {
            shell(`git reset --hard ${JSON.stringify(sessionBaseSha)}`);
          } else {
            shell("git restore --staged --worktree .");
          }
        } catch {
          try { shell("git checkout -- ."); } catch {}
        }

        if (decision === "cancel") {
          ctx.ui.notify("Cancelled — changes reverted.", "info");
          break fixLoop;
        }

        // Rejected — collect feedback and retry from clean state
        const fb = await ctx.ui.input(
          "What was wrong with that fix?",
          "Describe the issue so Pi can try again…"
        );
        if (!fb?.trim()) {
          ctx.ui.notify("No feedback — exiting.", "info");
          break fixLoop;
        }
        feedback = fb.trim();
        // Reset session base since we reverted
        try { sessionBaseSha = shell("git rev-parse HEAD").trim(); } catch {}
      }

      } // end commentLoop
    },
  });

  // ─── /todo command ──────────────────────────────────────────────────────────

  pi.registerCommand("todo", {
    description:
      "Browse TODO items from a TODO file in the current repo and have Pi implement them.\n" +
      "  /todo",

    handler: async (_args, ctx) => {
      const RESET  = A_RESET;
      const BOLD   = A_BOLD;
      const DIM    = A_DIM;
      const INVERT = A_INVERT;

      // ── 1. Find repo root ─────────────────────────────────────────────────
      let repoRoot: string;
      try {
        repoRoot = shell("git rev-parse --show-toplevel");
      } catch {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      // ── 2. Find TODO file ─────────────────────────────────────────────────
      const relPath = "TODO";
      const todoPath = join(repoRoot, relPath);

      if (!existsSync(todoPath)) {
        ctx.ui.notify("No TODO file found at repo root.", "info");
        return;
      }

      // ── 3. Parse TODO items ───────────────────────────────────────────────
      const fileContent = readFileSync(todoPath, "utf8");
      const threads = parseTodoFile(fileContent, relPath);

      if (threads.length === 0) {
        ctx.ui.notify(`No open TODO items found in ${relPath}.`, "info");
        return;
      }

      // ── 4. Navigator loop ─────────────────────────────────────────────────
      const BODY_VISIBLE = 22;
      const dismissedIds = new Set<number>();

      todoLoop: while (true) {

        let visibleThreads: Thread[] = [];

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
                const tLine = t.root.line ?? "?";
                const isMarked = markedIndices.has(threadIdx);

                content.push(
                  DIM + truncate(` ${t.root.path}:${tLine}  [${t.root.user.login}]`, cw) + RESET
                );
                content.push(DIM + ZB.h.repeat(cw) + RESET);

                const bodyLines = getBodyLines(width);
                clampScroll(bodyLines.length);

                const visibleEnd = Math.min(scrollY + BODY_VISIBLE, bodyLines.length);
                for (let i = scrollY; i < visibleEnd; i++) {
                  content.push(" " + bodyLines[i]);
                }
                for (let i = visibleEnd - scrollY; i < BODY_VISIBLE; i++) {
                  content.push("");
                }

                const markedBadge = markedIndices.size > 0 ? ` [${markedIndices.size} marked]` : "";
                const markFlag    = isMarked ? " ★" : "";
                const threadPos   = `${markFlag} ${threadIdx + 1}/${visibleThreads.length} `;
                const hint        = ` ← → · ↑↓ · m mark · x dismiss · Enter fix · Esc `;
                const scrollInfo  = bodyLines.length > BODY_VISIBLE
                  ? ` ${scrollY + 1}–${Math.min(scrollY + BODY_VISIBLE, bodyLines.length)}/${bodyLines.length} `
                  : "";

                return zellijFrame(
                  content, width,
                  {
                    left:  BOLD + ` TODO: ${relPath}${markedBadge} ` + RESET,
                    right: (isMarked ? A_GREEN : DIM) + threadPos + RESET,
                  },
                  {
                    left:  DIM + hint + RESET,
                    right: DIM + scrollInfo + RESET,
                  }
                );
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
                  if (markedIndices.has(threadIdx)) markedIndices.delete(threadIdx);
                  else markedIndices.add(threadIdx);
                } else if (data === "x") {
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

              invalidate() { cachedWidth = -1; },
            };
          },
          { overlay: true, overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center" } }
        );

        if (pickedIndices === null) {
          if (visibleThreads.length === 0) {
            ctx.ui.notify("All TODO items dismissed.", "info");
          }
          break todoLoop;
        }

        const selectedThreads = pickedIndices.map((i) => visibleThreads[i]).filter(Boolean);
        if (selectedThreads.length === 0) continue todoLoop;

        // ── 5. Plan stage ────────────────────────────────────────────────────
        const { approved: planApproved, planText: approvedPlan } = await planStage(
          pi, ctx,
          buildTodoPlanRequestMessage(selectedThreads),
          "todo"
        );
        if (!planApproved) continue todoLoop;

        // ── 6. Fix loop ──────────────────────────────────────────────────────
        const DIFF_VISIBLE = 30;
        let feedback: string | undefined;
        let continuing = false;

        let sessionBaseSha = "";
        try { sessionBaseSha = shell("git rev-parse HEAD").trim(); } catch {}

        fixLoop: while (true) {
          let turnBaseSha = "";
          try { turnBaseSha = shell("git rev-parse HEAD").trim(); } catch {}

          const statusMsg = continuing ? "Pi is continuing…"
            : feedback     ? "Pi is revising the implementation…"
            :                "Pi is implementing the plan…";
          ctx.ui.setStatus("todo", statusMsg);

          const msg = continuing
            ? "Please continue. Keep implementing until the task is fully complete."
            : buildTodoAgentMessage(selectedThreads, feedback, approvedPlan);
          await new Promise<void>((resolve) => {
            let settled = false;
            pi.on("agent_end", () => { if (!settled) { settled = true; resolve(); } });
            pi.sendUserMessage(msg);
          });
          ctx.ui.setStatus("todo", "");
          continuing = false;

          let currentSha = "";
          let rawDiff = "";
          try {
            currentSha = shell("git rev-parse HEAD").trim();
            const base = sessionBaseSha || turnBaseSha;
            const cmd  = currentSha !== base
              ? `git diff ${base}..${currentSha} --unified=5`
              : "git diff HEAD --unified=5";
            rawDiff = shell(cmd);
          } catch {}

          if (!rawDiff.trim()) {
            ctx.ui.notify("Pi made no changes.", "info");
            break fixLoop;
          }

          const patchLines  = rawDiff.split("\n");
          const piCommitted = !!turnBaseSha && !!currentSha && currentSha !== turnBaseSha;

          const decision = await ctx.ui.custom<"commit" | "continue" | "reject" | "cancel">(
            (tui, _theme, _kb, done) => {
              let scrollY = 0;
              function clampScroll() {
                const max = Math.max(0, patchLines.length - DIFF_VISIBLE);
                if (scrollY < 0) scrollY = 0;
                if (scrollY > max) scrollY = max;
              }
              return {
                render(width: number): string[] {
                  const content: string[] = [];
                  const end = Math.min(scrollY + DIFF_VISIBLE, patchLines.length);
                  for (let i = scrollY; i < end; i++) {
                    content.push(" " + colorDiffLine(patchLines[i], width - 4));
                  }
                  for (let i = end - scrollY; i < DIFF_VISIBLE; i++) content.push("");

                  const pos = patchLines.length > DIFF_VISIBLE
                    ? ` ${scrollY + 1}–${Math.min(scrollY + DIFF_VISIBLE, patchLines.length)}/${patchLines.length} `
                    : "";
                  const scrollInfo = patchLines.length > DIFF_VISIBLE ? ` ↑↓ ` : "";

                  return zellijFrame(
                    content, width,
                    { left: A_BOLD + ` Proposed Implementation — ${relPath} ` + A_RESET, right: A_DIM + pos + A_RESET },
                    { left: A_DIM + ` y commit · c continue · n reject · Esc cancel ` + A_RESET, right: A_DIM + scrollInfo + A_RESET }
                  );
                },
                handleInput(data: string) {
                  if      (data === "\x1b[A" || data === "k") { scrollY--; clampScroll(); }
                  else if (data === "\x1b[B" || data === "j") { scrollY++; clampScroll(); }
                  else if (data === "\x1b[5~") { scrollY -= DIFF_VISIBLE; clampScroll(); }
                  else if (data === "\x1b[6~") { scrollY += DIFF_VISIBLE; clampScroll(); }
                  else if (data === "\x1b[H")  { scrollY = 0; }
                  else if (data === "\x1b[F")  { scrollY = Math.max(0, patchLines.length - DIFF_VISIBLE); }
                  else if (data === "y")                   { done("commit");   return; }
                  else if (data === "c")                   { done("continue"); return; }
                  else if (data === "n")                   { done("reject");   return; }
                  else if (data === "\r" || data === "\n") { /* block Enter leak */ }
                  else if (data === "\x1b")                { done("cancel");   return; }
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
                shell(`git commit -m ${JSON.stringify(buildTodoCommitMessage(selectedThreads))}`);
              }
              for (const t of selectedThreads) dismissedIds.add(t.root.id);
              ctx.ui.notify(`Implementation committed.`, "info");
            } catch (err: any) {
              ctx.ui.notify(`Commit failed: ${err.message}`, "error");
            }
            break fixLoop;
          }

          if (decision === "continue") {
            continuing = true;
            feedback = undefined;
            continue fixLoop;
          }

          try {
            if (currentSha !== sessionBaseSha) {
              shell(`git reset --hard ${JSON.stringify(sessionBaseSha)}`);
            } else {
              shell("git restore --staged --worktree .");
            }
          } catch {
            try { shell("git checkout -- ."); } catch {}
          }

          if (decision === "cancel") {
            ctx.ui.notify("Cancelled — changes reverted.", "info");
            break fixLoop;
          }

          const fb = await ctx.ui.input(
            "What was wrong with that implementation?",
            "Describe the issue so Pi can try again…"
          );
          if (!fb?.trim()) {
            ctx.ui.notify("No feedback — exiting.", "info");
            break fixLoop;
          }
          feedback = fb.trim();
          try { sessionBaseSha = shell("git rev-parse HEAD").trim(); } catch {}
        }

      } // end todoLoop
    },
  });
}

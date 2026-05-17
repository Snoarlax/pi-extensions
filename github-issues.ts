/**
 * github-issues.ts — Pi extension
 *
 * Adds a /issues command to Pi that accepts:
 *   • A single repo  →  owner/repo  or  https://github.com/owner/repo
 *   • An org/user    →  owner       or  https://github.com/owner/
 *
 * For a single repo it fetches that repo's open issues.
 * For an org/user it fetches all repos (up to 10 with the most issues),
 * then aggregates their open issues into one combined list.
 *
 * Install:
 *   Global  → ~/.pi/agent/extensions/github-issues.ts
 *   Project → .pi/extensions/github-issues.ts
 *
 * Optional — set a GitHub token to raise the rate limit and access private repos:
 *   export GITHUB_TOKEN=ghp_...
 *
 * Usage inside Pi:
 *   /issues                                (uses last target or prompts for one)
 *   /issues owner/repo                     (single repo shorthand)
 *   /issues https://github.com/owner/repo  (single repo URL)
 *   /issues owner                          (org or user — all repos)
 *   /issues https://github.com/owner/      (org or user URL)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi has been published under two npm scopes during its lifetime:
//   @mariozechner/pi-*   (older installs, ≤ 0.73.x)
//   @earendil-works/pi-* (newer installs, ≥ 0.74.0)
// The picker below uses only raw ANSI + the stable ctx.ui.custom() API,
// so we don't need to import anything from pi-tui at all.

// ─── Types ───────────────────────────────────────────────────────────────────

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  comments: number;
  created_at: string;
  user: { login: string } | null;
  /** Injected by us when aggregating across repos */
  _repo?: string;
}

interface GitHubRepo {
  name: string;
  full_name: string;
  open_issues_count: number;
  archived: boolean;
  disabled: boolean;
}

type Target =
  | { kind: "repo"; slug: string }       // "owner/repo"
  | { kind: "profile"; login: string };  // "owner"  (org or user)

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Detect whether the input is a single repo or an org/user profile.
 *
 * Rules:
 *  - "owner/repo"                      → repo
 *  - "https://github.com/owner/repo"   → repo
 *  - "owner"                           → profile
 *  - "https://github.com/owner"        → profile
 *  - "https://github.com/owner/"       → profile
 */
function parseTarget(input: string): Target | null {
  const s = input.trim().replace(/\/$/, ""); // strip trailing slash

  // Looks like a URL
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      const url = new URL(s);
      if (url.hostname !== "github.com") return null;
      const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/").filter(Boolean);
      if (parts.length === 0) return null;
      if (parts.length === 1) return { kind: "profile", login: parts[0] };
      return { kind: "repo", slug: `${parts[0]}/${parts[1]}` };
    } catch {
      return null;
    }
  }

  // shorthand: owner/repo
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return { kind: "repo", slug: s };

  // shorthand: owner  (no slash, no protocol — treat as profile)
  if (/^[\w.-]+$/.test(s)) return { kind: "profile", login: s };

  return null;
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

function makeHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function ghGet<T>(url: string, token?: string): Promise<T> {
  const res = await fetch(url, { headers: makeHeaders(token) });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub API ${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch open issues for one repo (PRs filtered out) */
async function fetchRepoIssues(repo: string, token?: string): Promise<GitHubIssue[]> {
  const data = await ghGet<any[]>(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=50&sort=updated&direction=desc`,
    token
  );
  return data
    .filter((i) => !i.pull_request)
    .map((i) => ({ ...i, _repo: repo } as GitHubIssue));
}

/**
 * Fetch repos for an org or user.
 * Tries org endpoint first; falls back to user endpoint on 404.
 * Returns repos sorted by open_issues_count desc, capped at MAX_REPOS.
 */
const MAX_REPOS = 10;

async function fetchProfileRepos(login: string, token?: string): Promise<GitHubRepo[]> {
  let data: GitHubRepo[];
  try {
    data = await ghGet<GitHubRepo[]>(
      `https://api.github.com/orgs/${login}/repos?type=public&per_page=100&sort=pushed`,
      token
    );
  } catch (err: any) {
    if (err.message.includes("404")) {
      // Not an org — try as a user
      data = await ghGet<GitHubRepo[]>(
        `https://api.github.com/users/${login}/repos?type=public&per_page=100&sort=pushed`,
        token
      );
    } else {
      throw err;
    }
  }

  return data
    .filter((r) => !r.archived && !r.disabled && r.open_issues_count > 0)
    .sort((a, b) => b.open_issues_count - a.open_issues_count)
    .slice(0, MAX_REPOS);
}

// ─── Display helpers ──────────────────────────────────────────────────────────

/** One-liner for the TUI select list */
function summariseIssue(issue: GitHubIssue): string {
  const repo = issue._repo ? `[${issue._repo.split("/")[1]}] ` : "";
  const labels = issue.labels.map((l) => `[${l.name}]`).join(" ");
  const bodySnippet = issue.body
    ? issue.body.replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ").slice(0, 70).trimEnd()
    : "no description";
  return `${repo}#${issue.number}  ${issue.title}${labels ? "  " + labels : ""}  —  ${bodySnippet}…`;
}

/** Prompt sent to Pi when an issue is chosen */
function buildFixPrompt(issue: GitHubIssue): string {
  const repo = issue._repo ?? "unknown/repo";
  const body = issue.body?.trim() || "(no description provided)";
  const labels = issue.labels.map((l) => l.name).join(", ") || "none";

  return `
Please fix the following GitHub issue from the \`${repo}\` repository.

---
**Issue #${issue.number}: ${issue.title}**
URL: ${issue.html_url}
Labels: ${labels}
Opened by: ${issue.user?.login ?? "unknown"}

**Description:**
${body}
---

Steps I'd like you to take:
1. If the repository is not already cloned locally, clone it with \`git clone https://github.com/${repo}.git\`.
2. Understand the issue fully — re-read the description and explore the relevant code.
3. Identify the root cause.
4. Implement a fix, keeping changes minimal and focused.
5. Make sure existing tests still pass (or note if tests need updating).
6. Summarise what you changed and why.
`.trim();
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let lastTarget: Target | null = null;

  pi.registerCommand("issues", {
    description:
      "Browse GitHub issues and pick one for Pi to fix.\n" +
      "  /issues owner/repo          — single repo\n" +
      "  /issues owner               — all repos in an org or user profile\n" +
      "  /issues https://github.com/owner[/repo]",

    handler: async (args, ctx) => {
      const token = process.env.GITHUB_TOKEN;

      // ── 1. Resolve target ────────────────────────────────────────────────
      let target: Target | null = null;
      const argStr = args.trim();

      if (argStr) {
        target = parseTarget(argStr);
        if (!target) {
          ctx.ui.notify(
            `Couldn't parse "${argStr}". Use owner/repo, owner, or a full GitHub URL.`,
            "error"
          );
          return;
        }
      } else if (lastTarget) {
        const label =
          lastTarget.kind === "repo" ? lastTarget.slug : `${lastTarget.login} (profile)`;
        const reuse = await ctx.ui.confirm("Re-use last target?", `Use ${label} again?`);
        if (reuse) {
          target = lastTarget;
        } else {
          const input = await ctx.ui.input(
            "GitHub target",
            "owner/repo, owner, or full GitHub URL"
          );
          if (!input) { ctx.ui.notify("Cancelled.", "info"); return; }
          target = parseTarget(input);
          if (!target) {
            ctx.ui.notify(`Couldn't parse "${input}".`, "error");
            return;
          }
        }
      } else {
        const input = await ctx.ui.input(
          "GitHub target",
          "owner/repo, owner, or full GitHub URL"
        );
        if (!input) { ctx.ui.notify("Cancelled.", "info"); return; }
        target = parseTarget(input);
        if (!target) {
          ctx.ui.notify(`Couldn't parse "${input}".`, "error");
          return;
        }
      }

      lastTarget = target;

      // ── 2. Fetch issues ──────────────────────────────────────────────────
      let issues: GitHubIssue[] = [];

      if (target.kind === "repo") {
        ctx.ui.setStatus("github-issues", `Fetching issues from ${target.slug}…`);
        try {
          issues = await fetchRepoIssues(target.slug, token);
        } catch (err: any) {
          ctx.ui.setStatus("github-issues", "");
          ctx.ui.notify(`Failed to fetch issues: ${err.message}`, "error");
          return;
        }
        ctx.ui.setStatus("github-issues", "");

      } else {
        // Profile mode — fetch repos then their issues in parallel
        ctx.ui.setStatus("github-issues", `Fetching repos for ${target.login}…`);
        let repos: GitHubRepo[];
        try {
          repos = await fetchProfileRepos(target.login, token);
        } catch (err: any) {
          ctx.ui.setStatus("github-issues", "");
          ctx.ui.notify(`Failed to fetch repos: ${err.message}`, "error");
          return;
        }

        if (repos.length === 0) {
          ctx.ui.setStatus("github-issues", "");
          ctx.ui.notify(`No public repos with open issues found for ${target.login}.`, "info");
          return;
        }

        ctx.ui.setStatus(
          "github-issues",
          `Fetching issues from ${repos.length} repos in ${target.login}…`
        );

        const results = await Promise.allSettled(
          repos.map((r) => fetchRepoIssues(r.full_name, token))
        );

        for (const r of results) {
          if (r.status === "fulfilled") issues.push(...r.value);
        }

        // Sort combined list by most recently updated
        issues.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

        ctx.ui.setStatus("github-issues", "");
      }

      if (issues.length === 0) {
        const label = target.kind === "repo" ? target.slug : target.login;
        ctx.ui.notify(`No open issues found for ${label}.`, "info");
        return;
      }

      // ── 3. Present issue list — hand-rolled picker (no SelectList) ──────
      const label = target.kind === "repo" ? target.slug : `${target.login} (all repos)`;
      const MAX_VISIBLE = 15;

      // ANSI helpers — no theme API needed beyond basic fg(), which is stable
      const RESET  = "\x1b[0m";
      const BOLD   = "\x1b[1m";
      const DIM    = "\x1b[2m";
      const INVERT = "\x1b[7m";

      function truncate(s: string, max: number): string {
        // Strip ANSI codes for length measurement, then hard-truncate raw string
        const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
        if (visible.length <= max) return s;
        return visible.slice(0, max - 1) + "…";
      }

      function pad(s: string, width: number): string {
        const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
        return s + " ".repeat(Math.max(0, width - visible.length));
      }

      const selectedIdx = await ctx.ui.custom<number | null>(
        (tui, _theme, _kb, done) => {
          let cursor = 0;   // index in issues[]
          let scroll = 0;   // index of top visible row

          function clamp() {
            if (cursor < 0) cursor = 0;
            if (cursor >= issues.length) cursor = issues.length - 1;
            // Keep cursor inside the visible window
            if (cursor < scroll) scroll = cursor;
            if (cursor >= scroll + MAX_VISIBLE) scroll = cursor - MAX_VISIBLE + 1;
          }

          return {
            render(width: number): string[] {
              const lines: string[] = [];
              const innerW = width - 2; // 1-char padding each side

              // ── header ──
              lines.push(BOLD + truncate(` Issues — ${label}  (${issues.length})`, width) + RESET);
              lines.push(DIM + "─".repeat(width) + RESET);

              // ── visible rows ──
              const end = Math.min(scroll + MAX_VISIBLE, issues.length);
              for (let i = scroll; i < end; i++) {
                const issue = issues[i];
                const repo  = issue._repo ? `[${issue._repo.split("/")[1]}] ` : "";
                const lbl   = issue.labels.map((l: any) => `[${l.name}]`).join(" ");
                const row   = `${repo}#${issue.number} ${issue.title}${lbl ? "  " + lbl : ""}`;
                const cell  = truncate(row, innerW);
                if (i === cursor) {
                  lines.push(" " + INVERT + pad(cell, innerW) + RESET + " ");
                } else {
                  lines.push(" " + pad(cell, innerW) + " ");
                }
              }

              // ── scroll indicator ──
              lines.push(DIM + "─".repeat(width) + RESET);
              const pct  = issues.length > 1
                ? Math.round((cursor / (issues.length - 1)) * 100)
                : 100;
              const scrollInfo = ` ${cursor + 1}/${issues.length}  ${pct}%`;
              const hint       = " ↑↓ navigate · Enter select · Esc cancel ";
              const gap        = width - scrollInfo.length - hint.length;
              lines.push(DIM + hint + " ".repeat(Math.max(0, gap)) + scrollInfo + RESET);

              return lines;
            },

            handleInput(data: string) {
              // Arrow keys / vim keys / enter / esc
              if (data === "\x1b[A" || data === "k") { cursor--; clamp(); }
              else if (data === "\x1b[B" || data === "j") { cursor++; clamp(); }
              else if (data === "\x1b[5~") { cursor -= MAX_VISIBLE; clamp(); }  // PgUp
              else if (data === "\x1b[6~") { cursor += MAX_VISIBLE; clamp(); }  // PgDn
              else if (data === "\x1b[H")  { cursor = 0; clamp(); }             // Home
              else if (data === "\x1b[F")  { cursor = issues.length - 1; clamp(); } // End
              else if (data === "\r" || data === "\n") { done(cursor); return; }
              else if (data === "\x1b")    { done(null); return; }
              tui.requestRender();
            },

            invalidate() {},
          };
        },
        { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } }
      );

      if (selectedIdx === null) {
        ctx.ui.notify("No issue selected.", "info");
        return;
      }

      const selected = issues[selectedIdx];
      if (!selected) return;

      // ── 4. Confirm and hand off to Pi ────────────────────────────────────
      const confirmed = await ctx.ui.confirm(
        `Fix issue #${selected.number}?`,
        `${selected._repo ?? ""}  ${selected.title}`
      );

      if (!confirmed) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      await ctx.waitForIdle();
      pi.sendUserMessage(buildFixPrompt(selected));
    },
  });
}

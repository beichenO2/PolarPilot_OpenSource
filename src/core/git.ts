import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";

function git(args: string[], cwd: string, opts: { env?: NodeJS.ProcessEnv } = {}): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe", ...(opts.env ? { env: opts.env } : {}) }).trim(); }
  catch (e) { throw e instanceof Error ? e : new Error(String(e)); }
}

function ensureGit(cwd: string): void {
  try { git(["rev-parse", "--git-dir"], cwd, { env: { ...process.env, LC_ALL: "C" } }); }
  catch { throw new Error("Not a git repository"); }
}

export function getCurrentBranch(cwd: string): string { ensureGit(cwd); try { return git(["symbolic-ref", "--short", "HEAD"], cwd); } catch { return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd); } }
export function ensureCleanWorkingTree(cwd: string): void { if (git(["status", "--porcelain"], cwd)) throw new Error("Working tree not clean"); }
export function createBranch(name: string, cwd: string): void { git(["checkout", "-b", name], cwd); }
export function getHeadCommit(cwd: string): string { return git(["rev-parse", "HEAD"], cwd); }
export function getBaseCommit(cwd: string): string { return getHeadCommit(cwd); }
export function getBranchCommitCount(base: string, cwd: string): number { if (!base) return 0; return parseInt(git(["rev-list", "--count", "--first-parent", `${base}..HEAD`], cwd), 10); }
export function commitAll(msg: string, cwd: string): void { git(["add", "-A"], cwd); try { git(["commit", "-m", msg], cwd); } catch { /* nothing to commit */ } }
export function resetHard(cwd: string): void { git(["reset", "--hard", "HEAD"], cwd); git(["clean", "-fd"], cwd); }
export function getRepoRootDir(cwd: string): string { return git(["rev-parse", "--show-toplevel"], cwd); }
export function createWorktree(base: string, path: string, branch: string): void { git(["worktree", "add", "-b", branch, path], base); }
export function removeWorktree(base: string, path: string): void { git(["worktree", "remove", "--force", path], base); }
export function listWorktreePaths(base: string): Set<string> {
  let o: string;
  try { o = git(["worktree", "list", "--porcelain"], base); } catch { return new Set(); }
  const s = new Set<string>();
  for (const l of o.split("\n")) { if (l.startsWith("worktree ")) s.add(resolvePath(l.slice(9))); }
  return s;
}

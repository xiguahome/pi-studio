export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: GitFileStatus[];
  additions: number;
  deletions: number;
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601 timestamp from git (%aI). */
  date: string;
  subject: string;
  /** Raw %D refs decoration, e.g. "HEAD -> main, tag: v1.0" (may be empty). */
  refs: string;
}

export interface GitLogResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  commits: GitLogEntry[];
}

export interface GitShowFileStat {
  file: string;
  additions: number;
  deletions: number;
}

export interface GitShowResponse {
  supported: boolean;
  isGitRepository: boolean;
  hash?: string;
  authorName?: string;
  authorEmail?: string;
  date?: string;
  subject?: string;
  body?: string;
  /** Per-file +/- line counts. Binary files report -1. */
  stats?: GitShowFileStat[];
  /** Full unified patch (may be empty for merge commits). */
  patch?: string;
}

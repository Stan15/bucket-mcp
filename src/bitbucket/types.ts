/** Minimal response shapes - only the fields tools actually request via `fields=` (see fields.ts). */

export interface User {
  uuid: string;
  display_name: string;
  nickname?: string;
}

export interface Repository {
  uuid: string;
  name: string;
  full_name: string;
  slug?: string;
  description?: string;
  is_private?: boolean;
  mainbranch?: { name: string };
  links?: { html?: { href: string } };
}

export interface Branch {
  name: string;
  target?: { hash: string; date?: string };
}

export interface Tag {
  name: string;
  target?: { hash: string };
}

export interface Commit {
  hash: string;
  message: string;
  date: string;
  author?: { user?: User; raw?: string };
  links?: { html?: { href: string } };
}

export interface CommitStatus {
  key: string;
  name?: string;
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED";
  url?: string;
  description?: string;
}

export type PullRequestState = "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";

export interface PullRequest {
  id: number;
  title: string;
  description?: string;
  state: PullRequestState;
  author?: User;
  source?: { branch: { name: string } };
  destination?: { branch: { name: string } };
  reviewers?: User[];
  participants?: { user: User; approved: boolean; state: string | null }[];
  created_on?: string;
  updated_on?: string;
  links?: { html?: { href: string } };
}

export interface Comment {
  id: number;
  content: { raw: string };
  user?: User;
  inline?: { path: string; to?: number; from?: number };
  created_on?: string;
  deleted?: boolean;
}

export interface DiffStatEntry {
  status: "added" | "removed" | "modified" | "renamed";
  lines_added?: number;
  lines_removed?: number;
  old?: { path: string };
  new?: { path: string };
}

export interface CodeSearchResult {
  path_matches?: { path: string }[];
  file: { path: string };
  content_matches: { lines: { line: number; segments: { text: string; match?: boolean }[] }[] }[];
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface Tab {
  path: string;
  name: string;
  language: string;
  dirty: boolean;
}
/** Path helpers for zip-relative POSIX paths. Pure. */

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
    } else parts.push(seg);
  }
  return parts.join("/");
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Lower-case extension without dot ("" if none). `foo.synctex.gz` → "gz". */
export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

export function stripExt(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? p : p.slice(0, p.length - (b.length - i));
}

export function join(dir: string, p: string): string {
  return normalizePath(dir ? `${dir}/${p}` : p);
}

export function isAbsolutePath(p: string): boolean {
  return /^(\/|~|[A-Za-z]:[\\/])/.test(p.trim());
}

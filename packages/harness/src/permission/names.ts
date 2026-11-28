/**
 * A path as the file systems the engine supports may resolve it, for matching protected and hidden names. APFS and
 * HFS+ are case-insensitive by default and normalisation-insensitive, and HFS+ also ignores some invisible code
 * points (git's CVE-2014-9390: `.g‌it` is `.git` there). A name that would resolve to a protected one on any of
 * them is protected on every platform. Only for matching: the path itself is never rewritten.
 */
const IGNORABLE = /[​-‏‪-‮⁠-⁤⁪-⁯﻿]/g;

export function foldName(path: string): string {
  return path.replace(IGNORABLE, "").normalize("NFC").toLowerCase();
}

/**
 * How Cookie starts a TypeScript entry under Node.
 *
 * Type stripping exists from Node 22.6. Node 22.13 prints
 * `ExperimentalWarning: Type Stripping is an experimental feature and might change at any time`
 * on stderr, plus a line about `--trace-warnings`. That warning has no
 * code. `--disable-warning` matches a warning type or a code, so
 * `ExperimentalWarning` is the narrowest flag that removes it.
 * `--no-warnings` would hide other warnings. Later 22.x builds omit the
 * line; the flag stays so both stay quiet. Doctor and the drives still
 * reject any other stderr.
 */

export const TYPE_STRIP_NODE_ARGS = [
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
] as const;

export const MIN_NODE_VERSION = "22.6.0";

export function nodeSupportsTypeStripping(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 22) {
    return true;
  }
  if (major < 22) {
    return false;
  }
  return minor >= 6;
}

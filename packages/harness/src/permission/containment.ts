import { redirectTargets, splitShellCommands } from "./safety";

/**
 * Containment-escape denials for AUTOPILOT. In every other mode these actions reach the
 * human (the mode default asks); in autopilot nobody is asked, so the patterns a sandboxed
 * autonomous run must never perform are refused outright, whatever the allow rules say.
 * Deterministic, name-based, and narrow: each entry is a documented escape route, not a
 * heuristic about "dangerous-looking" commands.
 */

interface Rule {
  name: string;
  test: (sub: string) => boolean;
}

const METADATA_HOSTS = /169\.254\.169\.254|metadata\.google\.internal|fd00:ec2::254|100\.100\.100\.200|169\.254\.170\.2/i;

const RULES: Rule[] = [
  { name: "cloud metadata endpoint", test: (s) => METADATA_HOSTS.test(s) },
  {
    name: "pipe from the network into a shell",
    test: (s) => /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(s) || /\b(ba|z|da|k)?sh\s+<\(\s*(curl|wget)\b/.test(s),
  },
  { name: "privilege escalation", test: (s) => /^\s*(sudo|doas|su)\b/.test(s) || /\bpkexec\b/.test(s) },
  {
    name: "persistence (cron/launchd/systemd/login items)",
    test: (s) =>
      /^\s*crontab\b/.test(s) ||
      /\blaunchctl\s+(load|bootstrap|submit|enable)\b/.test(s) ||
      /\bsystemctl\s+(--user\s+)?(enable|link|edit)\b/.test(s) ||
      /\bosascript\b.*login item/i.test(s),
  },
  {
    name: "shell profile edit",
    test: (s) => redirectTargets(s).some((t) => /(^|\/)\.(bashrc|bash_profile|zshrc|zprofile|zshenv|profile|zlogin)$/.test(t)),
  },
  {
    name: "credential store dump",
    test: (s) => /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b/.test(s) || /\bgnome-keyring|secret-tool\s+lookup\b/.test(s),
  },
  {
    name: "decoded execution",
    test: (s) => /\bbase64\b[^|]*\|\s*(ba|z|da|k)?sh\b/.test(s) || /\beval\s+"?\$\(\s*(base64|xxd|openssl\s+enc)\b/.test(s),
  },
  { name: "disabling the firewall or gatekeeper", test: (s) => /\bspctl\s+--master-disable\b|\bsocketfilterfw\b.*--setglobalstate\s+off|\bufw\s+disable\b/.test(s) },
];

/** The escape route the command matches, or null. The whole command is checked (pipelines)
 *  and then each simple command in a chain (anchored patterns like `sudo`). */
export function containmentDeny(command: string): string | null {
  const candidates = [command, ...splitShellCommands(command)];
  for (const r of RULES) {
    const hit = candidates.find((c) => r.test(c));
    if (hit !== undefined) return `autopilot containment: ${r.name} — ${hit.trim().slice(0, 120)}`;
  }
  return null;
}

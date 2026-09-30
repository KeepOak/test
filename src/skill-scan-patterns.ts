import type { SkillFinding } from './skill-scan.js';

/** Selected Hermes skills_guard families, adapted to JavaScript; see THIRD_PARTY_NOTICES.md. */
export const hiddenSkillCharacters = /[\u200b-\u200d\u2060\u2062-\u2064\ufeff\u202a-\u202e\u2066-\u2069]/;
export const upstreamSkillPatterns: [SkillFinding['kind'], [RegExp, string][]][] = [
  ['exfiltration', [
    [/\b(?:curl|wget)\s+(?![^\n]*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b/i, 'interpolates a secret environment variable into an outside request'],
    [/\bcat\s+(?!>)[^\n]*(?:\.env\b|credentials\b|\.netrc\b|\.pgpass\b|\.npmrc\b|\.pypirc\b)/i, 'reads a known credential file'],
    [/!\[[^\n]*\]\(https?:\/\/[^\n)]*\$\{?/i, 'places an interpolated value in a remote image address'],
  ]],
  ['destructive', [
    [/\brm\s+-rf\s+\/(?:(?!tmp(?:\b|\/)|var\/tmp(?:\b|\/)|dev\/shm(?:\b|\/)|run(?:\b|\/))|(?:tmp|var\/tmp|dev\/shm|run)\/(?:[^/\s]*\/)*\.\.(?=\/|[\s;&|]|$))/i, 'requests recursive deletion from the filesystem root'],
    [/\brm\s+(-[^\s]*)?r[^\n]*\$HOME|\brmdir\s+[^\n]*\$HOME/i, 'requests recursive deletion of the home folder'],
    [/\bmkfs\b|\bdd\s+[^\n]*if=[^\n]*of=\/dev\//i, 'requests formatting or writing a raw disk'],
    [/>\s*\/etc\//i, 'overwrites system configuration'],
  ]],
  ['persistence', [
    [/\bcrontab\b|\.(?:bashrc|zshrc|bash_profile|bash_login|zprofile|zlogin)\b|(?<![\w)\]?])\.profile\b/i, 'references scheduled jobs or shell startup files'],
    [/authorized_keys|\/etc\/sudoers|\bvisudo\b/i, 'references persistent access or privilege configuration'],
    [/systemd[^\n]*\.service|systemctl\s+(?:enable|start)|\/etc\/init\.d\/|launchctl\s+load|LaunchAgents|LaunchDaemons/i, 'references a service or startup agent'],
    [/\bgit\s+config\s+--global\s+/i, 'changes global Git configuration'],
  ]],
  ['network', [
    [/\bnc\s+-[lp]|\bncat\s+-[lp]|\bsocat\b[^\n]*\b(?:tcp|udp|openssl|ssl|exec|system|pty|unix)[\w-]*:/i, 'references a network listener or process bridge'],
    [/\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b/i, 'references a service that exposes this computer through a tunnel'],
    [/0\.0\.0\.0:\d+|\bINADDR_ANY\b/i, 'binds to every network interface'],
    [/\/bin\/(?:bash|sh|zsh|ksh|dash)\s+-i\s+[^\n]*>\/dev\/tcp\//i, 'references an interactive shell over a network connection'],
  ]],
  ['obfuscation', [
    [hiddenSkillCharacters, 'contains invisible or directional characters that can hide instructions'],
    [/\bbase64\s+(?:-d|--decode)\s*\|/i, 'decodes an encoded payload into a command pipeline'],
    [/\b(?:eval|exec)\s*\(\s*["']/i, 'evaluates a literal program string'],
    [/\becho\s+[^\n]*\|\s*(?:bash|sh|zsh|ksh|dash|python|perl|ruby|node)\b/i, 'pipes constructed text into an interpreter'],
    [/\\x[0-9a-f]{2}[^\n]*\\x[0-9a-f]{2}[^\n]*\\x[0-9a-f]{2}|\\u[0-9a-f]{4}[^\n]*\\u[0-9a-f]{4}[^\n]*\\u[0-9a-f]{4}/i, 'contains a chain of encoded characters'],
  ]],
];

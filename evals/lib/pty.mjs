// Portable pty wrapper for tests that must talk to a program on a terminal
// (age reads passphrases from /dev/tty only; `brain key reveal` needs a tty).
//
//   ptyWrap(cmd)  → a shell snippet that runs `cmd` (a shell command string)
//                   under a pty via script(1), whichever flavour is installed:
//                     BSD / macOS : script -q /dev/null sh -c 'cmd'
//                     util-linux  : script -qec 'cmd' /dev/null
//   Pipe keystrokes into it:   ( sleep 1; printf 'x\r'; sleep 2 ) | <ptyWrap(cmd)>
// `cmd` must not contain single quotes; reference env vars ("$VAR") instead.
export function ptyWrap(cmd, platform = process.platform) {
  if (cmd.includes("'")) throw new Error('ptyWrap: no single quotes in cmd; pass values through env vars');
  return platform === 'linux' ? `script -qec '${cmd}' /dev/null` : `script -q /dev/null sh -c '${cmd}'`;
}

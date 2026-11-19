// Agent detection: which coding agent (if any) owns a pane, and what it is doing.
// Inputs are the pane's foreground process name (local pty, remote tmux or ps),
// its terminal title, and the visible screen text.

const AGENTS = [
  {
    kind: 'claude',
    proc: /^claude$/i,
    title: /claude|^[✳✻✽✶✢·⠂⠐⠈⠁]\s/i,
    screen: /Claude Code|\? for shortcuts|bypass permissions on|accept edits on|plan mode on|auto mode on|claude\.ai\/|Claude (Opus|Sonnet|Haiku|Fable|Mythos)/,
  },
  { kind: 'codex', proc: /^codex(-.*)?$/i, title: /codex/i, screen: /OpenAI Codex|codex-cli|>_ Codex|⏎ send/ },
  { kind: 'gemini', proc: /^gemini$/i, title: /gemini/i, screen: /Gemini CLI|GEMINI\.md|gemini-[\d.]+-(pro|flash)/ },
  { kind: 'aider', proc: /^aider$/i, title: /aider/i, screen: /[Aa]ider v\d/ },
  { kind: 'opencode', proc: /^opencode$/i, title: /opencode/i, screen: /opencode v?\d|OpenCode/ },
  { kind: 'amp', proc: /^amp$/i, title: /^amp\b/i, screen: /Welcome to Amp|ampcode\.com/ },
  { kind: 'goose', proc: /^goose$/i, title: /goose/i, screen: /goose is running|\( O\)>/ },
  { kind: 'cursor', proc: /^cursor-agent$/i, title: /cursor agent/i, screen: /Cursor Agent/ },
  { kind: 'copilot', proc: /^copilot$/i, title: /copilot/i, screen: /GitHub Copilot CLI|Welcome to GitHub Copilot/ },
  { kind: 'qwen', proc: /^qwen$/i, title: /qwen/i, screen: /Qwen Code/ },
  { kind: 'droid', proc: /^droid$/i, title: /droid/i, screen: /Factory Droid/ },
  { kind: 'crush', proc: /^crush$/i, title: /crush/i, screen: /Charm Crush/ },
];

const SHELL = /^-?(zsh|bash|sh|fish|dash|ksh|mksh|tcsh|csh|ash|busybox|nu|xonsh|elvish|pwsh|powershell(\.exe)?|cmd(\.exe)?|login|sshd|tmux.*|screen)$/i;

const WAITING = new RegExp(
  [
    'Do you want to [^\\n]*\\?',
    'Would you like to [^\\n]*\\?',
    '❯\\s*1\\.\\s*Yes',
    '\\b1\\.\\s*Yes[^\\n]*\\n[^\\n]*\\b2\\.',
    'Allow (this )?(command|edit|tool|execution)',
    'Allow [^\\n]{0,60}\\?\\s*$',
    '\\[y/n\\]|\\(y/n\\)|\\[Y/n\\]|\\(Y/n\\)|\\[y/N\\]|\\(y/N\\)',
    'Press Enter to (continue|confirm|approve)',
    'Waiting for (your |user )?(approval|confirmation|input|permission)',
    'needs your (approval|permission)',
    'Approve\\?|approval required',
    'Apply this change\\?',
  ].join('|'),
  'im'
);

const WORKING = /esc to interrupt|ctrl\+c to interrupt|esc to cancel|press esc to stop|esc to stop|ctrl-c to cancel/i;

const PROMPT_TAIL = /(^|\s)[$#%>❯➜λ]\s*$/;

function basename(p) {
  return String(p || '').split(/[\\/]/).pop().trim();
}

function matchProc(proc) {
  return AGENTS.find((a) => a.proc.test(proc)) || null;
}

function matchScreen(title, text) {
  return AGENTS.find((a) => (title && a.title.test(title)) || a.screen.test(text)) || null;
}

// prev: {kind, state, proc, since}; returns next {kind, state}
function detect(prev, { proc, hasProc, title, text }) {
  proc = basename(proc);
  let kind = null;
  const byProc = proc ? matchProc(proc) : null;

  const lines = text.split('\n').filter((l) => l.trim());
  const atPrompt = PROMPT_TAIL.test(lines[lines.length - 1] || '');
  const busy = WORKING.test(text) || WAITING.test(text);

  if (byProc) {
    kind = byProc.kind;
  } else {
    const sig = matchScreen(title, text);
    if (proc && SHELL.test(proc)) {
      // A shell in the foreground normally means no agent, but a wrapper script can
      // keep the shell as process-group leader. Only trust the screen while it is
      // visibly active, or still showing the agent UI after we already saw it run.
      if (sig && busy) kind = sig.kind;
      else if (prev.kind && proc === prev.proc && sig && !atPrompt) kind = prev.kind;
    } else if (sig) {
      kind = sig.kind;
    } else if (prev.kind && hasProc && proc && proc === prev.proc) {
      kind = prev.kind;
    } else if (prev.kind && !hasProc) {
      kind = atPrompt && !busy ? null : prev.kind;
    }
  }

  if (!kind) return { kind: null, state: 'none', proc };

  const tail = text.split('\n').slice(-25).join('\n');
  let state = 'idle';
  if (WAITING.test(tail)) state = 'waiting';
  else if (WORKING.test(tail)) state = 'working';
  return { kind, state, proc };
}

module.exports = { detect, basename, AGENTS };

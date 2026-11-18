import fs from 'node:fs';
import path from 'node:path';

export const WRITE_MUTATING_TOOLS = [
  'edit',
  'write',
  'patch',
  'apply_patch',
  'multiedit',
  'notebookedit',
];

const WRITE_TOOL_SET = new Set(WRITE_MUTATING_TOOLS);

export function isWriteMutatingTool(toolName) {
  return WRITE_TOOL_SET.has(String(toolName || '').toLowerCase());
}

export function checkReadOnlyBashViolation(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const patterns = [
    { re: /\bsed\s+-i\b/, label: 'sed -i in-place file edit' },
    { re: /\bperl\s+-[a-zA-Z]*i/, label: 'perl -i in-place file edit' },
    { re: /\bgit\s+(commit|reset|clean|checkout|restore|rebase|merge|am|apply)\b/, label: 'mutating git command' },
    { re: /\b(rm|mv|cp|chmod|chown|truncate)\s+.*\/app\b/, label: 'mutating /app workspace files' },
    { re: /\btee\s+(?!\/tmp\/|\/dev\/null)/, label: 'writing non-tmp file via tee' },
  ];
  for (const { re, label } of patterns) {
    if (re.test(command)) {
      return `Read-only role forbids workspace mutation (${label}). Inspect files/logs without modifying workspace state.`;
    }
  }
  return null;
}

// Runtime checks are independent of the model-visible JSON schema.
export function toolFor(strategy, role, name, child = false) {
  const r = strategy?.roles?.[role];
  if (!r) return null;
  const rule = r[name];
  if (!rule || !rule.enable || (child && name === 'delegate')) return null;
  const promptBody = (r[`${name}_prompt`] || '').trim();
  const prefix = promptBody ? `${promptBody}\n` : '';
  return {
    name,
    description:
      prefix +
      `Allowed roles: ${rule.valid_roles.join(', ')}. Call this tool alone. ` +
      (name === 'handoff'
        ? 'Transfer main control to the target role.'
        : 'Wait for a child report, then continue the current role.') +
      ' is_fork=true inherits the interaction snapshot before this assistant turn; false omits interaction history.' +
      (name === 'handoff'
        ? ' Both modes always receive the original task plus context and prompt.'
        : ' The child receives context and prompt, plus the snapshot when forked.'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['role', 'is_fork', 'context', 'prompt'],
      properties: {
        role: { type: 'string', enum: rule.valid_roles },
        is_fork: { type: 'boolean' },
        context: {
          type: 'string',
          description: 'Background and evidence for the recipient; may be empty.',
        },
        prompt: {
          type: 'string',
          minLength: 1,
          description: 'Assignment and expected result for the recipient.',
        },
      },
    },
  };
}

export function validateCall(strategy, role, name, args, child = false) {
  if (!['handoff', 'delegate'].includes(name)) throw new Error('Unknown control tool');
  const tool = toolFor(strategy, role, name, child);
  if (!tool) throw new Error(`${name} is disabled`);
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).sort().join(',') !== 'context,is_fork,prompt,role' ||
    !tool.parameters.properties.role.enum.includes(args.role) ||
    typeof args.is_fork !== 'boolean' ||
    typeof args.context !== 'string' ||
    typeof args.prompt !== 'string' ||
    !args.prompt.trim()
  ) {
    throw new Error('Invalid control arguments');
  }
}

export function interactions(input) {
  if (!Array.isArray(input)) throw new Error('Expected Responses input array');
  // Keep visible conversation (including image content parts) and complete tool call/result pairs.
  // Drop privileged instructions and provider-specific reasoning; never copy server response IDs.
  const rows = structuredClone(input).filter(
    x => !['system', 'developer'].includes(x.role) && x.type !== 'reasoning'
  );
  const calls = new Set(rows.filter(x => x.type === 'function_call').map(x => x.call_id));
  const results = new Set(rows.filter(x => x.type === 'function_call_output').map(x => x.call_id));
  return rows
    .filter(
      x =>
        !['function_call', 'function_call_output'].includes(x.type) ||
        (calls.has(x.call_id) && results.has(x.call_id))
    )
    .map(x => {
      delete x.id;
      return x;
    });
}

export function transferInput(args, snapshot) {
  return [
    ...(args.is_fork ? interactions(snapshot) : []),
    { role: 'user', content: `## Context\n${args.context}\n\n## Assignment\n${args.prompt}` },
  ];
}

export function handoffInput(args, snapshot, originalTask) {
  const original = interactions(originalTask);
  let history = args.is_fork ? interactions(snapshot) : [];
  // Forked projections already begin with the original task. Keep it exactly once.
  if (
    original.length &&
    JSON.stringify(history.slice(0, original.length)) === JSON.stringify(original)
  ) {
    history = history.slice(original.length);
  }
  return [...original, ...history, ...transferInput({ ...args, is_fork: false }, [])];
}

export function project(payload, role, inherited, cut) {
  const p = structuredClone(payload);
  if (!Array.isArray(p.input)) throw new Error('Expected Responses input array');
  const extra = role.system_prompt && role.system_prompt.trim()
    ? [{ role: 'developer', content: role.system_prompt }]
    : [];
  // Ordinary continuation is native Pi history, not a transferable snapshot.
  // Preserve reasoning/encrypted content, image blocks, item IDs and server continuation state.
  if (cut === null && inherited.length === 0) {
    let insertion = 0;
    while (insertion < p.input.length && ['system', 'developer'].includes(p.input[insertion].role)) {
      insertion++;
    }
    p.input.splice(insertion, 0, ...extra);
    return p;
  }
  if (cut !== null && (!Number.isInteger(cut) || cut < 0 || cut > p.input.length)) {
    throw new Error('Invalid transfer boundary');
  }
  const native = p.input.filter(x => ['system', 'developer'].includes(x.role));
  // Only the transferred snapshot is sanitized. The recipient's own new history
  // retains its native reasoning on every subsequent request.
  const fresh = (cut === null ? p.input : p.input.slice(cut)).filter(
    x => !['system', 'developer'].includes(x.role)
  );
  p.input = [...native, ...extra, ...inherited, ...fresh];
  delete p.previous_response_id;
  return p;
}

/**
 * Append-only, prompt-cache-safe observation archiver (SoL-Pi evidence-preserving style).
 * Never mutates historical turns and never touches multimodal image outputs.
 */
export function compactObservation(toolName, toolInput, rawText, obsConfig, archiveDir, seq) {
  if (!obsConfig || !obsConfig.enabled || typeof rawText !== 'string') {
    return { compacted: false, text: rawText };
  }
  const normTool = String(toolName || '').toLowerCase();
  let maxChars = 0;
  if (normTool === 'bash') {
    maxChars = Number(obsConfig.bash_max_chars ?? 12000);
  } else if (normTool === 'read') {
    const hasSlice =
      toolInput &&
      (toolInput.offset !== undefined ||
        toolInput.limit !== undefined ||
        toolInput.view_range !== undefined);
    maxChars = hasSlice
      ? Number(obsConfig.read_sliced_max_chars ?? 24000)
      : Number(obsConfig.read_max_chars ?? 16000);
  } else {
    return { compacted: false, text: rawText };
  }

  const headChars = Number(obsConfig.head_chars ?? 4500);
  const tailChars = Number(obsConfig.tail_chars ?? 4500);
  if (maxChars <= 0 || rawText.length <= maxChars || rawText.length <= headChars + tailChars + 400) {
    return { compacted: false, text: rawText };
  }

  const totalLines = rawText.split('\n').length;
  let archivePath = '';
  let archiveNotice = '';
  if (archiveDir) {
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      const safeTool = normTool.replace(/[^a-z0-9_-]/g, '') || 'tool';
      archivePath = path.join(archiveDir, `obs_${String(seq).padStart(4, '0')}_${safeTool}.log`);
      fs.writeFileSync(archivePath, rawText, 'utf8');
      archiveNotice =
        ` Full raw output (${rawText.length} chars, ${totalLines} lines) saved to \`${archivePath}\`.` +
        ` Inspect specific ranges with read/grep, or if \`delegate\` is available, pass \`${archivePath}\` to the read-only evidence reader.`;
    } catch {}
  }

  const omittedChars = rawText.length - headChars - tailChars;
  const compactedText =
    `${rawText.slice(0, headChars)}\n\n` +
    `... [ObservationArchive: omitted ${omittedChars} middle chars of ${rawText.length} total chars (${totalLines} lines).${archiveNotice}] ...\n\n` +
    `${rawText.slice(rawText.length - tailChars)}`;

  return {
    compacted: true,
    text: compactedText,
    originalChars: rawText.length,
    compactedChars: compactedText.length,
    savedChars: rawText.length - compactedText.length,
    archivePath,
  };
}

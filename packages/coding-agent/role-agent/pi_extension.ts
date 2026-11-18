import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  toolFor,
  validateCall,
  interactions,
  transferInput,
  project,
  handoffInput,
  compactObservation,
  isWriteMutatingTool,
  checkReadOnlyBashViolation,
} from './protocol.mjs';
import { checkDelegateScope, DEFAULT_MIN_BYTES, DEFAULT_MIN_LINES } from './delegate-scope.ts';

export default function (pi: any) {
  const folder = process.env.ROLE_RUN || process.env.RSI_RUN_DIR;
  if (!folder) {
    throw new Error('ROLE_RUN or RSI_RUN_DIR environment variable is required');
  }
  const spec = JSON.parse(fs.readFileSync(path.join(folder, 'spec.json'), 'utf8'));
  const providerName = spec.provider_name || 'role-api';
  const maxHandoffs = Number(spec.max_handoffs ?? spec.strategy?.max_handoffs ?? 8);
  const maxDelegates = Number(spec.max_delegates ?? spec.strategy?.max_delegates ?? 12);
  const childTimeoutSec = Number(spec.child_timeout ?? spec.timeout ?? 28800);
  const archiveDir = spec.obs_archive_dir || '/tmp/role-obs-archive';
  const obsConfig = spec.obs_limiter ?? spec.strategy?.obs_limiter ?? { enabled: false };

  let role: string = spec.role;
  let inherited: any[] = spec.inherited || [];
  let cut: number | null = null;
  let pending = false;
  let snapshot: any[] = [];
  let hops = 0;
  let delegates = 0;
  let obsSeq = 0;
  let batch: any[] = [];
  let busy = false;
  let originalTask: any[] | null = null;

  const log = (event: Record<string, unknown>) => {
    try {
      fs.mkdirSync(folder, { recursive: true });
      fs.appendFileSync(
        path.join(folder, 'events.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n',
        'utf8'
      );
    } catch {}
  };

  const fatal = (message: string) => {
    try {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'fatal.json'), JSON.stringify({ error: message }), 'utf8');
    } catch {}
  };

  // This Pi build aborts the request when a before_provider_request handler
  // throws, so rethrowing is enough to keep unprojected payloads from leaking.
  const stopRequest = (error: unknown) => {
    try {
      fatal(`Request projection failed: ${String(error)}`);
    } catch {}
    try {
      fs.writeSync(2, `ROLE_REQUEST_FATAL: ${String(error)}\n`);
    } catch {}
    throw error instanceof Error ? error : new Error(String(error));
  };

  const activeControlTools = () =>
    ['handoff', 'delegate'].filter(n => toolFor(spec.strategy, role, n, Boolean(spec.child)));

  const sync = async (ctx: any) => {
    const config = spec.strategy.roles[role];
    const model = ctx.modelRegistry.find(providerName, config.model);
    if (!model || !(await pi.setModel(model))) {
      throw new Error(`Cannot select role model ${providerName}/${config.model}`);
    }
    pi.setThinkingLevel(config.reasoning_effort);
    const baseTools = pi
      .getActiveTools()
      .filter((n: string) => !['handoff', 'delegate'].includes(n))
      .filter((n: string) => !(config.read_only && isWriteMutatingTool(n)));
    pi.setActiveTools([...baseTools, ...activeControlTools()]);
    ctx.ui?.setStatus?.(
      'role-agent',
      `Role: ${role} (${config.model})${spec.child ? ' [child]' : ''}`
    );
  };

  pi.on('session_start', async (_: any, ctx: any) => {
    await sync(ctx);
  });

  pi.on('before_agent_start', async (_: any, ctx: any) => {
    await sync(ctx);
  });

  pi.on('before_provider_headers', (event: any) => {
    const config = spec.strategy.roles[role];
    event.headers['X-Rsi-Role'] = role;
    event.headers['X-Rsi-Session-Kind'] = spec.child ? 'delegate' : 'main';
    event.headers['X-Rsi-Handoff-Hop'] = String(hops);
    event.headers['X-Role-Active-Model'] = config.model;
    event.headers['X-Role-Active-Effort'] = config.reasoning_effort;
    if (spec.delegate_id) {
      event.headers['X-Dh-Delegate-Id'] = String(spec.delegate_id);
    }
  });

  pi.on('before_provider_request', (event: any) => {
    try {
      const config = spec.strategy.roles[role];
      if (originalTask === null) {
        originalTask =
          spec.original_task ?? interactions(event.payload.input).filter((m: any) => m.role === 'user');
        fs.writeFileSync(path.join(folder, 'original-task.json'), JSON.stringify(originalTask), 'utf8');
      }
      const nextCut = pending ? event.payload.input.length : cut;
      const payload = project(event.payload, config, inherited, nextCut);
      payload.model = config.model;
      payload.reasoning = { ...(payload.reasoning || {}), effort: config.reasoning_effort };

      const controlMap = Object.fromEntries(
        activeControlTools().map(n => [n, toolFor(spec.strategy, role, n, Boolean(spec.child))])
      );
      payload.tools = (payload.tools || [])
        .filter((t: any) => !['handoff', 'delegate'].includes(t.name) || controlMap[t.name])
        .filter((t: any) => !(config.read_only && isWriteMutatingTool(t.name)));
      for (const t of payload.tools) {
        if (controlMap[t.name]) Object.assign(t, controlMap[t.name]);
      }

      const nextSnapshot = interactions(payload.input);
      log({
        event: 'request',
        role,
        child: Boolean(spec.child),
        model: payload.model,
        effort: payload.reasoning?.effort,
        hops,
        delegates,
        tools: activeControlTools(),
        read_only: Boolean(config.read_only),
        input_items: Array.isArray(payload.input) ? payload.input.length : 0,
      });
      cut = nextCut;
      pending = false;
      snapshot = nextSnapshot;
      return payload;
    } catch (error) {
      stopRequest(error);
    }
  });

  pi.on('message_end', (event: any) => {
    if (event?.message?.role === 'assistant' && Array.isArray(event.message.content)) {
      batch = event.message.content.filter((c: any) => c && c.type === 'toolCall');
    }
  });

  pi.on('tool_call', (event: any) => {
    const config = spec.strategy.roles[role];
    if (config.read_only) {
      if (isWriteMutatingTool(event.toolName)) {
        log({
          event: 'readonly_violation_blocked',
          role,
          tool: event.toolName,
          path: event.input?.path,
        });
        return {
          block: true,
          reason: `Role "${role}" is read-only (evidence/log reader): "${event.toolName}" is disabled. Return your extracted evidence to the parent agent.`,
        };
      }
      if (event.toolName === 'bash') {
        const violation = checkReadOnlyBashViolation(String(event.input?.command || ''));
        if (violation) {
          log({
            event: 'readonly_violation_blocked',
            role,
            tool: 'bash',
            command: String(event.input?.command || '').slice(0, 200),
          });
          return { block: true, reason: violation };
        }
      }
    }

    if (!['handoff', 'delegate'].includes(event.toolName)) return;
    try {
      validateCall(spec.strategy, role, event.toolName, event.input, Boolean(spec.child));
      if (batch.length !== 1) throw new Error('Control tools must be called alone');
      if (busy) throw new Error('Another transfer is running');
      if (event.toolName === 'handoff' && hops >= maxHandoffs) {
        throw new Error(`Handoff limit (${maxHandoffs}) reached; complete the task directly`);
      }
      if (event.toolName === 'delegate' && delegates >= maxDelegates) {
        throw new Error(`Delegate limit (${maxDelegates}) reached; complete the remaining work directly`);
      }
      const scope = spec.strategy.roles[role]?.delegate?.scope;
      if (event.toolName === 'delegate' && scope) {
        const verdict = checkDelegateScope(event.input || {}, {
          cwd: spec.workspace || process.cwd(),
          archiveDir,
          minBytes: Number(scope.min_bytes ?? DEFAULT_MIN_BYTES),
          minLines: Number(scope.min_lines ?? DEFAULT_MIN_LINES),
        });
        if (!verdict.ok) {
          log({ event: 'delegate_scope_rejected', role, reason: verdict.reason });
          throw new Error(verdict.reason);
        }
        log({ event: 'delegate_scope_ok', role, targets: verdict.targets });
      }
    } catch (error) {
      return { block: true, reason: String(error) };
    }
  });

  pi.on('tool_result', (event: any) => {
    try {
      if (!obsConfig || !obsConfig.enabled) return;
      if (event.toolName !== 'bash' && event.toolName !== 'read') return;
      if (!Array.isArray(event.content) || event.content.length === 0) return;
      // Preserve multimodal image blocks (e.g. read on PNG/JPEG/WEBP/GIF) completely untouched
      if (event.content.some((c: any) => !c || c.type !== 'text' || typeof c.text !== 'string')) {
        return;
      }
      if (event.content.length !== 1) return;

      const rawText = event.content[0].text;
      obsSeq += 1;
      const compacted = compactObservation(
        event.toolName,
        event.input || {},
        rawText,
        obsConfig,
        archiveDir,
        obsSeq
      );
      if (!compacted.compacted) return;
      log({
        event: 'obs_truncated',
        role,
        child: Boolean(spec.child),
        tool: event.toolName,
        original_chars: compacted.originalChars,
        compacted_chars: compacted.compactedChars,
        saved_chars: compacted.savedChars,
        archive_path: compacted.archivePath,
      });
      return {
        content: [{ ...event.content[0], text: compacted.text }],
      };
    } catch {}
  });

  for (const name of ['handoff', 'delegate'] as const) {
    const initial = spec.strategy.available_roles
      .map((r: string) => toolFor(spec.strategy, r, name, Boolean(spec.child)))
      .find(Boolean);
    if (!initial) continue;
    const registration = structuredClone(initial);
    registration.parameters.properties.role.enum = spec.strategy.available_roles;

    pi.registerTool({
      ...registration,
      label: name,
      executionMode: 'sequential',
      exposure: 'model-only',
      async execute(_id: string, args: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
        validateCall(spec.strategy, role, name, args, Boolean(spec.child));
        if (busy || batch.length !== 1) throw new Error('Call a control tool alone');
        if (signal?.aborted) throw new Error('Cancelled');
        busy = true;
        try {
          const input =
            name === 'handoff'
              ? handoffInput(args, snapshot, originalTask || [])
              : transferInput(args, snapshot);

          if (name === 'handoff') {
            if (hops >= maxHandoffs) {
              fatal('Handoff limit exceeded');
              throw new Error('Handoff limit exceeded; finish the task');
            }
            const previous = role;
            role = args.role;
            try {
              await sync(ctx);
            } catch (error) {
              role = previous;
              await sync(ctx);
              throw error;
            }
            inherited = input;
            pending = true;
            hops++;
            log({
              event: 'handoff',
              from: previous,
              role,
              model: spec.strategy.roles[role]?.model,
              child: Boolean(spec.child),
              is_fork: args.is_fork,
              hops,
              session: ctx.sessionManager?.getSessionId?.(),
            });
            return {
              content: [{ type: 'text', text: `Control transferred to ${role}. Continue the assignment.` }],
              details: { role },
            };
          }

          if (delegates >= maxDelegates) {
            throw new Error(`Delegate limit (${maxDelegates}) reached; complete the remaining work directly`);
          }
          delegates++;
          const delegateId = `delegate-${String(delegates).padStart(2, '0')}-${randomUUID().slice(0, 8)}`;
          const delegatesRoot = path.join(folder, 'delegates');
          const childFolder = path.join(delegatesRoot, delegateId);
          fs.mkdirSync(childFolder, { recursive: true });

          const requestPath = path.join(childFolder, 'request.json');
          const childBaseUrl = spec.gateway_trial_base
            ? `${spec.gateway_trial_base}/${encodeURIComponent(args.role)}/delegate/v1`
            : spec.base_url;
          const childSpec = {
            ...spec,
            role: args.role,
            child: true,
            delegate_id: delegateId,
            inherited: input,
            original_task: transferInput({ ...args, is_fork: false }, []),
            timeout: childTimeoutSec,
            child_timeout: childTimeoutSec,
            base_url: childBaseUrl,
          };
          fs.writeFileSync(requestPath, JSON.stringify(childSpec, null, 2) + '\n', 'utf8');

          log({
            event: 'delegate',
            from: role,
            role,
            target: args.role,
            model: spec.strategy.roles[args.role]?.model,
            is_fork: args.is_fork,
            delegate_id: delegateId,
            delegate_seq: delegates,
            timeout_sec: childTimeoutSec,
            folder: childFolder,
          });
          onUpdate?.({
            content: [{ type: 'text', text: `Waiting for ${args.role} (${spec.strategy.roles[args.role]?.model})…` }],
            details: { folder: childFolder, delegateId },
          });

          const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'child_runner.mjs');
          const nodeBin =
            process.env.ROLE_NODE_BIN ||
            (fs.existsSync('/opt/tb4-node/bin/node') ? '/opt/tb4-node/bin/node' : process.execPath);
          const result = await new Promise<any>((resolve, reject) => {
            const proc = spawn(nodeBin, [runnerPath, requestPath], {
              env: process.env,
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: true,
            });
            let out = '';
            let err = '';
            const killChildTree = () => {
              try {
                if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
              } catch {
                try {
                  proc.kill('SIGTERM');
                } catch {}
              }
            };
            const timer = setTimeout(() => {
              killChildTree();
            }, (childTimeoutSec + 30) * 1000);

            signal?.addEventListener('abort', killChildTree, { once: true });
            proc.stdout.on('data', d => {
              out += d.toString();
            });
            proc.stderr.on('data', d => {
              err += d.toString();
            });
            proc.on('error', error => {
              clearTimeout(timer);
              signal?.removeEventListener('abort', killChildTree);
              reject(error);
            });
            proc.on('close', code => {
              clearTimeout(timer);
              signal?.removeEventListener('abort', killChildTree);
              if (signal?.aborted) return reject(new Error('Delegate cancelled'));
              if (code !== 0) {
                return reject(new Error((err || out || `Delegate failed with exit code ${code}`).trim()));
              }
              try {
                resolve(JSON.parse(out.trim()));
              } catch (parseErr) {
                reject(new Error(`Invalid delegate JSON output: ${String(parseErr)}`));
              }
            });
            if (signal?.aborted) killChildTree();
          });

          log({
            event: 'delegate_return',
            role,
            target: args.role,
            delegate_id: delegateId,
            report_chars: String(result.report || '').length,
            folder: childFolder,
          });
          return {
            content: [{ type: 'text', text: result.report }],
            usage: result.usage,
            details: { role, target: args.role, delegateId, folder: childFolder },
          };
        } finally {
          busy = false;
        }
      },
    });
  }
}

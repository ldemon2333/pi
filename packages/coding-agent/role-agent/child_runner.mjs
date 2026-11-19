#!/usr/bin/env node
/**
 * Container-safe, Python-free child runner for `delegate` in both Pi (1.2.0) and OpenCode (1.19.3).
 * Enforces 8h default child timeout (28,800s), >1M context window (1,050,000), vision input, and xhigh effort.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVE_ROOT = path.resolve(HERE, '..');
const DEFAULT_CONTEXT_WINDOW = 1050000;
const DEFAULT_MAX_OUTPUT_TOKENS = 128000;

function saveJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function resolvePiCommand(spec) {
  if (spec.executable && fs.existsSync(spec.executable)) {
    return [spec.executable];
  }
  if (fs.existsSync('/usr/local/bin/pi')) {
    return ['/usr/local/bin/pi'];
  }
  // When shipped inside pi-coding-agent, run this package's own bundle.
  const packageCli = path.resolve(HERE, '../dist/bundle/cli.js');
  if (fs.existsSync(packageCli)) {
    const nodeBin = process.env.ROLE_NODE_BIN && fs.existsSync(process.env.ROLE_NODE_BIN) ? process.env.ROLE_NODE_BIN : process.execPath;
    return [nodeBin, packageCli];
  }
  const containerCli = '/opt/tb4-cli/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  const containerNode = '/opt/tb4-node/bin/node';
  if (fs.existsSync(containerCli) && fs.existsSync(containerNode)) {
    return [containerNode, containerCli];
  }
  const hostCli = path.join(SAVE_ROOT, 'runtime/cli-bundle/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  const hostNode = path.join(SAVE_ROOT, 'runtime/node-linux-x64/bin/node');
  if (fs.existsSync(hostCli)) {
    return [fs.existsSync(hostNode) ? hostNode : process.execPath, hostCli];
  }
  throw new Error('Pi 1.2.0 executable not found in child_runner');
}

function resolveOpenCodeBin(spec) {
  const candidates = [
    spec.opencode_executable,
    process.env.ROLE_OPENCODE_BIN,
    '/usr/local/bin/opencode',
    '/opt/tb4-cli/node_modules/opencode-ai/bin/opencode.exe',
    path.join(SAVE_ROOT, 'runtime/cli-bundle/node_modules/opencode-ai/bin/opencode.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('OpenCode 1.19.3 executable not found in child_runner');
}

function buildPiModelsJson(strategy, baseUrl) {
  const defs = {};
  for (const mId of ['gpt-6.1-sol', 'gpt-6-luna']) {
    defs[mId] = {
      id: mId,
      name: mId,
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      thinkingLevelMap: {
        off: null,
        minimal: 'low',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
      compat: { supportsOpenAIGrammarTools: true },
    };
  }
  for (const r of Object.values(strategy.roles || {})) {
    const mId = r.model;
    defs[mId] = {
      id: mId,
      name: mId,
      reasoning: true,
      input: r.enable_vision === false ? ['text'] : ['text', 'image'],
      contextWindow: Math.max(DEFAULT_CONTEXT_WINDOW, Number(r.context_window || DEFAULT_CONTEXT_WINDOW)),
      maxTokens: Number(r.max_output_tokens || DEFAULT_MAX_OUTPUT_TOKENS),
      thinkingLevelMap: {
        off: null,
        minimal: 'low',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
      compat: { supportsOpenAIGrammarTools: true },
    };
  }
  return {
    providers: {
      'role-api': {
        baseUrl,
        api: 'openai-responses',
        apiKey: '${OPENAI_API_KEY}',
        models: Object.keys(defs).sort().map((k) => defs[k]),
      },
    },
  };
}

function buildOpenCodeConfig(strategy, roleName, baseUrl) {
  const role = strategy.roles[roleName];
  const allModels = new Set(['gpt-6.1-sol', 'gpt-6-luna']);
  for (const r of Object.values(strategy.roles || {})) allModels.add(r.model);
  const modelsCfg = {};
  for (const mId of Array.from(allModels).sort()) {
    modelsCfg[mId] = {
      id: mId,
      name: mId,
      attachment: true,
      reasoning: true,
      tool_call: true,
      limit: { context: DEFAULT_CONTEXT_WINDOW, output: DEFAULT_MAX_OUTPUT_TOKENS },
      modalities: { input: ['text', 'image'], output: ['text'] },
      options: { reasoningEffort: 'xhigh', reasoningSummary: 'detailed' },
      variants: { xhigh: { reasoningEffort: 'xhigh', reasoningSummary: 'detailed' } },
    };
  }
  const primaryRef = `openai/${role.model}`;
  const agentEntry = {
    model: primaryRef,
    variant: role.reasoning_effort,
    options: { reasoningEffort: role.reasoning_effort },
  };
  const pluginUri = new URL('./opencode_plugin.mjs', import.meta.url).href;
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    plugin: [pluginUri],
    model: primaryRef,
    small_model: primaryRef,
    provider: {
      openai: {
        options: { baseURL: baseUrl, apiKey: 'dummy', timeout: 7200000 },
        models: modelsCfg,
      },
    },
    agent: Object.fromEntries(
      ['build', 'plan', 'general', 'explore', 'title', 'summary', 'compaction'].map((n) => [n, { ...agentEntry }])
    ),
    permission: {
      edit: role.read_only ? 'deny' : 'allow',
      bash: 'allow',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'allow',
    },
  };
  if (role.read_only) {
    cfg.tools = {
      edit: false,
      write: false,
      patch: false,
      apply_patch: false,
      multiedit: false,
    };
  }
  return cfg;
}

function summarizePiStdout(stdoutPath) {
  let finalMsg = null;
  let settled = false;
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const raw = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (ev.type === 'agent_start') settled = false;
    if (ev.type === 'agent_settled') settled = TrueBoolean(true);
    if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      const u = ev.message.usage || {};
      usage.input += Number(u.input || 0);
      usage.output += Number(u.output || 0);
      usage.cacheRead += Number(u.cacheRead || 0);
      usage.cacheWrite += Number(u.cacheWrite || 0);
      usage.totalTokens += Number(u.totalTokens || 0);
      finalMsg = ev.message;
    }
  }
  const report = ((finalMsg && finalMsg.content) || [])
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  return {
    report,
    usage,
    settled,
    final_stop_reason: finalMsg?.stopReason || null,
    success: Boolean(finalMsg && finalMsg.stopReason === 'stop' && report.trim() && settled),
  };
}

function TrueBoolean(v) {
  return Boolean(v);
}

function summarizeOpenCodeStdout(stdoutPath) {
  const allText = [];
  let lastStepText = [];
  let curStepText = [];
  const errors = [];
  let finishReason = null;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const raw = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    const part = ev.part || {};
    if (ev.type === 'step_start') {
      curStepText = [];
    } else if (ev.type === 'text' && part.text) {
      allText.push(part.text);
      curStepText.push(part.text);
    } else if (ev.type === 'step_finish') {
      finishReason = part.reason || finishReason;
      if (curStepText.length) lastStepText = [...curStepText];
      const toks = part.tokens || {};
      const cache = toks.cache || {};
      const inT = Number(toks.input || 0);
      const outT = Number(toks.output || 0);
      const crT = Number(cache.read || 0);
      const cwT = Number(cache.write || 0);
      usage.input += inT;
      usage.output += outT;
      usage.cacheRead += crT;
      usage.cacheWrite += cwT;
      usage.totalTokens += inT + outT + crT + cwT;
    } else if (ev.type === 'error') {
      errors.push(ev.error || ev);
    }
  }
  const report = lastStepText.join('\n').trim() || allText.join('\n').trim();
  return {
    report,
    usage,
    errors,
    final_stop_reason: finishReason,
    success: Boolean(report && errors.length === 0),
  };
}

function startHeaderRelay(upstreamBaseUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(upstreamBaseUrl.replace(/\/+$/, ''));
    const isHttps = u.protocol === 'https:';
    const clientMod = isHttps ? https : http;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);
        const activeModel = req.headers['x-role-active-model'];
        const activeEffort = req.headers['x-role-active-effort'];
        if (req.method === 'POST' && body.length > 0 && (activeModel || activeEffort)) {
          try {
            const parsed = JSON.parse(body.toString('utf8'));
            if (parsed && typeof parsed === 'object') {
              if (activeModel) parsed.model = String(activeModel).split('/').pop();
              if (activeEffort) {
                parsed.reasoning = { ...(parsed.reasoning || {}), effort: String(activeEffort) };
              }
              body = Buffer.from(JSON.stringify(parsed), 'utf8');
            }
          } catch {}
        }
        const headers = { ...req.headers };
        delete headers.host;
        delete headers.connection;
        delete headers['transfer-encoding'];
        headers['content-length'] = String(body.length);
        const upstreamReq = clientMod.request(
          {
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
            timeout: 7200000,
          },
          (upRes) => {
            res.writeHead(upRes.statusCode || 502, upRes.headers);
            upRes.pipe(res);
          }
        );
        upstreamReq.on('error', (err) => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        });
        if (body.length > 0) upstreamReq.write(body);
        upstreamReq.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const basePath = u.pathname.replace(/\/+$/, '');
      resolve({
        server,
        localBaseUrl: `http://127.0.0.1:${addr.port}${basePath}`,
      });
    });
    server.on('error', reject);
  });
}

async function runChild() {
  const requestPath = path.resolve(process.argv[2]);
  const spec = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  if (!spec.child) throw new Error('child_runner requires spec.child === true');

  const sessionFolder = path.join(path.dirname(requestPath), 'session');
  fs.mkdirSync(sessionFolder, { recursive: true });
  const archiveDir = spec.obs_archive_dir || '/tmp/role-obs-archive';
  fs.mkdirSync(archiveDir, { recursive: true });

  const harness = spec.harness || 'pi';
  const timeoutSec = Number(spec.child_timeout || spec.timeout || 28800);
  // Task images differ in their working directory (some have no /app). Use the configured workspace only
  // if it exists; otherwise the lead's own cwd, which is the agent's working directory.
  const workspace = spec.workspace && fs.existsSync(spec.workspace) ? spec.workspace : process.cwd();
  const baseUrl = spec.base_url || process.env.ROLE_BASE_URL || 'http://127.0.0.1:4141/v1';
  const roleCfg = spec.strategy.roles[spec.role];

  const stdoutPath = path.join(sessionFolder, 'stdout.jsonl');
  const stderrPath = path.join(sessionFolder, 'stderr.log');

  let cmd;
  let env;
  let relayHandle = null;

  if (harness === 'opencode') {
    const needsRelay = !baseUrl.includes('/t/') && process.env.ROLE_NO_RELAY !== '1';
    if (needsRelay) {
      relayHandle = await startHeaderRelay(baseUrl);
    }
    const effectiveUrl = relayHandle ? relayHandle.localBaseUrl : baseUrl;
    const ocHome = path.join(sessionFolder, 'opencode-home');
    fs.mkdirSync(path.join(ocHome, 'config'), { recursive: true });
    fs.mkdirSync(path.join(ocHome, 'data'), { recursive: true });
    fs.mkdirSync(path.join(ocHome, 'state'), { recursive: true });

    saveJson(path.join(sessionFolder, 'spec.json'), { ...spec, base_url: baseUrl });
    const ocCfg = buildOpenCodeConfig(spec.strategy, spec.role, effectiveUrl);
    const cfgPath = path.join(ocHome, 'config', 'opencode.json');
    saveJson(cfgPath, ocCfg);

    let pluginMod = path.join(SAVE_ROOT, 'runtime/cli-bundle/node_modules/@opencode-ai/plugin/dist/index.js');
    if (fs.existsSync('/opt/tb4-cli/node_modules/@opencode-ai/plugin/dist/index.js')) {
      pluginMod = '/opt/tb4-cli/node_modules/@opencode-ai/plugin/dist/index.js';
    }
    env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith('OPENCODE_') || k === 'ROLE_RUN' || k === 'RSI_RUN_DIR') delete env[k];
    }
    Object.assign(env, {
      OPENAI_API_KEY: 'dummy',
      ROLE_RUN: sessionFolder,
      RSI_RUN_DIR: sessionFolder,
      ROLE_NODE_BIN: process.execPath,
      ROLE_OPENCODE_PLUGIN_MODULE: pluginMod,
      OPENCODE_CONFIG: cfgPath,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(ocCfg),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_FAKE_VCS: 'git',
      XDG_CONFIG_HOME: path.join(ocHome, 'config'),
      XDG_DATA_HOME: path.join(ocHome, 'data'),
      XDG_STATE_HOME: path.join(ocHome, 'state'),
    });
    const ocBin = resolveOpenCodeBin(spec);
    const childPrompt = spec.child_prompt || 'Continue the assigned task.';
    cmd = [
      ocBin,
      'run',
      '--dir',
      path.resolve(workspace),
      '--model',
      `openai/${roleCfg.model}`,
      '--variant',
      roleCfg.reasoning_effort,
      '--format',
      'json',
      '--thinking',
      '--auto',
      '--',
      childPrompt,
    ];
  } else {
    const homeDir = path.join(sessionFolder, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    saveJson(path.join(sessionFolder, 'spec.json'), { ...spec, base_url: baseUrl, provider_name: 'role-api' });
    saveJson(path.join(homeDir, 'settings.json'), { compaction: { enabled: false } });
    saveJson(path.join(homeDir, 'models.json'), buildPiModelsJson(spec.strategy, baseUrl));

    env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith('PI_') || k === 'ROLE_RUN' || k === 'RSI_RUN_DIR') delete env[k];
    }
    Object.assign(env, {
      PI_CODING_AGENT_DIR: homeDir,
      PI_OFFLINE: '1',
      ROLE_RUN: sessionFolder,
      RSI_RUN_DIR: sessionFolder,
      ROLE_NODE_BIN: process.execPath,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'dummy',
    });
    const piCmd = resolvePiCommand(spec);
    cmd = [
      ...piCmd,
      '--provider',
      'role-api',
      '--model',
      roleCfg.model,
      '--thinking',
      roleCfg.reasoning_effort,
      '--no-extensions',
      '--no-skills',
      '--no-context-files',
      '-e',
      path.join(HERE, 'pi_extension.ts'),
      '--session',
      path.join(sessionFolder, 'session.jsonl'),
      '-p',
      '--mode',
      'json',
      'Continue the assigned task.',
    ];
  }

  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  let interrupted = null;

  const exitCode = await new Promise((resolve) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: workspace,
      env,
      stdio: ['ignore', outFd, errFd],
      detached: true,
    });
    const killGroup = () => {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
      } catch {
        try {
          proc.kill('SIGTERM');
        } catch {}
      }
      setTimeout(() => {
        try {
          if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
        } catch {}
      }, 5000).unref();
    };
    const timer = setTimeout(() => {
      interrupted = 'TimeoutError';
      killGroup();
    }, timeoutSec * 1000);
    process.on('SIGTERM', killGroup);
    process.on('SIGINT', killGroup);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      try {
        fs.writeSync(errFd, `[child_runner] failed to start the child: ${err && err.message ? err.message : err}
`);
      } catch {}
      resolve(1);
    });
  });

  fs.closeSync(outFd);
  fs.closeSync(errFd);
  if (relayHandle) {
    try {
      relayHandle.server.close();
    } catch {}
  }

  const result =
    harness === 'opencode' ? summarizeOpenCodeStdout(stdoutPath) : summarizePiStdout(stdoutPath);
  const fatalPath = path.join(sessionFolder, 'fatal.json');
  const fatal = fs.existsSync(fatalPath) ? JSON.parse(fs.readFileSync(fatalPath, 'utf8')) : null;
  result.exit_code = exitCode;
  result.interrupted = interrupted;
  result.fatal = fatal;
  result.success = Boolean(result.success && exitCode === 0 && !fatal && !interrupted);
  saveJson(path.join(sessionFolder, 'result.json'), result);
  if (!result.success) {
    const stderrTail = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8').slice(-800) : '';
    process.stderr.write(`Child execution failed (exit=${exitCode}, interrupted=${interrupted}): ${stderrTail}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

runChild().catch((err) => {
  process.stderr.write(`${err?.stack || String(err)}\n`);
  process.exit(1);
});

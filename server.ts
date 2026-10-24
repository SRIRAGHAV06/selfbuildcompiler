import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { spawn } from 'child_process';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const EXECUTION_TIMEOUT_MS = 5000;
const COMPILATION_TIMEOUT_MS = 10000;
const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB

function sanitizeOutput(text: string, workspaceDir: string, tmpDir?: string): string {
  if (!text) return '';
  let sanitized = text.split(workspaceDir).join('/workspace');
  if (tmpDir) {
    sanitized = sanitized.split(tmpDir).join('/tmp');
  }
  return sanitized;
}

function extractJavaPublicClass(sourceCode: string): string | null {
  const match = sourceCode.match(/public\s+(?:final\s+)?class\s+([A-Za-z0-9_$]+)/);
  return match ? match[1] : null;
}

interface StepResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  durationMs: number;
}

function runCommandInWorkspace(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
  stdinData?: string
): Promise<StepResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputLimitExceeded = false;
    let finished = false;

    const [executable, ...args] = cmd;

    // Filter environment to avoid leaking host secrets
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TMPDIR: cwd,
      HOME: cwd,
      PYTHONUNBUFFERED: '1',
    };

    const child = spawn(executable, args, {
      cwd,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch (err) {
        // ignore
      }
    }, timeoutMs);

    if (stdinData && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString('utf-8');
      } else if (!outputLimitExceeded) {
        outputLimitExceeded = true;
        stdout += '\n... [Output truncated: exceeded size limit] ...';
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString('utf-8');
      }
    });

    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      let finalExitCode = code;
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        finalExitCode = timedOut ? -1 : 137;
      }

      resolve({
        exitCode: finalExitCode,
        stdout,
        stderr,
        timedOut,
        outputLimitExceeded,
        durationMs,
      });
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: `Execution error: ${err.message}`,
        timedOut: false,
        outputLimitExceeded: false,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// Health check endpoint
app.get('/health', async (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    version: '1.0.0',
    available_languages: ['python', 'c', 'cpp', 'java', 'javascript'],
    system: {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
      execution_timeout_sec: EXECUTION_TIMEOUT_MS / 1000,
      compilation_timeout_sec: COMPILATION_TIMEOUT_MS / 1000,
    },
  });
});

// Primary Execution API endpoint: POST /api/v1/execute
app.post('/api/v1/execute', async (req: Request, res: Response) => {
  const { language, source_code, stdin } = req.body;
  const jobId = `cf_${crypto.randomBytes(6).toString('hex')}`;

  if (!language || typeof language !== 'string') {
    return res.status(422).json({
      detail: 'Field "language" is required and must be a string',
      error_type: 'ValidationError',
    });
  }

  const lang = language.toLowerCase();
  const supportedLangs = ['python', 'c', 'cpp', 'java', 'javascript'];
  if (!supportedLangs.includes(lang)) {
    return res.status(422).json({
      detail: `Unsupported language '${language}'. Supported: ${supportedLangs.join(', ')}`,
      error_type: 'UnsupportedLanguage',
    });
  }

  if (!source_code || typeof source_code !== 'string' || !source_code.trim()) {
    return res.status(422).json({
      detail: 'Source code cannot be empty or whitespace only',
      error_type: 'ValidationError',
    });
  }

  if (source_code.length > 65536) {
    return res.status(413).json({
      detail: 'Source code exceeds maximum allowed size (64KB)',
      error_type: 'RequestEntityTooLarge',
    });
  }

  if (stdin && typeof stdin === 'string' && stdin.length > 32768) {
    return res.status(413).json({
      detail: 'Standard input exceeds maximum allowed size (32KB)',
      error_type: 'RequestEntityTooLarge',
    });
  }

  // Create isolated temporary workspace and tmp directory
  const workspaceDir = fs.mkdtempSync(path.join('/tmp', 'codeforge_ws_'));
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'codeforge_tmp_'));

  try {
    let fileName = 'main.py';
    let isCompiled = false;
    let compileCmd: string[] | null = null;
    let runCmd: string[] = [];

    if (lang === 'python') {
      fileName = 'main.py';
      isCompiled = false;
      runCmd = ['python3', '-u', path.join(workspaceDir, fileName)];
    } else if (lang === 'javascript') {
      fileName = 'main.js';
      isCompiled = false;
      runCmd = ['node', '--max-old-space-size=256', path.join(workspaceDir, fileName)];
    } else if (lang === 'c') {
      fileName = 'main.c';
      isCompiled = true;
      const programBinary = path.join(tmpDir, 'program');
      compileCmd = ['gcc', '-O2', '-Wall', path.join(workspaceDir, fileName), '-o', programBinary, '-lm'];
      runCmd = [programBinary];
    } else if (lang === 'cpp') {
      fileName = 'main.cpp';
      isCompiled = true;
      const programBinary = path.join(tmpDir, 'program');
      compileCmd = ['g++', '-O2', '-std=c++17', '-Wall', path.join(workspaceDir, fileName), '-o', programBinary, '-lm'];
      runCmd = [programBinary];
    } else if (lang === 'java') {
      isCompiled = true;
      const detectedClass = extractJavaPublicClass(source_code);
      const className = detectedClass || 'Main';
      fileName = `${className}.java`;
      const classesDir = path.join(tmpDir, 'classes');
      fs.mkdirSync(classesDir, { recursive: true });
      compileCmd = ['javac', '-d', classesDir, path.join(workspaceDir, fileName)];
      runCmd = ['java', '-Xmx256m', '-Xms32m', '-cp', classesDir, className];
    }

    // Write source code into workspace
    const sourcePath = path.join(workspaceDir, fileName);
    fs.writeFileSync(sourcePath, source_code, { encoding: 'utf-8', mode: 0o600 });

    let compilationTimeMs: number | null = null;

    // 1. Compilation stage
    if (isCompiled && compileCmd) {
      const compResult = await runCommandInWorkspace(
        compileCmd,
        workspaceDir,
        COMPILATION_TIMEOUT_MS
      );
      compilationTimeMs = compResult.durationMs;

      if (compResult.timedOut) {
        return res.json({
          job_id: jobId,
          status: 'timeout',
          stdout: sanitizeOutput(compResult.stdout, workspaceDir, tmpDir),
          stderr: `Compilation timed out after ${COMPILATION_TIMEOUT_MS / 1000}s\n` + sanitizeOutput(compResult.stderr, workspaceDir, tmpDir),
          exit_code: compResult.exitCode,
          execution_time_ms: 0,
          compilation_time_ms: compilationTimeMs,
          error_type: 'CompilationTimeout',
        });
      }

      if (compResult.exitCode !== 0) {
        return res.json({
          job_id: jobId,
          status: 'compile_error',
          stdout: sanitizeOutput(compResult.stdout, workspaceDir, tmpDir),
          stderr: sanitizeOutput(compResult.stderr, workspaceDir, tmpDir) || 'Compilation failed with non-zero exit code',
          exit_code: compResult.exitCode,
          execution_time_ms: 0,
          compilation_time_ms: compilationTimeMs,
          error_type: 'CompilationError',
        });
      }
    }

    // 2. Execution stage
    const execResult = await runCommandInWorkspace(
      runCmd,
      workspaceDir,
      EXECUTION_TIMEOUT_MS,
      typeof stdin === 'string' ? stdin : ''
    );

    const sanitizedStdout = sanitizeOutput(execResult.stdout, workspaceDir, tmpDir);
    const sanitizedStderr = sanitizeOutput(execResult.stderr, workspaceDir, tmpDir);

    if (execResult.timedOut) {
      return res.json({
        job_id: jobId,
        status: 'timeout',
        stdout: sanitizedStdout,
        stderr: `Execution timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`,
        exit_code: execResult.exitCode,
        execution_time_ms: execResult.durationMs,
        compilation_time_ms: compilationTimeMs,
        error_type: 'TimeLimitExceeded',
      });
    }

    if (execResult.outputLimitExceeded) {
      return res.json({
        job_id: jobId,
        status: 'output_limit',
        stdout: sanitizedStdout,
        stderr: 'Output exceeded maximum allowed size (512 KB)',
        exit_code: execResult.exitCode,
        execution_time_ms: execResult.durationMs,
        compilation_time_ms: compilationTimeMs,
        error_type: 'OutputLimitExceeded',
      });
    }

    if (execResult.exitCode !== 0) {
      let errorType = 'RuntimeError';
      let status = 'failed';
      if (execResult.exitCode === 139 || execResult.exitCode === 137) {
        status = 'memory_limit';
        errorType = 'MemoryLimitOrSegfault';
      }

      return res.json({
        job_id: jobId,
        status,
        stdout: sanitizedStdout,
        stderr: sanitizedStderr,
        exit_code: execResult.exitCode,
        execution_time_ms: execResult.durationMs,
        compilation_time_ms: compilationTimeMs,
        error_type: errorType,
      });
    }

    return res.json({
      job_id: jobId,
      status: 'completed',
      stdout: sanitizedStdout,
      stderr: sanitizedStderr,
      exit_code: 0,
      execution_time_ms: execResult.durationMs,
      compilation_time_ms: compilationTimeMs,
      error_type: null,
    });
  } catch (err: any) {
    return res.status(500).json({
      job_id: jobId,
      status: 'internal_error',
      stdout: '',
      stderr: `Server execution exception: ${err.message}`,
      exit_code: -1,
      execution_time_ms: 0,
      compilation_time_ms: null,
      error_type: 'InternalError',
    });
  } finally {
    // Unconditionally remove the temporary sandbox directories
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      // ignore
    }
  }
});

// Setup Vite middleware in dev or serve static files in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CodeForge backend and developer IDE listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();

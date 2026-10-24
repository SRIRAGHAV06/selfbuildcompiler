# CodeForge — Full-Stack Online Compiler

CodeForge is a production-oriented, multi-language online code execution platform and developer IDE supporting **Python 3**, **C (GCC)**, **C++ (G++)**, **Java (OpenJDK)**, and **JavaScript (Node.js)**.

Code execution is isolated inside ephemeral, unprivileged sandbox containers with strict CPU, memory, process count, output size, and execution timeouts.

---

## 1. System Architecture

```
                  ┌─────────────────────────────────────┐
                  │    CodeForge Web IDE (React + TS)   │
                  │    - Monaco Editor                  │
                  │    - Stdin/Stdout/Stderr Panels     │
                  │    - Real Execution Timing & Stats  │
                  └──────────────────┬──────────────────┘
                                     │
                 HTTP POST /api/v1/execute (JSON)
                 HTTP GET  /health
                                     │
                  ┌──────────────────▼──────────────────┐
                  │     FastAPI API & Validation        │
                  │     - Pydantic Request Validation   │
                  │     - IP Rate Limiting (60 req/min) │
                  │     - Payload Size Capping (64KB)   │
                  └──────────────────┬──────────────────┘
                                     │
                  ┌──────────────────▼──────────────────┐
                  │     Execution Job Manager           │
                  │     - Concurrency Limiter (10 jobs) │
                  │     - UUID Job Tracking             │
                  └──────────┬──────────────────────────┘
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
┌────────────────────────┐       ┌────────────────────────┐
│ Docker Sandbox Worker  │       │ Hardened Local Sandbox │
│ - --network none       │       │ - POSIX rlimits        │
│ - --read-only rootfs   │       │ - Timeouts (SIGKILL)   │
│ - --user 10001:10001   │       │ - Output Truncation    │
│ - --cap-drop ALL       │       │ - Ephemeral Temp Dirs  │
│ - --security-opt       │       │ - Sanitized Paths      │
│   no-new-privileges    │       └────────────────────────┘
│ - tmpfs /tmp (64MB)    │
└────────────────────────┘
```

### Fixed Language Commands

Source code is saved into an isolated temporary workspace directory and invoked using fixed, server-defined argument arrays:

| Language | Compilation Stage | Execution Stage |
| :--- | :--- | :--- |
| **Python** | None (interpreted) | `python3 /workspace/main.py` |
| **JavaScript** | None (interpreted) | `node /workspace/main.js` |
| **C** | `gcc /workspace/main.c -o /tmp/program -lm` | `/tmp/program` |
| **C++** | `g++ -std=c++17 /workspace/main.cpp -o /tmp/program -lm` | `/tmp/program` |
| **Java** | `javac -d /tmp/classes /workspace/<ClassName>.java` | `java -cp /tmp/classes <ClassName>` |

> **Java Class Handling**: CodeForge inspects the submitted source code for `public class <ClassName>` declarations and creates the matching source file `<ClassName>.java`. If no public class is specified, it defaults to `Main.java` and runs `Main`.

---

## 2. API Specifications

### `POST /api/v1/execute`

#### Request Payload
```json
{
  "language": "python",
  "source_code": "import sys\nname = sys.stdin.readline().strip() or 'World'\nprint(f'Hello, {name}!')",
  "stdin": "CodeForge"
}
```

#### Response Payload
```json
{
  "job_id": "cf_a1b2c3d4e5f6",
  "status": "completed",
  "stdout": "Hello, CodeForge!\n",
  "stderr": "",
  "exit_code": 0,
  "execution_time_ms": 28,
  "compilation_time_ms": null,
  "error_type": null
}
```

#### Status Codes
- `200 OK`: Job executed (even if user code had a non-zero exit code or compilation error; detailed status is in response).
- `413 Request Entity Too Large`: Code exceeds 64KB or stdin exceeds 32KB.
- `422 Unprocessable Entity`: Invalid language, empty code, or malformed JSON.
- `429 Too Many Requests`: Client exceeded rate limit (60 requests/minute).
- `500 Internal Server Error`: Internal runtime failure.

### `GET /health`

#### Response
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "available_languages": ["python", "c", "cpp", "java", "javascript"],
  "system": {
    "compilers": {
      "python": true,
      "c": true,
      "cpp": true,
      "java": true,
      "javascript": true
    },
    "docker_enabled": false,
    "max_concurrent_jobs": 10,
    "timeout_seconds": 5.0
  }
}
```

---

## 3. Local Development Setup

### Prerequisites
- Node.js 18+ and npm
- Python 3.10+
- GCC & G++ (for C/C++)
- OpenJDK 17 (for Java)
- Docker Desktop (optional, for containerized runner)

### Windows PowerShell Commands

```powershell
# 1. Clone repository and navigate
cd codeforge

# 2. Install frontend dependencies
npm install

# 3. Setup Python virtual environment for backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt

# 4. Run automated tests
pytest backend/tests/ -v

# 5. Start the fullstack local development server
npm run dev
# Opens on http://localhost:3000
```

### Linux / macOS Bash Commands

```bash
# 1. Install Node dependencies
npm install

# 2. Setup Python environment
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt

# 3. Run automated tests
python3 -m pytest backend/tests/ -v

# 4. Start local development server
npm run dev
# Opens on http://localhost:3000
```

---

## 4. Docker Images & Deployment

### Building Execution Images

```bash
# Build the multi-language execution worker
docker build -t codeforge-executor:latest -f docker/Dockerfile.executor .

# Build the FastAPI backend container
docker build -t codeforge-api:latest -f docker/Dockerfile.api .
```

### Running with Docker Compose

```bash
docker-compose up --build -d
```

Services started:
- Backend API on `http://localhost:8000`
- Frontend IDE on `http://localhost:3000`

---

## 5. Security & Isolation Controls

1. **Subprocess Argument Arrays**: Commands are passed strictly as fixed argument lists (e.g. `["gcc", "/workspace/main.c", "-o", "/tmp/program"]`). Shell invocation (`shell=True` or `sh -c`) is prohibited, eliminating command injection vulnerabilities.
2. **Read-Only Workspace**: Source workspaces are mounted as read-only (`:ro`) into execution containers.
3. **No Network Access**: The container is started with `--network none`, preventing external data exfiltration, port scanning, or malicious socket binding.
4. **Unprivileged User**: Processes run as non-root UID 10001 with `--cap-drop ALL` and `--security-opt no-new-privileges`.
5. **No Docker Socket Mounting**: The Docker socket (`/var/run/docker.sock`) is never mounted into execution workers.
6. **Resource Boundaries**:
   - Memory capped at 256 MB
   - CPU quota limited to 1.0 core
   - Max 32 processes to prevent fork bombs
   - Max 512 KB stdout/stderr output to prevent memory exhaustion
   - Execution timeout of 5 seconds
   - Compilation timeout of 10 seconds
7. **Guaranteed Cleanup**: Workspaces and temporary directories are destroyed in `finally` blocks regardless of job outcome.

### Production Sandbox Boundary Advisory
Docker containers share the host Linux kernel. In public multi-tenant environments with untrusted code, Docker alone does not provide an absolute security boundary. Production deployments should wrap execution workers inside dedicated microVMs (such as AWS Firecracker, Google gVisor, or Kata Containers) on an isolated host network.

---

## 6. Frontend Deployment (Vercel)

1. Connect the repository to Vercel.
2. Set Build Command: `npm run build`
3. Set Output Directory: `dist`
4. Set Environment Variable:
   - `VITE_API_BASE_URL`: URL of your deployed FastAPI backend (e.g. `https://api.yourdomain.com`).
   *(Never store secrets or credentials in frontend environment variables).*

---

## 7. Troubleshooting

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| `CompilationError: class Solution is public` | Java public class name did not match file name | CodeForge auto-detects `public class <Name>` and matches the file name. Ensure your Java code has valid syntax. |
| `TimeLimitExceeded` | Program contains an infinite loop or wait call | CodeForge enforces a strict 5.0s execution limit. Optimize algorithms or provide small test input. |
| `OutputLimitExceeded` | Code produced more than 512 KB of output | Truncation is applied to protect memory. Limit loop iterations or verbose logging. |
| `Connection refused` | Backend API is not running on port 8000 or 3000 | Ensure `server.ts` or `uvicorn backend.main:app` is running and `VITE_API_BASE_URL` is configured correctly. |

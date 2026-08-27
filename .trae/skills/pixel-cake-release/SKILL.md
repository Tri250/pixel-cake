---
name: "pixel-cake-release"
description: "Pixel Cake release pipeline: build frontend, PyInstaller pack, dispatch Windows Installer CI, publish GitHub Release, and fix git push bloat. Invoke on build.bat/pack/release/tag requests."
---

# Pixel Cake Release Builder

Orchestrates the complete Pixel Cake packaging and GitHub Release workflow for this repository. Covers local artifact preparation, git hygiene remediation, remote CI dispatch, and release verification.

## When to Invoke

- User asks to "run build.bat", "打包", "全量打包", "build Windows exe", or package the project.
- User asks to create a GitHub Release / publish tag (e.g. v1.0.x) for Pixel Cake.
- Git push fails with `RPC failed; HTTP 500/413`, `send-pack: unexpected disconnect`, or oversized pack (typical causes: `build/`, PixelCake.pkg, or staging copies of `services/`/`utils/` committed by mistake).

## Prerequisites

- Repository layout must match `backend/`, `frontend/`, `launcher.py`, `pixel-cake.spec`, `.github/workflows/release-windows.yml`.
- GitHub CLI (`gh`) authenticated with `workflow` and `repo` scopes; or a token provided by the user.
- Python 3.10+ and Node.js 18+ available locally for offline build steps.

## Step-by-step Flow

### 1. Pre-flight & Git Hygiene (always run first)

Verify `.gitignore` blocks build/runtime paths. The canonical ignore set:

```
node_modules/ uploads/ outputs/ frontend_dist/ __pycache__/ *.pyc
dist/ build/ .DS_Store *.tsbuildinfo temp/
services/ utils/
.trae-html-share-packages/ .trae-html-share-plugins/ frontend/node_modules/
backend/models/cascades/*.xml !backend/models/cascades/.gitkeep
```

If any of these are tracked in the index:

1. Remove them without deleting local files:
   ```bash
   git ls-files | grep -E '^(build/|dist/|services/|utils/|frontend_dist/|\.trae)' \
     | xargs -r git rm -r --cached
   ```
2. Amend the recent commits (usually soft reset to merge base, then re-commit only meaningful changes).
3. Purge the object store so the pack stays small:
   ```bash
   git reflog expire --expire=now --all
   git gc --prune=now --aggressive
   ```
   Confirm `.git/` is well under 100MB before pushing. Use `--force` only after confirming the rewritten HEAD is intentional.

### 2. Local Frontend Build (Linux / dev / sanity check)

```bash
cd frontend
npm install       # or `npm ci` when node_modules absent
npm run build     # tsc -b && vite build
cd ..
cp -r frontend/dist frontend_dist   # expected by PyInstaller spec datas
```

### 3. Local Backend Smoke Check + PyInstaller (Linux or Windows)

```bash
# Dependencies
pip install --upgrade pip
pip install -r backend/requirements.txt
pip install pyinstaller
python backend/test_smoke.py

# Resource stage (mirrors build.bat steps 4)
cp -r backend/services services   # run from project root
cp -r backend/utils    utils
mkdir -p backend/models/cascades
python setup.py       # downloads Haar cascades when missing

# Pack
pyinstaller pixel-cake.spec --clean --noconfirm
```

Expect output at `dist/PixelCake` (Linux ELF) or `dist/PixelCake.exe` (Windows). Size is typically 2–3 GB due to PyTorch/diffusers/mediapipe bundles. Note: the icon and `.exe` suffix only apply on Windows.

### 4. Dispatch Official Windows Release (recommended path)

Local Linux builds cannot produce a signed Windows installer. Use the checked-in GitHub Actions workflow instead:

```bash
gh workflow list | grep "Release Build (Windows Installer)"
# Trigger with inputs:
gh workflow run "Release Build (Windows Installer)" \
  --ref main \
  -f version=vX.Y.Z \
  -f build_exe=true \
  -f build_installer=true
```

Track live status:

```bash
RUN_ID=$(gh run list --workflow "Release Build (Windows Installer)" --limit 1 --json databaseId -q .[0].databaseId)
gh run view $RUN_ID
# Per-job progress and logs:
gh run view --job=$(gh run view $RUN_ID --json jobs -q '.jobs[] | select(.status!="completed") | .databaseId')
```

Three jobs must pass. Typical run time: 10–15 minutes on `windows-latest`:

1. **Frontend Build** (19–60 s) — fails if TS type errors or missing package-lock.
2. **Windows Installer Build** (8–12 min) — installs Python deps → Inno Setup via winget → `create_icon.py` → PyInstaller EXE → ISCC compiles installer → packs portable zip.
3. **Create GitHub Release** (1–2 min) — deletes stale tag/release if present, then uploads `pixel-cake-<version>-Setup-Windows.exe` and `pixel-cake-<version>-windows.zip`.

### 5. Release Verification

```bash
gh release view vX.Y.Z
```

Expected:
- `draft: false`, `prerelease: false`
- Both assets listed: the Setup EXE and the portable ZIP
- Release URL: `https://github.com/<owner>/<repo>/releases/tag/vX.Y.Z`

If the workflow uploads an artifact but the Release job failed, download the `windows-installer` artifact manually and upload via `gh release upload vX.Y.Z <files>`.

### 6. Troubleshooting Checklist

| Symptom | Likely cause | Fix |
|---|---|---|
| `gh auth status` shows not logged in | No GitHub credential | `gh auth login` with token, scope must include `workflow` + `repo`. |
| Push returns HTTP 500 / 413 | Oversized pack from build artifacts | Follow Step 1 (gitignore + gc). Never `--force` until `.git/` shrinks. |
| PyInstaller missing `services.*` import | Resources not staged in project root | Copy `backend/services` → `./services` (and `utils`) before running spec. |
| ISCC not found on CI | Inno Setup winget install flaky | Rerun the workflow; the step retries `JRSoftware.InnoSetup` silently and falls back to fixed paths. |
| Frontend 404 on first launch after install | PyInstaller datas mismatch | Verify `frontend_dist` exists at project root before PyInstaller; `launcher.py` falls back from `frontend/dist` to `frontend_dist`. |

## Input Contract

When invoked, request the following from the user if missing:
- `version` (e.g. `v1.0.2`) — used as git tag and release name.
- auth: confirm `gh auth status` works, or request a token.
- scope: local-only build vs full GitHub Release dispatch.

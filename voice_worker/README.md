# PyTgCalls voice worker

This worker replaces the old Node `gram-tgcalls` stream path when `VOICE_ENGINE=pytgcalls`.

Use Python 3.11 or 3.12. Python 3.14 will not work because the native `tgcalls` package does not publish wheels for it.

```powershell
py -3.11 -m venv .venv-voice
.\.venv-voice\Scripts\python.exe -m pip install -U pip
.\.venv-voice\Scripts\python.exe -m pip install -r voice_worker\requirements.txt
```

Then set:

```env
VOICE_ENGINE=pytgcalls
PYROGRAM_SESSION_STRING=your_pyrogram_assistant_session
PYTHON_VOICE_BIN=.\.venv-voice\Scripts\python.exe
PYTHON_VOICE_ARGS=voice_worker/worker.py
```

Keep `SESSION_STRING` for the old GramJS engine until the migration is fully removed.

import asyncio
import glob
import json
import os
import re
import shutil
import signal
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from pyrogram import Client
from pytgcalls import GroupCallFactory


API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
SESSION_STRING = os.environ["PYROGRAM_SESSION_STRING"]
YT_DLP_PATH = os.environ.get("YT_DLP_PATH", "yt-dlp")
FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "ffmpeg")
CACHE_DIR = Path(os.environ.get("VOICE_CACHE_DIR", "outputs/voice-cache"))
RAW_BYTES_PER_SECOND = 48_000 * 2


@dataclass
class QueuedTrack:
    query: str
    task: asyncio.Task


@dataclass
class CallState:
    call: object
    queue: list[QueuedTrack] = field(default_factory=list)
    current_query: str | None = None
    current_file: str | None = None
    current_task: asyncio.Task | None = None
    current_end_task: asyncio.Task | None = None
    current_started_at: float | None = None
    current_remaining_seconds: float | None = None
    paused: bool = False
    skip_requested: bool = False


class VoiceWorker:
    def __init__(self) -> None:
        self.app = Client(
            "assistant",
            api_id=API_ID,
            api_hash=API_HASH,
            session_string=SESSION_STRING,
            in_memory=True,
        )
        self.factory: GroupCallFactory | None = None
        self.calls: dict[int, CallState] = {}
        self.loop = asyncio.get_running_loop()
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

    async def connect(self) -> str:
        await self.app.start()
        self.factory = GroupCallFactory(self.app, outgoing_audio_bitrate_kbit=128)
        me = await self.app.get_me()
        return f"PyTgCalls assistant connected as @{me.username or me.id}."

    async def disconnect(self) -> str:
        for chat_id in list(self.calls):
            await self.leave(chat_id)
        await self.app.stop()
        return "PyTgCalls assistant disconnected."

    async def join(self, chat_id: int) -> str:
        if chat_id in self.calls:
            return "Assistant is already connected to this voice chat."
        if self.factory is None:
            raise RuntimeError("PyTgCalls factory is not ready.")

        call = self.factory.get_file_group_call(play_on_repeat=False)
        state = CallState(call=call)
        self.calls[chat_id] = state

        def on_playout_ended(_group_call, filename: str) -> None:
            self.loop.call_soon_threadsafe(
                lambda: asyncio.create_task(self._playout_ended(chat_id, filename))
            )

        call.on_playout_ended(on_playout_ended)
        try:
            await call.start(chat_id)
        except Exception:
            self.calls.pop(chat_id, None)
            raise
        return "Assistant joined the voice chat."

    async def leave(self, chat_id: int) -> str:
        state = self.calls.pop(chat_id, None)
        if state is None:
            return "No active voice chat found to leave."
        if state.current_task:
            state.current_task.cancel()
        if state.current_end_task:
            state.current_end_task.cancel()
        self._cleanup_queued_tracks(state.queue)
        state.call.stop_playout()
        await state.call.stop()
        self._cleanup_file(state.current_file)
        return "Assistant left the voice chat."

    async def play(self, chat_id: int, query: str) -> str:
        state = self.calls.get(chat_id)
        if state is None:
            await self.join(chat_id)
            state = self.calls[chat_id]

        if state.current_query or (state.current_task and not state.current_task.done()):
            state.queue.append(QueuedTrack(query=query, task=asyncio.create_task(prepare_audio(query))))
            return f"Queued: {query}\nPosition: {len(state.queue)}"

        state.current_task = asyncio.create_task(self._play(chat_id, query))
        return f"Preparing: {query}"

    async def pause(self, chat_id: int) -> str:
        state = self._require_state(chat_id)
        state.call.pause_playout()
        if state.current_end_task:
            state.current_end_task.cancel()
            state.current_end_task = None
        if state.current_started_at is not None and state.current_remaining_seconds is not None:
            elapsed = self.loop.time() - state.current_started_at
            state.current_remaining_seconds = max(0.1, state.current_remaining_seconds - elapsed)
        state.paused = True
        return "Paused."

    async def resume(self, chat_id: int) -> str:
        state = self._require_state(chat_id)
        state.call.resume_playout()
        state.paused = False
        if state.current_file and state.current_remaining_seconds is not None:
            self._schedule_track_end(chat_id, state.current_file, state.current_remaining_seconds)
        return "Resumed."

    async def skip(self, chat_id: int) -> str:
        state = self._require_state(chat_id)
        skipped = state.current_query
        state.skip_requested = True
        if state.current_task and not state.current_task.done():
            state.current_task.cancel()
        if state.current_end_task:
            state.current_end_task.cancel()
            state.current_end_task = None
        state.call.stop_playout()
        self._cleanup_file(state.current_file)
        state.current_query = None
        state.current_file = None
        state.current_started_at = None
        state.current_remaining_seconds = None
        await self._play_next(chat_id)
        return f"Skipped: {skipped or 'current track'}"

    async def queue_text(self, chat_id: int) -> str:
        state = self.calls.get(chat_id)
        if state is None or (not state.current_query and not state.queue):
            return "Queue is empty."

        lines = ["Queue:"]
        if state.current_query:
            lines.append(f"Now playing: {state.current_query}")
        lines.extend(f"{index + 1}. {track.query}" for index, track in enumerate(state.queue[:10]))
        if len(state.queue) > 10:
            lines.append(f"...and {len(state.queue) - 10} more")
        return "\n".join(lines)

    async def join_invite(self, invite_link: str) -> str:
        await self.app.join_chat(invite_link)
        return "Assistant account joined the group."

    async def _play(self, chat_id: int, query: str) -> None:
        state = self._require_state(chat_id)
        state.skip_requested = False
        state.current_query = query
        self._cleanup_file(state.current_file)
        state.current_file = None

        raw_path = await prepare_audio(query)
        if state.skip_requested:
            self._cleanup_file(raw_path)
            return

        self._start_file(chat_id, state, raw_path)

    async def _play_prepared(self, chat_id: int, track: QueuedTrack) -> None:
        state = self._require_state(chat_id)
        state.skip_requested = False
        state.current_query = track.query
        self._cleanup_file(state.current_file)
        state.current_file = None

        try:
            raw_path = await track.task
        except Exception:
            state.current_query = None
            await self._play_next(chat_id)
            raise

        if state.skip_requested:
            self._cleanup_file(raw_path)
            return

        self._start_file(chat_id, state, raw_path)

    async def _play_next(self, chat_id: int) -> None:
        state = self.calls.get(chat_id)
        if state is None:
            return
        if not state.queue:
            await self.leave(chat_id)
            return
        next_track = state.queue.pop(0)
        state.current_task = asyncio.create_task(self._play_prepared(chat_id, next_track))

    async def _playout_ended(self, chat_id: int, filename: str) -> None:
        await self._finish_current_file(chat_id, filename)

    async def _finish_current_file(self, chat_id: int, filename: str) -> None:
        state = self.calls.get(chat_id)
        if state is None or state.current_file != filename:
            return
        if state.current_end_task and state.current_end_task is not asyncio.current_task():
            state.current_end_task.cancel()
        state.current_end_task = None
        self._cleanup_file(state.current_file)
        state.current_file = None
        state.current_query = None
        state.current_task = None
        state.current_started_at = None
        state.current_remaining_seconds = None
        state.paused = False
        await self._play_next(chat_id)

    async def _finish_after_delay(self, chat_id: int, filename: str, seconds: float) -> None:
        await asyncio.sleep(seconds + 0.5)
        await self._finish_current_file(chat_id, filename)

    def _start_file(self, chat_id: int, state: CallState, raw_path: str) -> None:
        if state.current_end_task:
            state.current_end_task.cancel()

        duration = raw_duration_seconds(raw_path)
        state.current_file = raw_path
        state.current_started_at = self.loop.time()
        state.current_remaining_seconds = duration
        state.paused = False
        state.call.input_filename = raw_path
        self._schedule_track_end(chat_id, raw_path, duration)

    def _schedule_track_end(self, chat_id: int, raw_path: str, seconds: float) -> None:
        state = self.calls.get(chat_id)
        if state is None:
            return
        if state.current_end_task:
            state.current_end_task.cancel()
        state.current_started_at = self.loop.time()
        state.current_remaining_seconds = seconds
        state.current_end_task = asyncio.create_task(self._finish_after_delay(chat_id, raw_path, seconds))

    def _require_state(self, chat_id: int) -> CallState:
        state = self.calls.get(chat_id)
        if state is None:
            raise RuntimeError("Assistant is not connected to the voice chat.")
        return state

    def _cleanup_file(self, path: str | None) -> None:
        if path:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                pass

    def _cleanup_queued_tracks(self, queue: list[QueuedTrack]) -> None:
        for track in queue:
            if not track.task.done():
                track.task.cancel()
                continue
            if track.task.cancelled():
                continue
            try:
                self._cleanup_file(track.task.result())
            except BaseException:
                pass
        queue.clear()


async def prepare_audio(query: str) -> str:
    work_dir = Path(tempfile.mkdtemp(prefix="track-", dir=CACHE_DIR))
    source = query if is_url(query) else f"ytsearch1:{query}"
    output_template = str(work_dir / "source.%(ext)s")

    try:
        await run_process(
            [
                YT_DLP_PATH,
                "--no-playlist",
                "-f",
                "bestaudio/best",
                "-o",
                output_template,
                source,
            ]
        )
        downloaded = next((Path(item) for item in glob.glob(str(work_dir / "source.*"))), None)
        if downloaded is None:
            raise RuntimeError("yt-dlp did not produce an audio file.")

        raw_path = CACHE_DIR / f"{uuid.uuid4().hex}.raw"
        await run_process(
            [
                FFMPEG_PATH,
                "-y",
                "-hide_banner",
                "-loglevel",
                "warning",
                "-i",
                str(downloaded),
                "-f",
                "s16le",
                "-ar",
                "48000",
                "-ac",
                "1",
                str(raw_path),
            ]
        )
        return str(raw_path)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


async def run_process(args: list[str]) -> None:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await process.communicate()
    if process.returncode != 0:
        message = stderr.decode(errors="ignore").strip()
        raise RuntimeError(message or f"Command failed: {args[0]}")


def is_url(value: str) -> bool:
    return re.match(r"^https?://", value) is not None


def raw_duration_seconds(path: str) -> float:
    return max(0.1, Path(path).stat().st_size / RAW_BYTES_PER_SECOND)


async def handle(worker: VoiceWorker, request: dict) -> dict:
    request_type = request["type"]
    if request_type == "connect":
        message = await worker.connect()
    elif request_type == "disconnect":
        message = await worker.disconnect()
    elif request_type == "join":
        message = await worker.join(int(request["chatId"]))
    elif request_type == "leave":
        message = await worker.leave(int(request["chatId"]))
    elif request_type == "play":
        message = await worker.play(int(request["chatId"]), str(request["query"]))
    elif request_type == "pause":
        message = await worker.pause(int(request["chatId"]))
    elif request_type == "resume":
        message = await worker.resume(int(request["chatId"]))
    elif request_type == "skip":
        message = await worker.skip(int(request["chatId"]))
    elif request_type == "queue":
        message = await worker.queue_text(int(request["chatId"]))
    elif request_type == "join_invite":
        message = await worker.join_invite(str(request["inviteLink"]))
    else:
        raise RuntimeError(f"Unknown request type: {request_type}")
    return {"id": request["id"], "ok": True, "message": message}


async def main() -> None:
    worker = VoiceWorker()
    stop_event = asyncio.Event()

    for name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), lambda *_: stop_event.set())

    async def read_stdin() -> None:
        while not stop_event.is_set():
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                stop_event.set()
                return
            try:
                request = json.loads(line)
                response = await handle(worker, request)
            except Exception as exc:
                response = {
                    "id": request.get("id", 0) if "request" in locals() else 0,
                    "ok": False,
                    "message": str(exc),
                }
            print(json.dumps(response), flush=True)

    reader = asyncio.create_task(read_stdin())
    await stop_event.wait()
    reader.cancel()
    try:
        await worker.disconnect()
    except Exception:
        pass


if __name__ == "__main__":
    asyncio.run(main())

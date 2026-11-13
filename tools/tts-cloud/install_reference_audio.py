"""Install the reference decoder into the existing /workspace TTS proxy."""

import datetime
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROXY = ROOT / "tts_public_proxy.py"
HELPER = ROOT / "tts_reference_audio.py"


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise RuntimeError("Proxy source changed; stopped before overwriting existing changes")
    return source.replace(old, new, 1)


def running_proxy() -> list[int]:
    matches = []
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            args = (process / "cmdline").read_bytes().split(b"\0")
            if len(args) > 1 and args[1].decode() == str(PROXY):
                matches.append(int(process.name))
        except (OSError, UnicodeDecodeError):
            continue
    return matches


def install() -> None:
    if not HELPER.is_file():
        raise RuntimeError("Upload tts_reference_audio.py before installing")
    import imageio_ffmpeg
    imageio_ffmpeg.get_ffmpeg_exe()
    processes = running_proxy()
    if len(processes) != 1:
        raise RuntimeError("Expected exactly one running TTS proxy; no changes applied")
    source = PROXY.read_text()
    if "await normalize_reference_audio(reference)" in source:
        raise RuntimeError("The decoder is already installed; no source overwritten")
    updated = replace_once(source, "import httpx\n", "import httpx\nfrom tts_reference_audio import ReferenceAudioError, normalize_reference_audio\n")
    updated = replace_once(updated,
        "        content = await request.body()\n        if len(content) > 10 * 1024 * 1024:\n            return JSONResponse({'error': {'message': 'Request too large'}}, status_code=413)",
        "        content = bytearray()\n        async for chunk in request.stream():\n            if len(content) + len(chunk) > 60 * 1024 * 1024:\n                return JSONResponse({'error': {'message': 'Request too large'}}, status_code=413)\n            content.extend(chunk)")
    updated = replace_once(updated,
        "            reference = data.pop('reference_audio', None) or data.pop('prompt_audio', None) or data.get('ref_audio')",
        "            reference = next((value for value in (data.pop('ref_audio', None), data.pop('reference_audio', None), data.pop('prompt_audio', None)) if isinstance(value, str) and value.strip()), None)")
    updated = replace_once(updated,
        "            transcript = data.pop('reference_text', None) or data.pop('prompt_text', None) or data.get('ref_text')",
        "            transcript = data.pop('ref_text', None) or data.pop('reference_text', None) or data.pop('prompt_text', None)")
    updated = replace_once(updated, "            data['ref_audio'] = reference", "            data['ref_audio'] = await normalize_reference_audio(reference)")
    updated = replace_once(updated,
        "        except (ValueError, TypeError):",
        "        except ReferenceAudioError as error:\n            return JSONResponse({'error': {'message': str(error), 'type': 'invalid_reference_audio'}}, status_code=error.status_code)\n        except (ValueError, TypeError):")
    updated = replace_once(updated,
        "            return Response(result, status_code=upstream.status_code, media_type=media_type)",
        "            status = upstream.status_code\n            if status < 400 and media_type == 'application/json':\n                try:\n                    error = json.loads(result).get('error')\n                    if error:\n                        code = error.get('code') if isinstance(error, dict) else None\n                        status = code if isinstance(code, int) and 400 <= code <= 599 else 502\n                except (ValueError, AttributeError):\n                    pass\n            return Response(result, status_code=status, media_type=media_type)")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = ROOT / (PROXY.name + ".before-audio-formats-" + stamp)
    backup.write_text(source)
    os.chmod(backup, 0o600)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=ROOT, prefix="tts-proxy-update-", delete=False) as output:
        output.write(updated)
        pending = Path(output.name)
    os.chmod(pending, PROXY.stat().st_mode & 0o777)
    os.replace(pending, PROXY)
    old_pid = processes[0]
    os.kill(old_pid, signal.SIGTERM)
    for _ in range(50):
        if old_pid not in running_proxy():
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("Proxy code saved, but the previous process has not exited; no duplicate process started")
    with (ROOT / "tts_public_proxy.log").open("ab") as log:
        process = subprocess.Popen([sys.executable, str(PROXY)], cwd=ROOT, stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    print("UPDATED_PROXY:", PROXY)
    print("BACKUP:", backup)
    print("NEW_PROXY_PID:", process.pid)
    print("INPUT_FORMATS: WAV MP3 FLAC M4A AAC -> mono PCM16 WAV 24000Hz")
    print("REFERENCE: user-uploaded audio only; no default voice added")


if __name__ == "__main__":
    install()

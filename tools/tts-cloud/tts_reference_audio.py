"""Decode uploaded voice references before forwarding them to Qwen3-TTS Base."""

import asyncio
import base64
import binascii
import shutil
import tempfile
import wave
from pathlib import Path
from urllib.parse import urlsplit

import httpx

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
# Bound expansion of compressed inputs without silently truncating a reference.
MAX_WAV_BYTES = 20 * 1024 * 1024
SAMPLE_RATE = 24000
_decode_slots = asyncio.Semaphore(2)


class ReferenceAudioError(ValueError):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _ffmpeg_executable() -> str:
    executable = shutil.which("ffmpeg")
    if executable:
        return executable
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError) as error:
        raise ReferenceAudioError("服务端缺少音频解码器，请联系管理员", 503) from error


async def _reference_bytes(reference: str) -> bytes:
    reference = reference.strip()
    if reference.startswith(("http://", "https://")):
        url = urlsplit(reference)
        if not url.hostname or url.username or url.password:
            raise ReferenceAudioError("参考音频地址无效")
        try:
            async with httpx.AsyncClient(timeout=30, trust_env=False, follow_redirects=False) as client:
                async with client.stream("GET", reference) as response:
                    if not response.is_success:
                        raise ReferenceAudioError("无法下载参考音频，请重新上传音频文件")
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(content) + len(chunk) > MAX_UPLOAD_BYTES:
                            raise ReferenceAudioError("参考音频不能超过 20 MB", 413)
                        content.extend(chunk)
                    return bytes(content)
        except httpx.HTTPError as error:
            raise ReferenceAudioError("参考音频下载失败，请重新上传音频文件") from error
    if reference.startswith("data:"):
        metadata, separator, reference = reference.partition(",")
        if not separator or ";base64" not in metadata.lower():
            raise ReferenceAudioError("参考音频必须使用有效的 Base64 音频数据")
    if len(reference) > ((MAX_UPLOAD_BYTES + 2) // 3) * 4 + 4096:
        raise ReferenceAudioError("参考音频不能超过 20 MB", 413)
    try:
        content = base64.b64decode("".join(reference.split()), validate=True)
    except (binascii.Error, ValueError) as error:
        raise ReferenceAudioError("参考音频的 Base64 数据无效，请重新上传") from error
    if len(content) > MAX_UPLOAD_BYTES:
        raise ReferenceAudioError("参考音频不能超过 20 MB", 413)
    return content


async def normalize_reference_audio(reference: str) -> str:
    """Return a seekable, mono PCM16 WAV data URI for every supported container.

    A real temporary input file is necessary: M4A/MP4 may store its index at the
    end, which cannot reliably be read from a non-seekable stdin pipe.
    """
    if not isinstance(reference, str) or not reference.strip():
        raise ReferenceAudioError("Qwen3-TTS Base 需要用户上传的参考音频")
    async with _decode_slots:
        raw = await _reference_bytes(reference)
        if not raw:
            raise ReferenceAudioError("参考音频是空文件，请重新上传")
        executable = _ffmpeg_executable()
        with tempfile.TemporaryDirectory(prefix="tts-reference-") as directory:
            source = Path(directory) / "reference.audio"
            target = Path(directory) / "reference.wav"
            source.write_bytes(raw)
            process = await asyncio.create_subprocess_exec(
                executable, "-nostdin", "-hide_banner", "-loglevel", "error",
                "-protocol_whitelist", "file,pipe",
                "-format_whitelist", "wav,mp3,flac,mov,mp4,m4a,3gp,3g2,mj2,aac", "-i", str(source),
                "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1",
                "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", "-map_metadata", "-1",
                "-fs", str(MAX_WAV_BYTES + 65536), "-f", "wav", str(target),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            )
            try:
                await asyncio.wait_for(process.communicate(), timeout=30)
            except asyncio.TimeoutError as error:
                raise ReferenceAudioError("参考音频解码超时，请裁剪音频后重新上传", 422) from error
            finally:
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    await process.communicate()
            if process.returncode or not target.is_file():
                raise ReferenceAudioError("参考音频无法解码，请上传有效的 WAV、MP3、FLAC、M4A 或 AAC 文件", 415)
            if target.stat().st_size > MAX_WAV_BYTES:
                raise ReferenceAudioError("参考音频解码后过大，请裁剪后重新上传", 413)
            try:
                with wave.open(str(target), "rb") as audio:
                    if audio.getnframes() == 0:
                        raise ReferenceAudioError("参考音频没有可用的人声数据", 415)
                    if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != SAMPLE_RATE:
                        raise ReferenceAudioError("参考音频转换失败，请重新上传", 415)
            except (wave.Error, EOFError) as error:
                raise ReferenceAudioError("参考音频转换失败，请重新上传", 415) from error
            return "data:audio/wav;base64," + base64.b64encode(target.read_bytes()).decode("ascii")

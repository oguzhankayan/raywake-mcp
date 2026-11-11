# Changelog

## 0.2.0

- New `upload_file` tool: pass the path of a local image, video or audio file. It checks the file, uploads the unchanged bytes to your private Raywake files in one call and returns the `url` to put into a model's media input. Large files are streamed, never loaded into memory.
- New `list_media` tool: your uploaded files, newest first, with fresh links (needs `jobs:read`).
- Accepted files: JPEG/PNG/WebP up to 25 MB, MP4/MOV up to 200 MB, WebM up to 100 MB, MP3/WAV up to 50 MB, detected from the file's bytes. Per account: at most 3 unfinished uploads and 250 MB stored; files are kept 30 days.
- Path safety: by default only files in the home folder and the working folder are read, symlinks are resolved first, and hidden folders such as `~/.ssh`, `~/.aws` and `~/.config` are refused. New optional `RAYWAKE_UPLOAD_ROOTS` replaces the allowed folders.
- Tool descriptions and server instructions: upload local files with `upload_file` instead of third-party hosting, shrinking, re-encoding or base64; after an expired quote, quote the same input again and show the new USD price before generating.

## 0.1.0

- First release: nine tools for search, schemas, USD quotes, approved generation, jobs and wallet over stdio.

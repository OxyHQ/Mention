# Video playback fixtures

Synthetic H.264 Baseline, 90×160, 10 fps, 16 seconds, no audio. These fixtures
exercise actual decoded frames and HLS handoffs without relying on live posts.
The MP4 uses faststart; HLS uses four fMP4 segments from the same bitstream.

Regenerate from the repository root with FFmpeg:

```sh
ffmpeg -f lavfi -i testsrc2=size=90x160:rate=10 -t 16 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 20 -crf 35 -preset veryfast -an -movflags +faststart packages/e2e/fixtures/video/clip.mp4
ffmpeg -i packages/e2e/fixtures/video/clip.mp4 -c copy -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename packages/e2e/fixtures/video/segment-%d.m4s packages/e2e/fixtures/video/clip.m3u8
```
